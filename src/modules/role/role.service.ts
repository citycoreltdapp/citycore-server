import { PERMISSIONS } from '@/constants/permissions';
import {
  GRANTABLE_PERMISSIONS,
  ROLES,
  ROLE_DEFINITIONS,
  STAFF_LEVEL,
  canManageRole,
  isBuiltInRole,
} from '@/constants/roles';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import { UserModel } from '@/modules/user/user.model';
import { CustomRoleModel, type ICustomRole } from './role.model';

const assertCustom = (key: string): void => {
  if (isBuiltInRole(key)) {
    throw AppError.forbidden('Built-in roles cannot be changed', 'ROLE_LOCKED');
  }
};

class RoleService extends BaseService<ICustomRole> {
  constructor() {
    super(CustomRoleModel, { resourceName: 'Role' });
  }

  async exists(key: string): Promise<boolean> {
    return isBuiltInRole(key) || (await CustomRoleModel.exists({ key })) !== null;
  }

  private async findCustom(key: string) {
    const role = await this.findOne({ key });
    if (!role) throw this.notFound();
    return role;
  }

  private async describe(actorRole: string, role: string, details: object, builtIn: boolean) {
    return {
      role,
      ...details,
      builtIn,
      assignable: canManageRole(actorRole, role),
      userCount: await UserModel.countDocuments({ role }).exec(),
    };
  }

  private describeCustom(actorRole: string, role: ICustomRole) {
    const { key, label, description, permissions, createdAt, updatedAt } = role;
    const details = { label, description, level: STAFF_LEVEL, permissions, createdAt, updatedAt };
    return this.describe(actorRole, key, details, false);
  }

  async list(actorRole: string) {
    const custom = await CustomRoleModel.find().sort('label').exec();
    return {
      permissions: PERMISSIONS,
      grantablePermissions: GRANTABLE_PERMISSIONS,
      roles: await Promise.all([
        ...ROLES.map((role) => this.describe(actorRole, role, ROLE_DEFINITIONS[role], true)),
        ...custom.map((role) => this.describeCustom(actorRole, role)),
      ]),
    };
  }

  async get(actorRole: string, key: string) {
    return isBuiltInRole(key)
      ? this.describe(actorRole, key, ROLE_DEFINITIONS[key], true)
      : this.describeCustom(actorRole, await this.findCustom(key));
  }

  async createRole(actorRole: string, data: Partial<ICustomRole> & { key: string }) {
    if (isBuiltInRole(data.key)) {
      throw AppError.conflict('A built-in role already uses that key', 'DUPLICATE_VALUE');
    }
    return this.describeCustom(actorRole, await this.create(data));
  }

  async updateRole(actorRole: string, key: string, data: Partial<ICustomRole>) {
    assertCustom(key);
    const role = await this.findCustom(key);
    role.set(data);
    await role.save();
    return this.describeCustom(actorRole, role);
  }

  async removeRole(key: string): Promise<void> {
    assertCustom(key);
    const role = await this.findCustom(key);
    const holders = await UserModel.countDocuments({ role: key }).exec();
    if (holders > 0) {
      throw AppError.conflict(
        `${holders} user(s) still hold this role. Move them to another role first`,
        'ROLE_IN_USE',
      );
    }
    await role.deleteOne();
  }
}

export const roleService = new RoleService();
