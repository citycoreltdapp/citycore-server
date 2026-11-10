import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { createBackgroundWorker } from '@/core/jobs/createBackgroundWorker';
import { birthdayService } from './birthday.service';
import { emailService } from './email.service';

// Separate workers, because a tick is skipped while its own worker is busy, and a long queue
// shouldn't be able to stop the birthday check from running.
const queueWorker = createBackgroundWorker('Email queue', [
  {
    run: () => emailService.processQueue(),
    intervalMs: env.EMAIL_QUEUE_POLL_SECONDS * 1000,
    runOnStart: true,
  },
]);

const birthdayWorker = createBackgroundWorker('Birthday email', [
  {
    run: () => birthdayService.runScheduled(),
    intervalMs: env.EMAIL_BIRTHDAY_CHECK_MINUTES * 60 * 1000,
    runOnStart: true,
  },
]);

export const startEmailWorkers = (): void => {
  if (!env.RESEND_ENABLED) logger.warn('RESEND_ENABLED is off, so no emails will be sent');
  queueWorker.start();
  birthdayWorker.start();
};

export const stopEmailWorkers = async (): Promise<void> => {
  await Promise.all([queueWorker.stop(), birthdayWorker.stop()]);
};
