import type { DurationUnit, IInvestmentPlan, PayoutFrequency } from './investment.model';

const BASIS_POINTS = 10_000n;
/** Each unit as a fraction of a year, so that 12 months earns exactly a year's rate. */
const UNITS_PER_YEAR: Record<DurationUnit, bigint> = { days: 365n, months: 12n, years: 1n };
const MONTHS_BETWEEN_PAYOUTS: Record<PayoutFrequency, number | null> = {
  monthly: 1,
  quarterly: 3,
  at_maturity: null,
};
const DAY_MS = 24 * 60 * 60 * 1000;

type RateTerms = Pick<
  IInvestmentPlan,
  'roiBasisPoints' | 'roiType' | 'durationValue' | 'durationUnit'
>;
type ScheduleTerms = RateTerms & Pick<IInvestmentPlan, 'payoutFrequency'>;

export interface ScheduledPayout {
  number: number;
  dueAt: Date;
  amount: number;
}

/** Rounds down, so a projection never promises more than the plan's rate gives. */
export const calculateReturn = (amount: number, plan: RateTerms): number => {
  const interest = BigInt(amount) * BigInt(plan.roiBasisPoints);
  return Number(
    plan.roiType === 'flat'
      ? interest / BASIS_POINTS
      : (interest * BigInt(plan.durationValue)) /
          (BASIS_POINTS * UNITS_PER_YEAR[plan.durationUnit]),
  );
};

/** Always count from the original date, so that a short month doesn't shift the later ones. */
const addMonths = (start: Date, months: number): Date => {
  const target = new Date(start);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target;
};

const maturityDate = (
  startAt: Date,
  { durationValue, durationUnit }: Pick<IInvestmentPlan, 'durationValue' | 'durationUnit'>,
): Date => {
  if (durationUnit === 'days') return new Date(startAt.getTime() + durationValue * DAY_MS);
  return addMonths(startAt, durationUnit === 'years' ? durationValue * 12 : durationValue);
};

/** The plan's length in months, as a fraction. A month counts as 30 days for a plan set in days. */
const durationInMonths = ({
  durationValue,
  durationUnit,
}: Pick<IInvestmentPlan, 'durationValue' | 'durationUnit'>): [bigint, bigint] => {
  const value = BigInt(durationValue);
  if (durationUnit === 'days') return [value, 30n];
  return [durationUnit === 'years' ? value * 12n : value, 1n];
};

/**
 * When the return gets paid, and how much each time. Each payout earns in proportion to the months
 * it covers, so a short last period earns less, and the last one takes whatever rounding left over.
 * Together the payouts always add up to exactly the expected return.
 */
export const buildSchedule = (amount: number, terms: ScheduleTerms, startAt: Date) => {
  const expectedReturn = calculateReturn(amount, terms);
  const maturesAt = maturityDate(startAt, terms);
  const interval = MONTHS_BETWEEN_PAYOUTS[terms.payoutFrequency];
  const [months, per] = durationInMonths(terms);

  const payouts: ScheduledPayout[] = [];
  let paid = 0;
  if (interval !== null) {
    for (let number = 1; ; number += 1) {
      const elapsed = number * interval;
      const dueAt = addMonths(startAt, elapsed);
      if (dueAt >= maturesAt) break;
      const earned = (BigInt(expectedReturn) * BigInt(elapsed) * per) / months;
      const cumulative = Math.min(Number(earned), expectedReturn);
      payouts.push({ number, dueAt, amount: cumulative - paid });
      paid = cumulative;
    }
  }
  payouts.push({ number: payouts.length + 1, dueAt: maturesAt, amount: expectedReturn - paid });

  return { expectedReturn, maturesAt, payouts };
};

export type CommissionTerms = Pick<IInvestmentPlan, 'durationValue' | 'durationUnit'>;

const MONTHS_PER_COMMISSION = 12;

/**
 * When a referral commission is paid over the investment's life: the full `perYear` at each 12
 * months, so 36 months pays it three times. A plan of a year or less pays it once, at maturity. Any
 * part-year after the first is paid at maturity in proportion, so 18 months pays one and a half.
 */
export const buildCommissionSchedule = (
  perYear: number,
  terms: CommissionTerms,
  startAt: Date,
): ScheduledPayout[] => {
  const maturesAt = maturityDate(startAt, terms);
  const [months, per] = durationInMonths(terms);

  const parts: Omit<ScheduledPayout, 'number'>[] = [];
  for (let year = 1; ; year += 1) {
    const dueAt = addMonths(startAt, year * MONTHS_PER_COMMISSION);
    if (dueAt >= maturesAt) break;
    parts.push({ dueAt, amount: perYear });
  }
  const fullYears = BigInt(parts.length * MONTHS_PER_COMMISSION);
  const lastPart =
    (BigInt(perYear) * (months - fullYears * per)) / (BigInt(MONTHS_PER_COMMISSION) * per);
  parts.push({
    dueAt: maturesAt,
    // A plan set in days can run a little over 12 months of 30 days, which is still only a year.
    amount: parts.length === 0 ? perYear : Math.min(Number(lastPart), perYear),
  });

  // A very small commission can round to nothing for a part-year, and there's nothing to pay then.
  return parts
    .filter(({ amount }) => amount > 0)
    .map((part, index) => ({ ...part, number: index + 1 }));
};
