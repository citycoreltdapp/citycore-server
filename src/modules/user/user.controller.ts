import { logger } from '@/config/logger';
import { Permission } from '@/constants/permissions';
import { Role, canManageRole } from '@/constants/roles';
import { createCrudController } from '@/core/base/createCrudController';
import { AppError } from '@/core/errors/AppError';
import { controller } from '@/core/http/controller';
import { created, noContent, ok } from '@/core/http/response';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { currentUser, hasPermission } from '@/middlewares/auth';
import { requireStoredFile } from '@/middlewares/upload';
import { authService } from '@/modules/auth/auth.service';
import { sessionService } from '@/modules/auth/session.service';
import { emailNotifications } from '@/modules/email/email.notifications';
import { roleService } from '@/modules/role/role.service';
import type { IUser } from './user.model';
import {
  createUserBodySchema,
  listUsersQuerySchema,
  updateProfileBodySchema,
  updateUserBodySchema,
  userSessionParamsSchema,
} from './user.schemas';
import { userService } from './user.service';

const crud = createCrudController<IUser>(userService, {
  listQuery: listUsersQuerySchema,
  createBody: createUserBodySchema,
  updateBody: updateUserBodySchema,
});

/** Stops anyone granting a role unless they hold the permission and outrank that role. */
const assertCanAssignRole = async (actor: Express.AuthUser, role: string): Promise<void> => {
  if (!hasPermission(actor, Permission.USERS_ASSIGN_ROLE)) {
    throw AppError.forbidden('You cannot assign roles', 'ROLE_ASSIGNMENT_FORBIDDEN');
  }
  if (!(await roleService.exists(role))) {
    throw AppError.validation([{ path: 'body.role', message: `Unknown role: ${role}` }]);
  }
  if (!canManageRole(actor.role, role)) {
    throw AppError.forbidden(`You cannot assign the ${role} role`, 'ROLE_ASSIGNMENT_FORBIDDEN');
  }
};

/** Stops anyone changing or deleting an account at or above their own level. */
const assertCanManageUser = async (actor: Express.AuthUser, targetId: string): Promise<string> => {
  const { role } = await userService.findById(targetId);
  if (!canManageRole(actor.role, role)) {
    throw AppError.forbidden('You cannot manage this user', 'USER_MANAGEMENT_FORBIDDEN');
  }
  return role;
};

/** Stops an admin from demoting, deactivating or deleting themselves and losing access. */
const assertNotSelf = (targetId: string, actorId: string): void => {
  if (targetId === actorId) {
    throw AppError.forbidden(
      'Use your profile to manage your own account',
      'SELF_ACTION_FORBIDDEN',
    );
  }
};

