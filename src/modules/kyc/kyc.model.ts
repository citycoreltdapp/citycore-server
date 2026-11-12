import { model, Schema, Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';
import type { CompanyType } from '@/integrations/dojah/dojah.client';
import { addressSchema, type IAddress } from '@/modules/user/user.model';

export const KYC_STATUSES = ['draft', 'in_review', 'approved', 'rejected'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const LOCKED_KYC_STATUSES: readonly KycStatus[] = ['in_review', 'approved'];

export const COMPANY_TYPES = [
  'limited',
  'businessName',
  'trustees',
  'limitedPartnership',
  'llp',
] as const satisfies readonly CompanyType[];

export const ID_TYPES = ['nin', 'bvn'] as const;
export type IdType = (typeof ID_TYPES)[number];

export interface IKycIdentity {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  gender: 'male' | 'female' | null;
  phone: string | null;
}

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

export interface IKycAffiliate {
  fullName: string;
  role: string;
}

export interface IKycBusiness {
  companyType: CompanyType;
  registrationNumber: string;
  companyName: string;
  registeredOn: Date | null;
  registeredAddress: string | null;
  affiliates: IKycAffiliate[];
  tin: string | null;
  tinFromRegistry: boolean;
  email: string | null;
  phone: string | null;
  operatingAddress: IAddress | null;
  verifiedAt: Date;
  detailsCompletedAt: Date | null;
}

export interface IKycSignatory {
  fullName: string;
  role: string;
  onCacRecord: boolean;
  idType: IdType;
  idLast4: string;
  verifiedName: string;
  verifiedAt: Date;
}

export interface IKycPayout {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  verifiedAt: Date;
}

export interface IKycVerification {
  user: Types.ObjectId;
  status: KycStatus;
  ninEncrypted: string | null;
  ninHash: string | null;
  ninLast4: string | null;
  ninVerifiedAt: Date | null;
  ninLookups: number;
  identity: IKycIdentity | null;
  details: IKycDetails | null;
  detailsCompletedAt: Date | null;
  business: IKycBusiness | null;
  businessLookups: number;
  signatory: IKycSignatory | null;
  signatoryIdEncrypted: string | null;
  payout: IKycPayout | null;
  selfie: IKycFile | null;
  utilityBill: IKycFile | null;
  authorisationLetter: IKycFile | null;
  companyLogo: IKycFile | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  rejectionReason: string | null;
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

const affiliateSchema = new Schema<IKycAffiliate>(
  {
    fullName: { type: String, required: true },
    role: { type: String, required: true },
  },
  { _id: false },
);

const businessSchema = new Schema<IKycBusiness>(
  {
    companyType: { type: String, enum: COMPANY_TYPES, required: true },
    registrationNumber: { type: String, required: true },
    companyName: { type: String, required: true },
    registeredOn: { type: Date, default: null },
    registeredAddress: { type: String, default: null },
    affiliates: { type: [affiliateSchema], default: [] },
    tin: { type: String, default: null },
    tinFromRegistry: { type: Boolean, default: false },
    email: { type: String, default: null },
    phone: { type: String, default: null },
    operatingAddress: { type: addressSchema, default: null },
    verifiedAt: { type: Date, required: true },
    detailsCompletedAt: { type: Date, default: null },
  },
  { _id: false },
);

const signatorySchema = new Schema<IKycSignatory>(
  {
    fullName: { type: String, required: true },
    role: { type: String, required: true },
    onCacRecord: { type: Boolean, default: true },
    idType: { type: String, enum: ID_TYPES, required: true },
    idLast4: { type: String, required: true },
    verifiedName: { type: String, required: true },
    verifiedAt: { type: Date, required: true },
  },
  { _id: false },
);

const payoutSchema = new Schema<IKycPayout>(
  {
    bankCode: { type: String, required: true },
    bankName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
    verifiedAt: { type: Date, required: true },
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
    business: { type: businessSchema, default: null },
    businessLookups: { type: Number, default: 0 },
    signatory: { type: signatorySchema, default: null },
    signatoryIdEncrypted: { type: String, default: null, select: false },
    payout: { type: payoutSchema, default: null },
    selfie: { type: fileSchema, default: null },
    utilityBill: { type: fileSchema, default: null },
    authorisationLetter: { type: fileSchema, default: null },
    companyLogo: { type: fileSchema, default: null },
    submittedAt: { type: Date, default: null, index: true },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: null },
    reviewNote: { type: String, default: null },
  },
  { hiddenFields: ['ninEncrypted', 'ninHash', 'signatoryIdEncrypted'] },
);

kycSchema.index(
  { ninHash: 1 },
  { unique: true, partialFilterExpression: { ninHash: { $type: 'string' } } },
);

export const KycVerificationModel = model<IKycVerification>('KycVerification', kycSchema);
