import { HttpStatus, type HttpStatusCode } from '@/constants/http';

export interface ErrorDetail {
  path: string;
  message: string;
}

/** An expected failure. Its message is safe to send to the client. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: HttpStatusCode = HttpStatus.INTERNAL_SERVER_ERROR,
    readonly code: string = 'INTERNAL_ERROR',
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', code = 'BAD_REQUEST') {
    return new AppError(message, HttpStatus.BAD_REQUEST, code);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(message, HttpStatus.UNAUTHORIZED, code);
  }

  static forbidden(message = 'You do not have permission to do this', code = 'FORBIDDEN') {
    return new AppError(message, HttpStatus.FORBIDDEN, code);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new AppError(message, HttpStatus.NOT_FOUND, code);
  }

  static conflict(message = 'Resource already exists', code = 'CONFLICT') {
    return new AppError(message, HttpStatus.CONFLICT, code);
  }

  static payloadTooLarge(message = 'Payload too large', code = 'PAYLOAD_TOO_LARGE') {
    return new AppError(message, HttpStatus.PAYLOAD_TOO_LARGE, code);
  }

  static validation(details: ErrorDetail[], message = 'Validation failed') {
    return new AppError(message, HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_ERROR', details);
  }

  static tooManyRequests(message = 'Too many requests, please try again later') {
    return new AppError(message, HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_REQUESTS');
  }

  static internal(message = 'Something went wrong') {
    return new AppError(message);
  }
}
