import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';
import { managedConfigName } from './platformConfig.managed';

export const CONFIG_TYPES = ['string', 'number', 'boolean', 'json'] as const;
export type ConfigType = (typeof CONFIG_TYPES)[number];

/** A setting staff can change at runtime. Secrets belong in `.env`, because these aren't encrypted. */
export interface IPlatformConfig {
  /** Permanent, so that anything reading the setting keeps working. */
  key: string;
  label: string;
  description: string;
  category: string;
  type: ConfigType;
  /** Always matches `type`: see `configValueError`. */
  value: unknown;
  /** Whether `GET /platform-config` shows this to anyone, signed in or not. */
  isPublic: boolean;
  /** Null when the system made the change, as when it first creates a managed setting. */
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const platformConfigSchema = createSchema<IPlatformConfig>(
  {
    key: { type: String, required: true, unique: true, immutable: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    category: { type: String, default: 'general', index: true },
    type: { type: String, enum: CONFIG_TYPES, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    isPublic: { type: Boolean, default: false, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  // Otherwise an empty object in a JSON value would be dropped when saved.
  { options: { minimize: false } },
);

/** Tells a frontend which settings can only have their value changed. */
platformConfigSchema.virtual('managed').get(function () {
  return managedConfigName(this.key) !== undefined;
});

export const PlatformConfigModel = model<IPlatformConfig>('PlatformConfig', platformConfigSchema);
