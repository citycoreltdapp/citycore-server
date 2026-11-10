import { setTimeout as delay } from 'node:timers/promises';
import type { HydratedDocument } from 'mongoose';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import type { ListQuery } from '@/core/validation/common.schemas';
import { ResendError, resendApi } from '@/integrations/resend/resend.client';
import { decrypt, encrypt } from '@/utils/encryption';
import {
  EMAIL_CATEGORIES,
  EMAIL_STATUSES,
  EmailLogModel,
  type EmailStatus,
  type IEmailLog,
} from './email.model';
import type { EmailTemplate } from './email.templates';

type EmailLog = HydratedDocument<IEmailLog>;

export interface QueueEmailInput {
  to: string;
  email: EmailTemplate;
  user?: string | null;
  triggeredBy?: string | null;
  expiresAt?: Date | null;
  dedupeKey?: string | null;
  /** Records the email without sending it, with this as the reason. */
  skipReason?: string | null;
}

const DUPLICATE_KEY_ERROR = 11000;
const BATCH_SIZE = 10;
const LOCK_MS = 2 * 60 * 1000;
const FIRST_RETRY_MS = 30 * 1000;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 30 * 1000;
const DISABLED_REASON = 'Email sending is turned off';
const EXPIRED_REASON = 'It expired before it could be sent';
const DAY_MS = 24 * 60 * 60 * 1000;

const PEOPLE_POPULATE = ['user', 'triggeredBy'].map((path) => ({
  path,
  select: 'name email',
  options: { lean: true },
  transform: (person: { _id: unknown; name: string; email: string } | null) =>
    person && { id: String(person._id), name: person.name, email: person.email },
}));

/** Rate limited emails wait here rather than each using up an attempt finding out the same thing. */
let pausedUntil = 0;

const finished = (email: EmailLog, changes: Partial<IEmailLog>) => {
  email.set({ lockedUntil: null, ...changes });
  return email.save();
};

const contentAfterSending = (email: EmailLog) => (email.sensitive ? null : email.content);

class EmailService extends BaseService<IEmailLog> {
  constructor() {
    super(EmailLogModel, { resourceName: 'Email', searchFields: ['to', 'subject'] });
  }

  /**
   * Records an email for the worker to send, so a slow or broken provider can't hold up a request,
   * and an email survives a restart. Returns null if `dedupeKey` was already used.
   */
  async queue({
    to,
    email: { html, text, sensitive = false, ...email },
    user = null,
    triggeredBy = null,
    expiresAt = null,
    dedupeKey = null,
    skipReason = null,
  }: QueueEmailInput): Promise<EmailLog | null> {
    const reason = skipReason ?? (env.RESEND_ENABLED ? null : DISABLED_REASON);
    const body = JSON.stringify({ html, text });
    try {
      return await EmailLogModel.create({
        ...email,
        to,
        user,
        triggeredBy,
        expiresAt,
        dedupeKey,
        sensitive,
        status: reason ? 'skipped' : 'queued',
        lastError: reason,
        content: reason ? null : sensitive ? encrypt(body) : body,
      } as Partial<IEmailLog>);
    } catch (err) {
      if (dedupeKey && (err as { code?: number }).code === DUPLICATE_KEY_ERROR) return null;
      throw err;
    }
  }

  private claimNext() {
    const now = new Date();
    return EmailLogModel.findOneAndUpdate(
      {
        $or: [
          { status: 'queued', nextAttemptAt: { $lte: now } },
          // A worker stopped halfway. The idempotency key means Resend won't send it twice.
          { status: 'sending', lockedUntil: { $lte: now } },
        ],
      },
      {
        status: 'sending',
        lockedUntil: new Date(now.getTime() + LOCK_MS),
        $inc: { attempts: 1 },
      },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    )
      .select('+content')
      .exec() as Promise<EmailLog | null>;
  }

  /** Sends what's waiting, a few at a time. Each one is claimed, so servers can't double up. */
  async processQueue(batchSize = BATCH_SIZE): Promise<number> {
    let handled = 0;
    while (handled < batchSize && Date.now() >= pausedUntil) {
      const email = await this.claimNext();
      if (!email) break;
      await this.deliver(email);
      handled += 1;
      if (env.EMAIL_SEND_INTERVAL_MS > 0) await delay(env.EMAIL_SEND_INTERVAL_MS);
    }
    return handled;
  }

