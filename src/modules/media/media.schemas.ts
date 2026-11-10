import { z } from 'zod';
import { createListQuerySchema, requireAtLeastOneField } from '@/core/validation/common.schemas';
import { MEDIA_KINDS } from './media.model';

const mediaDetails = {
  title: z.string().trim().max(200),
  altText: z.string().trim().max(300),
};

export const listMediaQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'title', 'size'],
  filters: { kind: z.enum(MEDIA_KINDS).optional() },
});

// Optional as a whole, so that a request with no file reaches the "file required" error.
export const uploadMediaBodySchema = z.object(mediaDetails).partial().optional();

export const updateMediaBodySchema = requireAtLeastOneField(z.object(mediaDetails).partial());
