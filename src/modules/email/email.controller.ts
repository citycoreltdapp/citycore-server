import { logger } from '@/config/logger';
import { controller } from '@/core/http/controller';
import { accepted, ok, paginated } from '@/core/http/response';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { currentUser } from '@/middlewares/auth';
import { UserModel } from '@/modules/user/user.model';
import { birthdayService } from './birthday.service';
import {
  listActivityQuerySchema,
  previewBirthdayBodySchema,
  sendBirthdayBodySchema,
  upcomingBirthdaysQuerySchema,
  updateBirthdaySettingsBodySchema,
} from './email.schemas';
import { emailService } from './email.service';
import { emailTemplates } from './email.templates';

export const emailAdminController = {
  listActivity: controller({ query: listActivityQuerySchema }, async (req, res) => {
    const { items, meta } = await emailService.listActivity(req.query);
    paginated(res, items, meta);
  }),

  getActivity: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await emailService.getActivity(req.params.id));
  }),

  stats: controller({}, async (_req, res) => {
    ok(res, await emailService.stats());
  }),

  retry: controller({ params: idParamsSchema }, async (req, res) => {
    const email = await emailService.retry(req.params.id);
    logger.info({ actorId: currentUser(req).id, emailId: req.params.id }, 'Email retried');
    accepted(res, email, 'Email queued again');
  }),

  /** Only ever to the caller's own address, so it can't be used to mail anyone else. */
  sendTest: controller({}, async (req, res) => {
    const { id } = currentUser(req);
    const user = await UserModel.findById(id).select('name email').orFail().lean().exec();
    const email = await emailService.queue({
      to: user.email,
      user: id,
      triggeredBy: id,
      email: emailTemplates.test(user.name),
    });
    accepted(res, email, 'Test email queued');
  }),

  getBirthdaySettings: controller({}, async (_req, res) => {
    ok(res, await birthdayService.getSettings());
  }),

  updateBirthdaySettings: controller(
    { body: updateBirthdaySettingsBodySchema },
    async (req, res) => {
      const actorId = currentUser(req).id;
      const settings = await birthdayService.updateSettings(req.body, actorId);
      logger.info({ actorId, changed: Object.keys(req.body) }, 'Birthday settings changed');
      ok(res, settings);
    },
  ),

  upcomingBirthdays: controller({ query: upcomingBirthdaysQuerySchema }, async (req, res) => {
    const { days, page, limit } = req.query;
    const all = await birthdayService.upcoming(days);
    const totalPages = Math.ceil(all.length / limit);
    paginated(res, all.slice((page - 1) * limit, page * limit), {
      page,
      limit,
      total: all.length,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    });
  }),

  previewBirthday: controller({ body: previewBirthdayBodySchema }, async (req, res) => {
    ok(res, await birthdayService.preview(req.body));
  }),

  sendBirthdays: controller({ body: sendBirthdayBodySchema }, async (req, res) => {
    const actorId = currentUser(req).id;
    const result = await birthdayService.send(req.body, actorId);
    logger.info({ actorId, ...result }, 'Birthday emails sent by staff');
    accepted(res, result, 'Birthday emails queued');
  }),
};
