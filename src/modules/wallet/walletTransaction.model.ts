import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';
import { WALLET_CURRENCY } from './wallet.model';

export const TRANSACTION_STATUSES = [
  'pending',
  'success',
  'failed',
  'abandoned',
  // Money may have moved, but it needs a person to decide what happens. Never credited automatically.
  'flagged',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTION_TYPES = [
  'funding',
  'referral_commission',
  'investment',
  'investment_return',
  'investment_principal',
  'investment_withdrawal',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_DIRECTIONS = ['credit', 'debit'] as const;
export type TransactionDirection = (typeof TRANSACTION_DIRECTIONS)[number];

export interface IWalletTransaction {
  /** Null only for a flagged transfer that couldn't be matched to anyone. */
  user: Types.ObjectId | null;
  wallet: Types.ObjectId | null;
  reference: string;
  type: TransactionType;
  direction: TransactionDirection;
  /** What the wallet receives, or for a debit what leaves it, in kobo. */
  amount: number;
  /** What the customer paid Paystack, in kobo: `amount` plus `customerFee`. Null if nothing was. */
  chargedAmount: number | null;
  /** The part of `chargedAmount` the customer paid as a fee, in kobo. */
  customerFee: number;
  currency: string;
  status: TransactionStatus;
  /** `internal` means the money came from the platform itself, such as a referral commission. */
  provider: 'paystack' | 'internal';
  channel: string | null;
  providerTransactionId: number | null;
  /** What Paystack actually charged, in kobo. Can exceed `customerFee`, as for a foreign card. */
  fees: number | null;
  paidAt: Date | null;
  settledAt: Date | null;
  /** The wallet balance right after this entry was applied. */
  balanceAfter: number | null;
  authorizationUrl: string | null;
  failureReason: string | null;
  /** Something an admin should look at, such as a credited payment later being reversed. */
  reviewNote: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const walletTransactionSchema = createSchema<IWalletTransaction>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    wallet: { type: Schema.Types.ObjectId, ref: 'Wallet', default: null },
    // The unique index is what makes it impossible to record the same payment twice.
    reference: { type: String, required: true, unique: true },
    type: { type: String, enum: TRANSACTION_TYPES, required: true },
    direction: { type: String, enum: TRANSACTION_DIRECTIONS, default: 'credit' },
    amount: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    chargedAmount: {
      type: Number,
      default: null,
      min: 0,
      // Null when the customer paid nothing, as for a referral commission.
      validate: (value: number | null) => value === null || Number.isSafeInteger(value),
    },
    customerFee: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    currency: { type: String, default: WALLET_CURRENCY },
    status: { type: String, enum: TRANSACTION_STATUSES, default: 'pending' },
    provider: { type: String, enum: ['paystack', 'internal'], default: 'paystack' },
    channel: { type: String, default: null },
    providerTransactionId: { type: Number, default: null },
    fees: { type: Number, default: null },
    paidAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },
    balanceAfter: { type: Number, default: null },
    authorizationUrl: { type: String, default: null },
    failureReason: { type: String, default: null },
    reviewNote: { type: String, default: null },
    lastCheckedAt: { type: Date, default: null },
  },
  { hiddenFields: ['lastCheckedAt'] },
);

walletTransactionSchema.index({ user: 1, createdAt: -1 });
walletTransactionSchema.index({ status: 1, lastCheckedAt: 1 });

export const WalletTransactionModel = model<IWalletTransaction>(
  'WalletTransaction',
  walletTransactionSchema,
);
