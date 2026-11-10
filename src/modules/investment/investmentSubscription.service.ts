import { emailNotifications } from '@/modules/email/email.notifications';
import mongoose, { type ClientSession, type HydratedDocument } from 'mongoose';
import { logger } from '@/config/logger';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import type { ListQuery } from '@/core/validation/common.schemas';
import { referralService } from '@/modules/referral/referral.service';
import { UserModel } from '@/modules/user/user.model';
import { walletService } from '@/modules/wallet/wallet.service';
import { InvestmentPlanModel } from './investment.model';
import { buildSchedule } from './investment.schedule';
import { availableFilter, insufficientUnits, resolvePurchase } from './investment.service';
import {
  InvestmentSubscriptionModel,
  type IInvestmentSubscription,
} from './investmentSubscription.model';

type Subscription = HydratedDocument<IInvestmentSubscription>;

interface InvestInput {
  planId: string;
  units?: number | undefined;
  amount?: number | undefined;
  idempotencyKey: string;
}

const DUPLICATE_KEY_ERROR = 11000;
const BASIS_POINTS = 10_000n;

const USER_POPULATE = { path: 'user', select: 'name email' };

const reference = (kind: string, id: unknown, suffix = ''): string =>
  `CCI-${kind}-${String(id)}${suffix}`;

class SubscriptionService extends BaseService<IInvestmentSubscription> {
  constructor() {
    super(InvestmentSubscriptionModel, { resourceName: 'Investment' });
  }

  /** Takes the amount from the wallet and starts the investment. All of it happens or none does. */
  async invest(
    userId: string,
    input: InvestInput,
  ): Promise<{ subscription: Subscription; replayed: boolean }> {
    const replay = await this.findReplay(userId, input);
    if (replay) return { subscription: replay, replayed: true };

    const wallet = await walletService.getOrCreateForUser(userId);
    try {
      const subscription = await mongoose.connection.transaction(async (session) => {
        const plan = await InvestmentPlanModel.findOne({
          ...availableFilter(),
          _id: input.planId,
        }).session(session);
        if (!plan) throw AppError.notFound('Investment plan not found');
        const { amount, units } = resolvePurchase(plan, input, 'body');
        if (units !== null) {
          // The filter is what stops a plan overselling, however many people buy at once.
          const reserved = await InvestmentPlanModel.updateOne(
            { _id: plan.id, unitsSold: { $lte: (plan.totalUnits as number) - units } },
            { $inc: { unitsSold: units } },
            { session },
          ).exec();
          if (reserved.matchedCount === 0) throw insufficientUnits();
        }

        const startedAt = new Date();
        const { expectedReturn, maturesAt, payouts } = buildSchedule(amount, plan, startedAt);
        const created = new InvestmentSubscriptionModel({
          user: userId,
          wallet: wallet.id,
          plan: plan.id,
          planSnapshot: {
            name: plan.name,
            slug: plan.slug,
            riskLevel: plan.riskLevel,
            roiBasisPoints: plan.roiBasisPoints,
            roiType: plan.roiType,
            payoutFrequency: plan.payoutFrequency,
            durationValue: plan.durationValue,
            durationUnit: plan.durationUnit,
            earlyWithdrawalAllowed: plan.earlyWithdrawalAllowed,
            earlyWithdrawalPenaltyBasisPoints: plan.earlyWithdrawalPenaltyBasisPoints,
            terms: plan.terms,
            thumbnail: plan.thumbnail,
            assetType: plan.assetType,
            assetSubtype: plan.assetSubtype,
            location: plan.location,
            roiGuaranteed: plan.roiGuaranteed,
            unitPrice: plan.unitPrice,
          },
          idempotencyKey: input.idempotencyKey,
          amount,
          units,
          currency: plan.currency,
          expectedReturn,
          payouts,
          nextPayoutAt: payouts[0]?.dueAt ?? null,
          startedAt,
          maturesAt,
          termsAcceptedAt: startedAt,
        });
        await created.save({ session });
        await walletService.postInternalEntry(
          {
            user: userId,
            wallet: wallet.id,
            reference: reference('I', created.id),
            type: 'investment',
            direction: 'debit',
            amount,
          },
          session,
        );
        // A referrer can't be added after investing, so the signup prompt closes here.
        await UserModel.updateOne(
          { _id: userId },
          { referralPromptPending: false },
          { session },
        ).exec();
        return created;
      });
      await this.recordReferralCommission(subscription as unknown as Subscription);
      await emailNotifications.investmentStarted({
        userId,
        plan: subscription.planSnapshot.name,
        amount: subscription.amount,
        expectedReturn: subscription.expectedReturn,
        maturesAt: subscription.maturesAt,
        currency: subscription.currency,
      });
      return { subscription: subscription as unknown as Subscription, replayed: false };
    } catch (err) {
      // The same request raced itself, and the other copy got there first.
      if ((err as { code?: number }).code === DUPLICATE_KEY_ERROR) {
        const raced = await this.findReplay(userId, input);
        if (raced) return { subscription: raced, replayed: true };
      }
      throw err;
    }
  }

