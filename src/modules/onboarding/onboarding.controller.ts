import { controller } from '@/core/http/controller';
import { accepted, created, ok } from '@/core/http/response';
import { currentUser } from '@/middlewares/auth';
import { requireFile } from '@/middlewares/upload';
import { onboardBodySchema, selfDocumentBodySchema } from '@/modules/symplus/symplus.schemas';
import { symplusService } from '@/modules/symplus/symplus.service';
import { onboardingService } from './onboarding.service';

export const onboardingController = {
  getState: controller({}, async (req, res) => {
    ok(res, await onboardingService.getState(currentUser(req).id));
  }),

  submitDetails: controller({ body: onboardBodySchema }, async (req, res) => {
    const userId = currentUser(req).id;
    const { queued } = await symplusService.onboard(userId, req.body);
    const state = await onboardingService.getState(userId);

    if (queued) {
      accepted(
        res,
        state,
        'Core banking is unavailable, so your details will be sent automatically',
      );
    } else {
      created(res, state, 'Your details have been submitted');
    }
  }),

  uploadDocument: controller({ body: selfDocumentBodySchema }, async (req, res) => {
    const userId = currentUser(req).id;
    await symplusService.uploadOwnDocument(userId, req.body.document_type, requireFile(req));
    created(res, await onboardingService.getState(userId), 'Document uploaded');
  }),

  refresh: controller({}, async (req, res) => {
    ok(res, await onboardingService.refresh(currentUser(req).id));
  }),
};
