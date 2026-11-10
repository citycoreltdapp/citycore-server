import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Permission } from '@/constants/permissions';
import { Role } from '@/constants/roles';
import { AppError } from '@/core/errors/AppError';
import { permissionsForRole } from '@/modules/role/role.model';
import { UserModel } from '@/modules/user/user.model';
import { verifyAccessToken, type AccessTokenClaims } from '@/utils/token';

const readBearerToken = (header: string | undefined): string => {
  const [scheme, token] = header?.split(' ') ?? [];
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw AppError.unauthorized();
  return token;
};

const decodeToken = (token: string): AccessTokenClaims => {
  try {
    return verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    throw AppError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }
};

/**
 * Checks the user on every request, so deactivation, role changes and password changes apply
 * immediately rather than when the access token expires.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const claims = decodeToken(readBearerToken(req.headers.authorization));

  const user = await UserModel.findById(claims.sub)
    .select('role isActive tokenVersion kycCompleted')
    .lean()
    .exec();

  if (!user || !user.isActive || user.tokenVersion !== claims.tokenVersion) {
    throw AppError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }

  req.user = {
    id: claims.sub,
    role: user.role,
    kycCompleted: user.kycCompleted,
    permissions: await permissionsForRole(user.role),
  };
  next();
};

/** A super admin passes every check, including any permission added in future. */
export const hasPermission = (
  user: Omit<Express.AuthUser, 'kycCompleted'>,
  permission: Permission,
): boolean => user.role === Role.SUPER_ADMIN || user.permissions.includes(permission);

/** Allows the request only if the user's role has every one of the given permissions. */
export const requirePermission =
  (...permissions: Permission[]): RequestHandler =>
  (req, _res, next) => {
    const user = currentUser(req);
    if (!permissions.every((permission) => hasPermission(user, permission))) {
      throw AppError.forbidden();
    }
    next();
  };

/**
 * For actions that put money in. Anyone can sign in and use the dashboard without KYC. The code
 * tells a frontend to send the user to onboarding rather than show a generic error.
 */
export const requireKyc: RequestHandler = (req, _res, next) => {
  if (!currentUser(req).kycCompleted) {
    throw AppError.forbidden('Complete your KYC to do this', 'KYC_REQUIRED');
  }
  next();
};

/** The signed-in user. For handlers on routes behind `authenticate`. */
export const currentUser = (req: { user?: Express.AuthUser }): Express.AuthUser => {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
};
