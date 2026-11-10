import { z } from 'zod';
import {
  createListQuerySchema,
  objectIdSchema,
  requireAtLeastOneField,
} from '@/core/validation/common.schemas';
import { COMMISSION_STATUSES, REFERRAL_SOURCES, REFERRAL_STATUSES } from './referral.model';

/** 100 billion naira, the same limit investment plans use. */
const MAX_AMOUNT_KOBO = 10_000_000_000_000;

const kobo = z
  .number()
  .int('Amount must be a whole number of kobo')
  .positive()
  .max(MAX_AMOUNT_KOBO);
const noteSchema = z.string().trim().min(1).max(1000);

export const referralCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,20}$/, 'Referral code must be 4 to 20 letters and numbers');

/** A signup form sends an empty field when the box is left blank, which means no code. */
export const optionalReferralCodeSchema = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  referralCodeSchema.optional(),
);

export const codeParamsSchema = z.object({ code: referralCodeSchema });

export const applyCodeBodySchema = z.object({ code: referralCodeSchema });

const referralFilters = { status: z.enum(REFERRAL_STATUSES).optional() };
const commissionFilters = { status: z.enum(COMMISSION_STATUSES).optional() };

export const listMyReferralsQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'qualifiedAt'],
  maxLimit: 50,
  filters: referralFilters,
});

export const listMyCommissionsQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'amount', 'paidAt', 'dueAt'],
  maxLimit: 50,
  filters: commissionFilters,
});

export const listReferralsQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'qualifiedAt', 'updatedAt'],
  filters: {
    ...referralFilters,
    source: z.enum(REFERRAL_SOURCES).optional(),
    referrer: objectIdSchema.optional(),
    referee: objectIdSchema.optional(),
  },
});

export const listCommissionsQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'amount', 'investmentAmount', 'paidAt', 'updatedAt', 'dueAt'],
  filters: {
    ...commissionFilters,
    referral: objectIdSchema.optional(),
    referrer: objectIdSchema.optional(),
    referee: objectIdSchema.optional(),
  },
});

export const createReferralBodySchema = z.object({
  referrer: objectIdSchema,
  referee: objectIdSchema,
  note: noteSchema.optional(),
});

export const updateReferralBodySchema = requireAtLeastOneField(
  z.object({ status: z.enum(REFERRAL_STATUSES), note: noteSchema.nullable() }).partial(),
);

export const createCommissionBodySchema = z.object({
  referee: objectIdSchema,
  investmentReference: z.string().trim().min(1).max(120),
  investmentAmount: kobo,
  plan: objectIdSchema.optional(),
  /** Replaces the amount worked out from the programme's rate. */
  amount: kobo.optional(),
  note: noteSchema.optional(),
});

export const updateCommissionBodySchema = requireAtLeastOneField(
  z.object({ amount: kobo, note: noteSchema.nullable() }).partial(),
);

export const rejectCommissionBodySchema = z.object({ note: noteSchema });

/** With no code, one is generated. */
export const setCodeBodySchema = z.object({ code: referralCodeSchema.optional() });

export type CreateCommissionBody = z.output<typeof createCommissionBodySchema>;
export type UpdateCommissionBody = z.output<typeof updateCommissionBodySchema>;
export type CreateReferralBody = z.output<typeof createReferralBodySchema>;
export type UpdateReferralBody = z.output<typeof updateReferralBodySchema>;