  private async deliver(email: EmailLog): Promise<void> {
    if (email.expiresAt && email.expiresAt <= new Date()) {
      await this.markFailed(email, EXPIRED_REASON);
      return;
    }

    try {
      const raw = email.content ?? '';
      const { html, text } = JSON.parse(email.sensitive ? decrypt(raw) : raw) as {
        html: string;
        text: string;
      };
      const providerId = await resendApi.send({
        to: email.to,
        subject: email.subject,
        html,
        text,
        idempotencyKey: `${email.id}-${email.generation}`,
      });
      await finished(email, {
        status: 'sent',
        providerId,
        sentAt: new Date(),
        lastError: null,
        content: contentAfterSending(email),
      });
    } catch (err) {
      await this.handleFailure(email, err);
    }
  }

  private async handleFailure(email: EmailLog, err: unknown): Promise<void> {
    if (!(err instanceof ResendError)) {
      logger.error({ err, emailId: email.id }, 'Could not send an email');
      await this.markFailed(email, 'The email could not be prepared');
      return;
    }

    if (err.rateLimited) {
      const waitMs = err.retryAfterMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
      pausedUntil = Date.now() + waitMs;
      logger.warn({ waitMs }, 'Resend rate limit reached, so pausing email');
      await finished(email, {
        status: 'queued',
        attempts: email.attempts - 1,
        nextAttemptAt: new Date(Date.now() + waitMs),
        lastError: err.message,
      });
      return;
    }

    if (err.retryable && email.attempts < env.EMAIL_QUEUE_MAX_ATTEMPTS) {
      await finished(email, {
        status: 'queued',
        nextAttemptAt: new Date(Date.now() + FIRST_RETRY_MS * 2 ** (email.attempts - 1)),
        lastError: err.message,
      });
      return;
    }

    logger.error({ emailId: email.id, template: email.template }, `Email failed: ${err.message}`);
    await this.markFailed(email, err.message);
  }

  /** A code is removed as soon as it can't be used. Other emails stay for a manual retry. */
  private markFailed(email: EmailLog, reason: string) {
    return finished(email, {
      status: 'failed',
      failedAt: new Date(),
      lastError: reason,
      ...(email.expiresAt && { content: null }),
    });
  }

  // The activity list.

  async listActivity({ dateFrom, dateTo, ...query }: ListQuery) {
    const createdAt = {
      ...(dateFrom ? { $gte: dateFrom as Date } : {}),
      ...(dateTo ? { $lte: dateTo as Date } : {}),
    };
    const result = await this.paginate(
      query,
      Object.keys(createdAt).length > 0 ? { createdAt } : {},
    );
    await EmailLogModel.populate(result.items, PEOPLE_POPULATE);
    return result;
  }

  /** Includes what was sent, unless the email is one staff shouldn't read. */
  async getActivity(id: string) {
    const email = await this.findById(id, '+content');
    await email.populate(PEOPLE_POPULATE);
    const body =
      email.content && !email.sensitive
        ? (JSON.parse(email.content) as { html: string; text: string })
        : null;
    return { ...email.toJSON(), html: body?.html ?? null, text: body?.text ?? null };
  }

  async stats(now = new Date()) {
    const since = new Date(now.getTime() - DAY_MS);
    const [byStatus, byCategory, lastDay] = await Promise.all([
      EmailLogModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
      EmailLogModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]).exec(),
      EmailLogModel.aggregate<{ _id: string; count: number }>([
        { $match: { updatedAt: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
    ]);

    // Every key is present, so a frontend can show a zero.
    const tally = (keys: readonly string[], rows: { _id: string; count: number }[]) =>
      Object.fromEntries(keys.map((key) => [key, rows.find((row) => row._id === key)?.count ?? 0]));

    return {
      byStatus: tally(EMAIL_STATUSES, byStatus),
      byCategory: tally(EMAIL_CATEGORIES, byCategory),
      lastDay: tally(['sent', 'failed'] satisfies EmailStatus[], lastDay),
    };
  }

  /** A retry is a new request to Resend, so it can succeed where the last one was refused. */
  async retry(id: string): Promise<EmailLog> {
    const email = await this.findById(id, '+content');
    if (email.status !== 'failed') {
      throw AppError.conflict('Only a failed email can be retried', 'EMAIL_NOT_FAILED');
    }
    if (!email.content || (email.expiresAt && email.expiresAt <= new Date())) {
      throw AppError.conflict('This email can no longer be sent', 'EMAIL_NOT_RETRYABLE');
    }

    const retried = await EmailLogModel.findOneAndUpdate(
      { _id: id, status: 'failed' },
      {
        status: 'queued',
        attempts: 0,
        $inc: { generation: 1 },
        nextAttemptAt: new Date(),
        failedAt: null,
        lastError: null,
      },
      { returnDocument: 'after' },
    ).exec();
    if (!retried) throw AppError.conflict('Only a failed email can be retried', 'EMAIL_NOT_FAILED');
    return retried as EmailLog;
  }
}

export const emailService = new EmailService();
