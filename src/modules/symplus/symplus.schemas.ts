import { z } from 'zod';
import {
  CUSTOMER_KINDS,
  CUSTOMER_LOOKUPS,
  DOCUMENT_READ_ENDPOINTS,
  REFERENCE_LISTS,
  type CustomerKind,
  type CustomerLookup,
  type CustomerUpdateSection,
  type IndividualDocumentType,
  type ReferenceList,
  type SymplusPayload,
} from '@/integrations/symplus/symplus.api';
import {
  CORPORATE_FIELDS,
  INDIVIDUAL_FIELDS,
  JOINT_FIELDS,
  MINOR_FIELDS,
} from '@/integrations/symplus/symplus.fields';
import { createListQuerySchema, objectIdSchema } from '@/core/validation/common.schemas';
import { JOB_STATUSES, JOB_TYPES } from './syncJob.model';

const MAX_CUSTOMER_ID_LENGTH = 30;

const text = z.string().trim().min(1).max(500);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const elevenDigits = z.string().regex(/^\d{11}$/, 'Must be 11 digits');
const email = z.string().trim().toLowerCase().pipe(z.email('Invalid email address'));

export const customerIdSchema = z.string().trim().min(1).max(MAX_CUSTOMER_ID_LENGTH);

/** Chooses a field's validation from its name, which follows the same pattern across Symplus. */
const schemaForField = (name: string): z.ZodType<string> => {
  if (/_date$|date_of_birth$/.test(name)) return isoDate;
  if (/bvn/.test(name) || /(^|_)nin(_no)?$/.test(name)) return elevenDigits;
  if (/email|_eml_/.test(name)) return email;
  if (/(^|_)customer_id$/.test(name)) return customerIdSchema;
  return text;
};

/** Unknown fields are dropped, so only names in `fields` ever reach Symplus. */
const payloadSchema = (fields: readonly string[], required: readonly string[] = []) => {
  const shape = Object.fromEntries(
    fields.map((name) => {
      const schema = schemaForField(name);
      return [name, required.includes(name) ? schema : schema.optional()];
    }),
  );
  const schema = z.object(shape);
  const checked =
    required.length > 0
      ? schema
      : schema.refine((value) => Object.keys(value).length > 0, 'Provide at least one field');
  return checked as unknown as z.ZodType<SymplusPayload>;
};

const without = <T extends string>(fields: readonly T[], excluded: readonly string[]) =>
  fields.filter((field) => !excluded.includes(field));

const INDIVIDUAL_REQUIRED = [
  'last_name',
  'first_name',
  'mobile_phone_no',
  'gender_cd',
  'primary_email_address',
  'address_street',
  'address_city',
  'address_country_cd',
];

// Set by the server for self-service onboarding, so a customer can't choose or spoof them.
const SERVER_CONTROLLED_FIELDS = [
  'primary_email_address',
  'external_crm_id',
  'external_reference1',
  'external_reference2',
  'retain_customer_id',
  'officer_id',
  'introducer_id',
  'location_cd',
];

export const onboardBodySchema = payloadSchema(
  without(INDIVIDUAL_FIELDS, SERVER_CONTROLLED_FIELDS),
  without(INDIVIDUAL_REQUIRED, SERVER_CONTROLLED_FIELDS),
);

const minorSchema = payloadSchema(MINOR_FIELDS, ['prt_exist_yn', 'remarks_text'])
  .refine(
    (minor) => ['0', '1'].includes(minor.prt_exist_yn ?? ''),
    'prt_exist_yn must be 1 (parent exists) or 0',
  )
  .refine((minor) => minor.prt_exist_yn !== '1' || Boolean(minor.p_customer_id), {
    message: 'p_customer_id is required when the parent is an existing customer',
  })
  .refine(
    (minor) => minor.prt_exist_yn !== '0' || Boolean(minor.p_last_name && minor.p_first_name),
    {
      message: "The parent's details are required when the parent isn't an existing customer",
    },
  );

export const CREATE_CUSTOMER_SCHEMAS: Record<CustomerKind, z.ZodType<SymplusPayload>> = {
  individual: payloadSchema(INDIVIDUAL_FIELDS, INDIVIDUAL_REQUIRED),
  corporate: payloadSchema(CORPORATE_FIELDS, [
    'organization_name',
    'address_street',
    'address_city',
    'address_country_cd',
    'primary_phone_no',
    'primary_email_address',
    'bank_cd',
    'bank_account_no',
    'bank_account_name',
  ]),
  joint: payloadSchema(JOINT_FIELDS, [
    'account_name',
    ...[1, 2].flatMap((n) =>
      [
        'first_name',
        'last_name',
        'gender_cd',
        'mobile_phone',
        'address_street',
        'address_city',
        'address_country_cd',
        'birth_date',
      ].map((field) => `person${n}_${field}`),
    ),
  ]),
  minor: minorSchema,
};

export const upgradeMinorBodySchema = payloadSchema(
  [
    'minor_customer_id',
    'minor_date_of_birth',
    'minor_nin',
    'minor_bvn',
    'minor_email_address',
    'minor_address_country_code',
    'minor_address_state_code',
    'minor_address_city',
    'minor_phone_number',
    'minor_address_street',
    'parent_customer_id',
    'parent_bvn',
    'remark',
  ],
  [
    'minor_customer_id',
    'minor_date_of_birth',
    'minor_nin',
    'minor_bvn',
    'minor_email_address',
    'minor_address_country_code',
    'minor_address_state_code',
    'minor_address_city',
    'minor_phone_number',
    'parent_customer_id',
    'parent_bvn',
  ],
);

