import type { Server } from 'node:http';
import { createApp } from './app';
import {
  assertTransactionsSupported,
  connectDatabase,
  disconnectDatabase,
} from './config/database';
import { env } from './config/env';
import { logger } from './config/logger';
import { platformConfigService } from './modules/platformConfig/platformConfig.service';
import {
  startInvestmentWorker,
  stopInvestmentWorker,
} from './modules/investment/investment.worker';
import { startWalletWorker, stopWalletWorker } from './modules/wallet/wallet.worker';
import { startEmailWorkers, stopEmailWorkers } from './modules/email/email.worker';
import { startSymplusWorker, stopSymplusWorker } from './modules/symplus/symplus.worker';


const SHUTDOWN_TIMEOUT_MS = 10_000;

let server: Server | undefined;
let shuttingDown = false;

const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'Shutting down');

  // Open connections shouldn't be able to hold the process up forever.
  setTimeout(() => {
    logger.error('Shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    if (server) {
      const closing = server;
      await new Promise<void>((resolve, reject) => {
        closing.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await Promise.all([
      stopSymplusWorker(),
      stopWalletWorker(),
      stopInvestmentWorker(),
      stopEmailWorkers(),
    ]);
    await disconnectDatabase();
    process.exit(exitCode);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
};

const start = async (): Promise<void> => {
  await connectDatabase();
  await assertTransactionsSupported();
  await platformConfigService.seedManagedConfigs();
  startSymplusWorker();
  startWalletWorker();
  startInvestmentWorker();
  startEmailWorkers();
  server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, `Listening on port ${env.PORT}`);
  });
  server.on('error', (err) => {
    logger.fatal({ err }, 'Server error');
    void shutdown('server error', 1);
  });
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled rejection');
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});

start().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
