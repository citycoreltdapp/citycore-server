import { Router } from 'express';
import { isDatabaseConnected } from '@/config/database';
import { HttpStatus } from '@/constants/http';

const router = Router();

router.get('/', (_req, res) => {
  const databaseUp = isDatabaseConnected();
  res.status(databaseUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
    status: databaseUp ? 'ok' : 'unavailable',
    uptimeSeconds: Math.floor(process.uptime()),
    database: databaseUp ? 'connected' : 'disconnected',
  });
});

export const healthRoutes = router;
