import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export interface ISession {
  user: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = createSchema<ISession>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  userAgent: { type: String, default: null },
  ip: { type: String, default: null },
});

// MongoDB deletes each session once its expiry date passes.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = model<ISession>('Session', sessionSchema);
