import { emailNotifications } from '@/modules/email/email.notifications';
import { randomUUID } from 'node:crypto';
import mongoose, { type ClientSession, type QueryFilter, type Types } from 'mongoose';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import {
  DEDICATED_ACCOUNT_CHANNEL,
  paystackApi,
  type FundingChannel,
  type VerifiedTransaction,
} from '@/integrations/paystack/paystack.api';
import { paystackDisabled } from '@/integrations/paystack/paystack.client';
import { userService } from '@/modules/user/user.service';
import { platformConfigService } from '@/modules/platformConfig/platformConfig.service';
import { assertFundingAmountAllowed, calculateTransferFee, quoteFunding } from './wallet.fees';
import { WALLET_CURRENCY, WalletModel, type IWallet } from './wallet.model';
import {
  WalletTransactionModel,
  type IWalletTransaction,
  type TransactionDirection,
  type TransactionType,
} from './walletTransaction.model';

const DUPLICATE_KEY_ERROR = 11000;
const RECONCILE_MIN_AGE_MS = 10 * 60 * 1000;
const RECONCILE_BATCH_SIZE = 100;
const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

const OPEN_STATUSES = ['pending', 'abandoned'];

export interface VirtualAccountEvent {
  customer?: { email?: string; customer_code?: string };
  email?: string;
  customer_code?: string;
  dedicated_account?: {
    bank?: { name?: string; slug?: string };
    account_name?: string;
    account_number?: string;
  } | null;
  reason?: string;
}

class TransactionService extends BaseService<IWalletTransaction> {
  constructor() {
    super(WalletTransactionModel, { resourceName: 'Transaction' });
  }
}

export const transactionService = new TransactionService();

class WalletService extends BaseService<IWallet> {
  constructor() {
    super(WalletModel, { resourceName: 'Wallet' });
  }

  /** Every user has exactly one wallet, created the first time it's needed. */
  async getOrCreateForUser(userId: string) {
    const filter: QueryFilter<IWallet> = { user: userId };
    try {
      return await WalletModel.findOneAndUpdate(
        filter,
        { $setOnInsert: { user: userId } },
        { upsert: true, returnDocument: 'after' },
      ).orFail();
    } catch (err) {
      // Two first requests raced, so the other one created it.
      if ((err as { code?: number }).code !== DUPLICATE_KEY_ERROR) throw err;
      return WalletModel.findOne(filter).orFail();
    }
  }

  /** Starts a card or bank transfer payment, and returns the page to send the customer to. */
  async startFunding(userId: string, amount: number, channels: readonly FundingChannel[]) {
    const settings = await platformConfigService.walletSettings();
    assertFundingAmountAllowed(amount, settings, 'body.amount');
    if (!env.PAYSTACK_ENABLED) throw paystackDisabled();

    const user = await userService.findById(userId);
    const wallet = await this.getOrCreateForUser(userId);
    const { fee, total } = quoteFunding(amount, settings);
    // Created by us before Paystack hears of it, so no payment can arrive without a record.
    const transaction = await WalletTransactionModel.create({
      user: userId,
      wallet: wallet.id,
      reference: `CCF-${randomUUID()}`,
      type: 'funding',
      amount,
      chargedAmount: total,
      customerFee: fee,
    });

    try {
      const initialized = await paystackApi.initializeTransaction({
        email: user.email,
        amount: total,
        reference: transaction.reference,
        channels,
        metadata: { userId, walletId: wallet.id, transactionId: transaction.id },
      });

      transaction.authorizationUrl = initialized.authorization_url;
      await transaction.save();

      return {
        reference: transaction.reference,
        amount,
        fee,
        total,
        authorizationUrl: initialized.authorization_url,
        accessCode: initialized.access_code,
      };
    } catch (err) {
      transaction.status = 'failed';
      transaction.failureReason = err instanceof AppError ? err.message : 'Could not start payment';
      await transaction.save();
      throw err;
    }
  }

