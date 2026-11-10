import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export const BLOG_STATUSES = ['draft', 'published', 'archived'] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

export interface IBlogPost {
  title: string;
  slug: string;
  excerpt: string;
  /** Markdown. A frontend must sanitise whatever it renders from this. */
  content: string;
  coverImage: string | null;
  category: string | null;
  tags: string[];
  metaTitle: string | null;
  metaDescription: string | null;
  status: BlogStatus;
  /** A published post goes live at this time, so a future date schedules it. */
  publishedAt: Date | null;
  author: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const blogPostSchema = createSchema<IBlogPost>({
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true },
  excerpt: { type: String, default: '', trim: true },
  content: { type: String, default: '' },
  coverImage: { type: String, default: null },
  category: { type: String, default: null, trim: true, index: true },
  tags: { type: [String], default: [], index: true },
  metaTitle: { type: String, default: null, trim: true },
  metaDescription: { type: String, default: null, trim: true },
  status: { type: String, enum: BLOG_STATUSES, default: 'draft' },
  publishedAt: { type: Date, default: null },
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
});

blogPostSchema.index({ status: 1, publishedAt: -1 });

export const BlogPostModel = model<IBlogPost>('BlogPost', blogPostSchema);
