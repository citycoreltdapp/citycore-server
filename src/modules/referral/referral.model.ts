import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';
import { WALLET_CURRENCY } from '@/modules/wallet/wallet.model';

export const REFERRAL_STATUSES = ['pending', 'qualified', 'rejected'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_SOURCES = ['signup', 'google_signup', 'google_prompt', 'admin'] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

/**
 * `scheduled` isn't earned yet, and becomes `pending` on its `dueAt`. `cancelled` will never be
 * earned, because the investment ended early.
 */
export const COMMISSION_STATUSES = [
  'scheduled',
  'pending',
  'approved',
  'paid',
  'rejected',
  'cancelled',
] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export interface IReferral {
  referrer: Types.ObjectId;
  referee: Types.ObjectId;
  /** The code as it was when used, as the referrer's current code can be changed by staff. */
  codeUsed: string;
  source: ReferralSource;
  status: ReferralStatus;
  /** When the referee first made an investment that earned a commission. */
  qualifiedAt: Date | null;
  /** For staff only. */
  note: string | null;
  /** The member of staff who assigned it. Null when the customer did. */
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IReferralCommission {
  referral: Types.ObjectId;
  referrer: Types.ObjectId;
  referee: Types.ObjectId;
  /** Identifies the investment. Its unique index stops one earning a commission twice. */
  investmentReference: string;
  plan: Types.ObjectId | null;
  /** The investment made in the app. Null when staff recorded one made elsewhere. */
  investment: Types.ObjectId | null;
  /** Which yearly payment of the investment's commission this is, out of `instalments`. */
  instalment: number;
  instalments: number;
  /** When a scheduled commission is earned. */
  dueAt: Date | null;
  /** In kobo. */
  investmentAmount: number;
  /** The rate at the time, so later changes to the programme don't alter this commission. */
  rateBasisPoints: number;
  /** What the referrer earns, in kobo. */
  amount: number;
  currency: string;
  status: CommissionStatus;
  /** For staff only. */
  note: string | null;
  createdBy: Types.ObjectId | null;
  approvedBy: Types.ObjectId | null;
  approvedAt: Date | null;
  rejectedBy: Types.ObjectId | null;
  rejectedAt: Date | null;
  paidBy: Types.ObjectId | null;
  paidAt: Date | null;
  /** The wallet transaction that paid it. */
  walletReference: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const referralSchema = createSchema<IReferral>({
  referrer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Unique, because a customer can only ever be referred by one person.
  referee: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  codeUsed: { type: String, required: true, index: true },
  source: { type: String, enum: REFERRAL_SOURCES, required: true },
  status: { type: String, enum: REFERRAL_STATUSES, default: 'pending', index: true },
  qualifiedAt: { type: Date, default: null },
  note: { type: String, default: null, trim: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
});

const isWholeAmount = { validator: Number.isSafeInteger, message: 'Amounts must be whole kobo' };

const commissionSchema = createSchema<IReferralCommission>({
  referral: { type: Schema.Types.ObjectId, ref: 'Referral', required: true, index: true },
  referrer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  referee: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  investmentReference: { type: String, required: true, unique: true, trim: true },
  plan: { type: Schema.Types.ObjectId, ref: 'InvestmentPlan', default: null },
  investment: {
    type: Schema.Types.ObjectId,
    ref: 'InvestmentSubscription',
    default: null,
    index: true,
  },
  instalment: { type: Number, default: 1, min: 1 },
  instalments: { type: Number, default: 1, min: 1 },
  dueAt: { type: Date, default: null },
  investmentAmount: { type: Number, required: true, min: 1, validate: isWholeAmount },
  rateBasisPoints: { type: Number, required: true, min: 0 },
  amount: { type: Number, required: true, min: 1, validate: isWholeAmount },
  currency: { type: String, default: WALLET_CURRENCY },
  status: { type: String, enum: COMMISSION_STATUSES, default: 'pending', index: true },
  note: { type: String, default: null, trim: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: { type: Date, default: null },
  rejectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  rejectedAt: { type: Date, default: null },
  paidBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  paidAt: { type: Date, default: null },
  walletReference: { type: String, default: null },
});

commissionSchema.index({ status: 1, dueAt: 1 });

export const ReferralModel = model<IReferral>('Referral', referralSchema);
export const ReferralCommissionModel = model<IReferralCommission>(
  'ReferralCommission',
  commissionSchema,
);