  /**
   * Asks Paystack what happened to a payment, and applies the answer. This is the one route to a
   * credit, whichever of the webhook, the callback or the reconciler got here first. It trusts
   * only Paystack's verification response, never what a client or webhook claims.
   */
  async settle(reference: string) {
    // Money moved inside the app was final when it moved, and Paystack has never heard of it.
    const existing = await WalletTransactionModel.findOne({ reference }).exec();
    if (existing?.provider === 'internal') return existing;

    const verified = await paystackApi.verifyTransaction(reference);
    if (!verified) return WalletTransactionModel.findOne({ reference }).exec();

    return verified.status === 'success'
      ? this.applySuccess(verified)
      : this.applyUnsuccessful(verified);
  }

  private async applySuccess(verified: VerifiedTransaction) {
    // Only the settlement that moves the money tells the customer, not the ones that find it done.
    let credited = false;
    // All of it happens or none does, so a crash can't leave the ledger and balance disagreeing.
    // Two concurrent settlements conflict on the wallet, and the retry sees it's already credited.
    const settled = await mongoose.connection.transaction(async (session) => {
      credited = false;
      const transaction =
        (await WalletTransactionModel.findOne({ reference: verified.reference }).session(
          session,
        )) ?? (await this.recordIncomingTransfer(verified, session));

      if (!transaction) {
        logger.warn({ reference: verified.reference }, 'Ignored an unknown Paystack transaction');
        return null;
      }
      if (transaction.status === 'success' || transaction.status === 'flagged') return transaction;

      const details = {
        channel: verified.channel,
        providerTransactionId: verified.id,
        fees: verified.fees,
        paidAt: verified.paid_at ? new Date(verified.paid_at) : new Date(),
        lastCheckedAt: new Date(),
      };

      const mismatch = this.findMismatch(transaction, verified);
      if (mismatch) {
        logger.error({ reference: verified.reference }, `Payment flagged: ${mismatch}`);
        transaction.set({ ...details, status: 'flagged', reviewNote: mismatch });
        await transaction.save({ session });
        return transaction;
      }

      const wallet = await this.credit(transaction.wallet?.toString(), transaction.amount, session);

      transaction.set({
        ...details,
        status: 'success',
        settledAt: new Date(),
        balanceAfter: wallet.balance,
        failureReason: null,
      });
      await transaction.save({ session });
      credited = true;
      return transaction;
    });

    if (credited && settled?.user) {
      await emailNotifications.walletFunded({
        userId: String(settled.user),
        amount: settled.amount,
        balanceAfter: settled.balanceAfter ?? null,
        currency: settled.currency,
        reference: settled.reference,
      });
    }
    return settled;
  }

  private findMismatch(transaction: IWalletTransaction, verified: VerifiedTransaction) {
    if (verified.currency !== transaction.currency) {
      return `Expected ${transaction.currency} but ${verified.currency} was paid`;
    }
    const expected = transaction.chargedAmount ?? transaction.amount;
    if (verified.amount !== expected) {
      return `Expected ${expected} kobo but ${verified.amount} was paid`;
    }
    return null;
  }

  private async credit(walletId: string | undefined, amount: number, session: ClientSession) {
    return WalletModel.findByIdAndUpdate(
      walletId,
      { $inc: { balance: amount } },
      { session, returnDocument: 'after' },
    ).orFail();
  }

