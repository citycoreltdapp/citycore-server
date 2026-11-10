import { logger } from '@/config/logger';
import { controller } from '@/core/http/controller';
import { created, noContent, ok, paginated } from '@/core/http/response';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { currentUser } from '@/middlewares/auth';
import {
  createPlanBodySchema,
  createSubscriptionBodySchema,
  listAdminSubscriptionsQuerySchema,
  listSubscriptionsQuerySchema,
  withdrawSubscriptionBodySchema,
  listAdminPlansQuerySchema,
  listAvailablePlansQuerySchema,
  planQuoteQuerySchema,
  planSlugParamsSchema,
  updatePlanBodySchema,
} from './investment.schemas';
import { investmentService } from './investment.service';
import { subscriptionService } from './investmentSubscription.service';

export const investmentController = {
  list: controller({ query: listAvailablePlansQuerySchema }, async (req, res) => {
    const { items, meta } = await investmentService.listAvailable(req.query);
    paginated(res, items, meta);
  }),

  getBySlug: controller({ params: planSlugParamsSchema }, async (req, res) => {
    ok(res, await investmentService.getAvailableBySlug(req.params.slug));
  }),

  listCategories: controller({}, async (_req, res) => {
    ok(res, await investmentService.listAvailableCategories());
  }),

  quote: controller(
    { params: planSlugParamsSchema, query: planQuoteQuerySchema },
    async (req, res) => {
      ok(res, await investmentService.quote(req.params.slug, req.query));
    },
  ),
};

export const subscriptionController = {
  create: controller({ body: createSubscriptionBodySchema }, async (req, res) => {
    const { planId, units, amount, idempotencyKey } = req.body;
    const { subscription, replayed } = await subscriptionService.invest(currentUser(req).id, {
      planId,
      units,
      amount,
      idempotencyKey,
    });
    if (replayed) ok(res, subscription);
    else created(res, subscription);
  }),

  list: controller({ query: listSubscriptionsQuerySchema }, async (req, res) => {
    const { items, meta } = await subscriptionService.paginate(req.query, {
      user: currentUser(req).id,
    });
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await subscriptionService.getOwn(currentUser(req).id, req.params.id));
  }),

  withdrawalQuote: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await subscriptionService.quoteWithdrawal(currentUser(req).id, req.params.id));
  }),

  withdraw: controller(
    { params: idParamsSchema, body: withdrawSubscriptionBodySchema },
    async (req, res) => {
      const actorId = currentUser(req).id;
      const subscription = await subscriptionService.withdraw(actorId, req.params.id);
      logger.info({ actorId, subscriptionId: subscription.id }, 'Investment withdrawn early');
      ok(res, subscription);
    },
  ),
};

export const subscriptionAdminController = {
  list: controller({ query: listAdminSubscriptionsQuerySchema }, async (req, res) => {
    const { items, meta } = await subscriptionService.listAll(req.query);
    paginated(res, items, meta);
  }),

  summary: controller({}, async (_req, res) => {
    ok(res, await subscriptionService.summary());
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await subscriptionService.getWithUser(req.params.id));
  }),
};

export const investmentAdminController = {
  list: controller({ query: listAdminPlansQuerySchema }, async (req, res) => {
    const { items, meta } = await investmentService.listAll(req.query);
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await investmentService.findById(req.params.id));
  }),

  create: controller({ body: createPlanBodySchema }, async (req, res) => {
    const actorId = currentUser(req).id;
    const plan = await investmentService.createPlan(req.body, actorId);
    logger.info({ actorId, planId: plan.id }, 'Investment plan created');
    created(res, plan);
  }),

  update: controller({ params: idParamsSchema, body: updatePlanBodySchema }, async (req, res) => {
    const plan = await investmentService.updatePlan(req.params.id, req.body);
    logger.info(
      { actorId: currentUser(req).id, planId: plan.id, changed: Object.keys(req.body) },
      'Investment plan updated',
    );
    ok(res, plan);
  }),

  remove: controller({ params: idParamsSchema }, async (req, res) => {
    await investmentService.deleteById(req.params.id);
    logger.info({ actorId: currentUser(req).id, planId: req.params.id }, 'Investment plan deleted');
    noContent(res);
  }),
};
