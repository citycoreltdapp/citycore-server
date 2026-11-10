import { randomUUID } from 'node:crypto';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import { isRetryable } from '@/integrations/symplus/symplus.errors';
import { decrypt, encrypt } from '@/utils/encryption';
import { SyncJobModel, type ISyncJob, type JobType } from './syncJob.model';

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const LOCK_DURATION_MS = 2 * 60 * 1000;
const MAX_JOBS_PER_RUN = 25;
const MAX_ERROR_LENGTH = 500;
const DUPLICATE_KEY_ERROR = 11000;

export interface JobHandler {
  run: (payload: never) => Promise<void>;
  /** Called once a job has failed for good. */
  onDead?: (payload: never, message: string) => Promise<void>;
}

interface EnqueueOptions {
  type: JobType;
  dedupeKey: string;
  payload: unknown;
  /** Replace an open job's payload, so a newer change wins over one still waiting to be sent. */
  replaceExisting?: boolean;
}

const errorMessage = (err: unknown): string =>
  (err instanceof AppError ? `${err.code}: ${err.message}` : 'Unexpected error').slice(
    0,
    MAX_ERROR_LENGTH,
  );

const backoffDelay = (attempts: number): number => {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  // Random spread, so a backlog doesn't hit Symplus all at once when it recovers.
  return delay * (0.75 + Math.random() * 0.5);
};

class SyncQueueService extends BaseService<ISyncJob> {
  private readonly handlers = new Map<JobType, JobHandler>();

  constructor() {
    super(SyncJobModel, { resourceName: 'Sync job' });
  }

  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async enqueue({ type, dedupeKey, payload, replaceExisting = false }: EnqueueOptions) {
    const values = {
      type,
      payload: encrypt(JSON.stringify(payload)),
      status: 'pending',
      attempts: 0,
      runAt: new Date(),
      lockedUntil: null,
      lockToken: null,
      lastError: null,
    };

    try {
      await SyncJobModel.updateOne(
        { dedupeKey },
        replaceExisting ? { $set: values } : { $setOnInsert: values },
        { upsert: true },
      ).exec();
    } catch (err) {
      // Another process queued the same work at the same moment, which is the outcome we wanted.
      if ((err as { code?: number }).code !== DUPLICATE_KEY_ERROR) throw err;
    }
  }

  /** Drops queued work that a newer direct request has made out of date. */
  async cancel(dedupeKey: string): Promise<void> {
    await SyncJobModel.deleteOne({ dedupeKey, status: 'pending' }).exec();
  }

  /** Runs every job that's due, and returns how many ran. */
  async processDue(limit = MAX_JOBS_PER_RUN): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const job = await this.claimNext();
      if (!job) break;
      await this.execute(job);
      processed += 1;
    }
    return processed;
  }

  /**
   * Claims atomically, so several server instances can share the queue. A `processing` job whose
   * lock has lapsed belongs to a process that died, and is picked up again.
   */
  private claimNext() {
    const now = new Date();
    return SyncJobModel.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', runAt: { $lte: now } },
          { status: 'processing', lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: {
          status: 'processing',
          lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS),
          lockToken: randomUUID(),
        },
        $inc: { attempts: 1 },
      },
      { sort: { runAt: 1 }, returnDocument: 'after' },
    ).exec();
  }

  private async execute(job: NonNullable<Awaited<ReturnType<SyncQueueService['claimNext']>>>) {
    const handler = this.handlers.get(job.type);
    const claim = { _id: job._id, lockToken: job.lockToken };
    const payload = (job.payload ? JSON.parse(decrypt(job.payload)) : {}) as never;

    try {
      if (!handler) throw new Error(`No handler for ${job.type}`);
      await handler.run(payload);
      await SyncJobModel.updateOne(claim, {
        $set: { status: 'succeeded', finishedAt: new Date(), lockedUntil: null, lastError: null },
        $unset: { dedupeKey: 1, payload: 1, lockToken: 1 },
      }).exec();
    } catch (err) {
      const message = errorMessage(err);

      if (isRetryable(err) && job.attempts < env.SYMPLUS_QUEUE_MAX_ATTEMPTS) {
        logger.warn(
          { jobId: job.id, type: job.type, attempts: job.attempts },
          'Sync job will retry',
        );
        await SyncJobModel.updateOne(claim, {
          $set: {
            status: 'pending',
            runAt: new Date(Date.now() + backoffDelay(job.attempts)),
            lockedUntil: null,
            lockToken: null,
            lastError: message,
          },
        }).exec();
        return;
      }

      logger.error({ jobId: job.id, type: job.type, attempts: job.attempts }, 'Sync job failed');
      // Removing dedupeKey lets the same work be queued afresh. The payload stays for manual retry.
      await SyncJobModel.updateOne(claim, {
        $set: { status: 'dead', lockedUntil: null, lockToken: null, lastError: message },
        $unset: { dedupeKey: 1 },
      }).exec();
      await handler?.onDead?.(payload, message);
    }
  }

  async retryDead(id: string) {
    const job = await SyncJobModel.findOneAndUpdate(
      { _id: id, status: 'dead' },
      { $set: { status: 'pending', attempts: 0, runAt: new Date(), lastError: null } },
      { returnDocument: 'after' },
    ).exec();
    if (!job) throw AppError.conflict('Only a failed job can be retried', 'JOB_NOT_RETRYABLE');
    return job;
  }

  async getStats(): Promise<Record<string, number>> {
    const groups = await SyncJobModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    return Object.fromEntries(groups.map(({ _id, count }) => [_id, count]));
  }
}

export const syncQueue = new SyncQueueService();
