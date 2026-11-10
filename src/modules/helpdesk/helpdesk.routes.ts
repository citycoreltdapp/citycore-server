import { Router } from 'express';
import { env } from '@/config/env';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import { createRateLimiter } from '@/middlewares/rateLimiter';
import {
  helpdeskAdminController as admin,
  helpdeskController as helpdesk,
} from './helpdesk.controller';

const canRead = requirePermission(Permission.HELPDESK_READ);
const canWrite = requirePermission(Permission.HELPDESK_WRITE);
const canDelete = requirePermission(Permission.HELPDESK_DELETE);

// Each new ticket or message lands in a staff queue, so it's worth more than an ordinary request.
const postLimiter = createRateLimiter({
  max: env.HELPDESK_RATE_LIMIT_MAX,
  message: 'Too many support requests, please try again later',
});

const adminRouter = Router();
adminRouter.get('/stats', canRead, admin.stats);
adminRouter.route('/tickets').get(canRead, admin.list).post(canWrite, admin.create);
adminRouter
  .route('/tickets/:id')
  .get(canRead, admin.getById)
  .patch(canWrite, admin.update)
  .delete(canDelete, admin.remove);
adminRouter
  .route('/tickets/:id/messages')
  .get(canRead, admin.listMessages)
  .post(canWrite, admin.addMessage);
adminRouter
  .route('/tickets/:id/messages/:messageId')
  .get(canRead, admin.getMessage)
  .patch(canWrite, admin.updateMessage)
  .delete(canWrite, admin.removeMessage);

const router = Router();
router.use(authenticate);
router.use('/admin', adminRouter);

router.route('/tickets').get(helpdesk.list).post(postLimiter, helpdesk.create);
router.route('/tickets/:id').get(helpdesk.getById).patch(helpdesk.update);
router.post('/tickets/:id/close', helpdesk.close);
router.post('/tickets/:id/reopen', helpdesk.reopen);
router
  .route('/tickets/:id/messages')
  .get(helpdesk.listMessages)
  .post(postLimiter, helpdesk.addMessage);
router
  .route('/tickets/:id/messages/:messageId')
  .get(helpdesk.getMessage)
  .patch(helpdesk.updateMessage)
  .delete(helpdesk.removeMessage);

export const helpdeskRoutes = router;
