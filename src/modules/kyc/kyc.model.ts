import { model, Schema, Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';
import type { IAddress } from '@/modules/user/user.model';

/**
 * `draft` while the customer works through the steps, `in_review` once submitted, then `approved`
 * or `rejected` by a reviewer. A rejected one goes back to being editable, and can be resubmitted.
 */
export const KYC_STATUSES = ['draft', 'in_review', 'approved', 'rejected'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

/** Statuses in which the customer can't change anything. */
export const LOCKED_KYC_STATUSES: readonly KycStatus[] = ['in_review', 'approved'];

/** What NIMC holds for the NIN, as Dojah returned it. Customers can't edit it. */
export interface IKycIdentity {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  gender: 'male' | 'female' | null;
  phone: string | null;
}

/** What the customer confirmed or filled in on the details step. */
export interface IKycDetails {
  phone: string;
  gender: 'male' | 'female';
  dateOfBirth: Date;
  address: IAddress;
  occupation: string | null;
}

export interface IKycFile {
  url: string;
  mimeType: string;
  uploadedAt: Date;
}

export interface IKycVerification {
  user: Types.ObjectId;
  status: KycStatus;
  /** Encrypted with DATA_ENCRYPTION_KEY. Never sent to the customer, and only to some staff. */
  ninEncrypted: string | null;
  /** A keyed hash, so a NIN can be found without decrypting every record. */
  ninHash: string | null;
  ninLast4: string | null;
  ninVerifiedAt: Date | null;
  /** How many times Dojah has been asked, as each lookup is billed. */
  ninLookups: number;
  identity: IKycIdentity | null;
  details: IKycDetails | null;
  detailsCompletedAt: Date | null;
  passportPhoto: IKycFile | null;
  utilityBill: IKycFile | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  /** Shown to the customer when rejected. */
  rejectionReason: string | null;
  /** For staff only. */
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const identitySchema = new Schema<IKycIdentity>(
  {
    firstName: { type: String, default: null },
    middleName: { type: String, default: null },
    lastName: { type: String, default: null },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: ['male', 'female', null], default: null },
    phone: { type: String, default: null },
  },
  { _id: false },
);

const addressSchema = new Schema<IAddress>(
  {
    line1: { type: String, required: true, trim: true },
    line2: { type: String, default: null, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    country: { type: String, required: true, uppercase: true },
    postalCode: { type: String, default: null, trim: true },
  },
  { _id: false },
);

const detailsSchema = new Schema<IKycDetails>(
  {
    phone: { type: String, required: true },
    gender: { type: String, enum: ['male', 'female'], required: true },
    dateOfBirth: { type: Date, required: true },
    address: { type: addressSchema, required: true },
    occupation: { type: String, default: null, trim: true },
  },
  { _id: false },
);

const fileSchema = new Schema<IKycFile>(
  {
    url: { type: String, required: true },
    mimeType: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const kycSchema = createSchema<IKycVerification>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    status: { type: String, enum: KYC_STATUSES, default: 'draft', index: true },
    ninEncrypted: { type: String, default: null, select: false },
    ninHash: { type: String, default: null, select: false },
    ninLast4: { type: String, default: null },
    ninVerifiedAt: { type: Date, default: null },
    ninLookups: { type: Number, default: 0 },
    identity: { type: identitySchema, default: null },
    details: { type: detailsSchema, default: null },
    detailsCompletedAt: { type: Date, default: null },
    passportPhoto: { type: fileSchema, default: null },
    utilityBill: { type: fileSchema, default: null },
    submittedAt: { type: Date, default: null, index: true },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: null },
    reviewNote: { type: String, default: null },
  },
  { hiddenFields: ['ninEncrypted', 'ninHash'] },
);

// One NIN verifies one account. Most records have none until the first step, hence the filter.
kycSchema.index(
  { ninHash: 1 },
  { unique: true, partialFilterExpression: { ninHash: { $type: 'string' } } },
);

export const KycVerificationModel = model<IKycVerification>('KycVerification', kycSchema);
