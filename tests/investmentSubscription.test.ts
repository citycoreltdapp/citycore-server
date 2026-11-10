import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { SessionModel } from '@/modules/auth/session.model';
import { EmailLogModel } from '@/modules/email/email.model';
import { InvestmentPlanModel } from '@/modules/investment/investment.model';
import {
  buildCommissionSchedule,
  buildSchedule,
  type CommissionTerms,
} from '@/modules/investment/investment.schedule';
import { InvestmentSubscriptionModel } from '@/modules/investment/investmentSubscription.model';
import { subscriptionService } from '@/modules/investment/investmentSubscription.service';
import { PlatformConfigModel } from '@/modules/platformConfig/platformConfig.model';
import { platformConfigService } from '@/modules/platformConfig/platformConfig.service';
import { ReferralCommissionModel, ReferralModel } from '@/modules/referral/referral.model';
import { UserModel } from '@/modules/user/user.model';
import { WalletModel } from '@/modules/wallet/wallet.model';
import { WalletTransactionModel } from '@/modules/wallet/walletTransaction.model';

const app = createApp();
const API = '/api/v1/investments';
const SUBS = `${API}/subscriptions`;
const ADMIN_SUBS = `${API}/admin/subscriptions`;
const PLANS = `${API}/admin/plans`;
const PASSWORD = 'Passw0rd123';
const AMOUNT = 10_000_000;
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

const planBody = {
  name: 'Fixed Income Note',
  description: 'A note paying a fixed return.',
  riskLevel: 'low',
  roiBasisPoints: 1200,
  roiType: 'per_annum',
  payoutFrequency: 'quarterly',
  durationValue: 12,
  durationUnit: 'months',
  minAmount: 1_000_000,
  maxAmount: 50_000_000,
  earlyWithdrawalAllowed: true,
  earlyWithdrawalPenaltyBasisPoints: 500,
  thumbnail: 'https://res.cloudinary.com/test-cloud/image/upload/v1/citycore/images/thumb.png',
  status: 'open',
};

const signIn = async (role: string, kycCompleted = true) => {
  const email = `${role}@example.com`;
  const user = await UserModel.create({
    name: `Test ${role}`,
    email,
    password: PASSWORD,
    role,
    kycCompleted,
  });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id as string, auth: `Bearer ${res.body.data.accessToken as string}` };
};

const fund = async (userId: string, balance: number) => {
  await WalletModel.findOneAndUpdate({ user: userId }, { balance }, { upsert: true });
};

const balanceOf = async (userId: string) =>
  (await WalletModel.findOne({ user: userId }).lean().exec())?.balance ?? 0;

let admin: Awaited<ReturnType<typeof signIn>>;
let customer: Awaited<ReturnType<typeof signIn>>;
let planId: string;
let keyCounter = 0;

const createPlan = async (body: object = {}) => {
  const res = await request(app)
    .post(PLANS)
    .set('Authorization', admin.auth)
    .send({ ...planBody, ...body });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
};

const invest = (body: object = {}, auth = customer.auth) =>
  request(app)
    .post(SUBS)
    .set('Authorization', auth)
    .send({
      planId,
      amount: AMOUNT,
      idempotencyKey: `test-key-${(keyCounter += 1)}`,
      acceptTerms: true,
      ...body,
    });

const investOk = async (body: object = {}) => {
  const res = await invest(body);
  expect(res.status).toBe(201);
  return res.body.data as { id: string; payouts: { dueAt: string; amount: number }[] };
};

const withdraw = (id: string, auth = customer.auth) =>
  request(app).post(`${SUBS}/${id}/withdraw`).set('Authorization', auth).send({ confirm: true });

/** Moves the investment's first `count` payouts into the past, as if time had gone by. */
const makeDue = async (id: string, count: number) => {
  const subscription = await InvestmentSubscriptionModel.findById(id).orFail();
  const past = new Date(Date.now() - 1000);
  subscription.payouts.slice(0, count).forEach((payout) => {
    payout.dueAt = past;
  });
  subscription.nextPayoutAt = past;
  await subscription.save();
};