export const userController = {
  list: crud.list,
  getById: crud.getById,

  create: controller({ body: createUserBodySchema }, async (req, res) => {
    const actor = currentUser(req);
    const { role } = req.body;
    // Every account can be a plain customer, so that alone needs no extra permission.
    if (role && role !== Role.USER) await assertCanAssignRole(actor, role);

    const user = await userService.create(req.body);
    await emailNotifications.accountCreatedByStaff(user);
    if (role && role !== Role.USER) {
      logger.info({ actorId: actor.id, targetId: user.id, to: role }, 'User created with a role');
    }
    created(res, user);
  }),

  update: controller({ params: idParamsSchema, body: updateUserBodySchema }, async (req, res) => {
    const actor = currentUser(req);
    assertNotSelf(req.params.id, actor.id);
    const previousRole = await assertCanManageUser(actor, req.params.id);
    const { role, email } = req.body;
    if (role && role !== previousRole) await assertCanAssignRole(actor, role);
    const { email: previousEmail } = await userService.findById(req.params.id);
    const emailChanging = !!email && email !== previousEmail;
    if (emailChanging) await userService.assertEmailNotLocked(req.params.id);

    const user = await userService.updateById(req.params.id, req.body);
    if (emailChanging) {
      await emailNotifications.emailChanged(user, previousEmail);
      await emailNotifications.verificationCode(user);
    }
    // Otherwise their tokens would start working again the moment they're reactivated.
    if (req.body.isActive === false) {
      await authService.logoutEverywhere(req.params.id);
      logger.info({ actorId: actor.id, targetId: user.id }, 'User deactivated');
    }
    if (role && role !== previousRole) {
      logger.info(
        { actorId: actor.id, targetId: user.id, from: previousRole, to: role },
        'User role changed',
      );
    }
    ok(res, user);
  }),

  remove: controller({ params: idParamsSchema }, async (req, res) => {
    const actor = currentUser(req);
    assertNotSelf(req.params.id, actor.id);
    const role = await assertCanManageUser(actor, req.params.id);
    await userService.deleteById(req.params.id);
    logger.info({ actorId: actor.id, targetId: req.params.id, role }, 'User deleted');
    noContent(res);
  }),

  getProfile: controller({}, async (req, res) => {
    ok(res, await userService.findById(currentUser(req).id));
  }),

  updateProfile: controller({ body: updateProfileBodySchema }, async (req, res) => {
    const actor = currentUser(req);
    const data = { ...req.body };
    // Customers have no job here. Anyone else may have nobody above them to set it.
    if (actor.role === Role.USER) {
      delete data.jobTitle;
      delete data.department;
    }
    if (Object.keys(data).length === 0) {
      throw AppError.forbidden('Only staff have work details', 'WORK_DETAILS_FORBIDDEN');
    }
    ok(res, await userService.updateById(actor.id, data));
  }),

  updateAvatar: controller({}, async (req, res) => {
    const file = requireStoredFile(req);
    ok(res, await userService.replaceAvatar(currentUser(req).id, file.url));
  }),

  removeAvatar: controller({}, async (req, res) => {
    ok(res, await userService.removeAvatar(currentUser(req).id));
  }),

  // Staff acting on someone else's profile. Rejected uploads are removed by the error middleware.

  setUserAvatar: controller({ params: idParamsSchema }, async (req, res) => {
    const actor = currentUser(req);
    assertNotSelf(req.params.id, actor.id);
    await assertCanManageUser(actor, req.params.id);
    const file = requireStoredFile(req);
    const user = await userService.replaceAvatar(req.params.id, file.url);
    logger.info({ actorId: actor.id, targetId: user.id }, 'User avatar replaced');
    ok(res, user);
  }),

  removeUserAvatar: controller({ params: idParamsSchema }, async (req, res) => {
    const actor = currentUser(req);
    assertNotSelf(req.params.id, actor.id);
    await assertCanManageUser(actor, req.params.id);
    const user = await userService.removeAvatar(req.params.id);
    logger.info({ actorId: actor.id, targetId: user.id }, 'User avatar removed');
    ok(res, user);
  }),

  getOverview: controller({ params: idParamsSchema }, async (req, res) => {
    const actor = currentUser(req);
    ok(
      res,
      await userService.getOverview(req.params.id, {
        wallet: hasPermission(actor, Permission.WALLET_READ),
        banking: hasPermission(actor, Permission.CUSTOMERS_READ),
        tickets: hasPermission(actor, Permission.HELPDESK_READ),
        investments: hasPermission(actor, Permission.INVESTMENTS_READ),
      }),
    );
  }),

  listUserSessions: controller({ params: idParamsSchema }, async (req, res) => {
    const actor = currentUser(req);
    assertNotSelf(req.params.id, actor.id);
    await assertCanManageUser(actor, req.params.id);
    ok(res, await sessionService.listActive(req.params.id));
  }),

  removeUserSession: controller({ params: userSessionParamsSchema }, async (req, res) => {
    const actor = currentUser(req);
    assertNotSelf(req.params.id, actor.id);
    await assertCanManageUser(actor, req.params.id);
    await sessionService.removeOwned(req.params.id, req.params.sessionId);
    logger.info(
      { actorId: actor.id, targetId: req.params.id, sessionId: req.params.sessionId },
      'User session ended by staff',
    );
    noContent(res);
  }),

  signOutUser: controller({ params: idParamsSchema }, async (req, res) => {
    const actor = currentUser(req);
    assertNotSelf(req.params.id, actor.id);
    await assertCanManageUser(actor, req.params.id);
    await authService.logoutEverywhere(req.params.id);
    logger.info({ actorId: actor.id, targetId: req.params.id }, 'User signed out by staff');
    noContent(res);
  }),
};
