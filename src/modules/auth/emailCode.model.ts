import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export const EMAIL_CODE_PURPOSES = ['verify_email', 'reset_password', 'sign_in'] as const;
export type EmailCodePurpose = (typeof EMAIL_CODE_PURPOSES)[number];

/** The latest code emailed to an account for one purpose. Requesting another replaces it. */
export interface IEmailCode {
  user: Types.ObjectId;
  /** Where it was sent. It stops working if the account moves to another address. */
  email: string;
  purpose: EmailCodePurpose;
  codeHash: string;
  attempts: number;
  lastSentAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const emailCodeSchema = createSchema<IEmailCode>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, required: true },
  purpose: { type: String, enum: EMAIL_CODE_PURPOSES, required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});

emailCodeSchema.index({ user: 1, purpose: 1 }, { unique: true });
emailCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailCodeModel = model<IEmailCode>('EmailCode', emailCodeSchema);
