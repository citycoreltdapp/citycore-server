import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';
import { WALLET_CURRENCY } from '@/modules/wallet/wallet.model';

export const PLAN_STATUSES = ['draft', 'open', 'closed', 'archived'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** `per_annum` is a yearly rate, prorated over the duration. `flat` is the total for the duration. */
export const ROI_TYPES = ['per_annum', 'flat'] as const;
export type RoiType = (typeof ROI_TYPES)[number];

export const DURATION_UNITS = ['days', 'months', 'years'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const PAYOUT_FREQUENCIES = ['monthly', 'quarterly', 'at_maturity'] as const;
export type PayoutFrequency = (typeof PAYOUT_FREQUENCIES)[number];

export interface PlanLocation {
  area: string;
  state: string;
  country: string;
}

export interface IInvestmentPlan {
  name: string;
  slug: string;
  summary: string;
  description: string;
  category: string | null;
  coverImage: string | null;
  /** The small image on a listing. A plan can't open without one. */
  thumbnail: string | null;
  /** For example "Residential". */
  assetType: string | null;
  /** For example "Development". */
  assetSubtype: string | null;
  location: PlanLocation | null;
  riskLevel: RiskLevel;
  /** 1500 is 15%. */
  roiBasisPoints: number;
  roiType: RoiType;
  /** False means the rate is only a target, which a frontend should say. */
  roiGuaranteed: boolean;
  payoutFrequency: PayoutFrequency;
  durationValue: number;
  durationUnit: DurationUnit;
  /** Set from the two above, so that plans can be sorted by length. Approximate for months. */
  durationDays: number;
  /** In kobo. A plan sold in units has both this and `totalUnits`. A plan with neither takes any amount. */
  unitPrice: number | null;
  totalUnits: number | null;
  /** Kept by the API. Units aren't released when an investment ends. */
  unitsSold: number;
  /** In kobo. Defaults to one unit on a plan sold in units. */
  minAmount: number;
  /** In kobo. Null means no upper limit. */
  maxAmount: number | null;
  currency: string;
  earlyWithdrawalAllowed: boolean;
  earlyWithdrawalPenaltyBasisPoints: number;
  features: string[];
  terms: string;
  status: PlanStatus;
  /** An open plan is available from this time. Null means straight away. */
  opensAt: Date | null;
  /** An open plan stops being available at this time. Null means until it's closed. */
  closesAt: Date | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const planLocationSchema = new Schema<PlanLocation>(
  {
    area: { type: String, required: true },
    state: { type: String, required: true },
    country: { type: String, required: true },
  },
  { _id: false },
);

const investmentPlanSchema = createSchema<IInvestmentPlan>({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true },
  summary: { type: String, default: '', trim: true },
  description: { type: String, required: true },
  category: { type: String, default: null, trim: true, index: true },
  coverImage: { type: String, default: null },
  thumbnail: { type: String, default: null },
  assetType: { type: String, default: null, trim: true, index: true },
  assetSubtype: { type: String, default: null, trim: true },
  location: { type: planLocationSchema, default: null },
  riskLevel: { type: String, enum: RISK_LEVELS, required: true },
  roiBasisPoints: { type: Number, required: true, min: 1 },
  roiType: { type: String, enum: ROI_TYPES, required: true },
  roiGuaranteed: { type: Boolean, default: false },
  payoutFrequency: { type: String, enum: PAYOUT_FREQUENCIES, required: true },
  durationValue: { type: Number, required: true, min: 1 },
  durationUnit: { type: String, enum: DURATION_UNITS, required: true },
  durationDays: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, default: null, min: 1 },
  totalUnits: { type: Number, default: null, min: 1 },
  unitsSold: { type: Number, default: 0, min: 0 },
  minAmount: { type: Number, required: true, min: 1 },
  maxAmount: { type: Number, default: null, min: 1 },
  currency: { type: String, default: WALLET_CURRENCY },
  earlyWithdrawalAllowed: { type: Boolean, default: false },
  earlyWithdrawalPenaltyBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
  features: { type: [String], default: [] },
  terms: { type: String, default: '' },
  status: { type: String, enum: PLAN_STATUSES, default: 'draft' },
  opensAt: { type: Date, default: null },
  closesAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
});

investmentPlanSchema.index({ status: 1, opensAt: 1, closesAt: 1 });

investmentPlanSchema.virtual('unitsAvailable').get(function () {
  return this.totalUnits === null ? null : this.totalUnits - this.unitsSold;
});

/** The whole offering's value, in kobo. */
investmentPlanSchema.virtual('totalOffering').get(function () {
  return this.totalUnits === null || this.unitPrice === null
    ? null
    : this.totalUnits * this.unitPrice;
});

export const InvestmentPlanModel = model<IInvestmentPlan>('InvestmentPlan', investmentPlanSchema);
