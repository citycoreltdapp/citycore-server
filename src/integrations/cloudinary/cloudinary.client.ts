import { randomUUID } from 'node:crypto';
import { v2 as cloudinary, type UploadApiErrorResponse, type UploadApiResponse } from 'cloudinary';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { HttpStatus } from '@/constants/http';
import { AppError } from '@/core/errors/AppError';

// The SDK reads CLOUDINARY_URL when first loaded, which can be before dotenv has run.
cloudinary.config(true);

const cloudName = env.CLOUDINARY_URL ? new URL(env.CLOUDINARY_URL).hostname : undefined;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only plain delivery URLs of files this server stored: no transformations, no other accounts.
const STORED_URL = new RegExp(
  `^https://res\\.cloudinary\\.com/${escapeRegex(cloudName ?? '')}/(image|raw)/upload/v\\d+/` +
    `(${escapeRegex(env.CLOUDINARY_FOLDER)}/(?:images|documents)/[0-9a-f-]{36}(\\.[a-z0-9]+)?)$`,
);

const parseStoredUrl = (url: string) => {
  const match = cloudName ? STORED_URL.exec(url) : null;
  if (!match) return null;
  const [, resourceType, path, extension] = match as unknown as [string, string, string, string?];
  // An image's public id has no extension. A raw file's includes it.
  const publicId = resourceType === 'image' && extension ? path.slice(0, -extension.length) : path;
  return { resourceType, publicId };
};

export interface UploadInput {
  buffer: Buffer;
  mimeType: string;
  /** Folder under CLOUDINARY_FOLDER. */
  subdirectory: string;
  /** Used by files Cloudinary doesn't treat as images, whose URLs would otherwise have none. */
  extension: string;
}

export const cloudinaryStorage = {
  isStoredUrl: (url: string): boolean => parseStoredUrl(url) !== null,

  /** Sends a file to Cloudinary under a generated name and returns its https URL. */
  upload: ({ buffer, mimeType, subdirectory, extension }: UploadInput): Promise<string> => {
    if (!cloudName) {
      throw new AppError(
        'File storage is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
        'STORAGE_NOT_CONFIGURED',
      );
    }
    const isImage = mimeType.startsWith('image/');
    const folder = `${env.CLOUDINARY_FOLDER}/${subdirectory}`;

    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            resource_type: isImage ? 'image' : 'raw',
            public_id: `${folder}/${randomUUID()}${isImage ? '' : extension}`,
            overwrite: false,
            timeout: env.CLOUDINARY_TIMEOUT_MS,
          },
          (error?: UploadApiErrorResponse, result?: UploadApiResponse) => {
            if (result && !error) {
              resolve(result.secure_url);
              return;
            }
            logger.error({ err: error }, 'Cloudinary upload failed');
            reject(
              error?.http_code === HttpStatus.BAD_REQUEST
                ? AppError.badRequest('The file could not be processed', 'INVALID_FILE_CONTENT')
                : new AppError(
                    'The file could not be stored, please try again',
                    HttpStatus.BAD_GATEWAY,
                    'STORAGE_UPLOAD_FAILED',
                  ),
            );
          },
        )
        .end(buffer);
    });
  },

  /** Deletes a stored file without failing the caller. Other URLs are left alone. */
  remove: async (url: string): Promise<void> => {
    const stored = parseStoredUrl(url);
    if (!stored) return;
    try {
      await cloudinary.uploader.destroy(stored.publicId, {
        resource_type: stored.resourceType,
        invalidate: true,
      });
    } catch (err) {
      logger.warn({ err, url }, 'Failed to remove file from Cloudinary');
    }
  },
};
