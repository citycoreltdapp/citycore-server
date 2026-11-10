import { Router } from 'express';
import { Permission } from '@/constants/permissions';
import { env } from '@/config/env';
import { authenticate, requireKyc, requirePermission } from '@/middlewares/auth';
import { createRateLimiter } from '@/middlewares/rateLimiter';
import {
  investmentAdminController as admin,
  investmentController as investments,
  subscriptionAdminController as subscriptionAdmin,
  subscriptionController as subscriptions,
} from './investment.controller';

const moneyLimiter = createRateLimiter({
  max: env.WALLET_RATE_LIMIT_MAX,
  message: 'Too many payment requests, please try again later',
});

const canRead = requirePermission(Permission.INVESTMENTS_READ);
const canWrite = requirePermission(Permission.INVESTMENTS_WRITE);
const canDelete = requirePermission(Permission.INVESTMENTS_DELETE);

const adminRouter = Router();
adminRouter.route('/plans').get(canRead, admin.list).post(canWrite, admin.create);
adminRouter
  .route('/plans/:id')
  .get(canRead, admin.getById)
  .patch(canWrite, admin.update)
  .delete(canDelete, admin.remove);

adminRouter.get('/subscriptions', canRead, subscriptionAdmin.list);
adminRouter.get('/subscriptions/summary', canRead, subscriptionAdmin.summary);
adminRouter.get('/subscriptions/:id', canRead, subscriptionAdmin.getById);

const router = Router();
router.use(authenticate);
router.use('/admin', adminRouter);

router.get('/plans', investments.list);
router.get('/plans/:slug', investments.getBySlug);
router.get('/plans/:slug/quote', investments.quote);
router.get('/categories', investments.listCategories);

router
  .route('/subscriptions')
  .get(subscriptions.list)
  .post(requireKyc, moneyLimiter, subscriptions.create);
router.get('/subscriptions/:id', subscriptions.getById);
router.get('/subscriptions/:id/withdraw/quote', subscriptions.withdrawalQuote);
// Not behind KYC, like the wallet's verify route: this only returns the customer's own money.
router.post('/subscriptions/:id/withdraw', moneyLimiter, subscriptions.withdraw);

export const investmentRoutes = router;
