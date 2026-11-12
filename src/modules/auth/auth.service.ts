import type { HydratedDocument } from 'mongoose';
import { env } from '@/config/env';
import { Role } from '@/constants/roles';
import { AppError } from '@/core/errors/AppError';
import { googleApi } from '@/integrations/google/google.client';
import { emailNotifications } from '@/modules/email/email.notifications';
import { referralService } from '@/modules/referral/referral.service';
import { UserModel, type IUser } from '@/modules/user/user.model';
import { userService } from '@/modules/user/user.service';
import { simulatePasswordCheck, verifyPassword } from '@/utils/password';
import { signAccessToken } from '@/utils/token';
import type {
  ChangeEmailBody,
  ChangePasswordBody,
  GoogleSignInBody,
  LoginBody,
  RegisterBody,
  ResetPasswordBody,
} from './auth.schemas';
import { EmailCodeModel } from './emailCode.model';
import { emailCodeService, invalidCode } from './emailCode.service';
import { sessionService, type ClientInfo } from './session.service';

const invalidCredentials = () =>
  AppError.unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');

const issueAccessToken = (user: HydratedDocument<IUser>): string =>
  signAccessToken({ sub: user.id, role: user.role, tokenVersion: user.tokenVersion });

const assertPassword = async (user: HydratedDocument<IUser>, password: string): Promise<void> => {
  if (!user.hasPassword) {
    throw AppError.conflict('Set a password for this account first', 'PASSWORD_NOT_SET');
  }
  if (!(await verifyPassword(password, user.password))) {
    throw AppError.badRequest('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
  }
};

const startSession = async (user: HydratedDocument<IUser>, client: ClientInfo) => ({
  user,
  accessToken: issueAccessToken(user),
  refreshToken: await sessionService.create(user.id, client),
});

const MIN_NAME_LENGTH = 2;
const FALLBACK_NAME = 'New Customer';

/** Signup only asks for an email, so jane.doe@example.com starts as Jane Doe until they change it. */
const nameFromEmail = (email: string): string => {
  const name = (email.split('@')[0] ?? '')
    .split(/[^a-zA-Z]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 100);
  return name.length >= MIN_NAME_LENGTH ? name : FALLBACK_NAME;
};

export const authService = {
  async register(
    { referrer: referralCode, name, email, password, accountType }: RegisterBody,
    client: ClientInfo,
  ) {
    // Checked first, so that a mistyped code doesn't leave an account behind without its referrer.
    const referral = referralCode ? await referralService.resolveCode(referralCode) : null;

    const user = await userService.create({
      email,
      password,
      accountType,
      name: name ?? nameFromEmail(email),
      termsAcceptedAt: new Date(),
    });
    if (referral) {
      await referralService.link(referral.referrerId, user.id, referral.code, 'signup');
    }
    await emailNotifications.verificationCode(user);
    return startSession(user, client);
  },

  /**
   * Signs in with Google, creating the account the first time. An email that already has an account
   * isn't joined to it automatically: its email may not be verified, so whoever registered it may
   * not own it, and they'd keep access through their password. Its owner links Google once signed in.
   */
  async signInWithGoogle({ idToken, referralCode }: GoogleSignInBody, client: ClientInfo) {
    const identity = await googleApi.verifyIdToken(idToken);

    const existing = await userService.findOne({ googleId: identity.googleId });
    if (existing) {
      if (!existing.isActive) {
        throw AppError.forbidden('This account is disabled', 'ACCOUNT_DISABLED');
      }
      existing.lastLoginAt = new Date();
      await existing.save();
      return { ...(await startSession(existing, client)), isNewUser: false };
    }

    if (!identity.emailVerified) {
      throw AppError.forbidden('Your Google email is not verified', 'GOOGLE_EMAIL_NOT_VERIFIED');
    }
    if (await UserModel.exists({ email: identity.email })) {
      throw AppError.conflict(
        'This email already has an account. Sign in with your password, then link Google',
        'GOOGLE_LINK_REQUIRED',
      );
    }

    const referral = referralCode ? await referralService.resolveCode(referralCode) : null;
    const user = await userService.create({
      name:
        identity.name && identity.name.length >= MIN_NAME_LENGTH
          ? identity.name.slice(0, 100)
          : nameFromEmail(identity.email),
      email: identity.email,
      emailVerified: true,
      googleId: identity.googleId,
      hasPassword: false,
      // No code came with the signup, so the app asks for one, and they can add it or skip.
      referralPromptPending: !referral,
      lastLoginAt: new Date(),
    });
    if (referral) {
      await referralService.link(referral.referrerId, user.id, referral.code, 'google_signup');
    }
    await emailNotifications.welcome(user);
    return { ...(await startSession(user, client)), isNewUser: true };
  },

  async linkGoogle(userId: string, idToken: string) {
    const identity = await googleApi.verifyIdToken(idToken);
    const user = await userService.findById(userId);

    if (user.googleId) throw AppError.conflict('Google is already linked', 'GOOGLE_ALREADY_LINKED');
    if (!identity.emailVerified) {
      throw AppError.forbidden('Your Google email is not verified', 'GOOGLE_EMAIL_NOT_VERIFIED');
    }
    if (await UserModel.exists({ googleId: identity.googleId })) {
      throw AppError.conflict(
        'That Google account is linked to another user',
        'GOOGLE_ACCOUNT_IN_USE',
      );
    }

    user.googleId = identity.googleId;
    if (identity.email === user.email) user.emailVerified = true;
    await user.save();
    return user;
  },

  /** For an account made with Google. It needs a password to change its email or to close. */
  async setPassword(userId: string, newPassword: string, client: ClientInfo) {
    const user = await userService.findByIdWithPassword(userId);
    if (user.hasPassword) {
      throw AppError.conflict('This account already has a password', 'PASSWORD_ALREADY_SET');
    }

    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();
    await sessionService.revokeAllForUser(userId);
    await emailNotifications.passwordChanged(user);

    return startSession(user, client);
  },

  async login({ email, password }: LoginBody, client: ClientInfo) {
    const user = await userService.findByEmailWithPassword(email);

    // An account made with Google has no password to compare, so it answers like a wrong one.
    if (!user?.hasPassword) {
      await simulatePasswordCheck(password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(password, user.password))) throw invalidCredentials();
    if (!user.isActive) throw AppError.forbidden('This account is disabled', 'ACCOUNT_DISABLED');

    if (env.AUTH_LOGIN_CODE) {
      await emailNotifications.signInCode(user);
      return { verificationRequired: true as const, email: user.email };
    }

    user.lastLoginAt = new Date();
    await user.save();
    return startSession(user, client);
  },

  async verifyLogin(email: string, code: string, client: ClientInfo) {
    const user = await userService.findOne({ email, isActive: true });
    if (!user) throw invalidCode();
    await emailCodeService.check(String(user._id), user.email, 'sign_in', code, { consume: true });

    user.lastLoginAt = new Date();
    if (!user.emailVerified) user.emailVerified = true;
    await user.save();
    return startSession(user, client);
  },

  async resendLoginCode(email: string): Promise<void> {
    const user = await userService.findOne({ email, isActive: true });
    if (!user) return;
    const pending = await EmailCodeModel.exists({
      user: user._id,
      purpose: 'sign_in',
      expiresAt: { $gt: new Date() },
    });
    if (pending) await emailNotifications.signInCode(user);
  },

  async refresh(refreshToken: string, client: ClientInfo) {
    const { userId, token } = await sessionService.rotate(refreshToken, client);
    const user = await userService.findOne({ _id: userId, isActive: true });

    if (!user) {
      await sessionService.revokeAllForUser(userId);
      throw AppError.unauthorized('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
    }

    return { user, accessToken: issueAccessToken(user), refreshToken: token };
  },

  logout(refreshToken: string) {
    return sessionService.revoke(refreshToken);
  },

  /** Ends every session and invalidates access tokens already issued. */
  async logoutEverywhere(userId: string) {
    const user = await userService.findById(userId);
    user.tokenVersion += 1;
    await user.save();
    await sessionService.revokeAllForUser(userId);
  },

  /** Signs out every other device and returns a new session for this one. */
  async changePassword(
    userId: string,
    { currentPassword, newPassword }: ChangePasswordBody,
    client: ClientInfo,
  ) {
    const user = await userService.findByIdWithPassword(userId);

    await assertPassword(user, currentPassword);

    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();
    await sessionService.revokeAllForUser(userId);
    await emailNotifications.passwordChanged(user);

    return startSession(user, client);
  },

  async requestEmailVerification(email: string): Promise<void> {
    const user = await userService.findOne({ email, isActive: true, emailVerified: false });
    if (user) await emailNotifications.verificationCode(user);
  },

  /**
   * The welcome waits until here, so that a mistyped address doesn't get one. Answers with a session,
   * so the app can go straight from the code screen to the dashboard. The code proves the inbox, as
   * a password reset would, so this gives nothing that a reset wouldn't.
   */
  async verifyEmail(email: string, code: string, client: ClientInfo) {
    const user = await userService.findOne({ email, isActive: true });
    if (!user) throw invalidCode();
    await emailCodeService.check(user.id, user.email, 'verify_email', code, { consume: true });
    user.emailVerified = true;
    user.lastLoginAt = new Date();
    await user.save();
    await emailNotifications.welcome(user);
    return startSession(user, client);
  },

  async forgotPassword(email: string): Promise<void> {
    const user = await userService.findOne({ email, isActive: true });
    if (user) await emailNotifications.passwordResetCode(user);
  },

  /** For the screen between entering the code and choosing a password. It stays usable. */
  async checkResetCode(email: string, code: string): Promise<void> {
    const user = await userService.findOne({ email, isActive: true });
    if (!user) throw invalidCode();
    await emailCodeService.check(user.id, user.email, 'reset_password', code, { consume: false });
  },

  /** Also signs out every device, as whoever had the old password shouldn't stay signed in. */
  async resetPassword({ email, code, newPassword }: ResetPasswordBody): Promise<void> {
    const user = await userService.findOne({ email, isActive: true });
    if (!user) throw invalidCode();
    await emailCodeService.check(user.id, user.email, 'reset_password', code, { consume: true });

    user.password = newPassword;
    user.tokenVersion += 1;
    // The code reached that inbox, which proves as much as verifying it would.
    user.emailVerified = true;
    await user.save();
    await sessionService.revokeAllForUser(user.id);
    await emailNotifications.passwordChanged(user);
  },

  async changeEmail(userId: string, { email, currentPassword }: ChangeEmailBody) {
    const user = await userService.findByIdWithPassword(userId);
    await assertPassword(user, currentPassword);

    if (email === user.email) {
      throw AppError.conflict('That is already your email', 'EMAIL_UNCHANGED');
    }
    await userService.assertEmailNotLocked(userId);

    const oldEmail = user.email;
    user.email = email;
    await user.save();
    await emailNotifications.emailChanged(user, oldEmail);
    await emailNotifications.verificationCode(user);
    return user;
  },

  /**
   * Deactivates rather than deletes, so financial records keep their owner and staff can restore
   * the account. The email stays taken while it's closed.
   */
  async closeAccount(userId: string, currentPassword: string): Promise<void> {
    const user = await userService.findByIdWithPassword(userId);
    await assertPassword(user, currentPassword);
    await userService.assertNoFundsHeld(userId);

    if (user.role === Role.SUPER_ADMIN) {
      const others = await UserModel.countDocuments({
        _id: { $ne: userId },
        role: Role.SUPER_ADMIN,
        isActive: true,
      }).exec();
      if (others === 0) {
        throw AppError.conflict('Appoint another super admin first', 'LAST_SUPER_ADMIN');
      }
    }

    user.isActive = false;
    user.tokenVersion += 1;
    await user.save();
    await sessionService.revokeAllForUser(userId);
    await emailNotifications.accountClosed(user);
  },
};
