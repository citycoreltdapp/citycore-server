import { env } from '@/config/env';
import { AppError } from '@/core/errors/AppError';
import { PAYSTACK_NOT_FOUND, paystackRequest } from './paystack.client';

export const FUNDING_CHANNELS = ['card', 'bank_transfer', 'bank', 'ussd'] as const;
export type FundingChannel = (typeof FUNDING_CHANNELS)[number];

/** The channel Paystack reports for a transfer into a dedicated virtual account. */
export const DEDICATED_ACCOUNT_CHANNEL = 'dedicated_nuban';

export interface InitializedTransaction {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface VerifiedTransaction {
  id: number;
  status: string;
  reference: string;
  /** In kobo. */
  amount: number;
  currency: string;
  channel: string;
  paid_at: string | null;
  fees: number | null;
  gateway_response: string | null;
  customer?: { customer_code?: string };
  authorization?: { channel?: string; receiver_bank_account_number?: string };
}

export interface AssignVirtualAccountInput {
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  /** Required by Paystack for financial services businesses, to validate the customer. */
  bvn?: string;
  account_number?: string;
  bank_code?: string;
}

export const paystackApi = {
  initializeTransaction: (input: {
    email: string;
    amount: number;
    reference: string;
    channels: readonly FundingChannel[];
    metadata: Record<string, string>;
  }) =>
    paystackRequest<InitializedTransaction>({
      name: 'transaction.initialize',
      path: '/transaction/initialize',
      body: {
        ...input,
        currency: 'NGN',
        ...(env.PAYSTACK_CALLBACK_URL && { callback_url: env.PAYSTACK_CALLBACK_URL }),
      },
    }),

  /** Returns null if Paystack has no transaction with this reference. */
  verifyTransaction: async (reference: string): Promise<VerifiedTransaction | null> => {
    try {
      return await paystackRequest<VerifiedTransaction>({
        name: 'transaction.verify',
        path: `/transaction/verify/${encodeURIComponent(reference)}`,
      });
    } catch (err) {
      if (err instanceof AppError && err.code === PAYSTACK_NOT_FOUND) return null;
      throw err;
    }
  },

  /** Starts the assignment. The result arrives later as a webhook event. */
  assignVirtualAccount: (input: AssignVirtualAccountInput) =>
    paystackRequest<unknown>({
      name: 'dedicated_account.assign',
      path: '/dedicated_account/assign',
      body: { ...input, country: 'NG', preferred_bank: env.PAYSTACK_DVA_PROVIDER },
    }),

  /** Asks Paystack to look for transfers it hasn't told us about. Allowed every 10 minutes. */
  requeryVirtualAccount: (accountNumber: string, providerSlug: string, date: string) => {
    const query = new URLSearchParams({
      account_number: accountNumber,
      provider_slug: providerSlug,
      date,
    });
    return paystackRequest<unknown>({
      name: 'dedicated_account.requery',
      path: `/dedicated_account/requery?${query.toString()}`,
    });
  },
};
