import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { createBackgroundWorker } from '@/core/jobs/createBackgroundWorker';
import { walletService } from './wallet.service';

const worker = createBackgroundWorker('Wallet', [
  {
    run: () => walletService.reconcilePending(),
    intervalMs: env.PAYSTACK_RECONCILE_MINUTES * 60 * 1000,
  },
]);

export const startWalletWorker = (): void => {
  if (!env.PAYSTACK_ENABLED) {
    logger.info('Paystack integration is disabled');
    return;
  }
  if (env.NODE_ENV === 'production' && env.PAYSTACK_SECRET_KEY?.includes('_test_')) {
    logger.warn('Paystack is using a test key in production');
  }
  worker.start();
};

export const stopWalletWorker = (): Promise<void> => worker.stop();
