import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { createBackgroundWorker } from '@/core/jobs/createBackgroundWorker';
import {
  symplusApi,
  type CustomerUpdateSection,
  type SymplusPayload,
} from '@/integrations/symplus/symplus.api';
import { CustomerLinkModel } from './customerLink.model';
import { symplusService } from './symplus.service';
import { syncQueue } from './syncQueue.service';

interface CreatePayload {
  linkId: string;
  userId: string;
  customer: SymplusPayload;
}

interface UpdatePayload {
  customerId: string;
  section: CustomerUpdateSection;
  data: SymplusPayload;
}

syncQueue.registerHandler('customer.create', {
  run: ({ linkId, userId, customer }: CreatePayload) =>
    symplusService.submitCustomer(linkId, userId, customer),
  onDead: ({ linkId }: CreatePayload, message: string) =>
    symplusService.markFailed(linkId, message),
});

syncQueue.registerHandler('customer.update', {
  run: async ({ customerId, section, data }: UpdatePayload) => {
    await symplusApi.updateCustomer(section, customerId, data);
  },
});

syncQueue.registerHandler('customer.status', {
  run: async ({ linkId }: { linkId: string }) => {
    await symplusService.refreshRegistration(linkId);
  },
});

syncQueue.registerHandler('customer.kyc', {
  run: async ({ linkId }: { linkId: string }) => {
    await symplusService.syncKyc(linkId);
  },
});

syncQueue.registerHandler('balance.sync', {
  run: async ({ linkId }: { linkId: string }) => {
    await symplusService.syncBalances(linkId);
  },
});

const RECURRING_JOBS = {
  status: 'customer.status',
  kyc: 'customer.kyc',
  balance: 'balance.sync',
} as const;

/** Queues a status check for every pending link, and KYC and balance syncs for every active one. */
export const scheduleRecurringSync = async (): Promise<void> => {
  const links = CustomerLinkModel.find({ status: { $in: ['pending', 'active'] } })
    .select('status')
    .lean()
    .cursor();

  for await (const link of links) {
    const linkId = link._id.toString();
    const types = link.status === 'pending' ? ['status'] : ['kyc', 'balance'];
    for (const name of types) {
      await syncQueue.enqueue({
        type: RECURRING_JOBS[name as keyof typeof RECURRING_JOBS],
        dedupeKey: `${name}:${linkId}`,
        payload: { linkId },
      });
    }
  }
};

const worker = createBackgroundWorker('Symplus', [
  { run: () => syncQueue.processDue(), intervalMs: env.SYMPLUS_QUEUE_POLL_SECONDS * 1000 },
  {
    run: scheduleRecurringSync,
    intervalMs: env.SYMPLUS_SYNC_INTERVAL_MINUTES * 60 * 1000,
    runOnStart: true,
  },
]);

export const startSymplusWorker = (): void => {
  if (!env.SYMPLUS_ENABLED) {
    logger.info('Symplus integration is disabled');
    return;
  }
  worker.start();
};

export const stopSymplusWorker = (): Promise<void> => worker.stop();
