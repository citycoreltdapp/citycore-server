import { Router } from 'express';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import { uploadLimiter } from '@/middlewares/rateLimiter';
import { documentUploader, imageUploader } from '@/middlewares/upload';
import { mediaController } from './media.controller';

const canRead = requirePermission(Permission.MEDIA_READ);
const canWrite = requirePermission(Permission.MEDIA_WRITE);

const router = Router();

router.use(authenticate);

// The permission check comes first, so a refused request never stores a file.
router.post(
  '/images',
  canWrite,
  uploadLimiter,
  imageUploader.single('file'),
  mediaController.uploadImage,
);
router.post(
  '/documents',
  canWrite,
  uploadLimiter,
  documentUploader.single('file'),
  mediaController.uploadDocument,
);

router.get('/', canRead, mediaController.list);
router
  .route('/:id')
  .get(canRead, mediaController.getById)
  .patch(canWrite, mediaController.update)
  .delete(requirePermission(Permission.MEDIA_DELETE), mediaController.remove);

export const mediaRoutes = router;
