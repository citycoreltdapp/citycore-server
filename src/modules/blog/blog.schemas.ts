import { z } from 'zod';
import {
  createListQuerySchema,
  imageSchema,
  objectIdSchema,
  requireAtLeastOneField,
  slugSchema,
} from '@/core/validation/common.schemas';
import { BLOG_STATUSES } from './blog.model';

const MAX_CONTENT_LENGTH = 200_000;

const tagSchema = z.string().trim().toLowerCase().min(1).max(30);

const fields = z.object({
  title: z.string().trim().min(3).max(200),
  slug: slugSchema,
  excerpt: z.string().trim().max(500),
  content: z.string().max(MAX_CONTENT_LENGTH),
  coverImage: imageSchema.nullable(),
  category: z.string().trim().min(1).max(60).nullable(),
  tags: z
    .array(tagSchema)
    .max(20)
    .transform((tags) => [...new Set(tags)]),
  metaTitle: z.string().trim().max(200).nullable(),
  metaDescription: z.string().trim().max(320).nullable(),
});

export const createPostBodySchema = fields.partial().required({ title: true });

export const updatePostBodySchema = requireAtLeastOneField(fields.partial());

export const publishPostBodySchema = z
  .object({
    /** A future time schedules the post. Omit it to publish now. */
    publishAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
  })
  // Express leaves the body undefined when a POST sends none.
  .default({});

export const slugParamsSchema = z.object({ slug: slugSchema });

const contentFilters = {
  category: z.string().trim().min(1).max(60).optional(),
  tag: tagSchema.optional(),
};

export const listPublicPostsQuerySchema = createListQuerySchema({
  sortable: ['publishedAt', 'title'],
  defaultSort: '-publishedAt',
  maxLimit: 50,
  filters: contentFilters,
});

export const listAdminPostsQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'updatedAt', 'publishedAt', 'title'],
  defaultSort: '-updatedAt',
  filters: {
    ...contentFilters,
    status: z.enum(BLOG_STATUSES).optional(),
    author: objectIdSchema.optional(),
  },
});
