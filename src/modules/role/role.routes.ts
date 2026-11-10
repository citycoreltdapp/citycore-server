import { Router } from 'express';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import { roleController } from './role.controller';

const router = Router();

const canRead = requirePermission(Permission.ROLES_READ);
const canWrite = requirePermission(Permission.ROLES_WRITE);

router.use(authenticate);

router.route('/').get(canRead, roleController.list).post(canWrite, roleController.create);
router
  .route('/:role')
  .get(canRead, roleController.get)
  .patch(canWrite, roleController.update)
  .delete(canWrite, roleController.remove);

export const roleRoutes = router;
