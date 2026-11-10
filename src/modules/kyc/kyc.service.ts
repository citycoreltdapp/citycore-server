import { createHmac } from 'node:crypto';
import type { HydratedDocument, QueryFilter } from 'mongoose';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { HttpStatus } from '@/constants/http';
import { AppError } from '@/core/errors/AppError';
import { cloudinaryStorage } from '@/integrations/cloudinary/cloudinary.client';
import { dojahApi, dojahDisabled } from '@/integrations/dojah/dojah.client';
import { emailNotifications } from '@/modules/email/email.notifications';
import { UserModel, type IUser } from '@/modules/user/user.model';
import { userService } from '@/modules/user/user.service';
import { decrypt, encrypt } from '@/utils/encryption';
import {
  KycVerificationModel,
  LOCKED_KYC_STATUSES,
  type IKycFile,
  type IKycVerification,
} from './kyc.model';
import type { DetailsBody, ListVerificationsQuery } from './kyc.schemas';

export const KYC_STEPS = [
  'verify_nin',
  'personal_details',
  'upload_documents',
  'submit',
  'await_review',
  'complete',
] as const;
export type KycStep = (typeof KYC_STEPS)[number];

export type KycDocumentKind = 'passportPhoto' | 'utilityBill';

const MIN_AGE_YEARS = 18;
const DUPLICATE_KEY = 11000;

type KycDocument = HydratedDocument<IKycVerification>;

const hashNin = (nin: string): string => {
  if (!env.DATA_ENCRYPTION_KEY) throw dojahDisabled();
  return createHmac('sha256', Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64'))
    .update(`nin:${nin}`)
    .digest('hex');
};

const ninInUse = () =>
  AppError.conflict('This NIN is already linked to another account', 'NIN_IN_USE');

const isDuplicateKey = (err: unknown): boolean =>
  (err as { code?: number } | null)?.code === DUPLICATE_KEY;

const ageOn = (birth: Date, today: Date): number => {
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < birth.getUTCMonth() ||
    (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
};

const legalName = (kyc: KycDocument): string | null => {
  const parts = [kyc.identity?.firstName, kyc.identity?.middleName, kyc.identity?.lastName].filter(
    (part): part is string => !!part,
  );
  const name = parts.join(' ').slice(0, 100);
  return name.length >= 2 ? name : null;
};

const fileView = (file: IKycFile | null | undefined) =>
  file ? { url: file.url, mimeType: file.mimeType, uploadedAt: file.uploadedAt } : null;

const nextStep = (kyc: KycDocument | null, user: HydratedDocument<IUser>): KycStep => {
  if (user.kycCompleted || kyc?.status === 'approved') return 'complete';
  if (kyc?.status === 'in_review') return 'await_review';
  if (!kyc?.ninVerifiedAt) return 'verify_nin';
  if (!kyc.detailsCompletedAt) return 'personal_details';
  if (!kyc.passportPhoto || !kyc.utilityBill) return 'upload_documents';
  return 'submit';
};

/** What the customer sees. Staff notes and who reviewed it stay out. */
const customerView = (kyc: KycDocument | null, user: HydratedDocument<IUser>) => {
  const step = nextStep(kyc, user);
  const identity = kyc?.identity ?? null;
  const details = kyc?.details ?? null;

  return {
    /** False while Dojah is switched off, so a frontend can hide or disable the verify button. */
    available: env.DOJAH_ENABLED,
    status: kyc?.status ?? 'not_started',
    nextStep: step,
    /** Whether the customer can still change anything. */
    editable: !kyc || !LOCKED_KYC_STATUSES.includes(kyc.status),
    emailVerified: user.emailVerified,
    kycCompleted: user.kycCompleted,
    kycCompletedAt: user.kycCompletedAt,
    nin: {
      verified: !!kyc?.ninVerifiedAt,
      last4: kyc?.ninLast4 ?? null,
      verifiedAt: kyc?.ninVerifiedAt ?? null,
      lookupsRemaining: Math.max(0, env.KYC_MAX_NIN_LOOKUPS - (kyc?.ninLookups ?? 0)),
    },
    /** From the NIN record. Read only. */
    identity,
    details,
    /**
     * Values for the details form: what's been saved, else the NIN record, else the profile. Fields
     * set by the NIN record are `locked`, so the form should show them but not let them change.
     */
    prefill: {
      firstName: identity?.firstName ?? null,
      middleName: identity?.middleName ?? null,
      lastName: identity?.lastName ?? null,
      dateOfBirth: identity?.dateOfBirth ?? details?.dateOfBirth ?? user.dateOfBirth ?? null,
      gender:
        identity?.gender ??
        details?.gender ??
        (user.gender === 'male' || user.gender === 'female' ? user.gender : null),
      phone: details?.phone ?? user.phone ?? identity?.phone ?? null,
      address: details?.address ?? user.address ?? null,
      occupation: details?.occupation ?? user.occupation ?? null,
      locked: {
        firstName: !!identity?.firstName,
        middleName: !!identity,
        lastName: !!identity?.lastName,
        dateOfBirth: !!identity?.dateOfBirth,
        gender: !!identity?.gender,
      },
    },
    documents: {
      passportPhoto: fileView(kyc?.passportPhoto),
      utilityBill: fileView(kyc?.utilityBill),
    },
    submittedAt: kyc?.submittedAt ?? null,
    reviewedAt: kyc?.reviewedAt ?? null,
    rejectionReason: kyc?.status === 'rejected' ? kyc.rejectionReason : null,
  };
};

const assertEditable = (kyc: KycDocument): void => {
  if (kyc.status === 'in_review') {
    throw AppError.conflict('Your verification is being reviewed', 'KYC_IN_REVIEW');
  }
  if (kyc.status === 'approved') {
    throw AppError.conflict('Your identity is already verified', 'KYC_ALREADY_APPROVED');
  }
};

const assertCanStart = (user: HydratedDocument<IUser>): void => {
  if (!user.emailVerified) {
    throw AppError.forbidden('Verify your email address first', 'EMAIL_NOT_VERIFIED');
  }
  if (user.kycCompleted) {
    throw AppError.conflict('Your identity is already verified', 'KYC_ALREADY_APPROVED');
  }
};

const findForUser = (userId: string) => KycVerificationModel.findOne({ user: userId }).exec();

const findOrCreateForUser = async (userId: string): Promise<KycDocument> =>
  (await KycVerificationModel.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, returnDocument: 'after' },
  ).exec()) as KycDocument;

