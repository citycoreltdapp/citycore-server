import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export const EMAIL_STATUSES = ['queued', 'sending', 'sent', 'failed', 'skipped'] as const;
export const EMAIL_CATEGORIES = [
  'security',
  'account',
  'transaction',
  'support',
  'birthday',
  'system',
] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

/** One email: it waits here to be sent, and stays afterwards as the activity record. */
export interface IEmailLog {
  to: string;
  subject: string;
  /** Which template made it, such as `birthday` or `password_reset_code`. */
  template: string;
  category: EmailCategory;
  status: EmailStatus;
  /** The account it's about, if any. */
  user: Types.ObjectId | null;
  /** The staff member who sent it. Empty when the system sent it by itself. */
  triggeredBy: Types.ObjectId | null;
  /** The rendered email as JSON. Encrypted when `sensitive`, and only kept as long as it's needed. */
  content: string | null;
  /** Holds a code or financial details, so staff can't read it and it's removed once sent. */
  sensitive: boolean;
  /** Resend's id for it. */
  providerId: string | null;
  attempts: number;
  /** Goes up with each manual retry, so Resend treats that as a new request. */
  generation: number;
  nextAttemptAt: Date;
  /** Until when a worker holds it. A crashed worker's email is picked up again after this. */
  lockedUntil: Date | null;
  /** Why it failed or was skipped. */
  lastError: string | null;
  sentAt: Date | null;
  failedAt: Date | null;
  /** A code past this is useless, so it's failed rather than sent late. */
  expiresAt: Date | null;
  /** The same key is only ever accepted once, such as one birthday email a year. */
  dedupeKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const emailLogSchema = createSchema<IEmailLog>(
  {
    to: { type: String, required: true, lowercase: true, trim: true },
    subject: { type: String, required: true },
    template: { type: String, required: true, index: true },
    category: { type: String, enum: EMAIL_CATEGORIES, required: true, index: true },
    status: { type: String, enum: EMAIL_STATUSES, default: 'queued' },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    triggeredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    content: { type: String, default: null, select: false },
    sensitive: { type: Boolean, default: false },
    providerId: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    generation: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: null },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    dedupeKey: { type: String, default: null },
  },
  { hiddenFields: ['content', 'dedupeKey', 'lockedUntil', 'generation', 'nextAttemptAt'] },
);

emailLogSchema.index({ status: 1, nextAttemptAt: 1 });
emailLogSchema.index({ createdAt: -1 });
emailLogSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

export const EmailLogModel = model<IEmailLog>('EmailLog', emailLogSchema);

export const BIRTHDAY_SETTINGS_ID = 'birthday';

export interface IBirthdaySettings {
  _id: string;
  /** Off until someone has read the message and chosen to start sending it. */
  autoSendEnabled: boolean;
  subject: string;
  message: string;
  /** The hour of the day to start sending, 0 to 23, in `timezone`. */
  sendHour: number;
  timezone: string;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const birthdaySettingsSchema = createSchema<IBirthdaySettings>(
  {
    _id: { type: String, default: BIRTHDAY_SETTINGS_ID },
    autoSendEnabled: { type: Boolean, default: false },
    subject: { type: String, default: 'Happy birthday, {{firstName}}!' },
    message: {
      type: String,
      default:
        'Everyone at City Core wishes you a very happy birthday, {{firstName}}.\n\nThank you for being part of our community. We hope the year ahead brings you joy, good health and prosperity.',
    },
    sendHour: { type: Number, default: 9, min: 0, max: 23 },
    timezone: { type: String, default: 'Africa/Lagos' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { hiddenFields: ['id'] },
);

export const BirthdaySettingsModel = model<IBirthdaySettings>(
  'BirthdaySettings',
  birthdaySettingsSchema,
);
