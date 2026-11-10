import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { isProduction } from '@/config/env';
import { HttpStatus, type HttpStatusCode } from '@/constants/http';
import { AppError } from '@/core/errors/AppError';
import { removeUploadedFiles } from '@/utils/file';

interface MongoDuplicateKeyError {
  code: 11000;
  keyValue?: Record<string, unknown>;
}

/** Errors raised by body-parser and other http-errors based middleware. */
interface HttpLikeError {
  status: number;
  expose?: boolean;
  type?: string;
  message: string;
}

const isDuplicateKeyError = (err: unknown): err is MongoDuplicateKeyError =>
  (err as MongoDuplicateKeyError | null)?.code === 11000;

const isHttpLikeError = (err: unknown): err is HttpLikeError =>
  typeof (err as HttpLikeError | null)?.status === 'number';

const fromMulterError = (err: multer.MulterError): AppError =>
  err.code === 'LIMIT_FILE_SIZE'
    ? AppError.payloadTooLarge('File is too large', 'FILE_TOO_LARGE')
    : AppError.badRequest(err.message, err.code);

const fromHttpLikeError = (err: HttpLikeError): AppError => {
  if (err.type === 'entity.parse.failed') {
    return AppError.badRequest('Request body contains malformed JSON', 'MALFORMED_JSON');
  }
  if (err.type === 'entity.too.large') return AppError.payloadTooLarge();
  if (err.status >= 500 || !err.expose) return AppError.internal();
  return new AppError(err.message, err.status as HttpStatusCode, 'REQUEST_ERROR');
};

/** Converts any thrown value into an AppError. Anything unrecognised becomes a generic 500. */
const normalizeError = (err: unknown): AppError => {
  if (err instanceof AppError) return err;
  if (err instanceof multer.MulterError) return fromMulterError(err);

  if (err instanceof mongoose.Error.ValidationError) {
    return AppError.validation(
      Object.values(err.errors).map(({ path, message }) => ({ path, message })),
    );
  }
  if (err instanceof mongoose.Error.CastError) {
    return AppError.badRequest(`Invalid value for ${err.path}`, 'INVALID_VALUE');
  }
  if (isDuplicateKeyError(err)) {
    const field = Object.keys(err.keyValue ?? {})[0] ?? 'value';
    return AppError.conflict(`That ${field} is already in use`, 'DUPLICATE_VALUE');
  }
  if (isHttpLikeError(err)) return fromHttpLikeError(err);

  return AppError.internal();
};

export const notFoundHandler: RequestHandler = (req) => {
  throw AppError.notFound(`Route not found: ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND');
};

export const errorHandler: ErrorRequestHandler = async (err, req, res, next) => {
  const error = normalizeError(err);
  const isServerError = error.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR;

  if (isServerError) req.log.error({ err }, 'Request failed');
  else req.log.debug({ err: error }, 'Request rejected');

  // A request can fail after multer has already stored its files.
  await removeUploadedFiles(req);

  if (res.headersSent) {
    next(err);
    return;
  }

  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    code: error.code,
    requestId: req.id,
    errors: error.details,
    stack: isServerError && !isProduction && err instanceof Error ? err.stack : undefined,
  });
};
