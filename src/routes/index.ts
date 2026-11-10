import { Router } from 'express';
import { authRoutes } from '@/modules/auth/auth.routes';
import { blogRoutes } from '@/modules/blog/blog.routes';
import { emailRoutes } from '@/modules/email/email.routes';
import { helpdeskRoutes } from '@/modules/helpdesk/helpdesk.routes';
import { kycRoutes } from '@/modules/kyc/kyc.routes';
import { investmentRoutes } from '@/modules/investment/investment.routes';
import { mediaRoutes } from '@/modules/media/media.routes';
import { onboardingRoutes } from '@/modules/onboarding/onboarding.routes';
import { platformConfigRoutes } from '@/modules/platformConfig/platformConfig.routes';
import { referralRoutes } from '@/modules/referral/referral.routes';
import { roleRoutes } from '@/modules/role/role.routes';
import { symplusRoutes } from '@/modules/symplus/symplus.routes';
import { uploadRoutes } from '@/modules/upload/upload.routes';
import { walletRoutes } from '@/modules/wallet/wallet.routes';
import { userRoutes } from '@/modules/user/user.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/media', mediaRoutes);
router.use('/uploads', uploadRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/kyc', kycRoutes);
router.use('/symplus', symplusRoutes);
router.use('/wallet', walletRoutes);
router.use('/investments', investmentRoutes);
router.use('/referrals', referralRoutes);
router.use('/blog', blogRoutes);
router.use('/helpdesk', helpdeskRoutes);
router.use('/emails', emailRoutes);
router.use('/platform-config', platformConfigRoutes);

export const apiRoutes = router;