  /** Happens after the money has moved: a commission problem must never undo an investment. */
  private async recordReferralCommission(subscription: Subscription) {
    const investmentReference = reference('I', subscription.id);
    try {
      await referralService.recordInvestment(
        {
          referee: subscription.user.toString(),
          investmentReference,
          investmentAmount: subscription.amount,
          plan: subscription.plan.toString(),
        },
        null,
        {
          investment: subscription.id,
          startedAt: subscription.startedAt,
          terms: subscription.planSnapshot,
        },
      );
    } catch (err) {
      // Most of these are expected, such as a customer nobody referred. Staff can record the rest.
      if (err instanceof AppError && err.statusCode < 500) return;
      logger.error({ err, investmentReference }, 'Could not record a referral commission');
    }
  }

  private async findReplay(
    userId: string,
    { planId, units, amount, idempotencyKey }: InvestInput,
  ): Promise<Subscription | null> {
    const existing = await this.findOne({ user: userId, idempotencyKey });
    if (
      existing &&
      (existing.plan.toString() !== planId ||
        (amount !== undefined && existing.amount !== amount) ||
        (units !== undefined && existing.units !== units))
    ) {
      throw AppError.conflict(
        'This idempotency key was used for a different investment',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    return existing;
  }

  /** Same 404 whether it doesn't exist or isn't theirs, so ids can't be probed. */
  async getOwn(userId: string, id: string): Promise<Subscription> {
    const subscription = await this.findOne({ _id: id, user: userId });
    if (!subscription) throw this.notFound();
    return subscription;
  }

  /**
   * Pays everything due by `asOf`, and returns the principal once the last payout is made. Each
   * entry has a unique reference, and overlapping runs conflict on the wallet and retry, so nothing
   * can be paid twice.
   */
  private async payDue(subscription: Subscription, asOf: Date, session: ClientSession) {
    const { id, user, wallet, amount } = subscription;

    for (const payout of subscription.payouts) {
      if (payout.paidAt || payout.dueAt > asOf) continue;
      if (payout.amount > 0) {
        await walletService.postInternalEntry(
          {
            user,
            wallet,
            reference: reference('R', id, `-${payout.number}`),
            type: 'investment_return',
            direction: 'credit',
            amount: payout.amount,
          },
          session,
        );
      }
      payout.paidAt = new Date();
      subscription.returnPaid += payout.amount;
    }

    const next = subscription.payouts.find(({ paidAt }) => !paidAt);
    subscription.nextPayoutAt = next?.dueAt ?? null;

    if (!next) {
      await walletService.postInternalEntry(
        {
          user,
          wallet,
          reference: reference('P', id),
          type: 'investment_principal',
          direction: 'credit',
          amount,
        },
        session,
      );
      subscription.status = 'matured';
      subscription.settledAt = new Date();
      subscription.principalReturned = amount;
    }
    await subscription.save({ session });
  }

  /**
   * Finds everything with a payout due and pays it, then releases referral commissions that have
   * come due. One failure doesn't hold up the rest.
   */
  async processDue(asOf: Date = new Date()): Promise<number> {
    const due = InvestmentSubscriptionModel.find({
      status: 'active',
      nextPayoutAt: { $lte: asOf },
    })
      .select('_id')
      .lean()
      .cursor();

    let processed = 0;
    for await (const { _id } of due) {
      try {
        let payment: Parameters<typeof emailNotifications.investmentPaid>[0] | null = null;
        await mongoose.connection.transaction(async (session) => {
          payment = null;
          const subscription = await InvestmentSubscriptionModel.findOne({
            _id,
            status: 'active',
          }).session(session);
          if (!subscription) return;
          const returnBefore = subscription.returnPaid;
          await this.payDue(subscription as Subscription, asOf, session);
          payment = {
            userId: String(subscription.user),
            plan: subscription.planSnapshot.name,
            returnPaid: subscription.returnPaid - returnBefore,
            principalReturned: subscription.status === 'matured' ? subscription.amount : 0,
            currency: subscription.currency,
          };
        });
        processed += 1;
        const paid = payment as Parameters<typeof emailNotifications.investmentPaid>[0] | null;
        if (paid && (paid.returnPaid > 0 || paid.principalReturned > 0)) {
          await emailNotifications.investmentPaid(paid);
        }
      } catch (err) {
        logger.error({ err, subscriptionId: String(_id) }, 'Could not pay an investment');
      }
    }
    await referralService.releaseDue(asOf);
    return processed;
  }

  private withdrawalTerms(subscription: Subscription) {
    if (subscription.status !== 'active') {
      throw AppError.conflict('This investment is no longer active', 'INVESTMENT_NOT_ACTIVE');
    }
    const now = new Date();
    if (subscription.maturesAt <= now) {
      throw AppError.conflict(
        'This investment has matured and will be paid out shortly',
        'INVESTMENT_MATURED',
      );
    }
    const { earlyWithdrawalAllowed, earlyWithdrawalPenaltyBasisPoints } = subscription.planSnapshot;
    if (!earlyWithdrawalAllowed) {
      throw AppError.conflict(
        'This plan does not allow early withdrawal',
        'EARLY_WITHDRAWAL_NOT_ALLOWED',
      );
    }

    const { amount, expectedReturn, returnPaid, payouts } = subscription;
    const penalty = Number(
      (BigInt(amount) * BigInt(earlyWithdrawalPenaltyBasisPoints)) / BASIS_POINTS,
    );
    // Anything already due is still the customer's, even if the worker hasn't reached it yet.
    const dueNow = payouts
      .filter(({ paidAt, dueAt }) => !paidAt && dueAt <= now)
      .reduce((sum, payout) => sum + payout.amount, 0);

    return {
      amount,
      penalty,
      principalReturned: amount - penalty,
      returnDueNow: dueNow,
      returnPaid,
      returnForfeited: expectedReturn - returnPaid - dueNow,
      currency: subscription.currency,
    };
  }

  async quoteWithdrawal(userId: string, id: string) {
    return this.withdrawalTerms(await this.getOwn(userId, id));
  }

  /** Ends the investment early: pays what's due, then returns the principal less any penalty. */
  async withdraw(userId: string, id: string): Promise<Subscription> {
    await this.getOwn(userId, id);

    const withdrawn = await mongoose.connection.transaction(async (session) => {
      const subscription = (await InvestmentSubscriptionModel.findOne({
        _id: id,
        user: userId,
      }).session(session)) as Subscription | null;
      if (!subscription) throw this.notFound();

      const { penalty, principalReturned, returnForfeited } = this.withdrawalTerms(subscription);
      const { user, wallet } = subscription;

      await this.payDue(subscription, new Date(), session);
      if (principalReturned > 0) {
        await walletService.postInternalEntry(
          {
            user,
            wallet,
            reference: reference('W', subscription.id),
            type: 'investment_withdrawal',
            direction: 'credit',
            amount: principalReturned,
          },
          session,
        );
      }
      subscription.set({
        status: 'withdrawn',
        nextPayoutAt: null,
        settledAt: new Date(),
        principalReturned,
        earlyWithdrawalPenalty: penalty,
        returnForfeited,
      });
      await subscription.save({ session });
      await referralService.cancelUnearned(subscription.id, session);
      return subscription;
    });
    await emailNotifications.investmentWithdrawn({
      userId,
      plan: withdrawn.planSnapshot.name,
      principalReturned: withdrawn.principalReturned,
      penalty: withdrawn.earlyWithdrawalPenalty,
      currency: withdrawn.currency,
    });
    return withdrawn;
  }

  // Staff.

  async listAll(query: ListQuery) {
    const result = await this.paginate(query);
    await InvestmentSubscriptionModel.populate(result.items, USER_POPULATE);
    return result;
  }

  async getWithUser(id: string): Promise<Subscription> {
    return (await this.findById(id)).populate(USER_POPULATE);
  }

  /** Totals by status. For active investments, `outstanding` is what the business still owes. */
  async summary() {
    const groups = await InvestmentSubscriptionModel.aggregate<{
      _id: string;
      count: number;
      principal: number;
      returnPaid: number;
      outstanding: number;
    }>([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          principal: { $sum: '$amount' },
          returnPaid: { $sum: '$returnPaid' },
          outstanding: {
            $sum: {
              $cond: [
                { $eq: ['$status', 'active'] },
                { $subtract: [{ $add: ['$amount', '$expectedReturn'] }, '$returnPaid'] },
                0,
              ],
            },
          },
        },
      },
    ]).exec();
    return Object.fromEntries(groups.map(({ _id, ...totals }) => [_id, totals]));
  }
}

export const subscriptionService = new SubscriptionService();
