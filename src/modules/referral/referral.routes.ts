import { Router } from 'express';
import { env } from '@/config/env';
import { Permission } from '@/constants/permissions';
import { authenticate, requirePermission } from '@/middlewares/auth';
import { createRateLimiter } from '@/middlewares/rateLimiter';
import {
  referralAdminController as admin,
  referralController as referrals,
} from './referral.controller';

const canRead = requirePermission(Permission.REFERRALS_READ);
const canWrite = requirePermission(Permission.REFERRALS_WRITE);
const canDelete = requirePermission(Permission.REFERRALS_DELETE);
const canPay = requirePermission(Permission.REFERRALS_PAYOUT);

// Public, so failed lookups are limited to stop anyone guessing their way through codes.
const codeLookupLimiter = createRateLimiter({
  max: env.AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  message: 'Too many failed attempts, please try again later',
});

const adminRouter = Router();
adminRouter.get('/stats', canRead, admin.getStats);
adminRouter.route('/referrals').get(canRead, admin.list).post(canWrite, admin.create);
adminRouter
  .route('/referrals/:id')
  .get(canRead, admin.getById)
  .patch(canWrite, admin.update)
  .delete(canDelete, admin.remove);
adminRouter
  .route('/commissions')
  .get(canRead, admin.listCommissions)
  .post(canWrite, admin.createCommission);
adminRouter
  .route('/commissions/:id')
  .get(canRead, admin.getCommission)
  .patch(canWrite, admin.updateCommission)
  .delete(canDelete, admin.removeCommission);
adminRouter.post('/commissions/:id/approve', canWrite, admin.approveCommission);
adminRouter.post('/commissions/:id/reject', canWrite, admin.rejectCommission);
adminRouter.post('/commissions/:id/pay', canPay, admin.payCommission);
adminRouter.get('/users/:id', canRead, admin.getUser);
adminRouter.put('/users/:id/code', canWrite, admin.setUserCode);

const router = Router();
router.get('/codes/:code', codeLookupLimiter, referrals.validateCode);

router.use(authenticate);
router.use('/admin', adminRouter);

router.get('/me', referrals.getPage);
router.get('/me/referrals', referrals.listReferrals);
router.get('/me/commissions', referrals.listCommissions);
router.post('/me/apply', referrals.applyCode);
router.post('/me/skip', referrals.skipPrompt);

export const referralRoutes = router;
