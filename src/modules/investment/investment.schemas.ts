import { z } from 'zod';
import {
  createListQuerySchema,
  imageSchema,
  objectIdSchema,
  requireAtLeastOneField,
  slugSchema,
} from '@/core/validation/common.schemas';
import {
  DURATION_UNITS,
  PAYOUT_FREQUENCIES,
  PLAN_STATUSES,
  RISK_LEVELS,
  ROI_TYPES,
} from './investment.model';
import { SUBSCRIPTION_STATUSES } from './investmentSubscription.model';

/** 100 billion naira. With the other limits here, this keeps every projection a safe integer. */
export const MAX_AMOUNT_KOBO = 10_000_000_000_000;
/** 1000%. */
const MAX_ROI_BASIS_POINTS = 100_000;

const kobo = (schema: z.ZodNumber) =>
  schema
    .int('Amount must be a whole number of kobo')
    .positive('Amount must be positive')
    .max(MAX_AMOUNT_KOBO, `Amount must be at most ${MAX_AMOUNT_KOBO} kobo`);

const MAX_UNITS = 1_000_000_000;
const unitsSchema = (schema: z.ZodNumber) =>
  schema.int('Units must be a whole number').positive('Units must be positive').max(MAX_UNITS);

const assetLabel = z.string().trim().min(1).max(80);
const placeName = z.string().trim().min(1).max(100);

const dateSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const fields = z.object({
  name: z.string().trim().min(3).max(120),
  slug: slugSchema,
  summary: z.string().trim().max(500),
  description: z.string().trim().min(1).max(20_000),
  category: z.string().trim().min(1).max(60).nullable(),
  coverImage: imageSchema.nullable(),
  thumbnail: imageSchema.nullable(),
  assetType: assetLabel.nullable(),
  assetSubtype: assetLabel.nullable(),
  location: z.object({ area: placeName, state: placeName, country: placeName }).nullable(),
  riskLevel: z.enum(RISK_LEVELS),
  roiBasisPoints: z.number().int().positive().max(MAX_ROI_BASIS_POINTS),
  roiType: z.enum(ROI_TYPES),
  roiGuaranteed: z.boolean(),
  payoutFrequency: z.enum(PAYOUT_FREQUENCIES),
  durationValue: z.number().int().positive(),
  durationUnit: z.enum(DURATION_UNITS),
  unitPrice: kobo(z.number()).nullable(),
  totalUnits: unitsSchema(z.number()).nullable(),
  minAmount: kobo(z.number()),
  maxAmount: kobo(z.number()).nullable(),
  earlyWithdrawalAllowed: z.boolean(),
  earlyWithdrawalPenaltyBasisPoints: z.number().int().min(0).max(10_000),
  features: z.array(z.string().trim().min(1).max(200)).max(20),
  terms: z.string().trim().max(50_000),
  status: z.enum(PLAN_STATUSES),
  opensAt: dateSchema.nullable(),
  closesAt: dateSchema.nullable(),
});

export const createPlanBodySchema = fields.partial().required({
  name: true,
  description: true,
  riskLevel: true,
  roiBasisPoints: true,
  roiType: true,
  payoutFrequency: true,
  durationValue: true,
  durationUnit: true,
});

export const updatePlanBodySchema = requireAtLeastOneField(fields.partial());

export const planSlugParamsSchema = z.object({ slug: slugSchema });

const investmentFilters = { status: z.enum(SUBSCRIPTION_STATUSES).optional() };
const SUBSCRIPTION_SORTABLE = ['createdAt', 'amount', 'maturesAt'];

const ONE_OF_UNITS_OR_AMOUNT = 'Provide either units or amount';
const hasOne = ({ units, amount }: { units?: number; amount?: number }) =>
  (units === undefined) !== (amount === undefined);

export const createSubscriptionBodySchema = z
  .object({
    planId: objectIdSchema,
    /** How many units to buy, on a plan sold in units. */
    units: unitsSchema(z.number()).optional(),
    amount: kobo(z.number()).optional(),
    /** Made by the client for each attempt, so a retry can't invest twice. A UUID is ideal. */
    idempotencyKey: z.string().regex(/^[\w-]{8,100}$/, 'Invalid idempotency key'),
    acceptTerms: z.literal(true, 'You must accept the terms of the plan'),
  })
  .refine(hasOne, ONE_OF_UNITS_OR_AMOUNT);

export const withdrawSubscriptionBodySchema = z.object({
  confirm: z.literal(true, 'Confirm the early withdrawal'),
});

export const listSubscriptionsQuerySchema = createListQuerySchema({
  sortable: SUBSCRIPTION_SORTABLE,
  maxLimit: 50,
  filters: investmentFilters,
});

export const listAdminSubscriptionsQuerySchema = createListQuerySchema({
  sortable: SUBSCRIPTION_SORTABLE,
  filters: {
    ...investmentFilters,
    plan: objectIdSchema.optional(),
    user: objectIdSchema.optional(),
  },
});

export const planQuoteQuerySchema = z
  .object({
    units: unitsSchema(z.coerce.number()).optional(),
    amount: kobo(z.coerce.number()).optional(),
  })
  .refine(hasOne, ONE_OF_UNITS_OR_AMOUNT);

const planFilters = {
  category: z.string().trim().min(1).max(60).optional(),
  riskLevel: z.enum(RISK_LEVELS).optional(),
  roiType: z.enum(ROI_TYPES).optional(),
  payoutFrequency: z.enum(PAYOUT_FREQUENCIES).optional(),
  assetType: assetLabel.optional(),
};

const SORTABLE = ['name', 'roiBasisPoints', 'durationDays', 'minAmount', 'createdAt'];

export const listAvailablePlansQuerySchema = createListQuerySchema({
  sortable: SORTABLE,
  maxLimit: 50,
  filters: planFilters,
});

export const listAdminPlansQuerySchema = createListQuerySchema({
  sortable: [...SORTABLE, 'updatedAt'],
  defaultSort: '-updatedAt',
  filters: { ...planFilters, status: z.enum(PLAN_STATUSES).optional() },
});
