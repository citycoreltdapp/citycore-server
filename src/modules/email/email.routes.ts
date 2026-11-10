import { Router } from 'express';
import { env } from '@/config/env';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import { createRateLimiter } from '@/middlewares/rateLimiter';
import { emailAdminController as admin } from './email.controller';

const canRead = requirePermission(Permission.EMAILS_READ);
const canSend = requirePermission(Permission.EMAILS_SEND);

const sendLimiter = createRateLimiter({
  max: env.EMAIL_SEND_RATE_LIMIT_MAX,
  message: 'Too many emails requested, please try again later',
});

const adminRouter = Router();
adminRouter.get('/stats', canRead, admin.stats);
adminRouter.post('/test', canSend, sendLimiter, admin.sendTest);
adminRouter.get('/activity', canRead, admin.listActivity);
adminRouter.get('/activity/:id', canRead, admin.getActivity);
adminRouter.post('/activity/:id/retry', canSend, sendLimiter, admin.retry);
adminRouter
  .route('/birthdays/settings')
  .get(canRead, admin.getBirthdaySettings)
  .patch(canSend, admin.updateBirthdaySettings);
adminRouter.get('/birthdays/upcoming', canRead, admin.upcomingBirthdays);
adminRouter.post('/birthdays/preview', canRead, admin.previewBirthday);
adminRouter.post('/birthdays/send', canSend, sendLimiter, admin.sendBirthdays);

const router = Router();
router.use(authenticate);
router.use('/admin', adminRouter);

export const emailRoutes = router;
