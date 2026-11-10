import type { Request, Response } from 'express';
import { env, isProduction } from '@/config/env';
import { AppError } from '@/core/errors/AppError';
import { controller } from '@/core/http/controller';
import { created, noContent, ok } from '@/core/http/response';
import { currentUser } from '@/middlewares/auth';
import { logger } from '@/config/logger';
import { idParamsSchema } from '@/core/validation/common.schemas';
import {
  changeEmailBodySchema,
  changePasswordBodySchema,
  closeAccountBodySchema,
  emailBodySchema,
  emailCodeBodySchema,
  googleSignInBodySchema,
  linkGoogleBodySchema,
  loginBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  setPasswordBodySchema,
} from './auth.schemas';
import { authService } from './auth.service';
import { REFRESH_TOKEN_TTL_MS, sessionService, type ClientInfo } from './session.service';

const REFRESH_COOKIE = 'refreshToken';

const refreshCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict',
  path: `${env.API_PREFIX}/auth`,
} as const;

const getClientInfo = (req: Pick<Request, 'ip' | 'headers'>): ClientInfo => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

const readRefreshCookie = (req: Pick<Request, 'cookies'>): string | undefined =>
  req.cookies?.[REFRESH_COOKIE];

/** The refresh token goes in an httpOnly cookie, out of reach of page scripts, not the body. */
const sendSession = <T extends { user: unknown; accessToken: string; refreshToken: string }>(
  res: Response,
  { refreshToken, ...session }: T,
  respond: typeof ok = ok,
  message?: string,
): void => {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...refreshCookieOptions,
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
  respond(res, session, message);
};

// The same answer whether or not the account exists, so these can't be used to test for one.
const CODE_SENT_MESSAGE = 'If that address has an account, a code is on its way';

export const authController = {
  requestEmailVerification: controller({ body: emailBodySchema }, async (req, res) => {
    await authService.requestEmailVerification(req.body.email);
    ok(res, undefined, CODE_SENT_MESSAGE);
  }),

  verifyEmail: controller({ body: emailCodeBodySchema }, async (req, res) => {
    const session = await authService.verifyEmail(
      req.body.email,
      req.body.code,
      getClientInfo(req),
    );
    sendSession(res, session, ok, 'Email verified');
  }),

  forgotPassword: controller({ body: emailBodySchema }, async (req, res) => {
    await authService.forgotPassword(req.body.email);
    ok(res, undefined, CODE_SENT_MESSAGE);
  }),

  checkResetCode: controller({ body: emailCodeBodySchema }, async (req, res) => {
    await authService.checkResetCode(req.body.email, req.body.code);
    ok(res, { valid: true });
  }),

  resetPassword: controller({ body: resetPasswordBodySchema }, async (req, res) => {
    await authService.resetPassword(req.body);
    ok(res, undefined, 'Password changed. You can sign in now');
  }),

  register: controller({ body: registerBodySchema }, async (req, res) => {
    const session = await authService.register(req.body, getClientInfo(req));
    sendSession(res, session, created, 'Account created');
  }),

  login: controller({ body: loginBodySchema }, async (req, res) => {
    sendSession(res, await authService.login(req.body, getClientInfo(req)));
  }),

  google: controller({ body: googleSignInBodySchema }, async (req, res) => {
    const session = await authService.signInWithGoogle(req.body, getClientInfo(req));
    if (session.isNewUser) sendSession(res, session, created, 'Account created');
    else sendSession(res, session);
  }),

  linkGoogle: controller({ body: linkGoogleBodySchema }, async (req, res) => {
    const { id } = currentUser(req);
    const user = await authService.linkGoogle(id, req.body.idToken);
    logger.info({ userId: id }, 'User linked Google');
    ok(res, user, 'Google linked');
  }),

  setPassword: controller({ body: setPasswordBodySchema }, async (req, res) => {
    const session = await authService.setPassword(
      currentUser(req).id,
      req.body.newPassword,
      getClientInfo(req),
    );
    sendSession(res, session, ok, 'Password set');
  }),

  refresh: controller({}, async (req, res) => {
    const token = readRefreshCookie(req);
    if (!token) throw AppError.unauthorized('Refresh token missing', 'INVALID_REFRESH_TOKEN');
    sendSession(res, await authService.refresh(token, getClientInfo(req)));
  }),

  logout: controller({}, async (req, res) => {
    const token = readRefreshCookie(req);
    if (token) await authService.logout(token);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
    noContent(res);
  }),

  logoutEverywhere: controller({}, async (req, res) => {
    await authService.logoutEverywhere(currentUser(req).id);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
    noContent(res);
  }),

  changePassword: controller({ body: changePasswordBodySchema }, async (req, res) => {
    const session = await authService.changePassword(
      currentUser(req).id,
      req.body,
      getClientInfo(req),
    );
    sendSession(res, session, ok, 'Password changed');
  }),

  changeEmail: controller({ body: changeEmailBodySchema }, async (req, res) => {
    const { id } = currentUser(req);
    const user = await authService.changeEmail(id, req.body);
    logger.info({ userId: id }, 'User changed their email');
    ok(res, user, 'Email changed');
  }),

  closeAccount: controller({ body: closeAccountBodySchema }, async (req, res) => {
    const { id } = currentUser(req);
    await authService.closeAccount(id, req.body.currentPassword);
    logger.info({ userId: id }, 'User closed their account');
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
    noContent(res);
  }),

  listSessions: controller({}, async (req, res) => {
    ok(res, await sessionService.listActive(currentUser(req).id, readRefreshCookie(req)));
  }),

  removeSession: controller({ params: idParamsSchema }, async (req, res) => {
    const wasCurrent = await sessionService.removeOwned(
      currentUser(req).id,
      req.params.id,
      readRefreshCookie(req),
    );
    if (wasCurrent) res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
    noContent(res);
  }),
};
