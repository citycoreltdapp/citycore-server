import { z } from 'zod';
import { createListQuerySchema, nameSchema } from '@/core/validation/common.schemas';
import { FUNDING_CHANNELS } from '@/integrations/paystack/paystack.api';
import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from './walletTransaction.model';

/**
 * What should reach the wallet, in kobo: 100000 is 1,000 naira. The funding limits can change at
 * runtime, so they're checked by `assertFundingAmountAllowed`.
 */
const fundingAmount = (schema: z.ZodNumber) =>
  schema.int('Amount must be a whole number of kobo').positive('Amount must be positive');

export const fundWalletBodySchema = z.object({
  amount: fundingAmount(z.number()),
  channels: z.array(z.enum(FUNDING_CHANNELS)).min(1).default(['card', 'bank_transfer']),
});

export const fundingQuoteQuerySchema = z.object({
  amount: fundingAmount(z.coerce.number()),
});

export const referenceParamsSchema = z.object({
  reference: z.string().regex(/^[\w.=-]{1,100}$/, 'Invalid reference'),
});

export const requestVirtualAccountBodySchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    phone: z.string().regex(/^\+?\d{10,15}$/, 'Invalid phone number'),
    bvn: z
      .string()
      .regex(/^\d{11}$/, 'BVN must be 11 digits')
      .optional(),
    accountNumber: z
      .string()
      .regex(/^\d{10}$/, 'Account number must be 10 digits')
      .optional(),
    bankCode: z.string().trim().min(1).max(10).optional(),
    // Paystack requires the customer's express consent to generate an account with their details.
    consent: z.literal(true, 'Your consent is required to create a virtual account'),
  })
  .refine(
    ({ bvn, accountNumber, bankCode }) =>
      [bvn, accountNumber, bankCode].every(Boolean) ||
      ![bvn, accountNumber, bankCode].some(Boolean),
    'Provide bvn, accountNumber and bankCode together, or none of them',
  );

const transactionFilters = {
  status: z.enum(TRANSACTION_STATUSES).optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
};

export const listTransactionsQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'amount', 'paidAt'],
  filters: transactionFilters,
});
