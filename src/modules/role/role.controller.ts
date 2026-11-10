import { logger } from '@/config/logger';
import { controller } from '@/core/http/controller';
import { created, noContent, ok } from '@/core/http/response';
import { currentUser } from '@/middlewares/auth';
import { createRoleBodySchema, roleParamsSchema, updateRoleBodySchema } from './role.schemas';
import { roleService } from './role.service';

export const roleController = {
  list: controller({}, async (req, res) => {
    ok(res, await roleService.list(currentUser(req).role));
  }),

  get: controller({ params: roleParamsSchema }, async (req, res) => {
    ok(res, await roleService.get(currentUser(req).role, req.params.role));
  }),

  create: controller({ body: createRoleBodySchema }, async (req, res) => {
    const actor = currentUser(req);
    const role = await roleService.createRole(actor.role, req.body);
    logger.info({ actorId: actor.id, role: role.role }, 'Role created');
    created(res, role);
  }),

  update: controller({ params: roleParamsSchema, body: updateRoleBodySchema }, async (req, res) => {
    const actor = currentUser(req);
    const role = await roleService.updateRole(actor.role, req.params.role, req.body);
    logger.info({ actorId: actor.id, role: role.role, changes: req.body }, 'Role updated');
    ok(res, role);
  }),

  remove: controller({ params: roleParamsSchema }, async (req, res) => {
    await roleService.removeRole(req.params.role);
    logger.info({ actorId: currentUser(req).id, role: req.params.role }, 'Role deleted');
    noContent(res);
  }),
};
