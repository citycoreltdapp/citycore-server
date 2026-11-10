import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'waiting_customer',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses that still need work from someone. */
export const ACTIVE_TICKET_STATUSES = [
  'open',
  'in_progress',
  'waiting_customer',
] as const satisfies readonly TicketStatus[];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = ['account', 'wallet', 'banking', 'technical', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export interface ITicket {
  /** What people quote to support, such as TKT-000042. */
  number: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  /** `priority` as a number, because as text it would sort alphabetically. Kept in step on save. */
  priorityRank: number;
  status: TicketStatus;
  /** The customer the ticket is for. Null once their account has been deleted. */
  requester: Types.ObjectId;
  assignee: Types.ObjectId | null;
  /** Differs from `requester` when staff raise a ticket for a customer. */
  createdBy: Types.ObjectId;
  /** URLs from POST /uploads. */
  attachments: string[];
  firstResponseAt: Date | null;
  /** Only public messages count, so this never reveals an internal note to the customer. */
  lastMessageAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ticketSchema = createSchema<ITicket>(
  {
    number: { type: String, required: true, unique: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    category: { type: String, enum: TICKET_CATEGORIES, default: 'other' },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'normal' },
    priorityRank: { type: Number, default: 0 },
    status: { type: String, enum: TICKET_STATUSES, default: 'open' },
    requester: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignee: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    attachments: { type: [String], default: [] },
    firstResponseAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { hiddenFields: ['priorityRank'] },
);

ticketSchema.pre('validate', function () {
  this.priorityRank = TICKET_PRIORITIES.indexOf(this.priority);
});

ticketSchema.index({ requester: 1, createdAt: -1 });
ticketSchema.index({ status: 1, priorityRank: -1, createdAt: 1 });

export const TicketModel = model<ITicket>('Ticket', ticketSchema);

interface ITicketCounter {
  _id: string;
  seq: number;
}

const ticketCounterSchema = createSchema<ITicketCounter>(
  { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
  { options: { timestamps: false } },
);

export const TicketCounterModel = model<ITicketCounter>('TicketCounter', ticketCounterSchema);
