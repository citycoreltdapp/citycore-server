import { logger } from '@/config/logger';
import { Permission } from '@/constants/permissions';
import { controller } from '@/core/http/controller';
import { created, noContent, ok, paginated } from '@/core/http/response';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { currentUser, hasPermission } from '@/middlewares/auth';
import {
  adminCreateMessageBodySchema,
  adminCreateTicketBodySchema,
  adminListTicketsQuerySchema,
  adminUpdateTicketBodySchema,
  createMessageBodySchema,
  createTicketBodySchema,
  listMessagesQuerySchema,
  listTicketsQuerySchema,
  messageParamsSchema,
  updateMessageBodySchema,
  updateTicketBodySchema,
} from './helpdesk.schemas';
import { ticketService } from './ticket.service';
import { ticketMessageService as messages, type MessageViewer } from './ticketMessage.service';

const asCustomer = (req: { user?: Express.AuthUser }): MessageViewer => ({
  userId: currentUser(req).id,
  isStaff: false,
});

const asStaff = (req: { user?: Express.AuthUser }): MessageViewer => ({
  userId: currentUser(req).id,
  isStaff: true,
});

/** A customer's own tickets, whatever their role: staff use the admin routes to work on others. */
export const helpdeskController = {
  list: controller({ query: listTicketsQuerySchema }, async (req, res) => {
    const { items, meta } = await ticketService.listForRequester(req.query, currentUser(req).id);
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await ticketService.getOwnWithPeople(req.params.id, currentUser(req).id));
  }),

  create: controller({ body: createTicketBodySchema }, async (req, res) => {
    created(res, await ticketService.createOwn(req.body, currentUser(req).id));
  }),

  update: controller({ params: idParamsSchema, body: updateTicketBodySchema }, async (req, res) => {
    ok(res, await ticketService.updateOwn(req.params.id, currentUser(req).id, req.body));
  }),

  close: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await ticketService.closeOwn(req.params.id, currentUser(req).id));
  }),

  reopen: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await ticketService.reopenOwn(req.params.id, currentUser(req).id));
  }),

  listMessages: controller(
    { params: idParamsSchema, query: listMessagesQuerySchema },
    async (req, res) => {
      const viewer = asCustomer(req);
      const ticket = await ticketService.getOwn(req.params.id, viewer.userId);
      const { items, meta } = await messages.list(ticket, req.query, viewer);
      paginated(res, items, meta);
    },
  ),

  getMessage: controller({ params: messageParamsSchema }, async (req, res) => {
    const viewer = asCustomer(req);
    const ticket = await ticketService.getOwn(req.params.id, viewer.userId);
    ok(res, await messages.get(ticket, req.params.messageId, viewer));
  }),

  addMessage: controller(
    { params: idParamsSchema, body: createMessageBodySchema },
    async (req, res) => {
      const viewer = asCustomer(req);
      const ticket = await ticketService.getOwn(req.params.id, viewer.userId);
      created(res, await messages.add(ticket, req.body, viewer));
    },
  ),

  updateMessage: controller(
    { params: messageParamsSchema, body: updateMessageBodySchema },
    async (req, res) => {
      const viewer = asCustomer(req);
      const ticket = await ticketService.getOwn(req.params.id, viewer.userId);
      ok(res, await messages.edit(ticket, req.params.messageId, req.body, viewer));
    },
  ),

  removeMessage: controller({ params: messageParamsSchema }, async (req, res) => {
    const viewer = asCustomer(req);
    const ticket = await ticketService.getOwn(req.params.id, viewer.userId);
    await messages.remove(ticket, req.params.messageId, viewer);
    noContent(res);
  }),
};

export const helpdeskAdminController = {
  stats: controller({}, async (_req, res) => {
    ok(res, await ticketService.stats());
  }),

  list: controller({ query: adminListTicketsQuerySchema }, async (req, res) => {
    const { items, meta } = await ticketService.listAll(req.query);
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await ticketService.getWithPeople(req.params.id));
  }),

  create: controller({ body: adminCreateTicketBodySchema }, async (req, res) => {
    created(res, await ticketService.createForCustomer(req.body, currentUser(req).id));
  }),

  update: controller(
    { params: idParamsSchema, body: adminUpdateTicketBodySchema },
    async (req, res) => {
      const ticket = await ticketService.updateTicket(req.params.id, req.body);
      logger.info(
        {
          actorId: currentUser(req).id,
          ticketId: ticket.id,
          changed: Object.keys(req.body),
          status: ticket.status,
        },
        'Ticket updated',
      );
      ok(res, ticket);
    },
  ),

  remove: controller({ params: idParamsSchema }, async (req, res) => {
    await ticketService.deleteById(req.params.id);
    logger.info({ actorId: currentUser(req).id, ticketId: req.params.id }, 'Ticket deleted');
    noContent(res);
  }),

  listMessages: controller(
    { params: idParamsSchema, query: listMessagesQuerySchema },
    async (req, res) => {
      const ticket = await ticketService.findById(req.params.id);
      const { items, meta } = await messages.list(ticket, req.query, asStaff(req));
      paginated(res, items, meta);
    },
  ),

  getMessage: controller({ params: messageParamsSchema }, async (req, res) => {
    const ticket = await ticketService.findById(req.params.id);
    ok(res, await messages.get(ticket, req.params.messageId, asStaff(req)));
  }),

  addMessage: controller(
    { params: idParamsSchema, body: adminCreateMessageBodySchema },
    async (req, res) => {
      const ticket = await ticketService.findById(req.params.id);
      created(res, await messages.add(ticket, req.body, asStaff(req)));
    },
  ),

  updateMessage: controller(
    { params: messageParamsSchema, body: updateMessageBodySchema },
    async (req, res) => {
      const ticket = await ticketService.findById(req.params.id);
      ok(res, await messages.edit(ticket, req.params.messageId, req.body, asStaff(req)));
    },
  ),

  removeMessage: controller({ params: messageParamsSchema }, async (req, res) => {
    const user = currentUser(req);
    const ticket = await ticketService.findById(req.params.id);
    const canDeleteAny = hasPermission(user, Permission.HELPDESK_DELETE);
    await messages.remove(ticket, req.params.messageId, asStaff(req), canDeleteAny);
    logger.info(
      { actorId: user.id, ticketId: ticket.id, messageId: req.params.messageId },
      'Ticket message deleted',
    );
    noContent(res);
  }),
};
