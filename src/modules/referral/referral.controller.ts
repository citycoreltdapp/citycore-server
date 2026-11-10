import { logger } from '@/config/logger';
import { controller } from '@/core/http/controller';
import { created, noContent, ok, paginated } from '@/core/http/response';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { currentUser } from '@/middlewares/auth';
import {
  applyCodeBodySchema,
  codeParamsSchema,
  createCommissionBodySchema,
  createReferralBodySchema,
  listCommissionsQuerySchema,
  listMyCommissionsQuerySchema,
  listMyReferralsQuerySchema,
  listReferralsQuerySchema,
  rejectCommissionBodySchema,
  setCodeBodySchema,
  updateCommissionBodySchema,
  updateReferralBodySchema,
} from './referral.schemas';
import { referralService as service } from './referral.service';

export const referralController = {
  /** For a signup form to check a code. It says nothing about whose code it is. */
  validateCode: controller({ params: codeParamsSchema }, async (req, res) => {
    await service.assertCodeValid(req.params.code);
    ok(res, { valid: true });
  }),

  getPage: controller({}, async (req, res) => {
    ok(res, await service.getMyPage(currentUser(req).id));
  }),

  listReferrals: controller({ query: listMyReferralsQuerySchema }, async (req, res) => {
    const { items, meta } = await service.listMine(currentUser(req).id, req.query);
    paginated(res, items, meta);
  }),

  listCommissions: controller({ query: listMyCommissionsQuerySchema }, async (req, res) => {
    const { items, meta } = await service.listMyCommissions(currentUser(req).id, req.query);
    paginated(res, items, meta);
  }),

  applyCode: controller({ body: applyCodeBodySchema }, async (req, res) => {
    ok(res, await service.applyCode(currentUser(req).id, req.body.code), 'Referral code added');
  }),

  skipPrompt: controller({}, async (req, res) => {
    ok(res, await service.skipPrompt(currentUser(req).id));
  }),
};

export const referralAdminController = {
  getStats: controller({}, async (_req, res) => {
    ok(res, await service.getStats());
  }),

  list: controller({ query: listReferralsQuerySchema }, async (req, res) => {
    const { items, meta } = await service.listAll(req.query);
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await service.getDetails(req.params.id));
  }),

  create: controller({ body: createReferralBodySchema }, async (req, res) => {
    const actorId = currentUser(req).id;
    const referral = await service.createByStaff(req.body, actorId);
    logger.info({ actorId, referee: req.body.referee }, 'Referral assigned by staff');
    created(res, referral);
  }),

  update: controller(
    { params: idParamsSchema, body: updateReferralBodySchema },
    async (req, res) => {
      const actorId = currentUser(req).id;
      const referral = await service.updateByStaff(req.params.id, req.body, actorId);
      logger.info(
        { actorId, referralId: req.params.id, changed: Object.keys(req.body) },
        'Referral updated',
      );
      ok(res, referral);
    },
  ),

  remove: controller({ params: idParamsSchema }, async (req, res) => {
    await service.removeByStaff(req.params.id);
    logger.info({ actorId: currentUser(req).id, referralId: req.params.id }, 'Referral deleted');
    noContent(res);
  }),

  listCommissions: controller({ query: listCommissionsQuerySchema }, async (req, res) => {
    const { items, meta } = await service.listCommissions(req.query);
    paginated(res, items, meta);
  }),

  getCommission: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await service.getCommission(req.params.id));
  }),

  createCommission: controller({ body: createCommissionBodySchema }, async (req, res) => {
    const actorId = currentUser(req).id;
    const commission = await service.recordInvestment(req.body, actorId);
    logger.info({ actorId, referee: req.body.referee }, 'Referral commission recorded');
    created(res, commission);
  }),

  updateCommission: controller(
    { params: idParamsSchema, body: updateCommissionBodySchema },
    async (req, res) => {
      const actorId = currentUser(req).id;
      const commission = await service.updateCommission(req.params.id, req.body, actorId);
      logger.info(
        { actorId, commissionId: req.params.id, changed: Object.keys(req.body) },
        'Referral commission updated',
      );
      ok(res, commission);
    },
  ),

  approveCommission: controller({ params: idParamsSchema }, async (req, res) => {
    const actorId = currentUser(req).id;
    const commission = await service.approveCommission(req.params.id, actorId);
    logger.info({ actorId, commissionId: req.params.id }, 'Referral commission approved');
    ok(res, commission);
  }),

  rejectCommission: controller(
    { params: idParamsSchema, body: rejectCommissionBodySchema },
    async (req, res) => {
      const actorId = currentUser(req).id;
      const commission = await service.rejectCommission(req.params.id, req.body.note, actorId);
      logger.info({ actorId, commissionId: req.params.id }, 'Referral commission rejected');
      ok(res, commission);
    },
  ),

  payCommission: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await service.payCommission(req.params.id, currentUser(req).id));
  }),

  removeCommission: controller({ params: idParamsSchema }, async (req, res) => {
    await service.removeCommission(req.params.id);
    logger.info(
      { actorId: currentUser(req).id, commissionId: req.params.id },
      'Referral commission deleted',
    );
    noContent(res);
  }),

  getUser: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await service.getUserSummary(req.params.id));
  }),

  setUserCode: controller({ params: idParamsSchema, body: setCodeBodySchema }, async (req, res) => {
    const summary = await service.setCode(req.params.id, req.body.code);
    logger.info(
      { actorId: currentUser(req).id, userId: req.params.id },
      'Referral code changed by staff',
    );
    ok(res, summary);
  }),
};
