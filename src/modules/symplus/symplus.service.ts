import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { HttpStatus } from '@/constants/http';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import {
  REFERENCE_LISTS,
  symplusApi,
  type CustomerKind,
  type CustomerUpdateSection,
  type ReferenceList,
  type SymplusMutationResult,
  type SymplusPayload,
  type SymplusRow,
} from '@/integrations/symplus/symplus.api';
import {
  isRetryable,
  symplusBadResponse,
  symplusDisabled,
} from '@/integrations/symplus/symplus.errors';
import { UserModel } from '@/modules/user/user.model';
import { userService } from '@/modules/user/user.service';
import { CustomerLinkModel, type ICustomerLink } from './customerLink.model';
import { syncQueue } from './syncQueue.service';

const updateJobKey = (customerId: string, section: CustomerUpdateSection) =>
  `update:${customerId}:${section}`;

/**
 * Symplus doesn't document its status values, so this matches on meaning. An unrecognised value
 * counts as pending: the link just stays where it is, and the raw text is kept for review.
 */
const classifyRegistrationStatus = (status: string | undefined) => {
  if (!status) return 'pending';
  if (/reject|declin|fail|cancel/i.test(status)) return 'rejected';
  if (/approv|active|complete|success/i.test(status)) return 'approved';
  return 'pending';
};

const toAmount = (value: unknown): number => {
  const amount = Number(value);
  // Better to fail the sync and keep the last good figures than to show someone a wrong balance.
  if (value === null || value === undefined || value === '' || Number.isNaN(amount)) {
    throw symplusBadResponse();
  }
  return amount;
};

const isYes = (value: unknown): boolean =>
  typeof value === 'string' && /^(y|yes|true|1)$/i.test(value.trim());

class SymplusService extends BaseService<ICustomerLink> {
  private readonly referenceCache = new Map<
    ReferenceList,
    { rows: SymplusRow[]; expiresAt: number }
  >();

  constructor() {
    super(CustomerLinkModel, { resourceName: 'Customer link' });
  }

  getLinkForUser(userId: string) {
    return this.findOne({ user: userId });
  }

  async requireLinkForUser(userId: string) {
    const link = await this.getLinkForUser(userId);
    if (!link) throw AppError.notFound('You have not set up a core banking profile', 'NOT_LINKED');
    return link;
  }

  async requireCustomerId(userId: string) {
    const link = await this.requireLinkForUser(userId);
    if (!link.customerId) {
      throw AppError.conflict('Your profile is still awaiting approval', 'CUSTOMER_NOT_ACTIVE');
    }
    return link.customerId;
  }

  /**
   * Finds a Symplus customer with this email that was created for this user. Matching on email
   * alone isn't enough, because anyone can register here with someone else's address and would
   * then see that person's balances. A record belonging to anyone else is refused.
   */
  private async findOwnCustomer(email: string, userId: string) {
    const matches = await symplusApi.findCustomers('email', email);
    if (matches.length === 0) return null;

    for (const { customer_id: customerId } of matches) {
      const details = await symplusApi.getCustomerDetails(customerId);
      if (details?.external_crm_id === userId) return customerId;
    }

    throw AppError.conflict(
      'This email is already registered with core banking. Please contact support to link it.',
      'SYMPLUS_CUSTOMER_EXISTS',
    );
  }

  /** Starts a user's onboarding. If Symplus is down it queues the work, and `queued` is true. */
  async onboard(userId: string, input: SymplusPayload) {
    if (!env.SYMPLUS_ENABLED) throw symplusDisabled();

    const user = await userService.findById(userId);
    const existing = await this.getLinkForUser(userId);

    if (existing && !['failed', 'rejected'].includes(existing.status)) {
      throw AppError.conflict('You already have a core banking profile', 'ALREADY_LINKED');
    }

    const link = existing ?? new CustomerLinkModel({ user: userId });
    link.status = 'queued';
    link.customerType = 'individual';
    link.lastError = null;
    // A rejected or failed attempt starts again as a new registration, with its own documents.
    link.customerId = null;
    link.sourceReference = null;
    link.upstreamStatus = null;
    link.submittedDocuments = [];
    await link.save();

    const customer: SymplusPayload = {
      ...input,
      primary_email_address: user.email,
      external_crm_id: userId,
      ...(env.SYMPLUS_DEFAULT_OFFICER_ID && { officer_id: env.SYMPLUS_DEFAULT_OFFICER_ID }),
      ...(env.SYMPLUS_DEFAULT_LOCATION_CD && { location_cd: env.SYMPLUS_DEFAULT_LOCATION_CD }),
    };

    try {
      await this.submitCustomer(link.id, userId, customer);
    } catch (err) {
      if (isRetryable(err)) {
        await syncQueue.enqueue({
          type: 'customer.create',
          dedupeKey: `create:${link.id}`,
          payload: { linkId: link.id, userId, customer },
        });
        return { link: await this.findById(link.id), queued: true };
      }
      await this.markFailed(link.id, err instanceof AppError ? err.message : 'Onboarding failed');
      throw err;
    }

    return { link: await this.findById(link.id), queued: false };
  }

