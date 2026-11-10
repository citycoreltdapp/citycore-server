import { Router } from 'express';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import {
  platformConfigAdminController as admin,
  platformConfigController as config,
} from './platformConfig.controller';

const canRead = requirePermission(Permission.PLATFORM_CONFIG_READ);
const canWrite = requirePermission(Permission.PLATFORM_CONFIG_WRITE);
const canDelete = requirePermission(Permission.PLATFORM_CONFIG_DELETE);

const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.route('/').get(canRead, admin.list).post(canWrite, admin.create);
adminRouter
  .route('/:key')
  .get(canRead, admin.get)
  .patch(canWrite, admin.update)
  .delete(canDelete, admin.remove);

const router = Router();
router.use('/admin', adminRouter);
router.get('/', config.listPublic);

export const platformConfigRoutes = router;
