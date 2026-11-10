import type { Request } from 'express';
import { cloudinaryStorage } from '@/integrations/cloudinary/cloudinary.client';

/** Every file multer accepted for this request, whichever of its methods was used. */
export const getUploadedFiles = (req: Request): Express.Multer.File[] => {
  const files = req.files ? Object.values(req.files).flat() : [];
  return req.file ? [req.file, ...files] : files;
};

/** Deletes whatever this request has already sent to storage. */
export const removeUploadedFiles = async (req: Request): Promise<void> => {
  const urls = getUploadedFiles(req).flatMap((file) => file.url ?? []);
  await Promise.all(urls.map((url) => cloudinaryStorage.remove(url)));
};
