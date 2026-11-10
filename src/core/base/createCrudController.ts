import type { ZodType } from 'zod';
import { controller } from '@/core/http/controller';
import { created, noContent, ok, paginated } from '@/core/http/response';
import { idParamsSchema, type ListQuery } from '@/core/validation/common.schemas';
import type { BaseService } from './BaseService';

interface CrudSchemas<T> {
  listQuery: ZodType<ListQuery>;
  createBody: ZodType<Partial<T>>;
  updateBody: ZodType<Partial<T>>;
}

/** Standard list/get/create/update/delete handlers for any service built on BaseService. */
export const createCrudController = <T>(service: BaseService<T>, schemas: CrudSchemas<T>) => ({
  list: controller({ query: schemas.listQuery }, async (req, res) => {
    const { items, meta } = await service.paginate(req.query);
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await service.findById(req.params.id));
  }),

  create: controller({ body: schemas.createBody }, async (req, res) => {
    created(res, await service.create(req.body));
  }),

  update: controller({ params: idParamsSchema, body: schemas.updateBody }, async (req, res) => {
    ok(res, await service.updateById(req.params.id, req.body));
  }),

  remove: controller({ params: idParamsSchema }, async (req, res) => {
    await service.deleteById(req.params.id);
    noContent(res);
  }),
});
