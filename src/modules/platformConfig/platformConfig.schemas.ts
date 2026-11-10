import { z } from 'zod';
import { createListQuerySchema, requireAtLeastOneField } from '@/core/validation/common.schemas';
import { CONFIG_TYPES, type ConfigType } from './platformConfig.model';

const MAX_STRING_LENGTH = 10_000;
// Well inside MongoDB's nesting limit, so a deep value gets a validation error and not a 500.
const MAX_JSON_DEPTH = 20;

const isStorableJson = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value !== 'object') return true;
  if (depth >= MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isStorableJson(item, depth + 1));
  return Object.entries(value).every(
    ([key, item]) =>
      !key.startsWith('$') &&
      !key.includes('.') &&
      key !== '__proto__' &&
      isStorableJson(item, depth + 1),
  );
};

const JSON_VALUE_MESSAGE = `Value must be an object or array, nested at most ${MAX_JSON_DEPTH} levels, with no keys that start with $, contain a dot or are __proto__`;

const VALUE_SCHEMAS: Record<ConfigType, z.ZodType> = {
  string: z.string().max(MAX_STRING_LENGTH),
  number: z.number(),
  boolean: z.boolean(),
  json: z
    .unknown()
    .refine(
      (value) => typeof value === 'object' && value !== null && isStorableJson(value),
      JSON_VALUE_MESSAGE,
    ),
};

/** Why `value` can't be stored as `type`, or null if it can. */
export const configValueError = (type: ConfigType, value: unknown): string | null => {
  const result = VALUE_SCHEMAS[type].safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? 'Invalid value');
};

export const configKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(100)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/,
    'Key must start with a letter and use only letters, numbers, underscores and dots',
  );

export const configParamsSchema = z.object({ key: configKeySchema });

const categorySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9_-]{0,49}$/,
    'Category must start with a letter and use only letters, numbers, underscores and hyphens',
  );

const fields = {
  label: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500),
  category: categorySchema,
  type: z.enum(CONFIG_TYPES),
  isPublic: z.boolean(),
};

export const listConfigsQuerySchema = createListQuerySchema({
  sortable: ['key', 'label', 'category', 'createdAt', 'updatedAt'],
  defaultSort: 'key',
  filters: {
    category: categorySchema.optional(),
    type: fields.type.optional(),
    isPublic: z.stringbool().optional(),
  },
});

export const createConfigBodySchema = z
  .object({
    key: configKeySchema,
    label: fields.label,
    description: fields.description.optional(),
    category: fields.category.optional(),
    type: fields.type,
    value: z.unknown(),
    isPublic: fields.isPublic.optional(),
  })
  .superRefine(({ type, value }, ctx) => {
    const message = configValueError(type, value);
    if (message) ctx.addIssue({ code: 'custom', path: ['value'], message });
  });

/** `value` is checked by the service, because it may have to match the type already stored. */
export const updateConfigBodySchema = requireAtLeastOneField(
  z.object({ ...fields, value: z.unknown() }).partial(),
);
