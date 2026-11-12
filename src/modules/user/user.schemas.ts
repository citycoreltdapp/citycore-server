import { z } from 'zod';
import {
  createListQuerySchema,
  emailSchema,
  nameSchema,
  objectIdSchema,
  passwordSchema,
  requireAtLeastOneField,
} from '@/core/validation/common.schemas';
import { roleKeySchema } from '@/modules/role/role.schemas';
import { GENDERS, MARITAL_STATUSES } from './user.model';

const MIN_BIRTH_YEAR = 1900;

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must include the country code, such as +2348012345678');

const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Country must be a two-letter code, such as NG');

const isTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(100),
  lga: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().min(1).max(100),
  country: countrySchema,
  postalCode: z.string().trim().max(20).nullable().optional(),
});

const nextOfKinSchema = z.object({
  name: nameSchema,
  relationship: z.string().trim().min(1).max(50),
  phone: phoneSchema,
  email: emailSchema.nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
});

const preferencesSchema = z
  .object({
    language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Language must look like en or en-NG'),
    timezone: z.string().max(64).refine(isTimezone, 'Unknown time zone'),
    emailNotifications: z.boolean(),
    smsNotifications: z.boolean(),
    pushNotifications: z.boolean(),
  })
  .partial();

const personalFields = z.object({
  name: nameSchema,
  phone: phoneSchema.nullable(),
  alternatePhone: phoneSchema.nullable(),
  dateOfBirth: z.iso
    .date()
    .transform((value) => new Date(value))
    .refine(
      (date) => date < new Date() && date.getUTCFullYear() >= MIN_BIRTH_YEAR,
      'Date of birth must be a real date in the past',
    )
    .nullable(),
  gender: z.enum(GENDERS).nullable(),
  maritalStatus: z.enum(MARITAL_STATUSES).nullable(),
  nationality: countrySchema.nullable(),
  address: addressSchema.nullable(),
  occupation: z.string().trim().min(1).max(100).nullable(),
  employer: z.string().trim().min(1).max(150).nullable(),
  nextOfKin: nextOfKinSchema.nullable(),
  preferences: preferencesSchema,
});

const departmentSchema = z.string().trim().min(1).max(100);

const workFields = z.object({
  jobTitle: z.string().trim().min(1).max(100).nullable(),
  department: departmentSchema.nullable(),
});

/** Only whoever manages the account may set this, so it's kept apart from `workFields`. */
const employeeIdSchema = z.string().trim().min(1).max(50).nullable();

export const listUsersQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'name', 'email', 'lastLoginAt'],
  filters: {
    role: roleKeySchema.optional(),
    isActive: z.stringbool().optional(),
    department: departmentSchema.optional(),
  },
});

export const createUserBodySchema = z.object({
  ...personalFields.partial().shape,
  ...workFields.partial().shape,
  employeeId: employeeIdSchema.optional(),
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  role: roleKeySchema.optional(),
});

export const updateUserBodySchema = requireAtLeastOneField(
  z
    .object({
      ...personalFields.shape,
      ...workFields.shape,
      employeeId: employeeIdSchema,
      email: emailSchema,
      role: roleKeySchema,
      isActive: z.boolean(),
    })
    .partial(),
);

/** Email, password and role aren't here: the first two need the password, the last an admin. */
export const updateProfileBodySchema = requireAtLeastOneField(
  z.object({ ...personalFields.shape, ...workFields.shape }).partial(),
);

export const userSessionParamsSchema = z.object({
  id: objectIdSchema,
  sessionId: objectIdSchema,
});
