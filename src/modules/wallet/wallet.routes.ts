import { Router } from 'express';
import { env } from '@/config/env';
import { Permission } from '@/constants/permissions';
import { authenticate, requireKyc, requirePermission } from '@/middlewares/auth';
import { createRateLimiter } from '@/middlewares/rateLimiter';
import { walletAdminController as admin, walletController as wallet } from './wallet.controller';

const paymentLimiter = createRateLimiter({
  max: env.WALLET_RATE_LIMIT_MAX,
  message: 'Too many payment requests, please try again later',
});

const adminRouter = Router();
const canRead = requirePermission(Permission.WALLET_READ);
adminRouter.get('/status', canRead, admin.getStatus);
adminRouter.get('/transactions', canRead, admin.listTransactions);
adminRouter.post(
  '/transactions/:reference/recheck',
  requirePermission(Permission.WALLET_RECONCILE),
  admin.recheckTransaction,
);

const router = Router();
router.use(authenticate);
router.use('/admin', adminRouter);

router.get('/', wallet.getWallet);
router.get('/transactions', wallet.listTransactions);
router.get('/transactions/:reference', wallet.getTransaction);
router.get('/fund/quote', wallet.getFundingQuote);
router.post('/fund', requireKyc, paymentLimiter, wallet.fund);
// Not behind KYC: this and the requery only finish money that's already been sent.
router.post('/fund/:reference/verify', paymentLimiter, wallet.verifyFunding);
router.post('/virtual-account', requireKyc, paymentLimiter, wallet.requestVirtualAccount);
router.post('/virtual-account/requery', paymentLimiter, wallet.requeryVirtualAccount);

export const walletRoutes = router;
