import type { RequestHandler } from 'express';
import { controller } from '@/core/http/controller';
import { ok, paginated } from '@/core/http/response';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { currentUser } from '@/middlewares/auth';
import { requireStoredFile } from '@/middlewares/upload';
import {
  approveBodySchema,
  detailsBodySchema,
  listVerificationsQuerySchema,
  ninBodySchema,
  rejectBodySchema,
} from './kyc.schemas';
import { kycService, type KycDocumentKind } from './kyc.service';

/** Checks the upload is allowed before the file is received, so nothing refused gets stored. */
export const kycUploadGuard: RequestHandler = async (req, _res, next) => {
  await kycService.assertCanUpload(currentUser(req).id);
  next();
};

const uploadDocument = (kind: KycDocumentKind, message: string) =>
  controller({}, async (req, res) => {
    const file = requireStoredFile(req);
    ok(res, await kycService.saveDocument(currentUser(req).id, kind, file), message);
  });

export const kycController = {
  getState: controller({}, async (req, res) => {
    ok(res, await kycService.getState(currentUser(req).id));
  }),

  verifyNin: controller({ body: ninBodySchema }, async (req, res) => {
    ok(res, await kycService.verifyNin(currentUser(req).id, req.body.nin), 'NIN verified');
  }),

  saveDetails: controller({ body: detailsBodySchema }, async (req, res) => {
    ok(res, await kycService.saveDetails(currentUser(req).id, req.body), 'Details saved');
  }),

  uploadPassportPhoto: uploadDocument('passportPhoto', 'Passport photograph uploaded'),
  uploadUtilityBill: uploadDocument('utilityBill', 'Utility bill uploaded'),

  submit: controller({}, async (req, res) => {
    ok(
      res,
      await kycService.submit(currentUser(req).id),
      'Submitted. We will let you know once it has been reviewed',
    );
  }),
};

export const kycAdminController = {
  list: controller({ query: listVerificationsQuerySchema }, async (req, res) => {
    const { items, meta } = await kycService.list(req.query);
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await kycService.getForReview(req.params.id));
  }),

  approve: controller({ params: idParamsSchema, body: approveBodySchema }, async (req, res) => {
    const result = await kycService.approve(currentUser(req).id, req.params.id, req.body.note);
    ok(res, result, 'Verification approved');
  }),

  reject: controller({ params: idParamsSchema, body: rejectBodySchema }, async (req, res) => {
    const { reason, note } = req.body;
    const result = await kycService.reject(currentUser(req).id, req.params.id, reason, note);
    ok(res, result, 'Verification rejected');
  }),
};
