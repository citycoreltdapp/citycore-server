import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from '@/config/env';
import { apiLimiter } from '@/middlewares/rateLimiter';
import { errorHandler, notFoundHandler } from '@/middlewares/errorHandler';
import { requestLogger } from '@/middlewares/requestLogger';
import { healthRoutes } from '@/modules/health/health.routes';
import { paystackWebhookRoutes } from '@/modules/wallet/paystack.webhook';
import { apiRoutes } from '@/routes';

const BODY_LIMIT = '1mb';

export const createApp = (): Express => {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestLogger);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.use(compression());

  // Ahead of the rate limiter, so that uptime checks are never throttled.
  app.use('/health', healthRoutes);

  // Ahead of the rate limiter, so that payment events are never throttled, and ahead of the JSON
  // parser, because the signature is checked against the exact bytes Paystack sent.
  app.use('/webhooks/paystack', paystackWebhookRoutes);

  app.use(env.API_PREFIX, apiLimiter);
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
  app.use(cookieParser());

  app.use(env.API_PREFIX, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
