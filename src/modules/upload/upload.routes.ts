import { Router } from 'express';
import { authenticate } from '@/middlewares/auth';
import { uploadLimiter } from '@/middlewares/rateLimiter';
import { documentUploader, imageUploader } from '@/middlewares/upload';
import { uploadController } from './upload.controller';

const router = Router();

router.use(authenticate, uploadLimiter);

router.post('/images', imageUploader.single('file'), uploadController.store);
router.post('/documents', documentUploader.single('file'), uploadController.store);

export const uploadRoutes = router;
