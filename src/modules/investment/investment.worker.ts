import { env } from '@/config/env';
import { createBackgroundWorker } from '@/core/jobs/createBackgroundWorker';
import { subscriptionService } from './investmentSubscription.service';

const worker = createBackgroundWorker('Investment', [
  {
    run: () => subscriptionService.processDue(),
    intervalMs: env.INVESTMENT_PAYOUT_MINUTES * 60 * 1000,
    runOnStart: true,
  },
]);

export const startInvestmentWorker = (): void => worker.start();

export const stopInvestmentWorker = (): Promise<void> => worker.stop();
