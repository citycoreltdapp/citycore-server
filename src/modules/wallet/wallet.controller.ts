import { env } from '@/config/env';
import { AppError } from '@/core/errors/AppError';
import { controller } from '@/core/http/controller';
import { accepted, created, ok, paginated } from '@/core/http/response';
import { currentUser } from '@/middlewares/auth';
import { platformConfigService } from '@/modules/platformConfig/platformConfig.service';
import { assertFundingAmountAllowed, quoteFunding } from './wallet.fees';
import {
  fundingQuoteQuerySchema,
  fundWalletBodySchema,
  listTransactionsQuerySchema,
  referenceParamsSchema,
  requestVirtualAccountBodySchema,
} from './wallet.schemas';
import { transactionService, walletService } from './wallet.service';
import { WalletTransactionModel } from './walletTransaction.model';

export const walletController = {
  getWallet: controller({}, async (req, res) => {
    ok(res, await walletService.getOrCreateForUser(currentUser(req).id));
  }),

  listTransactions: controller({ query: listTransactionsQuerySchema }, async (req, res) => {
    const { items, meta } = await transactionService.paginate(req.query, {
      user: currentUser(req).id,
    });
    paginated(res, items, meta);
  }),

  getTransaction: controller({ params: referenceParamsSchema }, async (req, res) => {
    ok(res, await findOwnTransaction(currentUser(req).id, req.params.reference));
  }),

  /** Lets a form show the fee and total before the customer commits. */
  getFundingQuote: controller({ query: fundingQuoteQuerySchema }, async (req, res) => {
    const settings = await platformConfigService.walletSettings();
    assertFundingAmountAllowed(req.query.amount, settings, 'query.amount');
    ok(res, quoteFunding(req.query.amount, settings));
  }),

  fund: controller({ body: fundWalletBodySchema }, async (req, res) => {
    const { amount, channels } = req.body;
    created(res, await walletService.startFunding(currentUser(req).id, amount, channels));
  }),

  /** For the page Paystack returns the customer to, so they see the result without waiting. */
  verifyFunding: controller({ params: referenceParamsSchema }, async (req, res) => {
    const { reference } = req.params;
    const own = await findOwnTransaction(currentUser(req).id, reference);
    ok(res, (await walletService.settle(own.reference)) ?? own);
  }),

  requestVirtualAccount: controller({ body: requestVirtualAccountBodySchema }, async (req, res) => {
    const wallet = await walletService.requestVirtualAccount(currentUser(req).id, req.body);
    accepted(res, wallet, 'Your virtual account is being created');
  }),

  requeryVirtualAccount: controller({}, async (req, res) => {
    await walletService.requeryVirtualAccount(currentUser(req).id);
    accepted(res, undefined, 'Checking for new transfers');
  }),
};

export const walletAdminController = {
  getStatus: controller({}, async (_req, res) => {
    const groups = await WalletTransactionModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();

    ok(res, {
      enabled: env.PAYSTACK_ENABLED,
      mode: env.PAYSTACK_SECRET_KEY?.includes('_test_') ? 'test' : 'live',
      signedWebhooks: Boolean(env.PAYSTACK_WEBHOOK_SECRET),
      transactions: Object.fromEntries(groups.map(({ _id, count }) => [_id, count])),
    });
  }),

  listTransactions: controller({ query: listTransactionsQuerySchema }, async (req, res) => {
    const { items, meta } = await transactionService.paginate(req.query);
    paginated(res, items, meta);
  }),

  recheckTransaction: controller({ params: referenceParamsSchema }, async (req, res) => {
    const transaction = await walletService.settle(req.params.reference);
    if (!transaction) throw AppError.notFound('Transaction not found');
    ok(res, transaction);
  }),
};

// Same 404 whether it doesn't exist or isn't theirs, so references can't be probed.
const findOwnTransaction = async (userId: string, reference: string) => {
  const transaction = await transactionService.findOne({ reference, user: userId });
  if (!transaction) throw AppError.notFound('Transaction not found');
  return transaction;
};
