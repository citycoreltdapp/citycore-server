import { z } from 'zod';
import {
  createListQuerySchema,
  objectIdSchema,
  requireAtLeastOneField,
} from '@/core/validation/common.schemas';
import { cloudinaryStorage } from '@/integrations/cloudinary/cloudinary.client';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from './ticket.model';

const MAX_TEXT_LENGTH = 10_000;
const MAX_ATTACHMENTS = 5;

// Only files from POST /uploads, so a ticket can't carry a link for staff to be tricked into opening.
const attachmentsSchema = z
  .array(
    z
      .string()
      .trim()
      .max(2048)
      .refine(cloudinaryStorage.isStoredUrl, 'Attachment must be a URL from POST /uploads'),
  )
  .max(MAX_ATTACHMENTS);

const textSchema = z.string().trim().min(1).max(MAX_TEXT_LENGTH);

const ticketFields = z.object({
  subject: z.string().trim().min(3).max(200),
  description: textSchema,
  category: z.enum(TICKET_CATEGORIES),
  attachments: attachmentsSchema,
});

const triageFields = z.object({
  priority: z.enum(TICKET_PRIORITIES),
  assignee: objectIdSchema.nullable(),
});

export const createTicketBodySchema = ticketFields
  .partial()
  .required({ subject: true, description: true });

export const updateTicketBodySchema = requireAtLeastOneField(ticketFields.partial());

export const adminCreateTicketBodySchema = createTicketBodySchema
  .extend(triageFields.partial().shape)
  .extend({ requester: objectIdSchema });

export const adminUpdateTicketBodySchema = requireAtLeastOneField(
  ticketFields
    .extend(triageFields.shape)
    .extend({ status: z.enum(TICKET_STATUSES) })
    .partial(),
);

// `status=open,in_progress` matches either.
const statusFilter = z
  .string()
  .transform((value) => value.split(','))
  .pipe(z.array(z.enum(TICKET_STATUSES)))
  .transform((statuses) => ({ $in: statuses }))
  .optional();

const ticketFilters = {
  status: statusFilter,
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
};

const TICKET_SORTABLE = ['createdAt', 'updatedAt', 'lastMessageAt', 'priorityRank'];

export const listTicketsQuerySchema = createListQuerySchema({
  sortable: TICKET_SORTABLE,
  filters: ticketFilters,
});

export const adminListTicketsQuerySchema = createListQuerySchema({
  sortable: TICKET_SORTABLE,
  filters: {
    ...ticketFilters,
    requester: objectIdSchema.optional(),
    assignee: objectIdSchema.optional(),
    unassigned: z.stringbool().optional(),
  },
});

const messageFields = z.object({ body: textSchema, attachments: attachmentsSchema });

export const createMessageBodySchema = messageFields.partial().required({ body: true });

export const adminCreateMessageBodySchema = createMessageBodySchema.extend({
  internal: z.boolean().optional(),
});

export const updateMessageBodySchema = requireAtLeastOneField(messageFields.partial());

export const listMessagesQuerySchema = createListQuerySchema({
  sortable: ['createdAt'],
  defaultSort: 'createdAt',
});

export const messageParamsSchema = z.object({ id: objectIdSchema, messageId: objectIdSchema });
