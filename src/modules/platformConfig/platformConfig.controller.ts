import { logger } from '@/config/logger';
import { controller } from '@/core/http/controller';
import { created, noContent, ok, paginated } from '@/core/http/response';
import { currentUser } from '@/middlewares/auth';
import {
  configParamsSchema,
  createConfigBodySchema,
  listConfigsQuerySchema,
  updateConfigBodySchema,
} from './platformConfig.schemas';
import { platformConfigService } from './platformConfig.service';

export const platformConfigController = {
  listPublic: controller({}, async (_req, res) => {
    ok(res, await platformConfigService.publicValues());
  }),
};

export const platformConfigAdminController = {
  list: controller({ query: listConfigsQuerySchema }, async (req, res) => {
    const { items, meta } = await platformConfigService.paginate(req.query);
    paginated(res, items, meta);
  }),

  get: controller({ params: configParamsSchema }, async (req, res) => {
    ok(res, await platformConfigService.getByKey(req.params.key));
  }),

  create: controller({ body: createConfigBodySchema }, async (req, res) => {
    const actorId = currentUser(req).id;
    const config = await platformConfigService.createConfig(req.body, actorId);
    logger.info({ actorId, key: config.key }, 'Platform config created');
    created(res, config);
  }),

  update: controller(
    { params: configParamsSchema, body: updateConfigBodySchema },
    async (req, res) => {
      const actorId = currentUser(req).id;
      const { key } = req.params;
      const config = await platformConfigService.updateConfig(key, req.body, actorId);
      logger.info({ actorId, key, changes: req.body }, 'Platform config updated');
      ok(res, config);
    },
  ),

  remove: controller({ params: configParamsSchema }, async (req, res) => {
    await platformConfigService.removeConfig(req.params.key);
    logger.info({ actorId: currentUser(req).id, key: req.params.key }, 'Platform config deleted');
    noContent(res);
  }),
};
