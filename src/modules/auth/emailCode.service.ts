import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env';
import { AppError } from '@/core/errors/AppError';
import { EmailCodeModel, type EmailCodePurpose } from './emailCode.model';

const CODE_RANGE = 1_000_000;
const CODE_DIGITS = 6;
const MAX_ATTEMPTS = 5;
/** Just under the 59 seconds the apps count down, so their resend button always works. */
const RESEND_COOLDOWN_MS = 55 * 1000;

export const invalidCode = () =>
  AppError.badRequest('That code is wrong or has expired', 'INVALID_CODE');

/** Keyed, because six digits alone could be tried in moments by anyone who read the database. */
const hashCode = (userId: string, purpose: EmailCodePurpose, code: string): string =>
  createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${purpose}:${userId}:${code}`).digest('hex');

const sameHash = (a: string, b: string): boolean =>
  timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export const emailCodeService = {
  /** Returns a new code to send, or null if one went out moments ago. */
  async issue(
    userId: string,
    email: string,
    purpose: EmailCodePurpose,
    now = new Date(),
  ): Promise<string | null> {
    const existing = await EmailCodeModel.findOne({ user: userId, purpose })
      .select('email lastSentAt')
      .lean()
      .exec();
    const justSent =
      existing?.email === email &&
      now.getTime() - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS;
    if (justSent) return null;

    const code = String(randomInt(CODE_RANGE)).padStart(CODE_DIGITS, '0');
    await EmailCodeModel.findOneAndUpdate(
      { user: userId, purpose },
      {
        email,
        codeHash: hashCode(userId, purpose, code),
        attempts: 0,
        lastSentAt: now,
        expiresAt: new Date(now.getTime() + env.EMAIL_CODE_TTL_MINUTES * 60 * 1000),
      },
      { upsert: true },
    ).exec();
    return code;
  },

  /**
   * Checks a code, and uses it up if `consume` is set. Each guess is counted before it's compared,
   * so concurrent guesses can't get past the limit, and a code that hits the limit stops working.
   * It must match the account's current address, or the old inbox could reset the password or
   * verify an address it doesn't own.
   */
  async check(
    userId: string,
    email: string,
    purpose: EmailCodePurpose,
    code: string,
    { consume }: { consume: boolean },
  ): Promise<void> {
    const record = await EmailCodeModel.findOneAndUpdate(
      {
        user: userId,
        email,
        purpose,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      { $inc: { attempts: 1 } },
    ).exec();
    if (!record || !sameHash(record.codeHash, hashCode(userId, purpose, code))) throw invalidCode();

    if (consume) await record.deleteOne();
    // Being right shouldn't use up one of the guesses, as the reset flow checks the code twice.
    else await EmailCodeModel.updateOne({ _id: record._id }, { $inc: { attempts: -1 } }).exec();
  },
};
