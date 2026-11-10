import express, { Router, type Request } from 'express';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { AppError } from '@/core/errors/AppError';
import { paystackDisabled } from '@/integrations/paystack/paystack.client';
import {
  verifyLegacySignature,
  verifySignedHeader,
} from '@/integrations/paystack/paystack.signature';
import { parseJsonBody } from '@/utils/http';
import { walletService, type VirtualAccountEvent } from './wallet.service';

const MAX_EVENT_SIZE = '1mb';

interface PaystackEvent {
  event?: string;
  data?: { reference?: string } & VirtualAccountEvent;
}

const hasValidSignature = (req: Request): boolean => {
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body)) return false;

  const signed = req.get('paystack-signature');
  if (signed && env.PAYSTACK_WEBHOOK_SECRET) {
    return verifySignedHeader(body, signed, env.PAYSTACK_WEBHOOK_SECRET);
  }

  const legacy = req.get('x-paystack-signature');
  return Boolean(
    legacy &&
    env.PAYSTACK_SECRET_KEY &&
    verifyLegacySignature(body, legacy, env.PAYSTACK_SECRET_KEY),
  );
};

const handleEvent = async ({ event, data = {} }: PaystackEvent): Promise<void> => {
  switch (event) {
    case 'charge.success':
      if (data.reference) await walletService.settle(data.reference);
      break;
    case 'dedicatedaccount.assign.success':
      await walletService.handleVirtualAccountAssigned(data);
      break;
    case 'dedicatedaccount.assign.failed':
    case 'customeridentification.failed':
      await walletService.handleVirtualAccountFailed(data);
      break;
    default:
      logger.debug({ event }, 'Ignored a Paystack event');
  }
};

const router = Router();

/**
 * Handles the event before responding, rather than the usual respond-then-process. A transfer into
 * a virtual account has no other record, so if Paystack is told 200 and this process then dies, the
 * money is never credited. A failure here returns an error, and Paystack sends the event again.
 */
router.post('/', express.raw({ type: () => true, limit: MAX_EVENT_SIZE }), async (req, res) => {
  if (!env.PAYSTACK_ENABLED) throw paystackDisabled();
  if (!hasValidSignature(req))
    throw AppError.unauthorized('Invalid signature', 'INVALID_SIGNATURE');

  const event = parseJsonBody((req.body as Buffer).toString('utf8')) as
    PaystackEvent | null | undefined;
  if (!event) throw AppError.badRequest('Invalid event body');

  await handleEvent(event);
  res.sendStatus(200);
});

export const paystackWebhookRoutes = router;
