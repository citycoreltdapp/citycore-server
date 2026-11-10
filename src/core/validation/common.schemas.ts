import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

export const objectIdSchema = z
  .string()
  .refine((value) => isValidObjectId(value) && value.length === 24, 'Invalid id');

export const idParamsSchema = z.object({ id: objectIdSchema });

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Invalid email address'));

export const nameSchema = z.string().trim().min(2).max(100);

// bcrypt only uses the first 72 bytes of its input, so longer passwords are rejected outright.
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value) <= 72, 'Password must be at most 72 bytes')
  .regex(/[a-zA-Z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must use only letters, numbers and single hyphens');

// An https URL, such as one from POST /uploads/images, never a scheme a browser would run.
export const imageSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => z.url({ protocol: /^https$/ }).safeParse(value).success,
    'Image must be an https URL',
  );

export interface ListQuery {
  page: number;
  limit: number;
  sort: string;
  search?: string;
  [filter: string]: unknown;
}

interface ListQueryOptions<F extends z.ZodRawShape> {
  /** Fields clients may sort by. Prefix with `-` in the query for descending order. */
  sortable: readonly string[];
  defaultSort?: string;
  maxLimit?: number;
  /** Extra query parameters. Their validated values are applied as database filters. */
  filters?: F;
}

export const createListQuerySchema = <F extends z.ZodRawShape = Record<never, never>>({
  sortable,
  defaultSort = '-createdAt',
  maxLimit = 100,
  filters,
}: ListQueryOptions<F>) =>
  z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(maxLimit).default(20),
      sort: z
        .string()
        .default(defaultSort)
        .refine(
          (value) => value.split(',').every((field) => sortable.includes(field.replace(/^-/, ''))),
          `Sort must use: ${sortable.join(', ')}`,
        ),
      search: z.string().trim().min(1).max(100).optional(),
    })
    .extend(filters ?? ({} as F));

/** Makes a partial update schema reject a request that would change nothing. */
export const requireAtLeastOneField = <T extends z.ZodObject>(schema: T) =>
  schema.refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
