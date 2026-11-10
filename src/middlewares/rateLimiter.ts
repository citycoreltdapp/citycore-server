import rateLimit from 'express-rate-limit';
import { env } from '@/config/env';
import { AppError } from '@/core/errors/AppError';

interface RateLimiterOptions {
  max: number;
  windowMinutes?: number;
  message?: string;
  /** Count only failed requests, so normal use doesn't lock anyone out. */
  skipSuccessfulRequests?: boolean;
}

/**
 * Counters live in this process's memory. Running several instances needs a shared store, such as
 * rate-limit-redis, passed through the `store` option.
 */
export const createRateLimiter = ({
  max,
  windowMinutes = env.RATE_LIMIT_WINDOW_MINUTES,
  message,
  skipSuccessfulRequests = false,
}: RateLimiterOptions) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (_req, _res, next) => next(AppError.tooManyRequests(message)),
  });

export const apiLimiter = createRateLimiter({ max: env.RATE_LIMIT_MAX });

export const authLimiter = createRateLimiter({
  max: env.AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  message: 'Too many failed attempts, please try again later',
});

export const uploadLimiter = createRateLimiter({
  max: env.UPLOAD_RATE_LIMIT_MAX,
  message: 'Too many uploads, please try again later',
});
