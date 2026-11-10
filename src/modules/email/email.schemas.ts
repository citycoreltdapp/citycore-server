import { z } from 'zod';
import { createListQuerySchema, objectIdSchema } from '@/core/validation/common.schemas';
import { EMAIL_CATEGORIES, EMAIL_STATUSES } from './email.model';

const MAX_RECIPIENTS = 500;

export const listActivityQuerySchema = createListQuerySchema({
  sortable: ['createdAt', 'sentAt', 'status', 'to', 'subject'],
  filters: {
    status: z.enum(EMAIL_STATUSES).optional(),
    category: z.enum(EMAIL_CATEGORIES).optional(),
    template: z.string().trim().min(1).max(100).optional(),
    user: objectIdSchema.optional(),
    triggeredBy: objectIdSchema.optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  },
});

const subjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(150)
  .refine((value) => !/[\r\n]/.test(value), 'Subject must be a single line');
const messageSchema = z.string().trim().min(1).max(5000);

const isTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const updateBirthdaySettingsBodySchema = z
  .object({
    autoSendEnabled: z.boolean(),
    subject: subjectSchema,
    message: messageSchema,
    sendHour: z.number().int().min(0).max(23),
    timezone: z.string().trim().refine(isTimezone, 'Unknown timezone'),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export const previewBirthdayBodySchema = z.object({
  subject: subjectSchema.optional(),
  message: messageSchema.optional(),
});

export const sendBirthdayBodySchema = previewBirthdayBodySchema.extend({
  userIds: z.array(objectIdSchema).min(1).max(MAX_RECIPIENTS).optional(),
});

export const upcomingBirthdaysQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
