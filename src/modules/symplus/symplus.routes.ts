import { Router } from 'express';
import { Permission } from '@/constants/permissions';
import type { CustomerUpdateSection } from '@/integrations/symplus/symplus.api';
import { authenticate, requirePermission } from '@/middlewares/auth';
import {
  symplusAdminController as admin,
  symplusSelfController as self,
} from './symplus.controller';
import { documentUpload, symplusLimiter } from './symplus.middleware';

const SECTION_PATHS: Record<CustomerUpdateSection, string> = {
  details: 'details',
  nextOfKin: 'next-of-kin',
  nin: 'nin',
  tin: 'tin',
  bank: 'bank',
  address: 'address',
  email: 'email',
  employment: 'employment',
  identification: 'identification',
};

const sections = Object.entries(SECTION_PATHS) as [CustomerUpdateSection, string][];

const canReadOps = requirePermission(Permission.CORE_BANKING_READ);
const canRead = requirePermission(Permission.CUSTOMERS_READ);
const canReadBalances = requirePermission(Permission.CUSTOMERS_BALANCES_READ);
const canReadDocuments = requirePermission(Permission.CUSTOMERS_DOCUMENTS_READ);
const canWrite = requirePermission(Permission.CUSTOMERS_WRITE);

const adminRouter = Router();

adminRouter.get('/status', canReadOps, admin.getStatus);

adminRouter.get('/jobs', canReadOps, admin.listJobs);
adminRouter.post(
  '/jobs/:id/retry',
  requirePermission(Permission.CORE_BANKING_RETRY),
  admin.retryJob,
);

adminRouter.post('/links', requirePermission(Permission.CUSTOMERS_LINK), admin.linkCustomer);
adminRouter.get('/links/:id', canRead, admin.getLink);

adminRouter.get('/customers', canRead, admin.listCustomers);
adminRouter.post('/customers/search', canRead, admin.searchCustomers);
adminRouter.get('/customers/by-serial', canRead, admin.listCustomersBySerial);
adminRouter.get('/customers/by-plan/:product', canRead, admin.listCustomersByAccountPlan);
adminRouter.get('/minors', canRead, admin.listMinors);
adminRouter.post('/minors/upgrade', canWrite, admin.upgradeMinor);
adminRouter.post('/registrations/:kind', canWrite, admin.createCustomer);
adminRouter.get('/registrations/:kind/:reference', canRead, admin.getRegistrationStatus);
adminRouter.post('/registrations/:kind/documents', canWrite, documentUpload, admin.uploadDocument);

adminRouter.get('/customers/:customerId', canRead, admin.getCustomer);
adminRouter.get('/customers/:customerId/balances', canReadBalances, admin.getBalances);
adminRouter.get('/customers/:customerId/minors', canRead, admin.listMinorsByParent);
adminRouter.get('/customers/:customerId/documents', canReadDocuments, admin.getDocumentStatus);
adminRouter.get('/customers/:customerId/documents/:type', canReadDocuments, admin.getDocument);
adminRouter.delete('/customers/:customerId/employment', canWrite, admin.removeEmployment);
for (const [section, path] of sections) {
  adminRouter.patch(`/customers/:customerId/${path}`, canWrite, admin.updateSection[section]);
}

const router = Router();

router.use(authenticate);

router.use('/admin', adminRouter);

router.get('/reference/:list', self.getReferenceList);

router.get('/me', self.getProfile);
router.get('/me/details', self.getDetails);
router.get('/me/balances', self.getBalances);
router.post('/me/balances/sync', symplusLimiter, self.syncBalances);
router.get('/me/documents', self.getDocumentStatus);
router.get('/me/documents/:type', self.getDocument);
router.delete('/me/employment', self.removeEmployment);
for (const [section, path] of sections) {
  router.patch(`/me/${path}`, symplusLimiter, self.updateSection[section]);
}

export const symplusRoutes = router;
