import { controller } from '@/core/http/controller';
import { created, noContent, ok, paginated } from '@/core/http/response';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { currentUser } from '@/middlewares/auth';
import { requireStoredFile } from '@/middlewares/upload';
import type { MediaKind } from './media.model';
import {
  listMediaQuerySchema,
  updateMediaBodySchema,
  uploadMediaBodySchema,
} from './media.schemas';
import { mediaService } from './media.service';

const uploadAs = (kind: MediaKind) =>
  controller({ body: uploadMediaBodySchema }, async (req, res) => {
    const file = requireStoredFile(req);
    const media = await mediaService.create({
      ...req.body,
      kind,
      url: file.url,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      uploadedBy: currentUser(req).id as never,
    });
    created(res, media);
  });

export const mediaController = {
  uploadImage: uploadAs('image'),
  uploadDocument: uploadAs('document'),

  list: controller({ query: listMediaQuerySchema }, async (req, res) => {
    const { items, meta } = await mediaService.paginate(req.query);
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await mediaService.findById(req.params.id));
  }),

  update: controller({ params: idParamsSchema, body: updateMediaBodySchema }, async (req, res) => {
    ok(res, await mediaService.updateById(req.params.id, req.body));
  }),

  remove: controller({ params: idParamsSchema }, async (req, res) => {
    await mediaService.deleteById(req.params.id);
    noContent(res);
  }),
};
