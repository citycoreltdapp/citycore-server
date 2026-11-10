import bcrypt from 'bcrypt';
import { env } from '@/config/env';

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, env.BCRYPT_ROUNDS);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

let dummyHash: Promise<string> | undefined;

/**
 * Spends the same time as a real check when no account matches, so response timing doesn't reveal
 * which email addresses are registered.
 */
export const simulatePasswordCheck = async (plain: string): Promise<void> => {
  dummyHash ??= hashPassword('placeholder-password-never-matched');
  await verifyPassword(plain, await dummyHash);
};
