import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export const WALLET_CURRENCY = 'NGN';

export const VIRTUAL_ACCOUNT_STATUSES = ['none', 'pending', 'active', 'failed'] as const;
export type VirtualAccountStatus = (typeof VIRTUAL_ACCOUNT_STATUSES)[number];

const isWholeAmount = {
  validator: Number.isSafeInteger,
  message: 'Amounts must be whole kobo',
};

export interface IWallet {
  user: Types.ObjectId;
  /** In kobo, as a whole number, so that amounts never pick up floating point errors. */
  balance: number;
  currency: string;
  paystackCustomerCode: string | null;
  virtualAccountStatus: VirtualAccountStatus;
  virtualAccountError: string | null;
  /** The email the account was requested with, which is how Paystack's events identify it. */
  virtualAccountEmail: string | null;
  virtualAccount: {
    bankName: string;
    bankSlug: string;
    accountName: string;
    accountNumber: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const virtualAccountSchema = new Schema(
  { bankName: String, bankSlug: String, accountName: String, accountNumber: String },
  { _id: false },
);

const walletSchema = createSchema<IWallet>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    balance: { type: Number, default: 0, min: 0, validate: isWholeAmount },
    currency: { type: String, default: WALLET_CURRENCY },
    paystackCustomerCode: { type: String, default: null },
    virtualAccountStatus: { type: String, enum: VIRTUAL_ACCOUNT_STATUSES, default: 'none' },
    virtualAccountError: { type: String, default: null },
    virtualAccountEmail: { type: String, default: null },
    virtualAccount: { type: virtualAccountSchema, default: null },
  },
  { hiddenFields: ['virtualAccountEmail', 'paystackCustomerCode'] },
);

walletSchema.index(
  { paystackCustomerCode: 1 },
  { unique: true, partialFilterExpression: { paystackCustomerCode: { $type: 'string' } } },
);
walletSchema.index({ 'virtualAccount.accountNumber': 1 }, { sparse: true });
walletSchema.index({ virtualAccountEmail: 1 }, { sparse: true });

export const WalletModel = model<IWallet>('Wallet', walletSchema);