  /**
   * Moves money inside the app, as part of the caller's transaction. A debit can't take a balance
   * below zero, and the unique reference means the same entry can't be applied twice.
   */
  async postInternalEntry(
    entry: {
      user: Types.ObjectId | string;
      wallet: Types.ObjectId | string;
      reference: string;
      type: TransactionType;
      direction: TransactionDirection;
      amount: number;
    },
    session: ClientSession,
  ) {
    const isDebit = entry.direction === 'debit';
    const wallet = await WalletModel.findOneAndUpdate(
      { _id: entry.wallet, ...(isDebit && { balance: { $gte: entry.amount } }) },
      { $inc: { balance: isDebit ? -entry.amount : entry.amount } },
      { session, returnDocument: 'after' },
    ).exec();
    if (!wallet) {
      if (isDebit) {
        throw AppError.conflict('Your wallet balance is too low', 'INSUFFICIENT_BALANCE');
      }
      throw AppError.internal();
    }

    const now = new Date();
    await WalletTransactionModel.create(
      [
        {
          ...entry,
          status: 'success',
          provider: 'internal',
          paidAt: now,
          settledAt: now,
          balanceAfter: wallet.balance,
        },
      ],
      { session },
    );
  }

  /**
   * Transfers into a virtual account arrive with a reference Paystack generated, so there's no
   * record of them yet. Money with no matching wallet is kept as flagged, so it can't be lost.
   */
  private async recordIncomingTransfer(verified: VerifiedTransaction, session: ClientSession) {
    const isTransfer =
      verified.channel === DEDICATED_ACCOUNT_CHANNEL ||
      verified.authorization?.channel === DEDICATED_ACCOUNT_CHANNEL;
    if (!isTransfer) return null;

    const customerCode = verified.customer?.customer_code;
    const accountNumber = verified.authorization?.receiver_bank_account_number;

    const owners = [
      ...(customerCode ? [{ paystackCustomerCode: customerCode }] : []),
      ...(accountNumber ? [{ 'virtualAccount.accountNumber': accountNumber }] : []),
    ];
    const wallet = owners.length
      ? await WalletModel.findOne({ $or: owners }).session(session)
      : null;

    if (!wallet)
      logger.error({ reference: verified.reference }, 'Unmatched virtual account transfer');

    // The sender chose the amount, so the fee can only come out of it. Paystack's own figure is the
    // accurate one, and the calculation is only for a response that doesn't include it.
    const fee =
      verified.fees ??
      calculateTransferFee(verified.amount, await platformConfigService.walletSettings());
    const reviewNote = !wallet
      ? 'No wallet matches this virtual account transfer'
      : fee >= verified.amount
        ? `The ${fee} kobo fee leaves nothing to credit from ${verified.amount} kobo`
        : null;

    const [transaction] = await WalletTransactionModel.create(
      [
        {
          user: wallet?.user ?? null,
          wallet: wallet?._id ?? null,
          reference: verified.reference,
          type: 'funding',
          // Flagged money is shown in full, as nothing has been taken from it yet.
          amount: reviewNote ? verified.amount : verified.amount - fee,
          chargedAmount: verified.amount,
          customerFee: reviewNote ? 0 : fee,
          currency: wallet ? WALLET_CURRENCY : verified.currency,
          status: reviewNote ? 'flagged' : 'pending',
          channel: verified.channel,
          providerTransactionId: verified.id,
          reviewNote,
        },
      ],
      { session },
    );
    return transaction ?? null;
  }

  private async applyUnsuccessful(verified: VerifiedTransaction) {
    const transaction = await WalletTransactionModel.findOne({
      reference: verified.reference,
    }).exec();
    if (!transaction) return null;

    transaction.lastCheckedAt = new Date();

    if (transaction.status === 'success') {
      // Taking money back out of a wallet is a business decision, so a person has to make it.
      if (verified.status === 'reversed') {
        logger.error({ reference: verified.reference }, 'A credited payment was reversed');
        transaction.reviewNote = 'Paystack reports this credited payment as reversed';
      }
    } else if (OPEN_STATUSES.includes(transaction.status)) {
      if (['failed', 'reversed'].includes(verified.status)) {
        transaction.status = 'failed';
        transaction.failureReason = verified.gateway_response ?? 'Payment failed';
      } else if (
        verified.status === 'abandoned' &&
        Date.now() - transaction.createdAt.getTime() > ABANDON_AFTER_MS
      ) {
        transaction.status = 'abandoned';
      }
    }

    await transaction.save();
    return transaction;
  }

