import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from '@/config/logger';

const SAFE_REQUEST_ID = /^[\w-]{1,64}$/;

export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  autoLogging: { ignore: (req) => req.url === '/health' },
});
