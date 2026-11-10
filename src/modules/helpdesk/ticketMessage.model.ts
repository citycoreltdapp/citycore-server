import { model, Schema, type Types } from 'mongoose';
import { createSchema } from '@/core/database/createSchema';

export interface ITicketMessage {
  ticket: Types.ObjectId;
  author: Types.ObjectId;
  body: string;
  /** URLs from POST /uploads. */
  attachments: string[];
  /** Posted through the staff routes, so a frontend can tell the two sides of a conversation. */
  fromStaff: boolean;
  /** A note between staff. Customers never see it, nor any sign that it exists. */
  internal: boolean;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ticketMessageSchema = createSchema<ITicketMessage>({
  ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true },
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, required: true },
  attachments: { type: [String], default: [] },
  fromStaff: { type: Boolean, default: false },
  internal: { type: Boolean, default: false },
  editedAt: { type: Date, default: null },
});

ticketMessageSchema.index({ ticket: 1, createdAt: 1 });

export const TicketMessageModel = model<ITicketMessage>('TicketMessage', ticketMessageSchema);
