import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { HttpStatus } from '@/constants/http';
import { AppError } from '@/core/errors/AppError';
import { fetchWithTimeout, parseJsonBody } from '@/utils/http';

export const PAYSTACK_NOT_FOUND = 'PAYSTACK_NOT_FOUND';

const unavailable = () =>
  new AppError(
    'The payment provider is temporarily unavailable',
    HttpStatus.BAD_GATEWAY,
    'PAYSTACK_UNAVAILABLE',
  );

const timedOut = () =>
  new AppError(
    'The payment provider took too long to respond',
    HttpStatus.GATEWAY_TIMEOUT,
    'PAYSTACK_TIMEOUT',
  );

export const paystackDisabled = () =>
  new AppError(
    'Wallet funding is not available right now',
    HttpStatus.SERVICE_UNAVAILABLE,
    'PAYSTACK_DISABLED',
  );

interface PaystackEnvelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

interface PaystackRequest {
  /** Used in logs instead of the path, which can hold a reference or an account number. */
  name: string;
  path: string;
  body?: unknown;
}

export const paystackRequest = async <T>({ name, path, body }: PaystackRequest): Promise<T> => {
  if (!env.PAYSTACK_ENABLED) throw paystackDisabled();

  const response = await fetchWithTimeout(
    new URL(path, env.PAYSTACK_BASE_URL).toString(),
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env.PAYSTACK_TIMEOUT_MS,
    { timeout: timedOut, network: unavailable },
  );

  const { status } = response;
  const parsed = parseJsonBody(await response.text()) as PaystackEnvelope<T> | null | undefined;

  if (status === 401 || status === 403) {
    // A 502, so a client doesn't read our key being wrong as its own session ending.
    logger.error({ name, status }, 'Paystack denied access');
    throw new AppError(
      'The payment provider could not be reached',
      HttpStatus.BAD_GATEWAY,
      'PAYSTACK_AUTH_FAILED',
    );
  }
  if (status === 429 || status >= 500) {
    logger.warn({ name, status }, 'Paystack request failed');
    throw unavailable();
  }

  const message = parsed?.message ?? 'The payment provider rejected the request';

  if (status === 404 || (status === 400 && /not found/i.test(message))) {
    throw new AppError(message, HttpStatus.NOT_FOUND, PAYSTACK_NOT_FOUND);
  }
  if (status >= 400 || parsed?.status === false) {
    throw new AppError(message.slice(0, 300), HttpStatus.BAD_REQUEST, 'PAYSTACK_REJECTED');
  }
  if (!parsed) {
    throw new AppError(
      'The payment provider returned an unexpected response',
      HttpStatus.BAD_GATEWAY,
      'PAYSTACK_BAD_RESPONSE',
    );
  }

  return parsed.data as T;
};
