import { z } from 'zod';
import { createListQuerySchema, objectIdSchema } from '@/core/validation/common.schemas';
import { addressSchema, phoneSchema } from '@/modules/user/user.schemas';
import { COMPANY_TYPES, ID_TYPES, KYC_STATUSES } from './kyc.model';

const elevenDigits = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{11}$/, `Your ${label} is the 11 digit number on your ${label} slip or card`);

export const ninBodySchema = z.object({ nin: elevenDigits('NIN') });

export const detailsBodySchema = z.object({
  phone: phoneSchema.optional(),
  gender: z.enum(['male', 'female']).optional(),
  dateOfBirth: z.coerce.date().optional(),
  address: addressSchema,
  occupation: z.string().trim().min(1).max(100).nullable().optional(),
});

export const businessLookupBodySchema = z.object({
  companyType: z.enum(COMPANY_TYPES),
  registrationNumber: z
    .string()
    .trim()
    .toUpperCase()
    .transform((value) => value.replace(/^(RC|BN|IT|LLP|LP)\s*/, ''))
    .pipe(z.string().regex(/^\d{4,8}$/, 'Enter the 4 to 8 digit number on your certificate')),
});

export const businessDetailsBodySchema = z.object({
  tin: z
    .string()
    .trim()
    .regex(/^(\d{8}-?\d{4}|\d{10})$/, 'Enter a valid TIN, such as 12345678-0001')
    .optional(),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')),
  phone: phoneSchema,
  operatingAddress: addressSchema.nullable(),
});

export const signatoryBodySchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  idType: z.enum(ID_TYPES),
  idNumber: z
    .string()
    .trim()
    .regex(/^\d{11}$/, 'Must be 11 digits'),
});

export const payoutBodySchema = z.object({
  bankCode: z
    .string()
    .trim()
    .regex(/^[0-9A-Z]{3,6}$/, 'Choose the company’s bank'),
  bankName: z.string().trim().min(2).max(100),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Account number must be 10 digits'),
});

export const approveBodySchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const rejectBodySchema = z.object({
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
export type BusinessLookupBody = z.output<typeof businessLookupBodySchema>;
export type BusinessDetailsBody = z.output<typeof businessDetailsBodySchema>;
export type SignatoryBody = z.output<typeof signatoryBodySchema>;
export type PayoutBody = z.output<typeof payoutBodySchema>;
export type ListVerificationsQuery = z.output<typeof listVerificationsQuerySchema>;