  /**
   * Sends a new customer to Symplus. It looks for an existing record first, because an earlier
   * attempt that timed out may have got through, and creating it again would make a duplicate.
   */
  async submitCustomer(linkId: string, userId: string, customer: SymplusPayload) {
    const link = await this.findById(linkId);
    if (link.customerId || link.sourceReference) return;

    const email = customer.primary_email_address as string;
    const existingId = await this.findOwnCustomer(email, userId);
    if (existingId) {
      link.customerId = existingId;
      link.status = 'active';
      link.lastError = null;
      await link.save();
      await this.trySyncKyc(link.id);
      return;
    }

    this.applyCreationResult(link, await symplusApi.createCustomer(link.customerType, customer));
    await link.save();
    if (link.status === 'active') await this.trySyncKyc(link.id);
  }

  private applyCreationResult(
    link: InstanceType<typeof CustomerLinkModel>,
    { customerId, sourceReference, code }: SymplusMutationResult,
  ) {
    if (!customerId && !sourceReference) throw symplusBadResponse();
    link.customerId = customerId ?? null;
    link.sourceReference = sourceReference ?? null;
    link.upstreamStatus = code ?? null;
    link.status = sourceReference ? 'pending' : 'active';
    link.lastError = null;
  }

  async markFailed(linkId: string, message: string) {
    await CustomerLinkModel.updateOne(
      { _id: linkId },
      { $set: { status: 'failed', lastError: message } },
    ).exec();
  }

  /** Checks an awaiting-approval registration with Symplus and updates the link. */
  async refreshRegistration(linkId: string) {
    const link = await this.findById(linkId);
    if (link.status !== 'pending' || !link.sourceReference) return link;

    const status = await symplusApi.getRegistrationStatus(link.customerType, link.sourceReference);
    link.upstreamStatus = status ?? link.upstreamStatus;

    const outcome = classifyRegistrationStatus(status);
    if (outcome === 'rejected') link.status = 'rejected';

    if (outcome === 'approved') {
      if (!link.customerId) {
        const user = await userService.findById(link.user.toString());
        link.customerId = await this.findOwnCustomer(user.email, user.id);
      }
      // If the record isn't findable yet, stay pending so the next check can try again.
      if (link.customerId) link.status = 'active';
    }

    await link.save();
    if (link.status === 'active') await this.trySyncKyc(link.id);
    return link;
  }

  /**
   * Copies the customer's KYC result from Symplus onto their account. This is the only thing that
   * sets `kycCompleted`, and it can turn it off again if Symplus withdraws it or blacklists them.
   * A value it doesn't recognise counts as not complete, and the raw text is kept for review.
   */
  async syncKyc(linkId: string) {
    const link = await this.findById(linkId);
    if (link.status !== 'active' || !link.customerId) return link;

    const details = await symplusApi.getCustomerDetails(link.customerId);
    if (!details) return link;

    const completed = isYes(details.kyc_completed) && !isYes(details.is_blacklisted_yesno);

    link.upstreamKyc = typeof details.kyc_completed === 'string' ? details.kyc_completed : null;
    link.kycCheckedAt = new Date();
    await link.save();

    // The filter leaves the date alone when nothing has changed.
    await UserModel.updateOne(
      { _id: link.user, kycCompleted: !completed },
      { $set: { kycCompleted: completed, kycCompletedAt: completed ? new Date() : null } },
    ).exec();
    return link;
  }

  /** For when the KYC check is a bonus on top of another step. The recurring sync catches up. */
  private async trySyncKyc(linkId: string) {
    try {
      await this.syncKyc(linkId);
    } catch (err) {
      logger.warn({ err, linkId }, 'Could not check KYC status');
    }
  }

