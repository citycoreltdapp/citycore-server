import { Router } from 'express';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import { uploadLimiter } from '@/middlewares/rateLimiter';
import { imageUploader } from '@/middlewares/upload';
import { userController } from './user.controller';

const router = Router();

router.use(authenticate);

// Defined before /:id so that "me" isn't read as an id.
router.get('/me', userController.getProfile);
router.patch('/me', userController.updateProfile);
router.put(
  '/me/avatar',
  uploadLimiter,
  imageUploader.single('avatar'),
  userController.updateAvatar,
);
router.delete('/me/avatar', userController.removeAvatar);

const canRead = requirePermission(Permission.USERS_READ);
const canWrite = requirePermission(Permission.USERS_WRITE);
const canDelete = requirePermission(Permission.USERS_DELETE);

router.route('/').get(canRead, userController.list).post(canWrite, userController.create);
router
  .route('/:id')
  .get(canRead, userController.getById)
  .patch(canWrite, userController.update)
  .delete(canDelete, userController.remove);
router
  .route('/:id/avatar')
  .put(canWrite, uploadLimiter, imageUploader.single('avatar'), userController.setUserAvatar)
  .delete(canWrite, userController.removeUserAvatar);
router.post('/:id/sign-out', canWrite, userController.signOutUser);
router.get('/:id/overview', canRead, userController.getOverview);
router.get('/:id/sessions', canRead, userController.listUserSessions);
router.delete('/:id/sessions/:sessionId', canWrite, userController.removeUserSession);

export const userRoutes = router;
