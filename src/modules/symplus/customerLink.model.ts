import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';
import { CUSTOMER_KINDS, type CustomerKind } from '@/integrations/symplus/symplus.api';

export const LINK_STATUSES = ['queued', 'pending', 'active', 'rejected', 'failed'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export interface INetWorth {
  moduleName: string;
  currencyId: string;
  currencyName: string;
  netWorth: number;
}

export interface IPosition {
  productId: string;
  productName: string;
  accountId: string;
  currencyId: string;
  currencyName: string;
  currentBalance: number;
  currentValue: number;
}

/** Connects a platform user to their Symplus customer record. Symplus remains the source of truth. */
export interface ICustomerLink {
  user: Types.ObjectId;
  customerType: CustomerKind;
  customerId: string | null;
  /** Identifies the customer while their registration is awaiting approval. */
  sourceReference: string | null;
  status: LinkStatus;
  /** The status text as Symplus sent it. */
  upstreamStatus: string | null;
  lastError: string | null;
  /** Document types sent during onboarding. Symplus can't report them until there's a customer ID. */
  submittedDocuments: string[];
  /** The `kyc_completed` value as Symplus sent it. */
  upstreamKyc: string | null;
  kycCheckedAt: Date | null;
  netWorth: INetWorth[];
  positions: IPosition[];
  balancesSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const customerLinkSchema = createSchema<ICustomerLink>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  customerType: { type: String, enum: CUSTOMER_KINDS, default: 'individual' },
  customerId: { type: String, default: null },
  sourceReference: { type: String, default: null },
  status: { type: String, enum: LINK_STATUSES, default: 'queued', index: true },
  upstreamStatus: { type: String, default: null },
  lastError: { type: String, default: null },
  submittedDocuments: { type: [String], default: [] },
  upstreamKyc: { type: String, default: null },
  kycCheckedAt: { type: Date, default: null },
  netWorth: {
    type: [
      {
        _id: false,
        moduleName: String,
        currencyId: String,
        currencyName: String,
        netWorth: Number,
      },
    ],
    default: [],
  },
  positions: {
    type: [
      {
        _id: false,
        productId: String,
        productName: String,
        accountId: String,
        currencyId: String,
        currencyName: String,
        currentBalance: Number,
        currentValue: Number,
      },
    ],
    default: [],
  },
  balancesSyncedAt: { type: Date, default: null },
});

// One platform user per Symplus customer. Most links have no customerId yet, hence the filter.
customerLinkSchema.index(
  { customerId: 1 },
  { unique: true, partialFilterExpression: { customerId: { $type: 'string' } } },
);

export const CustomerLinkModel = model<ICustomerLink>('CustomerLink', customerLinkSchema);