/**
 * `customer_id` is left out of every section. It comes from the signed-in user's link or from the
 * admin route's path, never from the body.
 */
export const CUSTOMER_UPDATE_SCHEMAS: Record<CustomerUpdateSection, z.ZodType<SymplusPayload>> = {
  details: payloadSchema([
    'title_code',
    'marital_status_code',
    'mother_maiden_name',
    'nationality_code',
    'remarks',
  ]),
  nextOfKin: payloadSchema([
    'nok_first_name',
    'nok_last_name',
    'nok_gender_code',
    'nok_primary_eml_address',
    'nok_mobile_telephone',
    'nok_address_street',
    'nok_address_city',
    'nok_address_country_cd',
    'nok_relationship_cd',
    'remarks',
  ]),
  nin: payloadSchema(['nin_no', 'remarks'], ['nin_no']),
  tin: payloadSchema(['tax_identification_no', 'remarks'], ['tax_identification_no']),
  bank: payloadSchema([
    'bank_code',
    'bank_account_name',
    'bank_account_no',
    'bank_sort_code',
    'alternate_bank_code',
    'alternate_bank_account_name',
    'alternate_bank_account_no',
    'alternate_bank_sort_code',
    'remarks',
  ]),
  address: payloadSchema([
    'primary_street',
    'primary_city',
    'primary_state_cd',
    'primary_country_cd',
    'primary_zip',
    'postal_address',
    'remarks',
  ]),
  email: payloadSchema(['primary_email', 'alternate_email', 'remarks'], ['primary_email']),
  // `adress_city` is misspelled in the Symplus API itself, and has to be sent that way.
  employment: payloadSchema(
    [
      'employer_name',
      'job_title',
      'address_street',
      'adress_city',
      'address_country_cd',
      'remarks',
    ],
    ['employer_name', 'address_street', 'adress_city', 'address_country_cd'],
  ),
  identification: payloadSchema(
    [
      'document_type_cd',
      'document_name',
      'document_number',
      'issue_date',
      'expiry_date',
      'issuing_authority',
      'remarks',
    ],
    ['document_type_cd', 'document_name', 'document_number', 'issue_date', 'expiry_date'],
  ),
};

const numberedCodes = (count: number) =>
  Array.from({ length: count }, (_, index) => String(index + 1).padStart(3, '0'));

const DOCUMENT_TYPES: Record<CustomerKind, readonly string[]> = {
  individual: ['PIX', 'IDN', 'SIG', 'UBL'],
  corporate: numberedCodes(24),
  joint: numberedCodes(8),
  minor: numberedCodes(2),
};

export const documentTypeSchema = (kind: CustomerKind) =>
  z.enum(DOCUMENT_TYPES[kind] as [string, ...string[]]);

export const selfDocumentBodySchema = z.object({ document_type: documentTypeSchema('individual') });

export const adminDocumentBodySchema = z
  .object({
    document_type: z.string().trim().min(1),
    customer_id: customerIdSchema.optional(),
    customer_source_reference: z.string().trim().min(1).max(100).optional(),
  })
  .refine((body) => body.customer_id || body.customer_source_reference, {
    message: 'Provide customer_id or customer_source_reference',
  });

export const documentTypeParamsSchema = z.object({
  type: z.enum(Object.keys(DOCUMENT_READ_ENDPOINTS) as [IndividualDocumentType]),
});

export const referenceParamsSchema = z.object({
  list: z.enum(Object.keys(REFERENCE_LISTS) as [ReferenceList]),
});

export const kindParamsSchema = z.object({ kind: z.enum(CUSTOMER_KINDS) });
export const kindReferenceParamsSchema = kindParamsSchema.extend({
  reference: z.string().trim().min(1).max(100),
});
export const customerParamsSchema = z.object({ customerId: customerIdSchema });
export const jobParamsSchema = z.object({ id: objectIdSchema });

// A POST body, because the values are a BVN, NIN, email or phone number, which shouldn't be in URLs.
export const searchCustomersBodySchema = z.object({
  by: z.enum(Object.keys(CUSTOMER_LOOKUPS) as [CustomerLookup]),
  value: z.string().trim().min(1).max(200),
});

export const listCustomersQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  rows: z.coerce.number().int().min(1).max(200).default(50),
});

export const serialRangeQuerySchema = z
  .object({
    start: z.coerce.number().int().min(1),
    end: z.coerce.number().int().min(1),
  })
  .refine((range) => range.end >= range.start && range.end - range.start < 200, {
    message: 'end must be at or after start, and the range at most 200 rows',
  });

export const accountPlanParamsSchema = z.object({ product: z.string().trim().min(1).max(100) });

export const linkCustomerBodySchema = z.object({
  userId: objectIdSchema,
  customerId: customerIdSchema,
  customerType: z.enum(CUSTOMER_KINDS).default('individual'),
});

export const listJobsQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'runAt', 'attempts'],
  filters: {
    status: z.enum(JOB_STATUSES).optional(),
    type: z.enum(JOB_TYPES).optional(),
  },
});
