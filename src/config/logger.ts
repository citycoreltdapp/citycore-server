import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
    },
  }),
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["paystack-signature"]',
    'req.headers["x-paystack-signature"]',
    'res.headers["set-cookie"]',
  ],
});