  /** Re-checks payments that never got a final answer, in case their webhook was missed. */
  async reconcilePending(): Promise<number> {
    const transactions = await WalletTransactionModel.find({
      status: 'pending',
      createdAt: { $lte: new Date(Date.now() - RECONCILE_MIN_AGE_MS) },
    })
      .sort({ lastCheckedAt: 1, createdAt: 1 })
      .limit(RECONCILE_BATCH_SIZE)
      .select('reference')
      .lean()
      .exec();

    for (const { reference } of transactions) {
      try {
        await this.settle(reference);
      } catch (err) {
        logger.warn({ err, reference }, 'Could not reconcile a payment');
      }
    }
    return transactions.length;
  }

  /** Requests a dedicated account. Paystack replies later through a webhook event. */
  async requestVirtualAccount(
    userId: string,
    input: {
      firstName: string;
      lastName: string;
      phone: string;
      bvn?: string;
      accountNumber?: string;
      bankCode?: string;
    },
  ) {
    const user = await userService.findById(userId);
    const wallet = await this.getOrCreateForUser(userId);

    if (['pending', 'active'].includes(wallet.virtualAccountStatus)) {
      throw AppError.conflict(
        'You already have a virtual account or a request in progress',
        'VIRTUAL_ACCOUNT_EXISTS',
      );
    }

    // The BVN and bank details are passed straight through, and aren't stored here.
    await paystackApi.assignVirtualAccount({
      email: user.email,
      first_name: input.firstName,
      last_name: input.lastName,
      phone: input.phone,
      ...(input.bvn && {
        bvn: input.bvn,
        account_number: input.accountNumber,
        bank_code: input.bankCode,
      }),
    });

    wallet.virtualAccountStatus = 'pending';
    wallet.virtualAccountEmail = user.email;
    wallet.virtualAccountError = null;
    await wallet.save();
    return wallet;
  }

  private findWalletForEvent(data: VirtualAccountEvent) {
    const email = data.customer?.email ?? data.email;
    return email ? WalletModel.findOne({ virtualAccountEmail: email.toLowerCase() }).exec() : null;
  }

  async handleVirtualAccountAssigned(data: VirtualAccountEvent) {
    const wallet = await this.findWalletForEvent(data);
    const account = data.dedicated_account;

    if (!wallet || !account?.account_number) {
      logger.warn('Virtual account event did not match a wallet');
      return;
    }

    wallet.set({
      virtualAccountStatus: 'active',
      virtualAccountError: null,
      paystackCustomerCode: data.customer?.customer_code ?? data.customer_code ?? null,
      virtualAccount: {
        bankName: account.bank?.name ?? '',
        bankSlug: account.bank?.slug ?? '',
        accountName: account.account_name ?? '',
        accountNumber: account.account_number,
      },
    });
    await wallet.save();
  }

  async handleVirtualAccountFailed(data: VirtualAccountEvent) {
    const wallet = await this.findWalletForEvent(data);
    if (!wallet || wallet.virtualAccountStatus === 'active') return;

    wallet.virtualAccountStatus = 'failed';
    wallet.virtualAccountError = data.reason ?? 'The virtual account could not be created';
    await wallet.save();
  }

  /** For a customer whose transfer hasn't shown up. Paystack re-sends any webhook it finds. */
  async requeryVirtualAccount(userId: string) {
    const wallet = await this.getOrCreateForUser(userId);
    if (!wallet.virtualAccount) {
      throw AppError.conflict('You do not have a virtual account', 'NO_VIRTUAL_ACCOUNT');
    }
    const today = new Date().toISOString().slice(0, 10);
    await paystackApi.requeryVirtualAccount(
      wallet.virtualAccount.accountNumber,
      wallet.virtualAccount.bankSlug,
      today,
    );
  }
}

export const walletService = new WalletService();
