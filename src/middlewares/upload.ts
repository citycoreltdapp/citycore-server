import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import { env } from '@/config/env';
import { DOCUMENT_TYPES, FILE_TYPES, IMAGE_TYPES, type MimeType } from '@/constants/fileTypes';
import { AppError } from '@/core/errors/AppError';
import { cloudinaryStorage } from '@/integrations/cloudinary/cloudinary.client';
import { getUploadedFiles } from '@/utils/file';

interface UploaderOptions {
  /** Folder in Cloudinary. Omit to only keep the file in memory, as `req.file.buffer`. */
  subdirectory?: string;
  allowedTypes: readonly MimeType[];
  maxSizeMb: number;
}

const isAllowed = (mimetype: string, allowed: readonly MimeType[]): mimetype is MimeType =>
  (allowed as readonly string[]).includes(mimetype);

const verifyFileContents: RequestHandler = (req, _res, next) => {
  for (const file of getUploadedFiles(req)) {
    if (!FILE_TYPES[file.mimetype as MimeType].matches(file.buffer)) {
      throw AppError.badRequest('File contents do not match its type', 'INVALID_FILE_CONTENT');
    }
  }
  next();
};

// After verification, so that nothing unchecked ever reaches storage. Waits for every upload to
// settle, so that the error handler can delete the ones that succeeded.
const storeFiles =
  (subdirectory: string): RequestHandler =>
  async (req, _res, next) => {
    const uploads = getUploadedFiles(req).map(async (file) => {
      file.url = await cloudinaryStorage.upload({
        buffer: file.buffer,
        mimeType: file.mimetype,
        subdirectory,
        extension: FILE_TYPES[file.mimetype as MimeType].extension,
      });
    });
    for (const result of await Promise.allSettled(uploads)) {
      if (result.status === 'rejected') throw result.reason;
    }
    next();
  };

export const createUploader = ({ subdirectory, allowedTypes, maxSizeMb }: UploaderOptions) => {
  const instance = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMb * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      if (isAllowed(file.mimetype, allowedTypes)) {
        callback(null, true);
        return;
      }
      callback(
        AppError.badRequest(
          `Unsupported file type. Allowed: ${allowedTypes.join(', ')}`,
          'UNSUPPORTED_FILE_TYPE',
        ),
      );
    },
  });

  const afterReceiving = subdirectory
    ? [verifyFileContents, storeFiles(subdirectory)]
    : [verifyFileContents];

  return {
    single: (field: string): RequestHandler[] => [instance.single(field), ...afterReceiving],
    array: (field: string, maxCount: number): RequestHandler[] => [
      instance.array(field, maxCount),
      ...afterReceiving,
    ],
  };
};

export const imageUploader = createUploader({
  subdirectory: 'images',
  allowedTypes: IMAGE_TYPES,
  maxSizeMb: env.MAX_IMAGE_SIZE_MB,
});

export const documentUploader = createUploader({
  subdirectory: 'documents',
  allowedTypes: DOCUMENT_TYPES,
  maxSizeMb: env.MAX_DOCUMENT_SIZE_MB,
});

/** The uploaded file. For handlers on routes behind `uploader.single()`. */
export const requireFile = (req: Pick<Request, 'file'>): Express.Multer.File => {
  if (!req.file) throw AppError.badRequest('A file is required', 'FILE_REQUIRED');
  return req.file;
};

/** The uploaded file and its URL. For handlers on routes whose uploader has a `subdirectory`. */
export const requireStoredFile = (
  req: Pick<Request, 'file'>,
): Express.Multer.File & { url: string } => {
  const file = requireFile(req);
  if (!file.url) throw AppError.internal();
  return file as Express.Multer.File & { url: string };
};
