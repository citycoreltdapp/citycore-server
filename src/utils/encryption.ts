import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '@/config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const getKey = (): Buffer => {
  if (!env.DATA_ENCRYPTION_KEY) throw new Error('DATA_ENCRYPTION_KEY is not set');
  return Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
};

export const encrypt = (plainText: string): string => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
};

export const decrypt = (payload: string): string => {
  const [iv, authTag, encrypted] = payload.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !authTag || !encrypted) throw new Error('Malformed encrypted payload');
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};
