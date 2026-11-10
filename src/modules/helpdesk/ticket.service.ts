import type { HydratedDocument, QueryFilter } from 'mongoose';
import { Permission } from '@/constants/permissions';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import type { ListQuery } from '@/core/validation/common.schemas';
import { hasPermission } from '@/middlewares/auth';
import { emailNotifications } from '@/modules/email/email.notifications';
import { permissionsForRole } from '@/modules/role/role.model';
import { UserModel } from '@/modules/user/user.model';
import {
  ACTIVE_TICKET_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketCounterModel,
  TicketModel,
  type ITicket,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from './ticket.model';
import { TicketMessageModel } from './ticketMessage.model';

export type Ticket = HydratedDocument<ITicket>;

interface TicketContent {
  subject?: string;
  description?: string;
  category?: TicketCategory;
  attachments?: string[];
}

interface NewTicket extends TicketContent {
  subject: string;
  description: string;
}

interface StaffNewTicket extends NewTicket {
  requester: string;
  priority?: TicketPriority;
  assignee?: string | null;
}

interface TicketChanges extends TicketContent {
  priority?: TicketPriority;
  assignee?: string | null;
  status?: TicketStatus;
}

const COUNTER_ID = 'ticket';
const NUMBER_DIGITS = 6;

interface PopulatedUser {
  _id: unknown;
  name: string;
  avatar: string | null;
  email?: string;
}

// Lean, so that no other user fields or virtuals come along with it.
const populateUser = (path: string, select: string) => ({
  path,
  select,
  options: { lean: true },
  transform: (user: PopulatedUser | null) =>
    user && {
      id: String(user._id),
      name: user.name,
      avatar: user.avatar,
      ...(user.email ? { email: user.email } : {}),
    },
});

// Only the requester's email: support needs it, and it's the requester's own on the customer side.
const TICKET_POPULATE = [
  populateUser('requester', 'name email avatar'),
  populateUser('assignee', 'name avatar'),
  populateUser('createdBy', 'name avatar'),
];

const closedError = () =>
  AppError.conflict('This ticket is closed. Reopen it first', 'TICKET_CLOSED');

/** The one place status changes, so the timestamps can't drift from it. */
const applyStatus = (ticket: Ticket, status: TicketStatus): void => {
  const now = new Date();
  if (status === 'resolved' && ticket.status !== 'resolved') ticket.resolvedAt = now;
  if (status !== 'resolved' && status !== 'closed') ticket.resolvedAt = null;
  ticket.closedAt = status === 'closed' ? now : null;
  ticket.status = status;
};

const reopenedStatus = (ticket: Ticket): TicketStatus => (ticket.assignee ? 'in_progress' : 'open');

class TicketService extends BaseService<ITicket> {
  constructor() {
    super(TicketModel, { resourceName: 'Ticket', searchFields: ['number', 'subject'] });
  }

  private async nextNumber(): Promise<string> {
    const counter = await TicketCounterModel.findOneAndUpdate(
      { _id: COUNTER_ID },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).exec();
    return `TKT-${String(counter.seq).padStart(NUMBER_DIGITS, '0')}`;
  }

  /** Leaves out the descriptions, which a listing doesn't need. */
  private async list(query: ListQuery, scope: QueryFilter<ITicket>) {
    const result = await this.paginate(query, scope, '-description');
    await TicketModel.populate(result.items, TICKET_POPULATE);
    return result;
  }

  private async open(data: NewTicket & Partial<StaffNewTicket>, requester: string, actor: string) {
    const ticket = await this.create({
      ...data,
      number: await this.nextNumber(),
      requester: requester as never,
      createdBy: actor as never,
      assignee: (data.assignee ?? null) as never,
      status: data.assignee ? 'in_progress' : 'open',
    });
    await emailNotifications.ticketCreated({
      userId: requester,
      number: ticket.number,
      subject: ticket.subject,
    });
    return ticket.populate(TICKET_POPULATE);
  }

  // Customers: someone else's ticket looks the same as a missing one.

  listForRequester(query: ListQuery, requester: string) {
    return this.list(query, { requester });
  }

  async getOwn(id: string, requester: string): Promise<Ticket> {
    const ticket = await this.findOne({ _id: id, requester });
    if (!ticket) throw this.notFound();
    return ticket;
  }

  async getOwnWithPeople(id: string, requester: string): Promise<Ticket> {
    return (await this.getOwn(id, requester)).populate(TICKET_POPULATE);
  }

  createOwn(data: NewTicket, requester: string): Promise<Ticket> {
    return this.open(data, requester, requester);
  }

  /** Only until staff have seen it, so nobody's reply ends up answering a different question. */
  async updateOwn(id: string, requester: string, data: TicketContent): Promise<Ticket> {
    const ticket = await this.getOwn(id, requester);
    if (ticket.status !== 'open' || ticket.firstResponseAt) {
      throw AppError.conflict(
        'This ticket can no longer be edited. Add a message instead',
        'TICKET_LOCKED',
      );
    }
    ticket.set(data);
    await ticket.save();
    return ticket.populate(TICKET_POPULATE);
  }

  async closeOwn(id: string, requester: string): Promise<Ticket> {
    const ticket = await this.getOwn(id, requester);
    if (ticket.status === 'closed') {
      throw AppError.conflict('This ticket is already closed', 'TICKET_ALREADY_CLOSED');
    }
    applyStatus(ticket, 'closed');
    await ticket.save();
    return ticket.populate(TICKET_POPULATE);
  }

  async reopenOwn(id: string, requester: string): Promise<Ticket> {
    const ticket = await this.getOwn(id, requester);
    if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
      throw AppError.conflict(
        'Only a resolved or closed ticket can be reopened',
        'TICKET_NOT_DONE',
      );
    }
    applyStatus(ticket, reopenedStatus(ticket));
    await ticket.save();
    return ticket.populate(TICKET_POPULATE);
  }

  // Staff.

  listAll({ unassigned, ...query }: ListQuery) {
    const scope = unassigned === undefined ? {} : { assignee: unassigned ? null : { $ne: null } };
    return this.list(query, scope);
  }

  async getWithPeople(id: string): Promise<Ticket> {
    return (await this.findById(id)).populate(TICKET_POPULATE);
  }

  async createForCustomer({ requester, ...data }: StaffNewTicket, actor: string): Promise<Ticket> {
    if (!(await UserModel.exists({ _id: requester }))) {
      throw AppError.badRequest('That customer does not exist', 'INVALID_REQUESTER');
    }
    if (data.assignee) await this.assertAssignable(data.assignee);
    return this.open(data, requester, actor);
  }

  async updateTicket(id: string, { status, ...data }: TicketChanges): Promise<Ticket> {
    const ticket = await this.findById(id);
    if (ticket.status === 'closed' && (!status || status === 'closed')) throw closedError();
    if (data.assignee) await this.assertAssignable(data.assignee);

    const nowResolved = status === 'resolved' && ticket.status !== 'resolved';
    ticket.set(data);
    if (status && status !== ticket.status) applyStatus(ticket, status);
    else if (!status && data.assignee && ticket.status === 'open') {
      applyStatus(ticket, 'in_progress');
    }
    await ticket.save();
    if (nowResolved) {
      await emailNotifications.ticketResolved({
        userId: String(ticket.requester),
        number: ticket.number,
        subject: ticket.subject,
      });
    }
    return ticket.populate(TICKET_POPULATE);
  }

  /** Removes the conversation too. Files stay, because others may be using the same upload. */
  override async deleteById(id: string): Promise<void> {
    await super.deleteById(id);
    await TicketMessageModel.deleteMany({ ticket: id }).exec();
  }

  private async assertAssignable(assignee: string): Promise<void> {
    const user = await UserModel.findById(assignee).select('role isActive').lean().exec();
    const permissions = user ? await permissionsForRole(user.role) : [];
    const canWork =
      user?.isActive &&
      hasPermission({ id: assignee, role: user.role, permissions }, Permission.HELPDESK_WRITE);
    if (!canWork) {
      throw AppError.badRequest(
        'A ticket can only be assigned to active staff who can work on tickets',
        'INVALID_ASSIGNEE',
      );
    }
  }

  async stats() {
    const [byStatus, activeByPriority, unassigned] = await Promise.all([
      TicketModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
      TicketModel.aggregate<{ _id: string; count: number }>([
        { $match: { status: { $in: ACTIVE_TICKET_STATUSES } } },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]).exec(),
      TicketModel.countDocuments({
        status: { $in: ACTIVE_TICKET_STATUSES },
        assignee: null,
      }).exec(),
    ]);

    // Every key is present, so a frontend can show a zero.
    const tally = (keys: readonly string[], rows: { _id: string; count: number }[]) =>
      Object.fromEntries(keys.map((key) => [key, rows.find((row) => row._id === key)?.count ?? 0]));

    return {
      byStatus: tally(TICKET_STATUSES, byStatus),
      activeByPriority: tally(TICKET_PRIORITIES, activeByPriority),
      unassignedActive: unassigned,
    };
  }

  /** Moves a ticket along when someone posts a public message. Internal notes never touch it. */
  async recordPublicMessage(ticket: Ticket, fromStaff: boolean): Promise<void> {
    const now = new Date();
    ticket.lastMessageAt = now;
    if (fromStaff) {
      ticket.firstResponseAt ??= now;
      if (ticket.status === 'open' || ticket.status === 'in_progress') {
        applyStatus(ticket, 'waiting_customer');
      }
    } else if (ticket.status === 'waiting_customer' || ticket.status === 'resolved') {
      applyStatus(ticket, reopenedStatus(ticket));
    }
    await ticket.save();
  }

  assertNotClosed(ticket: Ticket): void {
    if (ticket.status === 'closed') throw closedError();
  }
}

export const ticketService = new TicketService();
