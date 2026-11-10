import { emailNotifications } from '@/modules/email/email.notifications';
import mongoose, { Types, type ClientSession, type QueryFilter } from 'mongoose';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import type { ListQuery } from '@/core/validation/common.schemas';
import { InvestmentPlanModel } from '@/modules/investment/investment.model';
import {
  buildCommissionSchedule,
  type CommissionTerms,
} from '@/modules/investment/investment.schedule';
import { platformConfigService } from '@/modules/platformConfig/platformConfig.service';
import { UserModel } from '@/modules/user/user.model';
import { WALLET_CURRENCY, WalletModel } from '@/modules/wallet/wallet.model';
import { walletService } from '@/modules/wallet/wallet.service';
import { WalletTransactionModel } from '@/modules/wallet/walletTransaction.model';
import { generateReferralCode } from '@/utils/referralCode';
import {
  ReferralCommissionModel,
  ReferralModel,
  type IReferral,
  type IReferralCommission,
  type ReferralSource,
} from './referral.model';
import type {
  CreateCommissionBody,
  CreateReferralBody,
  UpdateCommissionBody,
  UpdateReferralBody,
} from './referral.schemas';

const BASIS_POINTS = 10_000n;
const DUPLICATE_KEY_ERROR = 11000;
const MAX_CODE_ATTEMPTS = 5;
const TOP_REFERRERS = 10;
const SEARCH_USER_LIMIT = 200;

const STAFF_USER_FIELDS = 'name email referralCode isActive';

interface StaffUser {
  id: string;
  name: string;
  email: string;
  referralCode: string | null;
  isActive: boolean;
}

const invalidCode = () =>
  AppError.badRequest('That referral code is not valid', 'INVALID_REFERRAL_CODE');

const selfDealing = () =>
  AppError.forbidden('You cannot act on your own referral earnings', 'SELF_DEALING');

/** Referrers see only a first name: who they invited is theirs to know, but not the details. */
const firstName = (name: string | undefined): string =>
  name?.trim().split(/\s+/)[0] ?? 'Former customer';

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const buildReferralLink = (code: string): string => {
  const url = new URL(env.REFERRAL_SIGNUP_URL ?? `${env.CORS_ORIGINS[0]}/signup`);
  url.searchParams.set('ref', code);
  return url.toString();
};

export const calculateCommission = (investmentAmount: number, rateBasisPoints: number): number =>
  Number((BigInt(investmentAmount) * BigInt(rateBasisPoints)) / BASIS_POINTS);

const loadNames = async (ids: Types.ObjectId[]): Promise<Map<string, string>> => {
  const users = await UserModel.find({ _id: { $in: ids } })
    .select('name')
    .lean()
    .exec();
  return new Map(users.map((user) => [String(user._id), user.name]));
};

const loadStaffUsers = async (ids: (Types.ObjectId | null)[]): Promise<Map<string, StaffUser>> => {
  const users = await UserModel.find({ _id: { $in: ids.filter(Boolean) } })
    .select(STAFF_USER_FIELDS)
    .lean()
    .exec();
  return new Map(
    users.map((user) => [
      String(user._id),
      {
        id: String(user._id),
        name: user.name,
        email: user.email,
        referralCode: user.referralCode,
        isActive: user.isActive,
      },
    ]),
  );
};

/** Lets staff search by the name or email of either person, as well as by the code. */
const staffSearchFilter = async (search: string, extra: string[]) => {
  const pattern = new RegExp(escapeRegex(search), 'i');
  const users = await UserModel.find({ $or: [{ name: pattern }, { email: pattern }] })
    .select('_id')
    .limit(SEARCH_USER_LIMIT)
    .lean()
    .exec();
  const ids = users.map((user) => user._id);
  return {
    $or: [
      { referrer: { $in: ids } },
      { referee: { $in: ids } },
      ...extra.map((field) => ({ [field]: pattern })),
    ],
  };
};

class ReferralCommissionService extends BaseService<IReferralCommission> {
  constructor() {
    super(ReferralCommissionModel, { resourceName: 'Commission' });
  }
}

const commissionService = new ReferralCommissionService();

class ReferralService extends BaseService<IReferral> {
  constructor() {
    super(ReferralModel, { resourceName: 'Referral' });
  }

  // Codes.

  /** Accounts from before the programme have no code, so one is created when first needed. */
  async ensureCode(userId: string): Promise<string> {
    const user = await UserModel.findById(userId).select('referralCode').lean().exec();
    if (!user) throw AppError.notFound('User not found');
    if (user.referralCode) return user.referralCode;
    return this.assignCode(userId);
  }

