import { z } from 'zod';
import { createListQuerySchema, objectIdSchema } from '@/core/validation/common.schemas';
import { addressSchema, phoneSchema } from '@/modules/user/user.schemas';
import { KYC_STATUSES } from './kyc.model';

export const ninBodySchema = z.object({
  nin: z
    .string()
    .trim()
    .regex(/^\d{11}$/, 'Your NIN is the 11 digit number on your NIN slip or card'),
});

/**
 * Names come from the NIN and can't be changed here. Gender and date of birth are only needed when
 * the NIN record has none, and are ignored when it does.
 */
export const detailsBodySchema = z.object({
  phone: phoneSchema,
  gender: z.enum(['male', 'female']).optional(),
  dateOfBirth: z.coerce.date().optional(),
  address: addressSchema,
  occupation: z.string().trim().min(1).max(100).nullable().optional(),
});

export const approveBodySchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const rejectBodySchema = z.object({
  /** Shown to the customer, so they know what to fix. */
  reason: z.string().trim().min(3).max(500),
  note: z.string().trim().max(1000).optional(),
});

export const listVerificationsQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'submittedAt', 'reviewedAt'],
  defaultSort: '-submittedAt',
  filters: {
    status: z.enum(KYC_STATUSES).optional(),
    user: objectIdSchema.optional(),
  },
});

export type DetailsBody = z.output<typeof detailsBodySchema>;
export type ListVerificationsQuery = z.output<typeof listVerificationsQuerySchema>;
