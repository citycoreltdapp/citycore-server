import { env } from '@/config/env';
import { SYMPLUS_DOCUMENT_TYPES } from '@/constants/fileTypes';
import { createRateLimiter } from '@/middlewares/rateLimiter';
import { createUploader } from '@/middlewares/upload';

const SYMPLUS_MAX_DOCUMENT_MB = 1;

// Each call here also calls Symplus, so these have a stricter limit than the general API.
export const symplusLimiter = createRateLimiter({
  max: env.SYMPLUS_RATE_LIMIT_MAX,
  message: 'Too many core banking requests, please try again later',
});

// Kept in memory, because Symplus takes documents as base64 and they shouldn't sit on our disk.
export const documentUpload = createUploader({
  allowedTypes: SYMPLUS_DOCUMENT_TYPES,
  maxSizeMb: SYMPLUS_MAX_DOCUMENT_MB,
}).single('file');
