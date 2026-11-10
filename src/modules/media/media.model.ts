import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export const MEDIA_KINDS = ['image', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface IMedia {
  url: string;
  kind: MediaKind;
  originalName: string;
  mimeType: string;
  size: number;
  title: string;
  /** Describes an image for screen readers. */
  altText: string;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const mediaSchema = createSchema<IMedia>({
  url: { type: String, required: true, unique: true },
  kind: { type: String, enum: MEDIA_KINDS, required: true, index: true },
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  title: { type: String, default: '', trim: true },
  altText: { type: String, default: '', trim: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
});

export const MediaModel = model<IMedia>('Media', mediaSchema);