/** Loads the user and their record for a change, after checking that a change is allowed. */
const loadForChange = async (userId: string) => {
  const user = await userService.findById(userId);
  assertCanStart(user);
  const kyc = await findOrCreateForUser(userId);
  assertEditable(kyc);
  return { user, kyc };
};

export const kycService = {
  async getState(userId: string) {
    const [user, kyc] = await Promise.all([userService.findById(userId), findForUser(userId)]);
    return customerView(kyc, user);
  },

  /**
   * Step 1. Checks the NIN with Dojah and keeps what NIMC holds for it. Profile fields that are
   * still empty are filled from it straight away, and the rest comes back as `prefill`.
   */
  async verifyNin(userId: string, nin: string) {
    if (!env.DOJAH_ENABLED) throw dojahDisabled();
    const { user, kyc } = await loadForChange(userId);

    const ninHash = hashNin(nin);
    const current = await KycVerificationModel.findById(kyc.id).select('+ninHash').lean().exec();
    // The same NIN again needs no second, billed lookup.
    if (current?.ninHash === ninHash && kyc.ninVerifiedAt) return customerView(kyc, user);

    if (await KycVerificationModel.exists({ ninHash, user: { $ne: user._id } })) throw ninInUse();

    // Counted before the call, so concurrent requests can't get past the limit.
    const counted = await KycVerificationModel.updateOne(
      { _id: kyc._id, ninLookups: { $lt: env.KYC_MAX_NIN_LOOKUPS } },
      { $inc: { ninLookups: 1 } },
    ).exec();
    if (counted.modifiedCount === 0) {
      throw new AppError(
        'You have tried too many NINs. Contact support to continue',
        HttpStatus.TOO_MANY_REQUESTS,
        'NIN_LOOKUP_LIMIT',
      );
    }
    kyc.ninLookups += 1;

    const identity = await dojahApi.lookupNin(nin);

    kyc.set({
      ninEncrypted: encrypt(nin),
      ninHash,
      ninLast4: nin.slice(-4),
      ninVerifiedAt: new Date(),
      identity: {
        firstName: identity.firstName,
        middleName: identity.middleName,
        lastName: identity.lastName,
        dateOfBirth: identity.dateOfBirth,
        gender: identity.gender,
        phone: identity.phone,
      },
      // A different person's NIN, so details confirmed against the old one must be confirmed again.
      details: null,
      detailsCompletedAt: null,
    });
    try {
      await kyc.save();
    } catch (err) {
      if (isDuplicateKey(err)) throw ninInUse();
      throw err;
    }

    // Only empty fields, so nothing the customer typed is overwritten.
    if (!user.phone && identity.phone) user.phone = identity.phone;
    if (!user.dateOfBirth && identity.dateOfBirth) user.dateOfBirth = identity.dateOfBirth;
    if (!user.gender && identity.gender) user.gender = identity.gender;
    if (user.isModified()) await user.save();

    logger.info({ userId }, 'Customer verified their NIN');
    return customerView(kyc, user);
  },

  /** Step 2. The customer confirms the NIN's details and adds what it doesn't have. */
  async saveDetails(userId: string, body: DetailsBody) {
    const { user, kyc } = await loadForChange(userId);
    if (!kyc.ninVerifiedAt || !kyc.identity) {
      throw AppError.conflict('Verify your NIN first', 'NIN_NOT_VERIFIED');
    }

    const gender = kyc.identity.gender ?? body.gender;
    const dateOfBirth = kyc.identity.dateOfBirth ?? body.dateOfBirth;
    const missing = [
      !gender && { path: 'body.gender', message: 'Gender is required' },
      !dateOfBirth && { path: 'body.dateOfBirth', message: 'Date of birth is required' },
    ].filter((detail): detail is { path: string; message: string } => !!detail);
    if (missing.length > 0 || !gender || !dateOfBirth) throw AppError.validation(missing);

    if (ageOn(dateOfBirth, new Date()) < MIN_AGE_YEARS) {
      throw AppError.forbidden(`You must be at least ${MIN_AGE_YEARS} years old`, 'UNDERAGE');
    }

    kyc.details = {
      phone: body.phone,
      gender,
      dateOfBirth,
      address: { ...body.address, line2: body.address.line2 ?? null },
      occupation: body.occupation ?? null,
    };
    kyc.detailsCompletedAt = new Date();
    await kyc.save();

    // What the customer confirmed becomes their profile, with their legal name from the NIN.
    user.set({
      name: legalName(kyc) ?? user.name,
      phone: body.phone,
      gender,
      dateOfBirth,
      address: kyc.details.address,
      ...(body.occupation !== undefined && { occupation: body.occupation }),
    });
    await user.save();

    return customerView(kyc, user);
  },

  /**
   * Runs before an upload is stored, so a file that would be refused never reaches storage.
   * Throws the same errors that the upload itself would.
   */
  async assertCanUpload(userId: string): Promise<void> {
    const { kyc } = await loadForChange(userId);
    if (!kyc.detailsCompletedAt) {
      throw AppError.conflict('Confirm your personal details first', 'DETAILS_REQUIRED');
    }
  },

  /**
   * Step 3. Stores a passport photograph or utility bill. The passport photograph also becomes the
   * customer's avatar. A replaced file is deleted, unless it's still the avatar.
   */
  async saveDocument(
    userId: string,
    kind: KycDocumentKind,
    file: { url: string; mimetype: string },
  ) {
    await this.assertCanUpload(userId);
    const kyc = (await findForUser(userId)) as KycDocument;

    const previous = kyc[kind]?.url ?? null;
    kyc[kind] = { url: file.url, mimeType: file.mimetype, uploadedAt: new Date() };
    await kyc.save();

    const user =
      kind === 'passportPhoto'
        ? await userService.replaceAvatar(userId, file.url)
        : await userService.findById(userId);

    if (previous && previous !== file.url && previous !== user.avatar) {
      await cloudinaryStorage.remove(previous);
    }
    return customerView(kyc, user);
  },

  /** Step 4. Hands everything to a reviewer. Nothing can change until they decide. */
  async submit(userId: string) {
    const { user, kyc } = await loadForChange(userId);
    const step = nextStep(kyc, user);
    if (step !== 'submit') {
      throw AppError.conflict('Finish every step before submitting', 'KYC_INCOMPLETE');
    }

    const updated = await KycVerificationModel.findOneAndUpdate(
      { _id: kyc._id, status: { $in: ['draft', 'rejected'] } },
      {
        $set: {
          status: 'in_review',
          submittedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          rejectionReason: null,
          reviewNote: null,
        },
      },
      { returnDocument: 'after' },
    ).exec();
    if (!updated) throw AppError.conflict('Your verification is being reviewed', 'KYC_IN_REVIEW');

    logger.info({ userId }, 'Customer submitted KYC for review');
    await emailNotifications.kycSubmitted({ userId });
    return customerView(updated, user);
  },

  // Staff

  async list({ page, limit, sort, search, status, user }: ListVerificationsQuery) {
    const filter: QueryFilter<IKycVerification> = {
      ...(status && { status }),
      ...(user && { user }),
    };
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const users = await UserModel.find({ $or: [{ name: pattern }, { email: pattern }] })
        .select('_id')
        .limit(1000)
        .lean()
        .exec();
      filter.user = user
        ? users.some((match) => String(match._id) === user)
          ? user
          : { $in: [] }
        : { $in: users.map((match) => match._id) };
    }

    const [items, total] = await Promise.all([
      KycVerificationModel.find(filter)
        .sort(`${sort.replaceAll(',', ' ')} _id`)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('user', 'name email avatar phone')
        .populate('reviewedBy', 'name email')
        .exec(),
      KycVerificationModel.countDocuments(filter).exec(),
    ]);
    const totalPages = Math.ceil(total / limit);
    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  },

  /** The whole record, with the full NIN, for a reviewer to compare against the documents. */
  async getForReview(id: string) {
    const kyc = await KycVerificationModel.findById(id)
      .select('+ninEncrypted')
      .populate('user', 'name email avatar phone dateOfBirth gender address emailVerified')
      .populate('reviewedBy', 'name email')
      .exec();
    if (!kyc) throw AppError.notFound('Verification not found');

    let nin: string | null = null;
    try {
      nin = kyc.ninEncrypted ? decrypt(kyc.ninEncrypted) : null;
    } catch (err) {
      logger.error({ err, kycId: id }, 'Could not decrypt a stored NIN');
    }
    return { ...kyc.toJSON(), nin };
  },

  async approve(actorId: string, id: string, note?: string) {
    const kyc = await this.claimForReview(actorId, id, {
      status: 'approved',
      reviewNote: note ?? null,
      rejectionReason: null,
    });
    await UserModel.updateOne(
      { _id: kyc.user },
      { $set: { kycCompleted: true, kycCompletedAt: kyc.reviewedAt } },
    ).exec();
    logger.info({ actorId, kycId: id, userId: String(kyc.user) }, 'KYC approved');
    await emailNotifications.kycApproved({ userId: String(kyc.user) });
    return this.getForReview(id);
  },

  async reject(actorId: string, id: string, reason: string, note?: string) {
    const kyc = await this.claimForReview(actorId, id, {
      status: 'rejected',
      rejectionReason: reason,
      reviewNote: note ?? null,
    });
    logger.info({ actorId, kycId: id, userId: String(kyc.user) }, 'KYC rejected');
    await emailNotifications.kycRejected({ userId: String(kyc.user), reason });
    return this.getForReview(id);
  },

  /** Records a decision, once. Two reviewers deciding at the same moment can't both succeed. */
  async claimForReview(
    actorId: string,
    id: string,
    decision: Pick<IKycVerification, 'status' | 'rejectionReason' | 'reviewNote'>,
  ) {
    const existing = await KycVerificationModel.findById(id).select('user status').lean().exec();
    if (!existing) throw AppError.notFound('Verification not found');
    if (String(existing.user) === actorId) {
      throw AppError.forbidden('You cannot review your own verification', 'SELF_REVIEW');
    }

    const kyc = await KycVerificationModel.findOneAndUpdate(
      { _id: id, status: 'in_review' },
      { $set: { ...decision, reviewedAt: new Date(), reviewedBy: actorId } },
      { returnDocument: 'after' },
    ).exec();
    if (!kyc) {
      throw AppError.conflict('This verification is not waiting for review', 'KYC_NOT_IN_REVIEW');
    }
    return kyc;
  },
};
