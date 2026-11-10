import { Types, type HydratedDocument, type QueryFilter } from 'mongoose';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import type { ListQuery } from '@/core/validation/common.schemas';
import { emailNotifications } from '@/modules/email/email.notifications';
import { TicketMessageModel, type ITicketMessage } from './ticketMessage.model';
import { ticketService, type Ticket } from './ticket.service';

type TicketMessage = HydratedDocument<ITicketMessage>;

interface MessageContent {
  body?: string;
  attachments?: string[];
}

/** Who is acting, which decides what they can see. */
export interface MessageViewer {
  userId: string;
  /** Staff routes only. Customers can't reach internal notes, even by id. */
  isStaff: boolean;
}

/** Long enough to fix a typo, but too short to rewrite what the other side has already answered. */
const EDIT_WINDOW_MINUTES = 15;

const AUTHOR_POPULATE = {
  path: 'author',
  select: 'name avatar',
  options: { lean: true },
  transform: (author: { _id: unknown; name: string; avatar: string | null } | null) =>
    author && { id: String(author._id), name: author.name, avatar: author.avatar },
};

class TicketMessageService extends BaseService<ITicketMessage> {
  constructor() {
    super(TicketMessageModel, { resourceName: 'Message' });
  }

  private visibleTo(ticket: Ticket, { isStaff }: MessageViewer): QueryFilter<ITicketMessage> {
    return { ticket: ticket._id, ...(isStaff ? {} : { internal: false }) };
  }

  private async getVisible(
    ticket: Ticket,
    messageId: string,
    viewer: MessageViewer,
  ): Promise<TicketMessage> {
    const message = await this.findOne({ ...this.visibleTo(ticket, viewer), _id: messageId });
    if (!message) throw this.notFound();
    return message;
  }

  private assertAuthorCanChange(ticket: Ticket, message: TicketMessage, userId: string): void {
    if (String(message.author) !== userId) {
      throw AppError.forbidden('You can only change your own messages', 'MESSAGE_NOT_YOURS');
    }
    ticketService.assertNotClosed(ticket);
    const age = Date.now() - message.createdAt.getTime();
    if (age > EDIT_WINDOW_MINUTES * 60 * 1000) {
      throw AppError.conflict(
        `Messages can only be changed for ${EDIT_WINDOW_MINUTES} minutes`,
        'MESSAGE_LOCKED',
      );
    }
  }

  async list(ticket: Ticket, query: ListQuery, viewer: MessageViewer) {
    const result = await this.paginate(query, this.visibleTo(ticket, viewer));
    await TicketMessageModel.populate(result.items, AUTHOR_POPULATE);
    return result;
  }

  async get(ticket: Ticket, messageId: string, viewer: MessageViewer): Promise<TicketMessage> {
    return (await this.getVisible(ticket, messageId, viewer)).populate(AUTHOR_POPULATE);
  }

  /** Internal notes may be added to a closed ticket, since the customer sees no change. */
  async add(
    ticket: Ticket,
    data: MessageContent & { body: string; internal?: boolean },
    { userId, isStaff }: MessageViewer,
  ): Promise<TicketMessage> {
    const internal = isStaff && data.internal === true;
    if (!internal) ticketService.assertNotClosed(ticket);

    const message = await this.create({
      ...data,
      ticket: ticket._id,
      author: userId as never,
      fromStaff: isStaff,
      internal,
    });
    if (!internal) await ticketService.recordPublicMessage(ticket, isStaff);
    // An internal note never goes out. A populated ticket holds its requester as a plain object.
    if (isStaff && !internal) {
      const requester = ticket.requester as unknown as Types.ObjectId | { id: string };
      await emailNotifications.ticketReply({
        userId: requester instanceof Types.ObjectId ? requester.toString() : requester.id,
        number: ticket.number,
        subject: ticket.subject,
        body: data.body,
      });
    }
    return message.populate(AUTHOR_POPULATE);
  }

  async edit(
    ticket: Ticket,
    messageId: string,
    data: MessageContent,
    viewer: MessageViewer,
  ): Promise<TicketMessage> {
    const message = await this.getVisible(ticket, messageId, viewer);
    this.assertAuthorCanChange(ticket, message, viewer.userId);
    message.set({ ...data, editedAt: new Date() });
    await message.save();
    return message.populate(AUTHOR_POPULATE);
  }

  /** `canDeleteAny` lets staff remove something that shouldn't be there, such as card details. */
  async remove(
    ticket: Ticket,
    messageId: string,
    viewer: MessageViewer,
    canDeleteAny = false,
  ): Promise<void> {
    const message = await this.getVisible(ticket, messageId, viewer);
    if (!canDeleteAny) this.assertAuthorCanChange(ticket, message, viewer.userId);
    await message.deleteOne();
  }
}

export const ticketMessageService = new TicketMessageService();
