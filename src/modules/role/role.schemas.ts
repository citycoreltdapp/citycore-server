import { z } from 'zod';
import { GRANTABLE_PERMISSIONS } from '@/constants/roles';
import { requireAtLeastOneField } from '@/core/validation/common.schemas';

export const roleKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9_]{1,49}$/,
    'Role key must start with a letter and use only letters, numbers and underscores',
  );

export const roleParamsSchema = z.object({ role: roleKeySchema });

const fields = {
  label: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300),
  permissions: z
    .array(z.enum(GRANTABLE_PERMISSIONS))
    .transform((permissions) => [...new Set(permissions)]),
};

export const createRoleBodySchema = z.object({
  key: roleKeySchema,
  label: fields.label,
  description: fields.description.optional(),
  permissions: fields.permissions,
});

export const updateRoleBodySchema = requireAtLeastOneField(z.object(fields).partial());
