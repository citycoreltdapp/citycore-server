import { createHash, randomBytes } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '@/config/env';

const JWT_ALGORITHM = 'HS256';

export interface AccessTokenClaims {
  sub: string;
  role: string;
  /** Compared with the user's tokenVersion, so access tokens can be revoked before they expire. */
  tokenVersion: number;
}

export const signAccessToken = (claims: AccessTokenClaims): string =>
  jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'],
  });

export const verifyAccessToken = (token: string): AccessTokenClaims =>
  jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: [JWT_ALGORITHM],
  }) as unknown as AccessTokenClaims;

export const generateOpaqueToken = (): string => randomBytes(48).toString('base64url');

/** Random tokens have enough entropy for a fast hash, so bcrypt isn't needed here. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
