import mongoose from 'mongoose';
import { env } from './env';
import { logger } from './logger';

mongoose.set('strictQuery', true);

mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));

export const connectDatabase = async (uri: string = env.MONGODB_URI): Promise<void> => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
};

export const disconnectDatabase = (): Promise<void> => mongoose.disconnect();

export const isDatabaseConnected = (): boolean =>
  mongoose.connection.readyState === mongoose.ConnectionStates.connected;

/** Multi-document transactions, which the wallet and investments rely on, need a replica set. */
export const assertTransactionsSupported = async (): Promise<void> => {
  const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
  if (!hello?.setName && hello?.msg !== 'isdbgrid') {
    throw new Error(
      'The wallet and investments need MongoDB transactions, but this server is not a replica set. Use Atlas, or `docker compose up -d` from this project.',
    );
  }
};
