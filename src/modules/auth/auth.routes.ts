import { Router } from 'express';
import { authenticate } from '@/middlewares/auth';
import { env } from '@/config/env';
import { authLimiter, createRateLimiter } from '@/middlewares/rateLimiter';
import { authController } from './auth.controller';

// These always answer the same, so unlike authLimiter it counts every request, successful or not.
const emailCodeLimiter = createRateLimiter({
  max: env.AUTH_RATE_LIMIT_MAX,
  message: 'Too many code requests, please try again later',
});

const router = Router();

router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.post('/login/verify', authLimiter, authController.verifyLogin);
router.post('/login/resend', emailCodeLimiter, authController.resendLoginCode);
router.post('/google', authLimiter, authController.google);
router.post('/google/link', authLimiter, authenticate, authController.linkGoogle);
router.post('/set-password', authLimiter, authenticate, authController.setPassword);
router.post('/verify-email/request', emailCodeLimiter, authController.requestEmailVerification);
router.post('/verify-email', authLimiter, authController.verifyEmail);
router.post('/forgot-password', emailCodeLimiter, authController.forgotPassword);
router.post('/reset-password/verify', authLimiter, authController.checkResetCode);
router.post('/reset-password', authLimiter, authController.resetPassword);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/logout-everywhere', authenticate, authController.logoutEverywhere);
router.post('/change-password', authLimiter, authenticate, authController.changePassword);
router.post('/change-email', authLimiter, authenticate, authController.changeEmail);
router.post('/close-account', authLimiter, authenticate, authController.closeAccount);
router.get('/sessions', authenticate, authController.listSessions);
router.delete('/sessions/:id', authenticate, authController.removeSession);

export const authRoutes = router;
