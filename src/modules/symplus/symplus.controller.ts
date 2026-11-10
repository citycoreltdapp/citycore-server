import type { Response } from 'express';
import { accepted, created, noContent, ok, paginated } from '@/core/http/response';
import { controller } from '@/core/http/controller';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { AppError } from '@/core/errors/AppError';
import {
  CUSTOMER_UPDATE_ENDPOINTS,
  symplusApi,
  type CustomerKind,
  type CustomerUpdateSection,
} from '@/integrations/symplus/symplus.api';
import { symplusNotFound } from '@/integrations/symplus/symplus.errors';
import { currentUser } from '@/middlewares/auth';
import { requireFile } from '@/middlewares/upload';
import {
  accountPlanParamsSchema,
  adminDocumentBodySchema,
  CREATE_CUSTOMER_SCHEMAS,
  CUSTOMER_UPDATE_SCHEMAS,
  customerParamsSchema,
  documentTypeParamsSchema,
  documentTypeSchema,
  jobParamsSchema,
  kindParamsSchema,
  kindReferenceParamsSchema,
  linkCustomerBodySchema,
  listCustomersQuerySchema,
  listJobsQuerySchema,
  referenceParamsSchema,
  searchCustomersBodySchema,
  serialRangeQuerySchema,
  upgradeMinorBodySchema,
} from './symplus.schemas';
import { symplusService } from './symplus.service';
import { syncQueue } from './syncQueue.service';

const QUEUED_MESSAGE =
  'Core banking is unavailable, so this will be sent automatically once it returns';

const sendUpdateResult = (res: Response, { queued }: { queued: boolean }) => {
  if (queued) accepted(res, undefined, QUEUED_MESSAGE);
  else ok(res, undefined, 'Updated');
};

const buildSectionControllers = <T>(
  build: (section: CustomerUpdateSection) => T,
): Record<CustomerUpdateSection, T> =>
  Object.fromEntries(
    (Object.keys(CUSTOMER_UPDATE_ENDPOINTS) as CustomerUpdateSection[]).map((section) => [
      section,
      build(section),
    ]),
  ) as Record<CustomerUpdateSection, T>;

export const symplusSelfController = {
  getProfile: controller({}, async (req, res) => {
    ok(res, await symplusService.requireLinkForUser(currentUser(req).id));
  }),

  getDetails: controller({}, async (req, res) => {
    const customerId = await symplusService.requireCustomerId(currentUser(req).id);
    const details = await symplusApi.getCustomerDetails(customerId);
    if (!details) throw symplusNotFound();
    ok(res, details);
  }),

  getBalances: controller({}, async (req, res) => {
    const { netWorth, positions, balancesSyncedAt } = await symplusService.requireLinkForUser(
      currentUser(req).id,
    );
    ok(res, { netWorth, positions, balancesSyncedAt });
  }),

  syncBalances: controller({}, async (req, res) => {
    const link = await symplusService.requireLinkForUser(currentUser(req).id);
    if (!link.customerId) {
      throw AppError.conflict('Your profile is still awaiting approval', 'CUSTOMER_NOT_ACTIVE');
    }
    const { netWorth, positions, balancesSyncedAt } = await symplusService.syncBalances(link.id);
    ok(res, { netWorth, positions, balancesSyncedAt });
  }),

  updateSection: buildSectionControllers((section) =>
    controller({ body: CUSTOMER_UPDATE_SCHEMAS[section] }, async (req, res) => {
      const customerId = await symplusService.requireCustomerId(currentUser(req).id);
      sendUpdateResult(res, await symplusService.updateCustomer(customerId, section, req.body));
    }),
  ),

  removeEmployment: controller({}, async (req, res) => {
    await symplusApi.removeEmployment(await symplusService.requireCustomerId(currentUser(req).id));
    noContent(res);
  }),

  getDocumentStatus: controller({}, async (req, res) => {
    const customerId = await symplusService.requireCustomerId(currentUser(req).id);
    ok(res, await symplusApi.getDocumentStatus(customerId));
  }),

  getDocument: controller({ params: documentTypeParamsSchema }, async (req, res) => {
    const customerId = await symplusService.requireCustomerId(currentUser(req).id);
    const document = await symplusApi.getDocument(req.params.type, customerId);
    if (!document) throw symplusNotFound('Document not found');
    ok(res, document);
  }),

  getReferenceList: controller({ params: referenceParamsSchema }, async (req, res) => {
    ok(res, await symplusService.getReferenceList(req.params.list));
  }),
};