  /** Copies the customer's current balances from Symplus onto their link. */
  async syncBalances(linkId: string) {
    const link = await this.findById(linkId);
    if (!link.customerId) return link;

    const [netWorth, positions] = await Promise.all([
      symplusApi.getNetWorth(link.customerId),
      symplusApi.getPositions(link.customerId),
    ]);

    link.netWorth = netWorth.map((row) => ({
      moduleName: row.module_name,
      currencyId: row.currency_id,
      currencyName: row.currency_name,
      netWorth: toAmount(row.net_worth_amount),
    }));
    link.positions = positions.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      accountId: row.account_id,
      currencyId: row.currency_id,
      currencyName: row.currency_name,
      currentBalance: toAmount(row.current_balance),
      currentValue: toAmount(row.current_value),
    }));
    link.balancesSyncedAt = new Date();
    await link.save();
    return link;
  }

  /** Sends an update to Symplus, queueing it if Symplus is down. Returns whether it was queued. */
  async updateCustomer(customerId: string, section: CustomerUpdateSection, data: SymplusPayload) {
    const dedupeKey = updateJobKey(customerId, section);
    await syncQueue.cancel(dedupeKey);

    try {
      await symplusApi.updateCustomer(section, customerId, data);
      return { queued: false };
    } catch (err) {
      if (!isRetryable(err)) throw err;
      await syncQueue.enqueue({
        type: 'customer.update',
        dedupeKey,
        payload: { customerId, section, data },
        replaceExisting: true,
      });
      return { queued: true };
    }
  }

  async uploadOwnDocument(userId: string, type: string, file: Express.Multer.File) {
    const link = await this.requireLinkForUser(userId);

    // Approved customers are identified by customer ID, pending ones by their source reference.
    const owner = link.customerId
      ? { customer_id: link.customerId }
      : link.sourceReference
        ? { customer_source_reference: link.sourceReference }
        : null;

    if (!owner) {
      throw AppError.conflict('Your profile has not been created yet', 'CUSTOMER_NOT_CREATED');
    }

    const result = await this.uploadDocument(link.customerType, owner, type, file);
    await CustomerLinkModel.updateOne(
      { _id: link.id },
      { $addToSet: { submittedDocuments: type } },
    ).exec();
    return result;
  }

  uploadDocument(
    kind: CustomerKind,
    owner: { customer_id?: string; customer_source_reference?: string },
    type: string,
    file: Express.Multer.File,
  ) {
    return symplusApi.uploadDocument(kind, owner, {
      type,
      mimeType: SYMPLUS_MIME_NAMES[file.mimetype] as string,
      contentBase64: file.buffer.toString('base64'),
    });
  }

  /** Lets an admin connect a user to a customer that already exists in Symplus. */
  async linkExistingCustomer(userId: string, customerId: string, customerType: CustomerKind) {
    await userService.findById(userId);

    if (!(await symplusApi.isValidCustomerId(customerId))) {
      throw new AppError(
        'That customer ID does not exist in core banking',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_CUSTOMER_ID',
      );
    }

    const link = (await this.getLinkForUser(userId)) ?? new CustomerLinkModel({ user: userId });
    if (link.customerId && link.customerId !== customerId) {
      throw AppError.conflict('This user is already linked to another customer', 'ALREADY_LINKED');
    }

    link.customerId = customerId;
    link.customerType = customerType;
    link.status = 'active';
    link.lastError = null;
    await link.save();
    await this.trySyncKyc(link.id);
    return link;
  }

  /** Reference lists barely change, so they're cached rather than fetched on every form load. */
  async getReferenceList(list: ReferenceList) {
    const cached = this.referenceCache.get(list);
    if (cached && cached.expiresAt > Date.now()) return cached.rows;

    const rows = await symplusApi.getReferenceList(list);
    this.referenceCache.set(list, {
      rows,
      expiresAt: Date.now() + env.SYMPLUS_REFERENCE_CACHE_MINUTES * 60 * 1000,
    });
    return rows;
  }

  async getStatus() {
    let connected = false;
    let error: string | undefined;

    if (env.SYMPLUS_ENABLED) {
      try {
        await symplusApi.checkConnection();
        connected = true;
      } catch (err) {
        error = err instanceof AppError ? err.code : 'UNKNOWN';
      }
    }

    return {
      enabled: env.SYMPLUS_ENABLED,
      connected,
      error,
      environment: env.SYMPLUS_BASE_URL?.includes('/sandbox/') ? 'sandbox' : 'live',
      referenceLists: Object.keys(REFERENCE_LISTS).length,
      queue: await syncQueue.getStats(),
    };
  }
}

const SYMPLUS_MIME_NAMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/bmp': 'bmp',
  'application/pdf': 'pdf',
};

export const symplusService = new SymplusService();
