import type { HydratedDocument, QueryFilter } from 'mongoose';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import type { ListQuery } from '@/core/validation/common.schemas';
import { toSlug } from '@/utils/slug';
import { MAX_AMOUNT_KOBO } from './investment.schemas';
import { buildSchedule } from './investment.schedule';
import { InvestmentPlanModel, type DurationUnit, type IInvestmentPlan } from './investment.model';
import { InvestmentSubscriptionModel } from './investmentSubscription.model';

type Plan = HydratedDocument<IInvestmentPlan>;
type PlanInput = Partial<
  Omit<IInvestmentPlan, 'createdBy' | 'durationDays' | 'currency' | 'unitsSold'>
>;

const FALLBACK_SLUG = 'plan';
const MAX_DURATION_DAYS = 18_250;
/** Customers don't need to see which member of staff set a plan up. */
const CUSTOMER_FIELDS = '-createdBy';

const DAYS_PER_UNIT: Record<DurationUnit, number> = { days: 1, months: 30, years: 365 };

export const availableFilter = (): QueryFilter<IInvestmentPlan> => {
  const now = new Date();
  return {
    status: 'open',
    // In $and, because a search adds its own top-level $or.
    $and: [
      { $or: [{ opensAt: null }, { opensAt: { $lte: now } }] },
      { $or: [{ closesAt: null }, { closesAt: { $gt: now } }] },
    ],
  };
};

/** Refuses an amount outside the plan's limits. `path` is where the client sent it. */
export const assertAmountAllowed = (
  amount: number,
  { minAmount, maxAmount }: Pick<IInvestmentPlan, 'minAmount' | 'maxAmount'>,
  path: string,
): void => {
  const message =
    amount < minAmount
      ? `Amount must be at least ${minAmount} kobo`
      : maxAmount !== null && amount > maxAmount
        ? `Amount must be at most ${maxAmount} kobo`
        : null;
  if (message) throw AppError.validation([{ path, message }]);
};

export const insufficientUnits = (): AppError =>
  AppError.conflict('There are not enough units left in this plan', 'INSUFFICIENT_UNITS');

/**
 * Works out what's being bought, from the units or the amount the customer sent, and checks it
 * against the plan. `prefix` is where the client sent it, such as `body`.
 */
export const resolvePurchase = (
  plan: Pick<IInvestmentPlan, 'unitPrice' | 'minAmount' | 'maxAmount'>,
  { units, amount }: { units?: number | undefined; amount?: number | undefined },
  prefix: string,
): { amount: number; units: number | null } => {
  const invalid = (field: string, message: string) =>
    AppError.validation([{ path: `${prefix}.${field}`, message }]);
  const { unitPrice } = plan;

  if (unitPrice === null && units !== undefined) {
    throw invalid('units', 'This plan is not sold in units, so send an amount');
  }
  const total = units !== undefined && unitPrice !== null ? units * unitPrice : (amount as number);
  const field = units !== undefined ? 'units' : 'amount';
  if (total > MAX_AMOUNT_KOBO) throw invalid(field, 'This is more than one investment can be');
  if (unitPrice !== null && total % unitPrice !== 0) {
    throw invalid(field, `Amount must be a whole number of units of ${unitPrice} kobo`);
  }
  assertAmountAllowed(total, plan, `${prefix}.${field}`);

  return { amount: total, units: unitPrice === null ? null : total / unitPrice };
};

class InvestmentService extends BaseService<IInvestmentPlan> {
  constructor() {
    super(InvestmentPlanModel, {
      resourceName: 'Investment plan',
      searchFields: [
        'name',
        'summary',
        'category',
        'assetType',
        'assetSubtype',
        'location.area',
        'location.state',
        'location.country',
      ],
    });
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = toSlug(name, FALLBACK_SLUG);
    let slug = base;
    for (let n = 2; await InvestmentPlanModel.exists({ slug }); n += 1) slug = `${base}-${n}`;
    return slug;
  }

