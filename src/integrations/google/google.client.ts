import { OAuth2Client } from 'google-auth-library';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { HttpStatus } from '@/constants/http';
import { AppError } from '@/core/errors/AppError';

export interface GoogleIdentity {
  /** Google's permanent id for the account. Unlike the email, it never changes. */
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

const client = new OAuth2Client();

const invalidToken = () => AppError.unauthorized('Invalid Google sign-in', 'INVALID_GOOGLE_TOKEN');

const isNetworkFailure = (err: unknown): boolean =>
  err instanceof TypeError || (err as Error | null)?.name === 'GaxiosError';

export const googleApi = {
  /** Checks the signature, expiry, issuer and audience, so a token for another app is refused. */
  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    if (env.GOOGLE_CLIENT_IDS.length === 0) {
      throw new AppError(
        'Google sign-in is not available right now',
        HttpStatus.SERVICE_UNAVAILABLE,
        'GOOGLE_SIGN_IN_DISABLED',
      );
    }

    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_IDS });
      payload = ticket.getPayload();
    } catch (err) {
      if (isNetworkFailure(err)) {
        logger.warn({ err }, 'Could not reach Google to verify a sign-in');
        throw new AppError(
          'Google sign-in is temporarily unavailable',
          HttpStatus.BAD_GATEWAY,
          'GOOGLE_UNAVAILABLE',
        );
      }
      throw invalidToken();
    }

    if (!payload?.sub || !payload.email) throw invalidToken();
    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: payload.name?.trim() || null,
    };
  },
};
