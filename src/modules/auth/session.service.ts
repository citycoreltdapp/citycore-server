import { env } from '@/config/env';
import { AppError } from '@/core/errors/AppError';
import { generateOpaqueToken, hashToken } from '@/utils/token';
import { SessionModel } from './session.model';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export const REFRESH_TOKEN_TTL_MS = env.REFRESH_TOKEN_TTL_DAYS * DAY_IN_MS;

export interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

const invalidRefreshToken = () =>
  AppError.unauthorized('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');

export const sessionService = {
  /** Starts a session and returns its refresh token. */
  async create(userId: string, client: ClientInfo): Promise<string> {
    const token = generateOpaqueToken();
    await SessionModel.create({
      user: userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userAgent: client.userAgent ?? null,
      ip: client.ip ?? null,
    });
    return token;
  },

  /**
   * Exchanges a refresh token for a new one. Each token works once, so seeing a used token again
   * means it was stolen or replayed, and every session the user has is revoked.
   */
  async rotate(token: string, client: ClientInfo): Promise<{ userId: string; token: string }> {
    const tokenHash = hashToken(token);
    const now = new Date();

    // A single atomic update, so two concurrent requests can't both redeem the same token.
    const session = await SessionModel.findOneAndUpdate(
      { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
      { revokedAt: now },
    ).exec();

    if (!session) {
      const used = await SessionModel.findOne({ tokenHash, revokedAt: { $ne: null } }).exec();
      if (used) await this.revokeAllForUser(used.user.toString());
      throw invalidRefreshToken();
    }

    const userId = session.user.toString();
    return { userId, token: await this.create(userId, client) };
  },

  async revoke(token: string): Promise<void> {
    await SessionModel.updateOne(
      { tokenHash: hashToken(token), revokedAt: null },
      { revokedAt: new Date() },
    ).exec();
  },

  /** A session is one signed-in device: refreshing replaces its record rather than adding one. */
  async listActive(userId: string, currentToken?: string) {
    const currentHash = currentToken ? hashToken(currentToken) : null;
    const sessions = await SessionModel.find({
      user: userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort('-createdAt')
      .lean()
      .exec();
    // Built by hand so that the token hash can't reach the response.
    return sessions.map((session) => ({
      id: String(session._id),
      userAgent: session.userAgent,
      ip: session.ip,
      lastActiveAt: session.createdAt,
      expiresAt: session.expiresAt,
      current: session.tokenHash === currentHash,
    }));
  },

  /**
   * Ends one of the user's sessions and says whether it was the caller's own. The record is deleted
   * rather than revoked: when that device next refreshes, a revoked record would look like a stolen
   * token and sign the user out everywhere.
   */
  async removeOwned(userId: string, sessionId: string, currentToken?: string): Promise<boolean> {
    const session = await SessionModel.findOneAndDelete({
      _id: sessionId,
      user: userId,
      revokedAt: null,
    }).exec();
    if (!session) throw AppError.notFound('Session not found');
    return !!currentToken && session.tokenHash === hashToken(currentToken);
  },

  async revokeAllForUser(userId: string): Promise<void> {
    await SessionModel.updateMany(
      { user: userId, revokedAt: null },
      { revokedAt: new Date() },
    ).exec();
  },
};