  /** Checks across fields, on the plan as it will be, so that a partial update can't break them. */
  private async validateAndSave(plan: Plan): Promise<Plan> {
    plan.minAmount ??= plan.unitPrice as number;
    const { minAmount, maxAmount, opensAt, closesAt, durationValue, durationUnit } = plan;
    const { unitPrice, totalUnits, unitsSold } = plan;
    const isWholeUnits = (amount: number) => unitPrice === null || amount % unitPrice === 0;
    plan.durationDays = durationValue * DAYS_PER_UNIT[durationUnit];

    const details = [
      ...(plan.status === 'open' && !plan.thumbnail
        ? [{ path: 'body.thumbnail', message: 'A plan needs a thumbnail before it can open' }]
        : []),
      ...((unitPrice === null) !== (totalUnits === null)
        ? [{ path: 'body.totalUnits', message: 'Provide unitPrice and totalUnits together' }]
        : []),
      ...(minAmount == null
        ? [{ path: 'body.minAmount', message: 'Provide minAmount, or sell the plan in units' }]
        : !isWholeUnits(minAmount) || (maxAmount !== null && !isWholeUnits(maxAmount))
          ? [{ path: 'body.minAmount', message: 'Limits must be whole numbers of units' }]
          : []),
      ...(plan.isModified('unitPrice') && unitsSold > 0
        ? [{ path: 'body.unitPrice', message: 'The unit price is fixed once units have sold' }]
        : []),
      ...(unitsSold > 0 && (totalUnits ?? 0) < unitsSold
        ? [{ path: 'body.totalUnits', message: `${unitsSold} units have already sold` }]
        : []),
      ...(plan.durationDays > MAX_DURATION_DAYS
        ? [{ path: 'body.durationValue', message: 'Duration must be at most 50 years' }]
        : []),
      ...(maxAmount !== null && maxAmount < minAmount
        ? [{ path: 'body.maxAmount', message: 'Maximum amount cannot be below the minimum' }]
        : []),
      ...(opensAt && closesAt && closesAt <= opensAt
        ? [{ path: 'body.closesAt', message: 'Closing time must be after the opening time' }]
        : []),
      ...(!plan.earlyWithdrawalAllowed && plan.earlyWithdrawalPenaltyBasisPoints > 0
        ? [
            {
              path: 'body.earlyWithdrawalPenaltyBasisPoints',
              message: 'A penalty needs early withdrawal to be allowed',
            },
          ]
        : []),
    ];
    if (details.length > 0) throw AppError.validation(details);

    return plan.save();
  }

  // Customers: only what's available now, so anything else looks the same as a missing plan.

  listAvailable(query: ListQuery) {
    return this.paginate(query, availableFilter(), CUSTOMER_FIELDS);
  }

  async getAvailableBySlug(slug: string): Promise<Plan> {
    const plan = await this.findOne({ ...availableFilter(), slug }, CUSTOMER_FIELDS);
    if (!plan) throw this.notFound();
    return plan;
  }

  async listAvailableCategories() {
    const counts = await InvestmentPlanModel.aggregate<{ _id: string; count: number }>([
      { $match: { ...availableFilter(), category: { $ne: null } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]).exec();
    return counts.map(({ _id, count }) => ({ name: _id, count }));
  }

  /** What a purchase would earn. A projection only: nothing is invested or reserved. */
  async quote(slug: string, purchase: { units?: number | undefined; amount?: number | undefined }) {
    const plan = await this.getAvailableBySlug(slug);
    const { roiBasisPoints, roiType, durationValue, durationUnit } = plan;

    const { amount, units } = resolvePurchase(plan, purchase, 'query');
    if (units !== null && units > (plan.totalUnits as number) - plan.unitsSold) {
      throw insufficientUnits();
    }

    const {
      expectedReturn: projectedReturn,
      maturesAt,
      payouts,
    } = buildSchedule(amount, plan, new Date());
    return {
      units,
      unitPrice: plan.unitPrice,
      amount,
      projectedReturn,
      projectedTotal: amount + projectedReturn,
      currency: plan.currency,
      roiBasisPoints,
      roiType,
      roiGuaranteed: plan.roiGuaranteed,
      durationValue,
      durationUnit,
      maturesAt,
      payouts,
    };
  }

  // Staff.

  listAll(query: ListQuery) {
    return this.paginate(query);
  }

  async createPlan(
    data: PlanInput & Pick<IInvestmentPlan, 'name'>,
    createdBy: string,
  ): Promise<Plan> {
    const slug = data.slug ?? (await this.uniqueSlug(data.name));
    return this.validateAndSave(
      new InvestmentPlanModel({ ...data, slug, createdBy }) as unknown as Plan,
    );
  }

  async updatePlan(id: string, data: PlanInput): Promise<Plan> {
    const plan = await this.findById(id);
    plan.set(data);
    return this.validateAndSave(plan);
  }

  /** Investments keep their own copy of the terms, but the plan is still their history. */
  override async deleteById(id: string): Promise<void> {
    if (await InvestmentSubscriptionModel.exists({ plan: id })) {
      throw AppError.conflict(
        'This plan has investments, so close or archive it instead',
        'PLAN_IN_USE',
      );
    }
    await super.deleteById(id);
  }
}

export const investmentService = new InvestmentService();
