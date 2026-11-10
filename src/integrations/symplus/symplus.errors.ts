import { HttpStatus, type HttpStatusCode } from '@/constants/http';
import { AppError } from '@/core/errors/AppError';

/** A failed Symplus call. `retryable` means the same request could succeed if sent again. */
export class SymplusError extends AppError {
  constructor(
    message: string,
    statusCode: HttpStatusCode,
    code: string,
    readonly retryable = false,
  ) {
    super(message, statusCode, code);
    this.name = 'SymplusError';
  }
}

export const isRetryable = (err: unknown): boolean => err instanceof SymplusError && err.retryable;

export const symplusDisabled = () =>
  new SymplusError(
    'Core banking is not available right now',
    HttpStatus.SERVICE_UNAVAILABLE,
    'SYMPLUS_DISABLED',
  );

export const symplusUnavailable = () =>
  new SymplusError(
    'Core banking is temporarily unavailable',
    HttpStatus.BAD_GATEWAY,
    'SYMPLUS_UNAVAILABLE',
    true,
  );

export const symplusTimeout = () =>
  new SymplusError(
    'Core banking took too long to respond',
    HttpStatus.GATEWAY_TIMEOUT,
    'SYMPLUS_TIMEOUT',
    true,
  );

// Maps to 502, not 401, so a client doesn't read our credential problem as its own session ending.
export const symplusAuthFailed = () =>
  new SymplusError(
    'Core banking could not be reached',
    HttpStatus.BAD_GATEWAY,
    'SYMPLUS_AUTH_FAILED',
    true,
  );

export const symplusBadResponse = () =>
  new SymplusError(
    'Core banking returned an unexpected response',
    HttpStatus.BAD_GATEWAY,
    'SYMPLUS_BAD_RESPONSE',
  );

export const symplusRejected = (message: string) =>
  new SymplusError(message, HttpStatus.BAD_REQUEST, 'SYMPLUS_REJECTED');

export const symplusNotFound = (message = 'Customer not found in core banking') =>
  new SymplusError(message, HttpStatus.NOT_FOUND, 'SYMPLUS_NOT_FOUND');
