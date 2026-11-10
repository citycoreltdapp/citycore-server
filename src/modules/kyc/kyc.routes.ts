import { Router } from 'express';
import { env } from '@/config/env';
import { KYC_DOCUMENT_TYPES, KYC_PHOTO_TYPES } from '@/constants/fileTypes';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import { createRateLimiter, uploadLimiter } from '@/middlewares/rateLimiter';
import { createUploader } from '@/middlewares/upload';
import {
  kycAdminController as admin,
  kycController as kyc,
  kycUploadGuard,
} from './kyc.controller';

// Each NIN check is a billed call to Dojah.
const kycLimiter = createRateLimiter({
  max: env.KYC_RATE_LIMIT_MAX,
  message: 'Too many verification attempts, please try again later',
});

// Under images/ and documents/, so the files are cleaned up like any other upload.
const passportPhotoUpload = createUploader({
  subdirectory: 'images',
  allowedTypes: KYC_PHOTO_TYPES,
  maxSizeMb: env.MAX_IMAGE_SIZE_MB,
}).single('file');

const utilityBillUpload = createUploader({
  subdirectory: 'documents',
  allowedTypes: KYC_DOCUMENT_TYPES,
  maxSizeMb: env.MAX_DOCUMENT_SIZE_MB,
}).single('file');

const router = Router();

router.use(authenticate);

router.get('/admin/verifications', requirePermission(Permission.CUSTOMERS_READ), admin.list);
router.get(
  '/admin/verifications/:id',
  requirePermission(Permission.CUSTOMERS_READ, Permission.CUSTOMERS_DOCUMENTS_READ),
  admin.getById,
);
router.post(
  '/admin/verifications/:id/approve',
  requirePermission(Permission.CUSTOMERS_WRITE),
  admin.approve,
);
router.post(
  '/admin/verifications/:id/reject',
  requirePermission(Permission.CUSTOMERS_WRITE),
  admin.reject,
);

router.get('/', kyc.getState);
router.post('/nin', kycLimiter, kyc.verifyNin);
router.put('/details', kyc.saveDetails);
router.put(
  '/passport-photo',
  uploadLimiter,
  kycUploadGuard,
  ...passportPhotoUpload,
  kyc.uploadPassportPhoto,
);
router.put(
  '/utility-bill',
  uploadLimiter,
  kycUploadGuard,
  ...utilityBillUpload,
  kyc.uploadUtilityBill,
);
router.post('/submit', kyc.submit);

export const kycRoutes = router;
