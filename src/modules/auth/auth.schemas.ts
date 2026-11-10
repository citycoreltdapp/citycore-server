import { z } from 'zod';
import { emailSchema, nameSchema, passwordSchema } from '@/core/validation/common.schemas';
import { optionalReferralCodeSchema } from '@/modules/referral/referral.schemas';

export const registerBodySchema = z.object({
  /** Optional: the customer can add it to their profile later. */
  name: nameSchema.optional(),
  email: emailSchema,
  password: passwordSchema,
  referralCode: optionalReferralCodeSchema,
});

const googleTokenSchema = z.string().trim().min(1, 'A Google token is required').max(4096);

export const googleSignInBodySchema = z.object({
  idToken: googleTokenSchema,
  referralCode: optionalReferralCodeSchema,
});

export const linkGoogleBodySchema = z.object({ idToken: googleTokenSchema });

export const setPasswordBodySchema = z.object({ newPassword: passwordSchema });

export const loginBodySchema = z.object({
  email: emailSchema,
  // Password rules aren't applied here, so older passwords keep working if the rules change.
  password: z.string().min(1, 'Password is required').max(200),
});

export const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(200),
    newPassword: passwordSchema,
  })
  .refine((body) => body.currentPassword !== body.newPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current one',
  });

export const changeEmailBodySchema = z.object({
  email: emailSchema,
  currentPassword: z.string().min(1, 'Current password is required').max(200),
});

const emailCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6 digit code');

export const emailBodySchema = z.object({ email: emailSchema });

export const emailCodeBodySchema = z.object({ email: emailSchema, code: emailCodeSchema });

export const resetPasswordBodySchema = emailCodeBodySchema.extend({ newPassword: passwordSchema });

export const closeAccountBodySchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(200),
});

export type ResetPasswordBody = z.output<typeof resetPasswordBodySchema>;
export type GoogleSignInBody = z.output<typeof googleSignInBodySchema>;
export type ChangeEmailBody = z.output<typeof changeEmailBodySchema>;
export type RegisterBody = z.output<typeof registerBodySchema>;
export type LoginBody = z.output<typeof loginBodySchema>;
export type ChangePasswordBody = z.output<typeof changePasswordBodySchema>;