const ledger = (userId: string) =>
  WalletTransactionModel.find({ user: userId }).sort('createdAt').lean().exec();

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([
    UserModel.init(),
    SessionModel.init(),
    InvestmentPlanModel.init(),
    InvestmentSubscriptionModel.init(),
    WalletModel.init(),
    WalletTransactionModel.init(),
    ReferralModel.init(),
    ReferralCommissionModel.init(),
  ]);
});

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    InvestmentPlanModel.deleteMany({}),
    InvestmentSubscriptionModel.deleteMany({}),
    WalletModel.deleteMany({}),
    WalletTransactionModel.deleteMany({}),
    ReferralModel.deleteMany({}),
    ReferralCommissionModel.deleteMany({}),
    PlatformConfigModel.deleteMany({}),
  ]);
  await platformConfigService.seedManagedConfigs();
  admin = await signIn('admin');
  customer = await signIn('user');
  planId = await createPlan();
  await fund(customer.id, 100_000_000);
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('the payout schedule', () => {
  const terms = {
    roiBasisPoints: 1200,
    roiType: 'per_annum',
    durationValue: 12,
    durationUnit: 'months',
    payoutFrequency: 'monthly',
  } as const;
  const sum = (payouts: { amount: number }[]) => payouts.reduce((a, b) => a + b.amount, 0);

  it('pays once at maturity', () => {
    const start = new Date('2026-01-15T10:00:00Z');
    const { payouts, maturesAt, expectedReturn } = buildSchedule(
      AMOUNT,
      { ...terms, payoutFrequency: 'at_maturity' },
      start,
    );
    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.amount).toBe(expectedReturn);
    expect(maturesAt.toISOString()).toBe('2027-01-15T10:00:00.000Z');
  });

  it('splits a return across months, adding up exactly', () => {
    const { payouts, expectedReturn } = buildSchedule(
      1_000_001,
      terms,
      new Date('2026-01-15T00:00:00Z'),
    );
    expect(payouts).toHaveLength(12);
    expect(sum(payouts)).toBe(expectedReturn);
    expect(payouts.every(({ amount }) => amount >= 0)).toBe(true);
  });

  it('keeps to the same day of the month, using the last day of a short one', () => {
    const { payouts } = buildSchedule(AMOUNT, terms, new Date('2026-01-31T00:00:00Z'));
    expect(payouts.slice(0, 3).map(({ dueAt }) => dueAt.toISOString().slice(0, 10))).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('pays a short last period in proportion', () => {
    const { payouts, expectedReturn } = buildSchedule(
      AMOUNT,
      { ...terms, durationValue: 5, payoutFrequency: 'quarterly' },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(payouts.map(({ amount }) => amount)).toEqual([
      Math.floor((expectedReturn * 3) / 5),
      expectedReturn - Math.floor((expectedReturn * 3) / 5),
    ]);
  });

  it('never pays more than the return on a plan set in days', () => {
    // From 1 February, a month has passed after 28 of the 29 days.
    const { payouts, expectedReturn } = buildSchedule(
      AMOUNT,
      { ...terms, durationValue: 29, durationUnit: 'days' },
      new Date('2026-02-01T00:00:00Z'),
    );
    expect(sum(payouts)).toBe(expectedReturn);
    expect(payouts.every(({ amount }) => amount >= 0)).toBe(true);
  });
});

describe('the commission schedule', () => {
  const start = new Date('2026-03-15T00:00:00Z');
  const schedule = (total: number, durationValue: number, durationUnit = 'months') =>
    buildCommissionSchedule(total, { durationValue, durationUnit } as CommissionTerms, start).map(
      ({ number, amount, dueAt }) => [number, amount, dueAt.toISOString().slice(0, 10)],
    );

  it.each([
    [
      36,
      [
        [1, 900, '2027-03-15'],
        [2, 900, '2028-03-15'],
        [3, 900, '2029-03-15'],
      ],
    ],
    [
      24,
      [
        [1, 900, '2027-03-15'],
        [2, 900, '2028-03-15'],
      ],
    ],
    [12, [[1, 900, '2027-03-15']]],
    [6, [[1, 900, '2026-09-15']]],
    [
      18,
      [
        [1, 900, '2027-03-15'],
        [2, 450, '2027-09-15'],
      ],
    ],
  ])('pays a %i month investment', (months, expected) => {
    expect(schedule(900, months)).toEqual(expected);
  });

  it('pays one full year for a plan of 365 days', () => {
    expect(schedule(900, 365, 'days')).toEqual([[1, 900, '2027-03-15']]);
  });

  it('never pays more than a year for a plan set in days', () => {
    expect(schedule(900, 730, 'days').map(([, amount]) => amount)).toEqual([900, 900]);
  });

  it('skips a part-year that rounds to nothing', () => {
    expect(schedule(1, 18).map(([number, amount]) => [number, amount])).toEqual([[1, 1]]);
  });
});

describe('investing', () => {
  it('moves the money, records it, and locks in the terms', async () => {
    const investment = await investOk();

    expect(await balanceOf(customer.id)).toBe(90_000_000);
    const stored = await InvestmentSubscriptionModel.findById(investment.id).orFail();
    expect(stored).toMatchObject({ status: 'active', amount: AMOUNT, expectedReturn: 1_200_000 });
    expect(stored.payouts).toHaveLength(4);

    const [entry] = await ledger(customer.id);
    expect(entry).toMatchObject({
      type: 'investment',
      direction: 'debit',
      amount: AMOUNT,
      provider: 'internal',
      status: 'success',
      balanceAfter: 90_000_000,
    });

    await request(app)
      .patch(`${PLANS}/${planId}`)
      .set('Authorization', admin.auth)
      .send({
        roiBasisPoints: 9000,
        earlyWithdrawalAllowed: false,
        earlyWithdrawalPenaltyBasisPoints: 0,
      })
      .expect(200);
    const read = await request(app)
      .get(`${SUBS}/${investment.id}`)
      .set('Authorization', customer.auth);
    expect(read.body.data.planSnapshot).toMatchObject({
      roiBasisPoints: 1200,
      earlyWithdrawalAllowed: true,
    });
    expect(read.body.data.expectedReturn).toBe(1_200_000);
    expect(read.body.data).not.toHaveProperty('idempotencyKey');
  });

  it('needs KYC to invest, but not to read', async () => {
    await UserModel.updateOne({ _id: customer.id }, { kycCompleted: false });
    const res = await invest();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('KYC_REQUIRED');
    expect((await request(app).get(SUBS).set('Authorization', customer.auth)).status).toBe(200);
    expect(await balanceOf(customer.id)).toBe(100_000_000);
  });

  it('still pays out and lets a customer withdraw after KYC is withdrawn', async () => {
    const { id } = await investOk();
    await UserModel.updateOne({ _id: customer.id }, { kycCompleted: false });
    await makeDue(id, 1);
    await subscriptionService.processDue();
    expect(await balanceOf(customer.id)).toBe(90_300_000);
    expect((await withdraw(id)).status).toBe(200);
  });

  it('refuses a low balance and leaves nothing behind', async () => {
    await fund(customer.id, AMOUNT - 1);
    const res = await invest();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(customer.id)).toBe(AMOUNT - 1);
    expect(await InvestmentSubscriptionModel.countDocuments()).toBe(0);
    expect(await WalletTransactionModel.countDocuments()).toBe(0);
  });

  it('keeps to the plan limits and needs the terms accepted', async () => {
    expect((await invest({ amount: 999_999 })).status).toBe(422);
    expect((await invest({ amount: 50_000_001 })).status).toBe(422);
    expect((await invest({ acceptTerms: false })).status).toBe(422);
    expect((await invest({ idempotencyKey: 'x' })).status).toBe(422);
    expect(await balanceOf(customer.id)).toBe(100_000_000);
  });

  it('refuses a plan that is not available', async () => {
    const draft = await createPlan({ name: 'Draft', status: 'draft' });
    const closed = await createPlan({ name: 'Closed', status: 'closed' });
    expect((await invest({ planId: draft })).status).toBe(404);
    expect((await invest({ planId: closed })).status).toBe(404);
    expect(await balanceOf(customer.id)).toBe(100_000_000);
  });

  it('treats a retry with the same key as the same investment', async () => {
    const first = await invest({ idempotencyKey: 'retry-key-1' });
    expect(first.status).toBe(201);
    const second = await invest({ idempotencyKey: 'retry-key-1' });
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await balanceOf(customer.id)).toBe(90_000_000);

    const different = await invest({ idempotencyKey: 'retry-key-1', amount: AMOUNT + 1 });
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('charges once when the same request arrives twice at the same moment', async () => {
    const results = await Promise.all([
      invest({ idempotencyKey: 'race-key-1' }),
      invest({ idempotencyKey: 'race-key-1' }),
      invest({ idempotencyKey: 'race-key-1' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await balanceOf(customer.id)).toBe(90_000_000);
    expect(await InvestmentSubscriptionModel.countDocuments()).toBe(1);
  });

  it('never overspends when different investments race', async () => {
    await fund(customer.id, AMOUNT);
    const results = await Promise.all([invest(), invest(), invest()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await InvestmentSubscriptionModel.countDocuments()).toBe(1);
  });

  it("hides other customers' investments", async () => {
    const { id } = await investOk();
    const other = await signIn('editor');
    expect((await request(app).get(`${SUBS}/${id}`).set('Authorization', other.auth)).status).toBe(
      404,
    );
    expect((await withdraw(id, other.auth)).status).toBe(404);
    const list = await request(app).get(SUBS).set('Authorization', other.auth);
    expect(list.body.data).toEqual([]);
    expect(await balanceOf(customer.id)).toBe(90_000_000);
  });
});

describe('buying units', () => {
  const unitPlan = (totalUnits = 1000) =>
    createPlan({
      name: `Lekki Residences ${totalUnits}`,
      assetType: 'Residential',
      location: { area: 'Lekki', state: 'Lagos', country: 'Nigeria' },
      unitPrice: 15_000_000,
      totalUnits,
      minAmount: undefined,
      maxAmount: null,
      roiBasisPoints: 1600,
    });

  it('charges for the units, counts them, and keeps the details', async () => {
    planId = await unitPlan();
    const res = await invest({ units: 2, amount: undefined });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      units: 2,
      amount: 30_000_000,
      expectedReturn: 4_800_000,
      planSnapshot: {
        unitPrice: 15_000_000,
        thumbnail: planBody.thumbnail,
        location: { area: 'Lekki', state: 'Lagos', country: 'Nigeria' },
      },
    });
    expect(await balanceOf(customer.id)).toBe(70_000_000);
    expect((await InvestmentPlanModel.findById(planId))?.unitsSold).toBe(2);
  });

  it('works out the units from an amount, and refuses part of a unit', async () => {
    planId = await unitPlan();
    const res = await invest({ amount: 15_000_000 });
    expect(res.body.data.units).toBe(1);
    expect((await invest({ amount: 16_000_000 })).status).toBe(422);
    expect((await invest({ units: 1, amount: 15_000_000 })).status).toBe(422);
    expect((await invest({ units: undefined, amount: undefined })).status).toBe(422);
  });

  it('treats a retry as the same purchase, without counting the units again', async () => {
    planId = await unitPlan();
    const body = { units: 1, amount: undefined, idempotencyKey: 'unit-retry-1' };
    await invest(body).expect(201);
    await invest(body).expect(200);
    expect((await invest({ ...body, units: 2 })).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await InvestmentPlanModel.findById(planId))?.unitsSold).toBe(1);
    expect(await balanceOf(customer.id)).toBe(85_000_000);
  });

  it('refuses more units than are left, and takes no money', async () => {
    planId = await unitPlan(1);
    const res = await invest({ units: 2, amount: undefined });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_UNITS');
    expect(await balanceOf(customer.id)).toBe(100_000_000);
  });

  it('never oversells when buyers race for the last unit', async () => {
    planId = await unitPlan(1);
    const results = await Promise.all([
      invest({ units: 1, amount: undefined }),
      invest({ units: 1, amount: undefined }),
      invest({ units: 1, amount: undefined }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect((await InvestmentPlanModel.findById(planId))?.unitsSold).toBe(1);
    expect(await balanceOf(customer.id)).toBe(85_000_000);
  });

  it('gives units back if the payment fails', async () => {
    planId = await unitPlan();
    await fund(customer.id, 1);
    expect((await invest({ units: 1, amount: undefined })).body.code).toBe('INSUFFICIENT_BALANCE');
    expect((await InvestmentPlanModel.findById(planId))?.unitsSold).toBe(0);
  });

  it('protects what has sold when the plan is edited', async () => {
    planId = await unitPlan(10);
    await invest({ units: 3, amount: undefined }).expect(201);
    const patch = (body: object) =>
      request(app).patch(`${PLANS}/${planId}`).set('Authorization', admin.auth).send(body);
    expect((await patch({ unitPrice: 20_000_000 })).status).toBe(422);
    expect((await patch({ totalUnits: 2 })).status).toBe(422);
    expect((await patch({ totalUnits: 3 })).status).toBe(200);
    expect((await patch({ unitPrice: null, totalUnits: null })).status).toBe(422);
  });

  it('leaves units sold after an early withdrawal', async () => {
    planId = await unitPlan();
    const { body } = await invest({ units: 1, amount: undefined }).expect(201);
    await withdraw(body.data.id).expect(200);
    expect((await InvestmentPlanModel.findById(planId))?.unitsSold).toBe(1);
  });
});

describe('paying out', () => {
  it('pays what is due, then the rest and the principal at maturity, once each', async () => {
    const { id } = await investOk();

    await makeDue(id, 1);
    expect(await subscriptionService.processDue()).toBe(1);
    expect(await balanceOf(customer.id)).toBe(90_300_000);
    expect(await subscriptionService.processDue()).toBe(0);
    expect(await balanceOf(customer.id)).toBe(90_300_000);

    const later = new Date(Date.now() + YEAR_MS);
    await subscriptionService.processDue(later);
    await subscriptionService.processDue(later);

    expect(await balanceOf(customer.id)).toBe(101_200_000);
    const stored = await InvestmentSubscriptionModel.findById(id).orFail();
    expect(stored).toMatchObject({
      status: 'matured',
      returnPaid: 1_200_000,
      principalReturned: AMOUNT,
      nextPayoutAt: null,
    });
    const entries = await ledger(customer.id);
    expect(entries.filter(({ type }) => type === 'investment_return')).toHaveLength(4);
    expect(entries.filter(({ type }) => type === 'investment_principal')).toHaveLength(1);
  });

  it('pays once when two runs overlap', async () => {
    await investOk();
    const later = new Date(Date.now() + YEAR_MS);
    await Promise.all([
      subscriptionService.processDue(later),
      subscriptionService.processDue(later),
    ]);
    expect(await balanceOf(customer.id)).toBe(101_200_000);
  });

  it('leaves investments alone before anything is due', async () => {
    await investOk();
    expect(await subscriptionService.processDue()).toBe(0);
    expect(await balanceOf(customer.id)).toBe(90_000_000);
  });
});

describe('withdrawing early', () => {
  it('returns the principal less the penalty, and gives up future returns', async () => {
    const { id } = await investOk();

    const quote = await request(app)
      .get(`${SUBS}/${id}/withdraw/quote`)
      .set('Authorization', customer.auth);
    expect(quote.body.data).toMatchObject({
      penalty: 500_000,
      principalReturned: 9_500_000,
      returnDueNow: 0,
      returnForfeited: 1_200_000,
    });

    const res = await withdraw(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'withdrawn',
      earlyWithdrawalPenalty: 500_000,
      principalReturned: 9_500_000,
      returnForfeited: 1_200_000,
      nextPayoutAt: null,
    });
    expect(await balanceOf(customer.id)).toBe(99_500_000);

    expect((await withdraw(id)).body.code).toBe('INVESTMENT_NOT_ACTIVE');
    expect(await balanceOf(customer.id)).toBe(99_500_000);
    await subscriptionService.processDue(new Date(Date.now() + YEAR_MS));
    expect(await balanceOf(customer.id)).toBe(99_500_000);
  });

  it('pays anything already due first', async () => {
    const { id } = await investOk();
    await makeDue(id, 1);
    const res = await withdraw(id);
    expect(res.body.data).toMatchObject({ returnPaid: 300_000, returnForfeited: 900_000 });
    expect(await balanceOf(customer.id)).toBe(90_000_000 + 300_000 + 9_500_000);
  });

  it('pays once when two withdrawals race', async () => {
    const { id } = await investOk();
    const results = await Promise.all([withdraw(id), withdraw(id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balanceOf(customer.id)).toBe(99_500_000);
  });

  it('keeps to the terms agreed at the start', async () => {
    const locked = await createPlan({
      name: 'Locked',
      earlyWithdrawalAllowed: false,
      earlyWithdrawalPenaltyBasisPoints: 0,
    });
    const { id } = await investOk({ planId: locked });
    const res = await withdraw(id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EARLY_WITHDRAWAL_NOT_ALLOWED');
    expect(await balanceOf(customer.id)).toBe(90_000_000);
  });

  it('refuses after maturity, and leaves the payout to the worker', async () => {
    const { id } = await investOk();
    await InvestmentSubscriptionModel.updateOne(
      { _id: id },
      { maturesAt: new Date(Date.now() - 1000) },
    );
    expect((await withdraw(id)).body.code).toBe('INVESTMENT_MATURED');
  });

  it('needs confirming', async () => {
    const { id } = await investOk();
    const res = await request(app)
      .post(`${SUBS}/${id}/withdraw`)
      .set('Authorization', customer.auth)
      .send({});
    expect(res.status).toBe(422);
  });
});

describe('staff', () => {
  it('lists every investment with its owner, and totals them', async () => {
    const { id } = await investOk();
    await investOk();
    await withdraw(id);

    const list = await request(app)
      .get(`${ADMIN_SUBS}?status=active`)
      .set('Authorization', admin.auth);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].user).toMatchObject({ name: 'Test user', email: 'user@example.com' });

    const one = await request(app).get(`${ADMIN_SUBS}/${id}`).set('Authorization', admin.auth);
    expect(one.body.data.status).toBe('withdrawn');

    const summary = await request(app)
      .get(`${ADMIN_SUBS}/summary`)
      .set('Authorization', admin.auth);
    expect(summary.body.data.active).toMatchObject({
      count: 1,
      principal: AMOUNT,
      outstanding: 11_200_000,
    });
    expect(summary.body.data.withdrawn).toMatchObject({ count: 1, outstanding: 0 });
  });

  it('keeps customers out, and lets an auditor read', async () => {
    const auditor = await signIn('auditor');
    for (const path of [ADMIN_SUBS, `${ADMIN_SUBS}/summary`]) {
      expect((await request(app).get(path).set('Authorization', customer.auth)).status).toBe(403);
      expect((await request(app).get(path).set('Authorization', auditor.auth)).status).toBe(200);
    }
  });

  it('cannot delete a plan that has investments', async () => {
    await investOk();
    const res = await request(app).delete(`${PLANS}/${planId}`).set('Authorization', admin.auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_IN_USE');
    await request(app)
      .patch(`${PLANS}/${planId}`)
      .set('Authorization', admin.auth)
      .send({ status: 'archived' })
      .expect(200);
  });

  it('cannot delete a user whose money is in an active investment', async () => {
    await fund(customer.id, AMOUNT);
    const { id } = await investOk();
    expect(await balanceOf(customer.id)).toBe(0);

    const res = await request(app)
      .delete(`/api/v1/users/${customer.id}`)
      .set('Authorization', admin.auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVESTMENTS_ACTIVE');
    expect(await InvestmentSubscriptionModel.exists({ _id: id })).not.toBeNull();
  });

  it('shows investments in the user overview', async () => {
    await investOk();
    const res = await request(app)
      .get(`/api/v1/users/${customer.id}/overview`)
      .set('Authorization', admin.auth);
    expect(res.body.data.investments).toEqual({ active: 1, activePrincipal: AMOUNT });
  });

  it('answers a recheck of an internal entry without asking Paystack', async () => {
    await investOk();
    const [entry] = await ledger(customer.id);
    const res = await request(app)
      .post(`/api/v1/wallet/admin/transactions/${entry?.reference}/recheck`)
      .set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('success');
  });
});

describe('referrals', () => {
  const setRate = (basisPoints: number) =>
    PlatformConfigModel.updateOne(
      { key: 'referral.commission.basis_points' },
      { value: basisPoints },
    );

  const linkReferrer = async () => {
    const referrer = await signIn('editor');
    await ReferralModel.create({
      referrer: referrer.id,
      referee: customer.id,
      codeUsed: 'CODE1234',
      source: 'signup',
    });
    return referrer;
  };

  const longPlan = (months: number) =>
    createPlan({ name: `Plan ${months}`, durationValue: months, payoutFrequency: 'at_maturity' });
  const commissions = () =>
    ReferralCommissionModel.find({ referee: customer.id }).sort('instalment').lean().exec();
  const monthsFromNow = (months: number) =>
    new Date(Date.now() + months * 31 * 24 * 60 * 60 * 1000);
  const COMMISSIONS = '/api/v1/referrals/admin/commissions';

  it('pays the full rate each year of a 36 month investment, with nothing up front', async () => {
    await setRate(600);
    await linkReferrer();
    planId = await longPlan(36);
    const res = await invest({ idempotencyKey: 'referred-key-1' });
    await invest({ idempotencyKey: 'referred-key-1' }).expect(200);

    const parts = await commissions();
    expect(parts).toHaveLength(3);
    // 6% of N100,000 is N6,000, each year.
    expect(parts.map(({ amount }) => amount)).toEqual([600_000, 600_000, 600_000]);
    expect(parts.map(({ status }) => status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(parts.map(({ instalment, instalments }) => [instalment, instalments])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(parts[0]?.investmentReference).toBe(`CCI-I-${res.body.data.id as string}-Y1`);
    const startYear = new Date(res.body.data.startedAt as string).getUTCFullYear();
    expect(parts.map(({ dueAt }) => dueAt?.getUTCFullYear())).toEqual([
      startYear + 1,
      startYear + 2,
      startYear + 3,
    ]);
    expect(parts[2]?.dueAt?.toISOString()).toBe(res.body.data.maturesAt);
  });

  it('leaves the return on the investment as advertised', async () => {
    await linkReferrer();
    await setRate(600);
    planId = await longPlan(24);
    const res = await invest();
    expect(res.body.data.expectedReturn).toBe(2_400_000);
    expect(res.body.data.planSnapshot.roiBasisPoints).toBe(1200);
    expect(await commissions()).toHaveLength(2);
  });

  it('releases each year as it comes due, for staff to approve and pay', async () => {
    await setRate(600);
    const referrer = await linkReferrer();
    planId = await longPlan(36);
    await invest().expect(201);
    const [first] = await commissions();
    const url = `${COMMISSIONS}/${String(first?._id)}`;
    const act = (action: string) =>
      request(app).post(`${url}/${action}`).set('Authorization', admin.auth).send({});

    // Not earned yet, so it can't be approved or paid.
    expect((await act('approve')).status).toBe(409);
    expect((await act('pay')).status).toBe(409);

    await subscriptionService.processDue(monthsFromNow(6));
    expect((await commissions()).map(({ status }) => status)).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
    ]);

    await subscriptionService.processDue(monthsFromNow(13));
    expect((await commissions()).map(({ status }) => status)).toEqual([
      'pending',
      'scheduled',
      'scheduled',
    ]);

    await act('approve').expect(200);
    await act('pay').expect(200);
    expect((await act('pay')).status).toBe(409);
    expect(await balanceOf(referrer.id)).toBe(600_000);

    await subscriptionService.processDue(monthsFromNow(25));
    expect((await commissions()).map(({ status }) => status)).toEqual([
      'paid',
      'pending',
      'scheduled',
    ]);
    expect(await balanceOf(referrer.id)).toBe(600_000);
  });

  it('shows the referrer their schedule', async () => {
    await setRate(600);
    const referrer = await linkReferrer();
    planId = await longPlan(36);
    await invest().expect(201);

    const page = await request(app).get('/api/v1/referrals/me').set('Authorization', referrer.auth);
    expect(page.body.data.earnings).toMatchObject({ scheduled: 1_800_000, pending: 0, paid: 0 });
    const list = await request(app)
      .get('/api/v1/referrals/me/commissions?sort=dueAt')
      .set('Authorization', referrer.auth);
    expect(list.body.data[0]).toMatchObject({ instalment: 1, instalments: 3, status: 'scheduled' });
    expect(list.body.data[0].dueAt).toBeTruthy();
    expect(list.body.data[0]).not.toHaveProperty('investmentAmount');
  });

  it('counts one investment once towards the limit, however many instalments it has', async () => {
    await setRate(600);
    await linkReferrer();
    planId = await longPlan(36);
    await invest().expect(201);
    await invest().expect(201);
    expect(await commissions()).toHaveLength(3);

    await PlatformConfigModel.updateOne(
      { key: 'referral.commission.max_investments' },
      { value: 2 },
    );
    await invest().expect(201);
    expect(await commissions()).toHaveLength(6);
    await invest().expect(201);
    expect(await commissions()).toHaveLength(6);
  });

  it('cancels what has not come due when the investment is withdrawn', async () => {
    await setRate(600);
    await linkReferrer();
    planId = await longPlan(36);
    const { body } = await invest().expect(201);

    const [first] = await commissions();
    await ReferralCommissionModel.updateOne(
      { _id: first?._id },
      { dueAt: new Date(Date.now() - 1000) },
    );
    await withdraw(body.data.id).expect(200);

    expect((await commissions()).map(({ status }) => status)).toEqual([
      'scheduled',
      'cancelled',
      'cancelled',
    ]);
    await subscriptionService.processDue(monthsFromNow(40));
    expect((await commissions()).map(({ status }) => status)).toEqual([
      'pending',
      'cancelled',
      'cancelled',
    ]);
  });

  it('keeps paying instalments after the investment matures', async () => {
    await setRate(600);
    await linkReferrer();
    planId = await longPlan(36);
    await invest().expect(201);
    await subscriptionService.processDue(monthsFromNow(40));
    expect((await commissions()).map(({ status }) => status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('rejects what is scheduled when the referral is rejected', async () => {
    await setRate(600);
    await linkReferrer();
    planId = await longPlan(24);
    await invest().expect(201);
    const referral = await ReferralModel.findOne({ referee: customer.id }).orFail();
    await request(app)
      .patch(`/api/v1/referrals/admin/referrals/${referral.id}`)
      .set('Authorization', admin.auth)
      .send({ status: 'rejected' })
      .expect(200);
    expect((await commissions()).map(({ status }) => status)).toEqual(['rejected', 'rejected']);
  });

  it('pays staff-recorded commissions the old way, with no schedule', async () => {
    await setRate(600);
    await linkReferrer();
    const res = await request(app)
      .post(COMMISSIONS)
      .set('Authorization', admin.auth)
      .send({ referee: customer.id, investmentReference: 'INV-1', investmentAmount: AMOUNT });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'pending', instalments: 1, dueAt: null });
  });

  it('still invests when no commission can be earned', async () => {
    await linkReferrer(); // The rate is still 0.
    await investOk();
    expect(await ReferralCommissionModel.countDocuments()).toBe(0);
    expect(await balanceOf(customer.id)).toBe(90_000_000);
  });

  it('closes the signup referral prompt', async () => {
    await UserModel.updateOne({ _id: customer.id }, { referralPromptPending: true });
    await investOk();
    const user = await UserModel.findById(customer.id).select('referralPromptPending').lean();
    expect(user?.referralPromptPending).toBe(false);
  });
});

describe('investment emails', () => {
  const templates = async () =>
    (
      await EmailLogModel.find({ user: customer.id, category: 'transaction' })
        .sort('createdAt')
        .lean()
    ).map(({ template }) => template);

  beforeEach(() => EmailLogModel.deleteMany({}));

  it('announces an investment once, even if the request is repeated', async () => {
    const key = 'email-replay';
    await invest({ idempotencyKey: key }).expect(201);
    await invest({ idempotencyKey: key });
    expect(await templates()).toEqual(['investment_started']);
  });

  it('reports a payout once, however many runs overlap', async () => {
    const { id } = await investOk();
    await makeDue(id, 1);
    await Promise.all([subscriptionService.processDue(), subscriptionService.processDue()]);
    await subscriptionService.processDue();
    expect(await templates()).toEqual(['investment_started', 'investment_payout']);
  });

  it('reports a withdrawal', async () => {
    planId = await createPlan({ earlyWithdrawalAllowed: true });
    const { id } = await investOk();
    await withdraw(id).expect(200);
    expect(await templates()).toEqual(['investment_started', 'investment_withdrawn']);
  });

  it('leaves the investment standing if the email cannot be queued', async () => {
    const spy = vi.spyOn(EmailLogModel, 'create').mockRejectedValue(new Error('database hiccup'));
    try {
      await invest().expect(201);
    } finally {
      spy.mockRestore();
    }
    expect(await templates()).toEqual([]);
  });
});
