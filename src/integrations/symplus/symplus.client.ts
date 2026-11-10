import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { fetchWithTimeout, parseJsonBody as parseJson } from '@/utils/http';
import {
  isRetryable,
  symplusAuthFailed,
  symplusBadResponse,
  symplusDisabled,
  symplusNotFound,
  symplusRejected,
  symplusTimeout,
  symplusUnavailable,
} from './symplus.errors';

type JsonObject = Record<string, unknown>;

export interface SymplusRequest {
  /** Endpoint name. Used for logging, because full paths can contain a BVN, NIN or email. */
  endpoint: string;
  /** Path parameters. Each is URL encoded, which also gives the `%40` Symplus requires in emails. */
  params?: readonly (string | number)[];
  /** Sent as a JSON POST when present. */
  body?: unknown;
  headers?: Record<string, string>;
}

const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;
const RETRY_BASE_DELAY_MS = 300;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const REJECTED_FALLBACK = 'Core banking rejected the request';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const firstString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === 'string' && value.trim() !== '');

const extractMessage = (body: unknown): string => {
  if (!isObject(body)) return REJECTED_FALLBACK;
  const result = Array.isArray(body.result) ? (body.result[0] as unknown) : undefined;
  const message = firstString(
    body.message,
    body.remarks,
    body.error_description,
    body.error,
    isObject(result) ? result.remarks : undefined,
  );
  return (message ?? REJECTED_FALLBACK).slice(0, MAX_ERROR_MESSAGE_LENGTH);
};

const send = (url: string, init: RequestInit) =>
  fetchWithTimeout(url, init, env.SYMPLUS_TIMEOUT_MS, {
    timeout: symplusTimeout,
    network: symplusUnavailable,
  });

class SymplusClient {
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;

  /** Returns a cached token where possible. Concurrent callers share a single token request. */
  getAccessToken(forceRefresh = false): Promise<string> {
    if (!env.SYMPLUS_ENABLED) return Promise.reject(symplusDisabled());
    if (forceRefresh) this.token = undefined;
    if (this.token && this.token.expiresAt > Date.now()) return Promise.resolve(this.token.value);

    this.tokenRequest ??= this.requestToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }

  private async requestToken(): Promise<string> {
    const credentials = Buffer.from(
      `${env.SYMPLUS_CLIENT_KEY}:${env.SYMPLUS_CLIENT_SECRET}`,
    ).toString('base64');

    const response = await send(env.SYMPLUS_TOKEN_URL as string, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });

    if (!response.ok) {
      logger.error({ upstreamStatus: response.status }, 'Symplus token request failed');
      if (response.status >= 500) throw symplusUnavailable();
      throw symplusAuthFailed();
    }

    const body = parseJson(await response.text());
    if (!isObject(body) || typeof body.access_token !== 'string') throw symplusBadResponse();

    const lifetimeSeconds = Number(body.expires_in) || DEFAULT_TOKEN_LIFETIME_SECONDS;
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + lifetimeSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    };
    return this.token.value;
  }

  /**
   * Sends an authenticated request and returns the parsed body, or null when there's no content.
   * Reads are retried here. Writes aren't, because a write that timed out may still have been
   * applied, so the sync queue decides how to repeat those safely.
   */
  async request(request: SymplusRequest): Promise<unknown> {
    const attempts = request.body === undefined ? env.SYMPLUS_MAX_READ_RETRIES + 1 : 1;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.sendAuthenticated(request);
      } catch (err) {
        if (!isRetryable(err) || attempt >= attempts) throw err;
        await wait(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  private async sendAuthenticated(request: SymplusRequest): Promise<unknown> {
    let response = await this.sendOnce(request, await this.getAccessToken());

    // The token can be revoked before its stated expiry, so get a new one and try once more.
    if (response.status === 401) {
      response = await this.sendOnce(request, await this.getAccessToken(true));
    }

    logger.debug(
      { endpoint: request.endpoint, upstreamStatus: response.status },
      'Symplus response',
    );
    return this.readResponse(request, response);
  }

  private sendOnce(request: SymplusRequest, token: string): Promise<Response> {
    const path = [request.endpoint, ...(request.params ?? [])]
      .map((part) => encodeURIComponent(part))
      .join('/');

    return send(new URL(path, env.SYMPLUS_BASE_URL).toString(), {
      method: request.body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(request.body !== undefined && { 'Content-Type': 'application/json' }),
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  }

  private async readResponse(request: SymplusRequest, response: Response): Promise<unknown> {
    const { status } = response;

    if (status === 204) return null;

    const body = parseJson(await response.text());

    if (status === 401 || status === 403) {
      logger.error({ endpoint: request.endpoint, status }, 'Symplus denied access');
      throw symplusAuthFailed();
    }
    if (status === 404) throw symplusNotFound();
    if (status === 429 || status >= 500) {
      logger.warn({ endpoint: request.endpoint, status }, 'Symplus request failed');
      throw symplusUnavailable();
    }
    if (status >= 400) throw symplusRejected(extractMessage(body));
    if (body === undefined) throw symplusBadResponse();

    // Failures can also arrive with a 2xx status.
    if (
      isObject(body) &&
      typeof body.status === 'string' &&
      body.status.toLowerCase() !== 'success'
    ) {
      throw symplusRejected(extractMessage(body));
    }

    return body;
  }
}

export const symplusClient = new SymplusClient();
