import { model } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export const JOB_STATUSES = ['pending', 'processing', 'succeeded', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  'customer.create',
  'customer.update',
  'customer.status',
  'customer.kyc',
  'balance.sync',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

const FINISHED_JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export interface ISyncJob {
  type: JobType;
  status: JobStatus;
  /** Set only while a job is open, so a piece of work can't be queued twice. */
  dedupeKey?: string;
  /** Encrypted, because it can hold a BVN, NIN or bank details. Cleared once the job succeeds. */
  payload?: string;
  attempts: number;
  runAt: Date;
  lockedUntil: Date | null;
  /** Identifies the current run, so a run that was superseded can't record a result. */
  lockToken: string | null;
  lastError: string | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const syncJobSchema = createSchema<ISyncJob>(
  {
    type: { type: String, enum: JOB_TYPES, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'pending' },
    dedupeKey: { type: String, unique: true, sparse: true },
    payload: { type: String },
    attempts: { type: Number, default: 0 },
    runAt: { type: Date, default: Date.now },
    lockedUntil: { type: Date, default: null },
    lockToken: { type: String, default: null },
    lastError: { type: String, default: null },
    finishedAt: { type: Date, default: null },
  },
  { hiddenFields: ['payload', 'lockToken'] },
);

syncJobSchema.index({ status: 1, runAt: 1 });
// Only succeeded jobs get a finishedAt. Dead jobs stay until someone deals with them.
syncJobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: FINISHED_JOB_RETENTION_SECONDS });

export const SyncJobModel = model<ISyncJob>('SymplusSyncJob', syncJobSchema);
