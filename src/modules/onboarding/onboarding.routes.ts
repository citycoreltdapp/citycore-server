import { Router } from 'express';
import { authenticate } from '@/middlewares/auth';
import { documentUpload, symplusLimiter } from '@/modules/symplus/symplus.middleware';
import { onboardingController as onboarding } from './onboarding.controller';

const router = Router();

router.use(authenticate);

router.get('/', onboarding.getState);
router.post('/details', symplusLimiter, onboarding.submitDetails);
router.post('/documents', symplusLimiter, documentUpload, onboarding.uploadDocument);
router.post('/refresh', symplusLimiter, onboarding.refresh);

export const onboardingRoutes = router;
