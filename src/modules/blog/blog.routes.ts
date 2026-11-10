import { Router } from 'express';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import { blogAdminController as admin, blogController as blog } from './blog.controller';

const canRead = requirePermission(Permission.CONTENT_READ);
const canWrite = requirePermission(Permission.CONTENT_WRITE);
const canPublish = requirePermission(Permission.CONTENT_PUBLISH);
const canDelete = requirePermission(Permission.CONTENT_DELETE);

const adminRouter = Router();
adminRouter.use(authenticate);
adminRouter.route('/posts').get(canRead, admin.list).post(canWrite, admin.create);
adminRouter
  .route('/posts/:id')
  .get(canRead, admin.getById)
  .patch(canWrite, admin.update)
  .delete(canDelete, admin.remove);
adminRouter.post('/posts/:id/publish', canPublish, admin.publish);
adminRouter.post('/posts/:id/unpublish', canPublish, admin.unpublish);
adminRouter.post('/posts/:id/archive', canPublish, admin.archive);

const router = Router();
router.use('/admin', adminRouter);

router.get('/posts', blog.list);
router.get('/posts/:slug', blog.getBySlug);
router.get('/categories', blog.listCategories);
router.get('/tags', blog.listTags);

export const blogRoutes = router;
