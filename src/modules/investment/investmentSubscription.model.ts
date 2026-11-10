import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';
import {
  DURATION_UNITS,
  PAYOUT_FREQUENCIES,
  planLocationSchema,
  RISK_LEVELS,
  ROI_TYPES,
  type IInvestmentPlan,
} from './investment.model';

export const SUBSCRIPTION_STATUSES = ['active', 'matured', 'withdrawn'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type PlanSnapshot = Pick<
  IInvestmentPlan,
  | 'name'
  | 'slug'
  | 'riskLevel'
  | 'roiBasisPoints'
  | 'roiType'
  | 'payoutFrequency'
  | 'durationValue'
  | 'durationUnit'
  | 'earlyWithdrawalAllowed'
  | 'earlyWithdrawalPenaltyBasisPoints'
  | 'terms'
  | 'thumbnail'
  | 'assetType'
  | 'assetSubtype'
  | 'location'
  | 'roiGuaranteed'
  | 'unitPrice'
>;

export interface ISubscriptionPayout {
  number: number;
  dueAt: Date;
  /** In kobo. */
  amount: number;
  paidAt: Date | null;
}

export interface IInvestmentSubscription {
  user: Types.ObjectId;
  wallet: Types.ObjectId;
  plan: Types.ObjectId;
  /** The terms the customer agreed to. Later edits to the plan don't change them. */
  planSnapshot: PlanSnapshot;
  /** Unique per user, so that a retried request can't invest twice. */
  idempotencyKey: string;
  /** The principal, in kobo. */
  amount: number;
  /** How many units this bought. Null on a plan not sold in units. */
  units: number | null;
  currency: string;
  /** The whole return if held to maturity, in kobo. */
  expectedReturn: number;
  returnPaid: number;
  payouts: ISubscriptionPayout[];
  /** Null once nothing more will be paid. */
  nextPayoutAt: Date | null;
  status: SubscriptionStatus;
  startedAt: Date;
  maturesAt: Date;
  /** When the principal went back to the wallet. */
  settledAt: Date | null;
  principalReturned: number;
  earlyWithdrawalPenalty: number;
  /** The return given up by withdrawing early. */
  returnForfeited: number;
  termsAcceptedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const planSnapshotSchema = new Schema<PlanSnapshot>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true },
    riskLevel: { type: String, enum: RISK_LEVELS, required: true },
    roiBasisPoints: { type: Number, required: true },
    roiType: { type: String, enum: ROI_TYPES, required: true },
    payoutFrequency: { type: String, enum: PAYOUT_FREQUENCIES, required: true },
    durationValue: { type: Number, required: true },
    durationUnit: { type: String, enum: DURATION_UNITS, required: true },
    earlyWithdrawalAllowed: { type: Boolean, required: true },
    earlyWithdrawalPenaltyBasisPoints: { type: Number, required: true },
    terms: { type: String, default: '' },
    thumbnail: { type: String, default: null },
    assetType: { type: String, default: null },
    assetSubtype: { type: String, default: null },
    location: { type: planLocationSchema, default: null },
    roiGuaranteed: { type: Boolean, default: false },
    unitPrice: { type: Number, default: null },
  },
  { _id: false },
);

const payoutSchema = new Schema<ISubscriptionPayout>(
  {
    number: { type: Number, required: true },
    dueAt: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    paidAt: { type: Date, default: null },
  },
  { _id: false },
);

const subscriptionSchema = createSchema<IInvestmentSubscription>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    wallet: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    plan: { type: Schema.Types.ObjectId, ref: 'InvestmentPlan', required: true, index: true },
    planSnapshot: { type: planSnapshotSchema, required: true },
    idempotencyKey: { type: String, required: true },
    amount: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    units: { type: Number, default: null, min: 1 },
    currency: { type: String, required: true },
    expectedReturn: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    returnPaid: { type: Number, default: 0, min: 0 },
    payouts: { type: [payoutSchema], required: true },
    nextPayoutAt: { type: Date, default: null },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'active' },
    startedAt: { type: Date, required: true },
    maturesAt: { type: Date, required: true },
    settledAt: { type: Date, default: null },
    principalReturned: { type: Number, default: 0, min: 0 },
    earlyWithdrawalPenalty: { type: Number, default: 0, min: 0 },
    returnForfeited: { type: Number, default: 0, min: 0 },
    termsAcceptedAt: { type: Date, required: true },
  },
  { hiddenFields: ['idempotencyKey'] },
);

subscriptionSchema.index({ user: 1, idempotencyKey: 1 }, { unique: true });
subscriptionSchema.index({ user: 1, createdAt: -1 });
subscriptionSchema.index({ status: 1, nextPayoutAt: 1 });

export const InvestmentSubscriptionModel = model<IInvestmentSubscription>(
  'InvestmentSubscription',
  subscriptionSchema,
);
