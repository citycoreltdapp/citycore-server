import { controller } from '@/core/http/controller';
import { created } from '@/core/http/response';
import { requireStoredFile } from '@/middlewares/upload';

export const uploadController = {
  /** Shared by every upload route. The uploader in front of it decides what's accepted. */
  store: controller({}, (req, res) => {
    const file = requireStoredFile(req);
    created(res, {
      url: file.url,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    });
  }),
};
