import { model } from 'mongoose';
import type { Permission } from '@/constants/permissions';
import { ROLE_DEFINITIONS, isBuiltInRole } from '@/constants/roles';
import { createSchema } from '@/core/database/createSchema';

/** A role made in the role manager. Built-in roles are defined in code, not stored. */
export interface ICustomRole {
  key: string;
  label: string;
  description: string;
  permissions: Permission[];
  createdAt: Date;
  updatedAt: Date;
}

const customRoleSchema = createSchema<ICustomRole>({
  key: { type: String, required: true, unique: true },
  label: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  permissions: { type: [String], default: [] },
});

export const CustomRoleModel = model<ICustomRole>('CustomRole', customRoleSchema);

/** An unrecognised role gets nothing, so a bad value in the database fails closed. */
export const permissionsForRole = async (role: string): Promise<readonly Permission[]> => {
  if (isBuiltInRole(role)) return ROLE_DEFINITIONS[role].permissions;
  const custom = await CustomRoleModel.findOne({ key: role }).select('permissions').lean().exec();
  return custom?.permissions ?? [];
};