export const symplusAdminController = {
  getStatus: controller({}, async (_req, res) => {
    ok(res, await symplusService.getStatus());
  }),

  linkCustomer: controller({ body: linkCustomerBodySchema }, async (req, res) => {
    const { userId, customerId, customerType } = req.body;
    req.log.info({ adminId: currentUser(req).id, userId }, 'Linked Symplus customer');
    created(res, await symplusService.linkExistingCustomer(userId, customerId, customerType));
  }),

  searchCustomers: controller({ body: searchCustomersBodySchema }, async (req, res) => {
    // Records who looked, and by what, without logging the value being searched for.
    req.log.info({ adminId: currentUser(req).id, by: req.body.by }, 'Symplus customer search');
    ok(res, await symplusApi.findCustomers(req.body.by, req.body.value));
  }),

  listCustomers: controller({ query: listCustomersQuerySchema }, async (req, res) => {
    ok(res, await symplusApi.listCustomersByRows(req.query.offset, req.query.rows));
  }),

  listCustomersBySerial: controller({ query: serialRangeQuerySchema }, async (req, res) => {
    ok(res, await symplusApi.listCustomersBySerial(req.query.start, req.query.end));
  }),

  listCustomersByAccountPlan: controller({ params: accountPlanParamsSchema }, async (req, res) => {
    ok(res, await symplusApi.listCustomersByAccountPlan(req.params.product));
  }),

  listMinors: controller({}, async (_req, res) => {
    ok(res, await symplusApi.listMinors());
  }),

  listMinorsByParent: controller({ params: customerParamsSchema }, async (req, res) => {
    ok(res, await symplusApi.listMinorsByParent(req.params.customerId));
  }),

  upgradeMinor: controller({ body: upgradeMinorBodySchema }, async (req, res) => {
    created(res, await symplusApi.upgradeMinor(req.body));
  }),

  createCustomer: controller({ params: kindParamsSchema }, async (req, res) => {
    const { kind } = req.params;
    const result = CREATE_CUSTOMER_SCHEMAS[kind].safeParse(req.body);
    if (!result.success) {
      throw AppError.validation(
        result.error.issues.map((issue) => ({
          path: ['body', ...issue.path].join('.'),
          message: issue.message,
        })),
      );
    }
    created(res, await symplusApi.createCustomer(kind, result.data));
  }),

  getRegistrationStatus: controller({ params: kindReferenceParamsSchema }, async (req, res) => {
    const { kind, reference } = req.params;
    ok(res, { reference, status: await symplusApi.getRegistrationStatus(kind, reference) });
  }),

  uploadDocument: controller(
    { params: kindParamsSchema, body: adminDocumentBodySchema },
    async (req, res) => {
      const kind: CustomerKind = req.params.kind;
      const { document_type: type, customer_id, customer_source_reference } = req.body;

      if (!documentTypeSchema(kind).safeParse(type).success) {
        throw AppError.badRequest(`Invalid document type for a ${kind} customer`);
      }

      const owner = customer_id ? { customer_id } : { customer_source_reference };
      created(res, await symplusService.uploadDocument(kind, owner, type, requireFile(req)));
    },
  ),

  getCustomer: controller({ params: customerParamsSchema }, async (req, res) => {
    const details = await symplusApi.getCustomerDetails(req.params.customerId);
    if (!details) throw symplusNotFound();
    ok(res, details);
  }),

  getBalances: controller({ params: customerParamsSchema }, async (req, res) => {
    const { customerId } = req.params;
    const [netWorth, positions] = await Promise.all([
      symplusApi.getNetWorth(customerId),
      symplusApi.getPositions(customerId),
    ]);
    ok(res, { netWorth, positions });
  }),

  getDocumentStatus: controller({ params: customerParamsSchema }, async (req, res) => {
    ok(res, await symplusApi.getDocumentStatus(req.params.customerId));
  }),

  getDocument: controller(
    { params: customerParamsSchema.extend(documentTypeParamsSchema.shape) },
    async (req, res) => {
      const document = await symplusApi.getDocument(req.params.type, req.params.customerId);
      if (!document) throw symplusNotFound('Document not found');
      ok(res, document);
    },
  ),

  updateSection: buildSectionControllers((section) =>
    controller(
      { params: customerParamsSchema, body: CUSTOMER_UPDATE_SCHEMAS[section] },
      async (req, res) => {
        sendUpdateResult(
          res,
          await symplusService.updateCustomer(req.params.customerId, section, req.body),
        );
      },
    ),
  ),

  removeEmployment: controller({ params: customerParamsSchema }, async (req, res) => {
    await symplusApi.removeEmployment(req.params.customerId);
    noContent(res);
  }),

  listJobs: controller({ query: listJobsQuerySchema }, async (req, res) => {
    const { items, meta } = await syncQueue.paginate(req.query);
    paginated(res, items, meta);
  }),

  retryJob: controller({ params: jobParamsSchema }, async (req, res) => {
    ok(res, await syncQueue.retryDead(req.params.id));
  }),

  getLink: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await symplusService.requireLinkForUser(req.params.id));
  }),
};