  private async assignCode(userId: string, onlyIfMissing = true): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const code = generateReferralCode();
      try {
        const updated = await UserModel.findOneAndUpdate(
          { _id: userId, ...(onlyIfMissing && { referralCode: null }) },
          { referralCode: code },
          { returnDocument: 'after' },
        )
          .select('referralCode')
          .lean()
          .exec();
        if (updated?.referralCode) return updated.referralCode;
        // Another request gave this account a code first.
        return (await UserModel.findById(userId).select('referralCode').lean().orFail().exec())
          .referralCode as string;
      } catch (err) {
        if ((err as { code?: number }).code !== DUPLICATE_KEY_ERROR) throw err;
      }
    }
    throw AppError.internal('Could not generate a referral code');
  }

  /** The referrer a code belongs to. A closed account's code no longer works. */
  async resolveCode(code: string) {
    const referrer = await UserModel.findOne({ referralCode: code, isActive: true })
      .select('_id')
      .lean()
      .exec();
    if (!referrer) throw invalidCode();
    return { referrerId: String(referrer._id), code };
  }

  async assertCodeValid(code: string): Promise<void> {
    await this.resolveCode(code);
  }

  // Linking two people.

  private async assertCanLink(referrerId: string, refereeId: string): Promise<void> {
    if (referrerId === refereeId) {
      throw AppError.badRequest('You cannot use your own referral code', 'SELF_REFERRAL');
    }
    if (await ReferralModel.exists({ referee: refereeId })) {
      throw AppError.conflict('This account already has a referrer', 'ALREADY_REFERRED');
    }
    // Two people referring each other would let them earn from each other.
    if (await ReferralModel.exists({ referrer: refereeId, referee: referrerId })) {
      throw AppError.conflict('These two accounts cannot refer each other', 'CIRCULAR_REFERRAL');
    }
  }

  async link(
    referrerId: string,
    refereeId: string,
    code: string,
    source: ReferralSource,
    extra: { note?: string; createdBy?: string } = {},
  ) {
    await this.assertCanLink(referrerId, refereeId);
    return ReferralModel.create({
      referrer: referrerId,
      referee: refereeId,
      codeUsed: code,
      source,
      note: extra.note ?? null,
      createdBy: extra.createdBy ?? null,
    });
  }

  // The customer's own referral page.

  private async summarize(userId: string) {
    const id = new Types.ObjectId(userId);
    const [referrals, commissions] = await Promise.all([
      ReferralModel.aggregate<{ _id: string; count: number }>([
        { $match: { referrer: id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
      ReferralCommissionModel.aggregate<{ _id: string; amount: number }>([
        { $match: { referrer: id } },
        { $group: { _id: '$status', amount: { $sum: '$amount' } } },
      ]).exec(),
    ]);
    const countOf = (status: string) => referrals.find(({ _id }) => _id === status)?.count ?? 0;
    const amountOf = (status: string) => commissions.find(({ _id }) => _id === status)?.amount ?? 0;
    return {
      referrals: {
        total: referrals.reduce((sum, { count }) => sum + count, 0),
        pending: countOf('pending'),
        qualified: countOf('qualified'),
        rejected: countOf('rejected'),
      },
      earnings: {
        scheduled: amountOf('scheduled'),
        pending: amountOf('pending'),
        approved: amountOf('approved'),
        paid: amountOf('paid'),
        currency: WALLET_CURRENCY,
      },
    };
  }

  async getMyPage(userId: string) {
    const code = await this.ensureCode(userId);
    const [user, referral, summary, settings] = await Promise.all([
      UserModel.findById(userId).select('referralPromptPending').lean().orFail().exec(),
      ReferralModel.findOne({ referee: userId }).select('referrer createdAt').lean().exec(),
      this.summarize(userId),
      platformConfigService.walletSettings(),
    ]);
    const names = referral ? await loadNames([referral.referrer]) : new Map<string, string>();
    return {
      code,
      link: buildReferralLink(code),
      referredBy: referral && {
        name: firstName(names.get(String(referral.referrer))),
        at: referral.createdAt,
      },
      promptPending: user.referralPromptPending,
      ...summary,
      programme: {
        commissionBasisPoints: settings.referralCommissionBasisPoints,
        minInvestmentAmount: settings.referralMinInvestmentKobo,
        currency: WALLET_CURRENCY,
      },
    };
  }

  async listMine(userId: string, query: ListQuery) {
    const { items, meta } = await this.paginate(query, { referrer: userId });
    const names = await loadNames(items.map((item) => item.referee));
    return {
      meta,
      items: items.map((item) => ({
        id: item.id as string,
        name: firstName(names.get(String(item.referee))),
        status: item.status,
        joinedAt: item.createdAt,
        qualifiedAt: item.qualifiedAt,
      })),
    };
  }

  async listMyCommissions(userId: string, query: ListQuery) {
    const { items, meta } = await commissionService.paginate(query, { referrer: userId });
    const names = await loadNames(items.map((item) => item.referee));
    // Built by hand: the investment's amount and reference are the referee's business.
    return {
      meta,
      items: items.map((item) => ({
        id: item.id as string,
        name: firstName(names.get(String(item.referee))),
        amount: item.amount,
        currency: item.currency,
        status: item.status,
        instalment: item.instalment,
        instalments: item.instalments,
        dueAt: item.dueAt,
        createdAt: item.createdAt,
        paidAt: item.paidAt,
      })),
    };
  }

  /** The prompt shown after a Google signup. It can be answered once, so never after investing. */
  async applyCode(userId: string, code: string) {
    const user = await UserModel.findById(userId).select('referralPromptPending').orFail().exec();
    if (!user.referralPromptPending) {
      throw AppError.conflict('A referral code can no longer be added', 'REFERRAL_WINDOW_CLOSED');
    }
    const { referrerId } = await this.resolveCode(code);
    await this.link(referrerId, userId, code, 'google_prompt');
    user.referralPromptPending = false;
    await user.save();
    return this.getMyPage(userId);
  }

  async skipPrompt(userId: string) {
    await UserModel.updateOne({ _id: userId }, { referralPromptPending: false }).exec();
    return this.getMyPage(userId);
  }

  // Staff: referrals.

  private async describeReferrals(items: (IReferral & { toJSON(): object })[]) {
    const users = await loadStaffUsers(items.flatMap((item) => [item.referrer, item.referee]));
    return items.map((item) => ({
      ...item.toJSON(),
      referrer: users.get(String(item.referrer)) ?? null,
      referee: users.get(String(item.referee)) ?? null,
    }));
  }

  async listAll({ search, ...query }: ListQuery) {
    const scope: QueryFilter<IReferral> = search
      ? await staffSearchFilter(search, ['codeUsed'])
      : {};
    const { items, meta } = await this.paginate(query, scope);
    return { meta, items: await this.describeReferrals(items) };
  }

  async getDetails(id: string) {
    const referral = await this.findById(id);
    const [described] = await this.describeReferrals([referral]);
    const commissions = await ReferralCommissionModel.find({ referral: id }).sort('-createdAt');
    return { ...described, commissions };
  }

  async createByStaff({ referrer, referee, note }: CreateReferralBody, actorId: string) {
    if (referrer === actorId) throw selfDealing();
    const users = await UserModel.find({ _id: { $in: [referrer, referee] } })
      .select('_id')
      .lean()
      .exec();
    const found = users.map((user) => String(user._id));
    if (!found.includes(referrer) || !found.includes(referee)) {
      throw AppError.notFound('User not found');
    }

    const code = await this.ensureCode(referrer);
    const referral = await this.link(referrer, referee, code, 'admin', {
      note,
      createdBy: actorId,
    });
    await UserModel.updateOne({ _id: referee }, { referralPromptPending: false }).exec();
    return this.getDetails(referral.id);
  }

  /** Rejecting a referral cancels what it hasn't paid yet. What's been paid needs a person. */
  async updateByStaff(id: string, data: UpdateReferralBody, actorId: string) {
    const referral = await this.findById(id);
    if (String(referral.referrer) === actorId) throw selfDealing();

    referral.set(data);
    if (data.status === 'qualified' && !referral.qualifiedAt) referral.qualifiedAt = new Date();
    if (data.status === 'pending') referral.qualifiedAt = null;
    await referral.save();

    if (data.status === 'rejected') {
      await ReferralCommissionModel.updateMany(
        { referral: id, status: { $in: ['scheduled', 'pending', 'approved'] } },
        {
          status: 'rejected',
          rejectedBy: actorId,
          rejectedAt: new Date(),
          note: 'Its referral was rejected',
        },
      ).exec();
    }
    return this.getDetails(id);
  }

  /** Commissions are financial records, so a referral with live ones can only be rejected. */
  async removeByStaff(id: string) {
    await this.findById(id);
    const live = await ReferralCommissionModel.exists({
      referral: id,
      status: { $ne: 'rejected' },
    });
    if (live) {
      throw AppError.conflict(
        'This referral has commissions. Reject it instead',
        'REFERRAL_HAS_COMMISSIONS',
      );
    }
    await ReferralCommissionModel.deleteMany({ referral: id }).exec();
    await this.deleteById(id);
  }

  // Staff: commissions.

  private async describeCommissions(items: (IReferralCommission & { toJSON(): object })[]) {
    const users = await loadStaffUsers(items.flatMap((item) => [item.referrer, item.referee]));
    const plans = await InvestmentPlanModel.find({
      _id: { $in: items.map((item) => item.plan).filter(Boolean) },
    })
      .select('name')
      .lean()
      .exec();
    return items.map((item) => ({
      ...item.toJSON(),
      referrer: users.get(String(item.referrer)) ?? null,
      referee: users.get(String(item.referee)) ?? null,
      plan: item.plan
        ? { id: String(item.plan), name: plans.find((p) => p._id.equals(item.plan))?.name ?? null }
        : null,
    }));
  }

  private async describeCommission(id: string) {
    const [described] = await this.describeCommissions([await commissionService.findById(id)]);
    return described;
  }

  async listCommissions({ search, ...query }: ListQuery) {
    const scope: QueryFilter<IReferralCommission> = search
      ? await staffSearchFilter(search, ['investmentReference'])
      : {};
    const { items, meta } = await commissionService.paginate(query, scope);
    return { meta, items: await this.describeCommissions(items) };
  }

  getCommission(id: string) {
    return this.describeCommission(id);
  }

  /**
   * Records what an investment earned the person who referred its owner. Staff call this with their
   * id, and the commission is pending at once. The investment checkout calls it with none and a
   * `schedule`, which pays the commission again for each year of the investment's life. Nothing is
   * paid until a person approves it.
   */
  async recordInvestment(
    data: CreateCommissionBody,
    actorId: string | null = null,
    schedule?: { investment: string; startedAt: Date; terms: CommissionTerms },
  ) {
    const { referee, investmentReference, investmentAmount, plan, note } = data;

    const referral = await ReferralModel.findOne({ referee }).exec();
    if (!referral) throw AppError.notFound('This customer was not referred', 'NOT_REFERRED');
    if (String(referral.referrer) === actorId) throw selfDealing();
    if (referral.status === 'rejected') {
      throw AppError.conflict('This referral was rejected', 'REFERRAL_REJECTED');
    }
    if (plan && !(await InvestmentPlanModel.exists({ _id: plan }))) {
      throw AppError.notFound('Investment plan not found');
    }

    const settings = await platformConfigService.walletSettings();
    if (investmentAmount < settings.referralMinInvestmentKobo) {
      throw AppError.conflict(
        `Investments below ${settings.referralMinInvestmentKobo} kobo earn no commission`,
        'BELOW_MIN_INVESTMENT',
      );
    }

    const limit = settings.referralMaxCommissionedInvestments;
    if (limit > 0) {
      // One investment can have several instalments, but it only uses up one of the limit.
      const investments = await ReferralCommissionModel.aggregate<{ _id: unknown }>([
        { $match: { referral: referral._id, status: { $ne: 'rejected' } } },
        { $group: { _id: { $ifNull: ['$investment', '$_id'] } } },
      ]).exec();
      const earned = investments.length;
      if (earned >= limit) {
        throw AppError.conflict(
          'This referral has earned all the commissions it can',
          'COMMISSION_LIMIT_REACHED',
        );
      }
    }

    const rateBasisPoints = settings.referralCommissionBasisPoints;
    const amount = data.amount ?? calculateCommission(investmentAmount, rateBasisPoints);
    if (amount <= 0) {
      throw AppError.conflict(
        'The commission rate is not set, so this investment earns nothing',
        'COMMISSION_RATE_NOT_SET',
      );
    }
    if (amount > investmentAmount) {
      throw AppError.validation([
        { path: 'body.amount', message: 'A commission cannot be more than the investment' },
      ]);
    }

    const shared = {
      referral: referral.id,
      referrer: referral.referrer,
      referee,
      plan: plan ?? null,
      investmentAmount,
      rateBasisPoints,
      note: note ?? null,
      createdBy: actorId,
    };
    const [commission] = schedule
      ? await this.scheduleInstalments(shared, amount, investmentReference, schedule)
      : await ReferralCommissionModel.create([{ ...shared, investmentReference, amount }]);
    if (!commission) throw AppError.internal();

    if (referral.status === 'pending') {
      referral.status = 'qualified';
      referral.qualifiedAt = new Date();
      await referral.save();
    }
    return this.describeCommission(commission.id);
  }

  private scheduleInstalments(
    shared: Record<string, unknown>,
    perYear: number,
    investmentReference: string,
    {
      investment,
      startedAt,
      terms,
    }: { investment: string; startedAt: Date; terms: CommissionTerms },
  ) {
    const parts = buildCommissionSchedule(perYear, terms, startedAt);
    return ReferralCommissionModel.insertMany(
      parts.map(({ number, dueAt, amount }) => ({
        ...shared,
        investment,
        investmentReference: `${investmentReference}-Y${number}`,
        amount,
        instalment: number,
        instalments: parts.length,
        dueAt,
        status: 'scheduled',
      })),
    );
  }

  /** Scheduled commissions that have come due join the queue for staff to approve. */
  async releaseDue(asOf: Date = new Date()): Promise<number> {
    const { modifiedCount } = await ReferralCommissionModel.updateMany(
      { status: 'scheduled', dueAt: { $lte: asOf } },
      { status: 'pending' },
    ).exec();
    return modifiedCount;
  }

  /** The investment ended early, so what hasn't come due yet will never be earned. */
  async cancelUnearned(investment: string, session: ClientSession): Promise<void> {
    await ReferralCommissionModel.updateMany(
      { investment, status: 'scheduled', dueAt: { $gt: new Date() } },
      { status: 'cancelled', note: 'The investment was withdrawn early' },
      { session },
    ).exec();
  }

  private async findForAction(id: string, actorId: string) {
    const commission = await commissionService.findById(id);
    if (String(commission.referrer) === actorId) throw selfDealing();
    return commission;
  }

  async updateCommission(id: string, data: UpdateCommissionBody, actorId: string) {
    const commission = await this.findForAction(id, actorId);
    if (commission.status !== 'pending') {
      throw AppError.conflict('Only a pending commission can be edited', 'COMMISSION_LOCKED');
    }
    if (data.amount !== undefined && data.amount > commission.investmentAmount) {
      throw AppError.validation([
        { path: 'body.amount', message: 'A commission cannot be more than the investment' },
      ]);
    }
    commission.set(data);
    await commission.save();
    return this.describeCommission(id);
  }

  /** Each move is one atomic update on the expected status, so two people can't both make it. */
  private async moveCommission(
    id: string,
    from: IReferralCommission['status'][],
    update: Partial<IReferralCommission>,
  ) {
    const moved = await ReferralCommissionModel.findOneAndUpdate(
      { _id: id, status: { $in: from } },
      update,
      { returnDocument: 'after' },
    ).exec();
    if (!moved) {
      throw AppError.conflict(
        `Only a commission that is ${from.join(' or ')} can do this`,
        'INVALID_COMMISSION_STATUS',
      );
    }
    return this.describeCommission(id);
  }

  async approveCommission(id: string, actorId: string) {
    await this.findForAction(id, actorId);
    return this.moveCommission(id, ['pending'], {
      status: 'approved',
      approvedBy: new Types.ObjectId(actorId),
      approvedAt: new Date(),
    });
  }

  async rejectCommission(id: string, note: string, actorId: string) {
    await this.findForAction(id, actorId);
    return this.moveCommission(id, ['scheduled', 'pending', 'approved'], {
      status: 'rejected',
      note,
      rejectedBy: new Types.ObjectId(actorId),
      rejectedAt: new Date(),
    });
  }

  /**
   * Credits the referrer's wallet. All of it happens or none does, and the status check inside the
   * transaction means two concurrent payouts can't both pay. The wallet reference is unique too.
   */
  async payCommission(id: string, actorId: string) {
    const commission = await this.findForAction(id, actorId);
    if (commission.status !== 'approved') {
      throw AppError.conflict(
        'Only an approved commission can be paid',
        'INVALID_COMMISSION_STATUS',
      );
    }

    const referrerId = String(commission.referrer);
    const referrer = await UserModel.findById(referrerId).select('isActive').lean().exec();
    if (!referrer?.isActive) {
      throw AppError.conflict('The referrer no longer has an active account', 'REFERRER_INACTIVE');
    }

    const wallet = await walletService.getOrCreateForUser(referrerId);
    const walletReference = `CCR-${id}`;

    await mongoose.connection.transaction(async (session) => {
      const now = new Date();
      const paid = await ReferralCommissionModel.findOneAndUpdate(
        { _id: id, status: 'approved' },
        { status: 'paid', paidBy: actorId, paidAt: now, walletReference },
        { session, returnDocument: 'after' },
      ).exec();
      if (!paid) {
        throw AppError.conflict(
          'Only an approved commission can be paid',
          'INVALID_COMMISSION_STATUS',
        );
      }

      const credited = await WalletModel.findByIdAndUpdate(
        wallet.id,
        { $inc: { balance: paid.amount } },
        { session, returnDocument: 'after' },
      )
        .orFail()
        .exec();

      await WalletTransactionModel.create(
        [
          {
            user: referrerId,
            wallet: wallet.id,
            reference: walletReference,
            type: 'referral_commission',
            provider: 'internal',
            amount: paid.amount,
            currency: paid.currency,
            status: 'success',
            paidAt: now,
            settledAt: now,
            balanceAfter: credited.balance,
          },
        ],
        { session },
      );
    });

    logger.info({ actorId, commissionId: id }, 'Referral commission paid');
    await emailNotifications.commissionPaid({
      userId: referrerId,
      amount: commission.amount,
      currency: commission.currency,
    });
    return this.describeCommission(id);
  }

  /** What's approved or paid stays on the record. Reject an approved one first. */
  async removeCommission(id: string) {
    const commission = await commissionService.findById(id);
    if (!['pending', 'rejected'].includes(commission.status)) {
      throw AppError.conflict(
        'Only a pending or rejected commission can be deleted',
        'COMMISSION_LOCKED',
      );
    }
    await commission.deleteOne();
  }

  // Staff: people and the programme.

  async getUserSummary(userId: string) {
    const code = await this.ensureCode(userId);
    const [referral, summary] = await Promise.all([
      ReferralModel.findOne({ referee: userId }).exec(),
      this.summarize(userId),
    ]);
    return {
      code,
      link: buildReferralLink(code),
      referredBy: referral ? (await this.describeReferrals([referral]))[0] : null,
      ...summary,
    };
  }

  /** Old links stop working, as the previous code is no longer anyone's. */
  async setCode(userId: string, code?: string) {
    if (!(await UserModel.exists({ _id: userId }))) throw AppError.notFound('User not found');
    if (!code) await this.assignCode(userId, false);
    else {
      const taken = await UserModel.exists({ referralCode: code, _id: { $ne: userId } });
      if (taken) throw AppError.conflict('That code is already in use', 'REFERRAL_CODE_TAKEN');
      await UserModel.updateOne({ _id: userId }, { referralCode: code }).exec();
    }
    return this.getUserSummary(userId);
  }

  async getStats() {
    const [referrals, commissions, top, settings] = await Promise.all([
      ReferralModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
      ReferralCommissionModel.aggregate<{ _id: string; count: number; amount: number }>([
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      ]).exec(),
      ReferralModel.aggregate<{ _id: Types.ObjectId; referrals: number; qualified: number }>([
        { $match: { status: { $ne: 'rejected' } } },
        {
          $group: {
            _id: '$referrer',
            referrals: { $sum: 1 },
            qualified: { $sum: { $cond: [{ $eq: ['$status', 'qualified'] }, 1, 0] } },
          },
        },
        { $sort: { referrals: -1, _id: 1 } },
        { $limit: TOP_REFERRERS },
      ]).exec(),
      platformConfigService.walletSettings(),
    ]);
    const users = await loadStaffUsers(top.map(({ _id }) => _id));
    return {
      referrals: Object.fromEntries(referrals.map(({ _id, count }) => [_id, count])),
      commissions: Object.fromEntries(
        commissions.map(({ _id, count, amount }) => [_id, { count, amount }]),
      ),
      currency: WALLET_CURRENCY,
      topReferrers: top.map(({ _id, referrals: total, qualified }) => ({
        user: users.get(String(_id)) ?? null,
        referrals: total,
        qualified,
      })),
      settings: {
        commissionBasisPoints: settings.referralCommissionBasisPoints,
        minInvestmentAmount: settings.referralMinInvestmentKobo,
        maxCommissionedInvestments: settings.referralMaxCommissionedInvestments,
      },
    };
  }
}

export const referralService = new ReferralService();
