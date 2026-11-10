import { env } from '@/config/env';
import { parseJsonBody } from '@/utils/http';

export class ResendError extends Error {
  constructor(
    message: string,
    /** Whether the same request could work later. A rejected address or sender never will. */
    readonly retryable: boolean,
    readonly rateLimited = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ResendError';
  }
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend answers a repeat with the first result, so a retry can't send the email twice. */
  idempotencyKey: string;
}

const readRetryAfter = (response: Response): number | undefined => {
  const seconds = Number(response.headers.get('retry-after') ?? undefined);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

export const resendApi = {
  /** Sends one email and returns Resend's id for it. Failures throw a ResendError. */
  async send({ to, subject, html, text, idempotencyKey }: OutgoingEmail): Promise<string> {
    let response: Response;
    try {
      response = await fetch(new URL('/emails', env.RESEND_BASE_URL), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'User-Agent': 'citycore-server',
        },
        body: JSON.stringify({
          from: env.RESEND_FROM,
          to: [to],
          subject,
          html,
          text,
          ...(env.RESEND_REPLY_TO && { reply_to: env.RESEND_REPLY_TO }),
        }),
        signal: AbortSignal.timeout(env.RESEND_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new ResendError(timedOut ? 'Resend timed out' : 'Could not reach Resend', true);
    }

    const { status } = response;
    const body = parseJsonBody(await response.text()) as
      { id?: string; message?: string } | null | undefined;

    if (status >= 200 && status < 300 && body?.id) return body.id;

    const message = (body?.message ?? `Resend answered ${status}`).slice(0, 500);
    if (status === 429) throw new ResendError(message, true, true, readRetryAfter(response));
    // A 409 means the same key is still being processed, or was first used with other content.
    throw new ResendError(message, status >= 500 || status === 409 || status < 300);
  },
};
