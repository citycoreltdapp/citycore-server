import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { SessionModel } from '@/modules/auth/session.model';
import { InvestmentPlanModel } from '@/modules/investment/investment.model';
import { calculateReturn } from '@/modules/investment/investment.schedule';
import { UserModel } from '@/modules/user/user.model';

const app = createApp();
const API = '/api/v1/investments';
const ADMIN = `${API}/admin/plans`;
const PUBLIC = `${API}/plans`;
const PASSWORD = 'Passw0rd123';
const ID = '507f1f77bcf86cd799439011';
const HOUR = 60 * 60 * 1000;

const signIn = async (role: string) => {
  const email = `${role}@example.com`;
  await UserModel.create({ name: `Test ${role}`, email, password: PASSWORD, role });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return `Bearer ${res.body.data.accessToken as string}`;
};

const plan = {
  name: 'Fixed Income Note',
  description: 'A note paying a fixed return.',
  riskLevel: 'low',
  roiBasisPoints: 1800,
  roiType: 'per_annum',
  payoutFrequency: 'at_maturity',
  durationValue: 6,
  durationUnit: 'months',
  minAmount: 10_000_000,
  thumbnail: 'https://res.cloudinary.com/test-cloud/image/upload/v1/citycore/images/thumb.png',
};

let admin: string;
let customer: string;

const createPlan = async (body: object = {}) => {
  const res = await request(app)
    .post(ADMIN)
    .set('Authorization', admin)
    .send({ ...plan, status: 'open', ...body });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; slug: string };
};

const listSlugs = async (query = '') => {
  const res = await request(app).get(`${PUBLIC}${query}`).set('Authorization', customer);
  expect(res.status).toBe(200);
  return (res.body.data as { slug: string }[]).map(({ slug }) => slug);
};

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([UserModel.init(), SessionModel.init(), InvestmentPlanModel.init()]);
});

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    InvestmentPlanModel.deleteMany({}),
  ]);
  admin = await signIn('admin');
  customer = await signIn('user');
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('managing plans', () => {
  it('creates a draft with every field, ignoring createdBy and durationDays in the body', async () => {
    const res = await request(app)
      .post(ADMIN)
      .set('Authorization', admin)
      .send({
        ...plan,
        summary: 'Short',
        category: 'Fixed income',
        coverImage: 'https://res.cloudinary.com/test-cloud/image/upload/v1/citycore/images/a.png',
        maxAmount: 50_000_000,
        earlyWithdrawalAllowed: true,
        earlyWithdrawalPenaltyBasisPoints: 250,
        features: ['Capital paid at maturity'],
        terms: 'Terms apply.',
        createdBy: ID,
        durationDays: 1,
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      slug: 'fixed-income-note',
      status: 'draft',
      durationDays: 180,
      currency: 'NGN',
      maxAmount: 50_000_000,
      earlyWithdrawalPenaltyBasisPoints: 250,
    });
    expect(res.body.data.createdBy).not.toBe(ID);
  });

  it('reads, updates and deletes a plan', async () => {
    const { id } = await createPlan();

    const read = await request(app).get(`${ADMIN}/${id}`).set('Authorization', admin);
    expect(read.body.data.name).toBe(plan.name);

    const updated = await request(app)
      .patch(`${ADMIN}/${id}`)
      .set('Authorization', admin)
      .send({ roiBasisPoints: 2000, durationValue: 1, durationUnit: 'years' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ roiBasisPoints: 2000, durationDays: 365 });

    expect((await request(app).delete(`${ADMIN}/${id}`).set('Authorization', admin)).status).toBe(
      204,
    );
    expect((await request(app).get(`${ADMIN}/${id}`).set('Authorization', admin)).status).toBe(404);
    expect((await request(app).delete(`${ADMIN}/${id}`).set('Authorization', admin)).status).toBe(
      404,
    );
  });

  it('makes slugs unique, and answers 409 when a chosen slug is taken', async () => {
    expect((await createPlan()).slug).toBe('fixed-income-note');
    const second = await createPlan();
    expect(second.slug).toBe('fixed-income-note-2');
    const res = await request(app)
      .patch(`${ADMIN}/${second.id}`)
      .set('Authorization', admin)
      .send({ slug: 'fixed-income-note' });
    expect(res.status).toBe(409);
  });

  it.each([
    [{ name: undefined }],
    [{ description: undefined }],
    [{ roiBasisPoints: 0 }],
    [{ roiBasisPoints: 15.5 }],
    [{ roiType: 'weekly' }],
    [{ riskLevel: 'none' }],
    [{ durationValue: 0 }],
    [{ durationValue: 51, durationUnit: 'years' }],
    [{ minAmount: 100.5 }],
    [{ maxAmount: 1 }],
    [{ coverImage: 'javascript:alert(1)' }],
    [{ earlyWithdrawalPenaltyBasisPoints: 100 }],
    [{ opensAt: '2030-01-02T00:00:00Z', closesAt: '2030-01-01T00:00:00Z' }],
  ])('rejects %j', async (bad) => {
    const res = await request(app)
      .post(ADMIN)
      .set('Authorization', admin)
      .send({ ...plan, ...bad });
    expect(res.status).toBe(422);
    expect(await InvestmentPlanModel.countDocuments()).toBe(0);
  });

  it('checks an update against the fields it leaves alone', async () => {
    const { id } = await createPlan({ maxAmount: 20_000_000 });
    const res = await request(app)
      .patch(`${ADMIN}/${id}`)
      .set('Authorization', admin)
      .send({ minAmount: 30_000_000 });
    expect(res.status).toBe(422);
    expect((await InvestmentPlanModel.findById(id))?.minAmount).toBe(plan.minAmount);
  });

  it('rejects an empty update', async () => {
    const { id } = await createPlan();
    const res = await request(app).patch(`${ADMIN}/${id}`).set('Authorization', admin).send({});
    expect(res.status).toBe(422);
  });

  it('filters the admin list by status, and shows every status', async () => {
    await createPlan({ name: 'Open plan' });
    await createPlan({ name: 'Draft plan', status: 'draft' });
    const all = await request(app).get(ADMIN).set('Authorization', admin);
    expect(all.body.meta.total).toBe(2);
    const drafts = await request(app).get(`${ADMIN}?status=draft`).set('Authorization', admin);
    expect(drafts.body.data.map((p: { name: string }) => p.name)).toEqual(['Draft plan']);
  });
});

describe('offering details', () => {
  const offering = {
    name: 'Lekki Residences',
    assetType: 'Residential',
    assetSubtype: 'Development',
    location: { area: 'Lekki', state: 'Lagos', country: 'Nigeria' },
    unitPrice: 15_000_000,
    totalUnits: 1000,
    roiBasisPoints: 1600,
    durationValue: 12,
    minAmount: undefined,
  };

  it('shows customers everything on the offering', async () => {
    await createPlan(offering);
    const res = await request(app).get(`${PUBLIC}/lekki-residences`).set('Authorization', customer);
    expect(res.body.data).toMatchObject({
      thumbnail: plan.thumbnail,
      assetType: 'Residential',
      assetSubtype: 'Development',
      location: { area: 'Lekki', state: 'Lagos', country: 'Nigeria' },
      unitPrice: 15_000_000,
      totalUnits: 1000,
      unitsSold: 0,
      unitsAvailable: 1000,
      totalOffering: 15_000_000_000,
      roiBasisPoints: 1600,
      roiType: 'per_annum',
      roiGuaranteed: false,
      minAmount: 15_000_000,
    });
  });

  it('projects the return on a number of units', async () => {
    await createPlan(offering);
    const res = await request(app)
      .get(`${PUBLIC}/lekki-residences/quote?units=2`)
      .set('Authorization', customer);
    // 2 units of N150,000 at 16% for 12 months: N48,000 on N300,000.
    expect(res.body.data).toMatchObject({
      units: 2,
      amount: 30_000_000,
      projectedReturn: 4_800_000,
      projectedTotal: 34_800_000,
      durationValue: 12,
      durationUnit: 'months',
      roiGuaranteed: false,
    });
  });

  it('takes an amount only if it buys whole units, and not more than exist', async () => {
    await createPlan(offering);
    const quote = (query: string) =>
      request(app).get(`${PUBLIC}/lekki-residences/quote?${query}`).set('Authorization', customer);
    expect((await quote('amount=30000000')).body.data.units).toBe(2);
    expect((await quote('amount=30000001')).status).toBe(422);
    expect((await quote('units=2&amount=30000000')).status).toBe(422);
    expect((await quote('')).status).toBe(422);
    expect((await quote('units=1001')).body.code).toBe('INSUFFICIENT_UNITS');
  });

  it('refuses units on a plan with no units', async () => {
    await createPlan();
    const res = await request(app)
      .get(`${PUBLIC}/fixed-income-note/quote?units=1`)
      .set('Authorization', customer);
    expect(res.status).toBe(422);
  });

  it('finds plans by location and asset type', async () => {
    await createPlan(offering);
    await createPlan({ name: 'Elsewhere', assetType: 'Commercial' });
    expect(await listSlugs('?search=Lekki')).toEqual(['lekki-residences']);
    expect(await listSlugs('?assetType=Commercial')).toEqual(['elsewhere']);
  });

  it('needs a thumbnail to open, but not for a draft', async () => {
    const res = await request(app)
      .post(ADMIN)
      .set('Authorization', admin)
      .send({ ...plan, thumbnail: null, status: 'open' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('body.thumbnail');

    const { id } = await createPlan({ thumbnail: null, status: 'draft' });
    const open = await request(app)
      .patch(`${ADMIN}/${id}`)
      .set('Authorization', admin)
      .send({ status: 'open' });
    expect(open.status).toBe(422);
  });

  it.each([
    [{ unitPrice: 15_000_000 }],
    [{ totalUnits: 10 }],
    [{ unitPrice: 15_000_000, totalUnits: 10, minAmount: 20_000_000 }],
    [{ unitPrice: 15_000_000, totalUnits: 10, maxAmount: 20_000_000 }],
    [{ unitPrice: 1.5, totalUnits: 10 }],
    [{ unitPrice: 15_000_000, totalUnits: 0 }],
    [{ thumbnail: 'javascript:alert(1)' }],
    [{ location: { area: 'Lekki' } }],
    [{ minAmount: undefined }],
  ])('rejects %j', async (bad) => {
    const res = await request(app)
      .post(ADMIN)
      .set('Authorization', admin)
      .send({ ...plan, ...bad });
    expect(res.status).toBe(422);
  });

  it('ignores unitsSold in a request', async () => {
    const { id } = await createPlan(offering);
    await request(app)
      .patch(`${ADMIN}/${id}`)
      .set('Authorization', admin)
      .send({ summary: 'x', unitsSold: 999 })
      .expect(200);
    expect((await InvestmentPlanModel.findById(id))?.unitsSold).toBe(0);
  });
});

describe('access', () => {
  it('needs a signed-in user for every route', async () => {
    for (const path of [PUBLIC, `${PUBLIC}/x`, `${PUBLIC}/x/quote`, `${API}/categories`, ADMIN]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it('keeps customers out of the admin routes', async () => {
    const { id } = await createPlan();
    const as = (req: request.Test) => req.set('Authorization', customer);
    expect((await as(request(app).get(ADMIN))).status).toBe(403);
    expect((await as(request(app).post(ADMIN)).send(plan)).status).toBe(403);
    expect((await as(request(app).patch(`${ADMIN}/${id}`)).send({ name: 'Hacked' })).status).toBe(
      403,
    );
    expect((await as(request(app).delete(`${ADMIN}/${id}`))).status).toBe(403);
  });

  it('lets an auditor read but not change plans', async () => {
    const auditor = await signIn('auditor');
    const { id } = await createPlan();
    expect((await request(app).get(ADMIN).set('Authorization', auditor)).status).toBe(200);
    expect(
      (
        await request(app)
          .patch(`${ADMIN}/${id}`)
          .set('Authorization', auditor)
          .send({ summary: 'x' })
      ).status,
    ).toBe(403);
    expect((await request(app).delete(`${ADMIN}/${id}`).set('Authorization', auditor)).status).toBe(
      403,
    );
  });
});

describe('browsing plans', () => {
  it('shows customers only what is available now', async () => {
    const now = Date.now();
    await createPlan({ name: 'Available' });
    await createPlan({ name: 'Draft', status: 'draft' });
    await createPlan({ name: 'Closed', status: 'closed' });
    await createPlan({ name: 'Archived', status: 'archived' });
    await createPlan({ name: 'Not yet', opensAt: new Date(now + HOUR).toISOString() });
    await createPlan({ name: 'Past', closesAt: new Date(now - HOUR).toISOString() });
    await createPlan({
      name: 'In window',
      opensAt: new Date(now - HOUR).toISOString(),
      closesAt: new Date(now + HOUR).toISOString(),
    });

    expect((await listSlugs('?sort=name')).sort()).toEqual(['available', 'in-window']);
    // A search adds its own $or, which mustn't replace the availability check.
    expect(await listSlugs('?search=Not%20yet')).toEqual([]);
    expect(await listSlugs('?search=Available')).toEqual(['available']);

    for (const slug of ['draft', 'closed', 'archived', 'not-yet', 'past']) {
      const res = await request(app).get(`${PUBLIC}/${slug}`).set('Authorization', customer);
      expect(res.status).toBe(404);
    }
  });

  it('shows duration and ROI, but not who created the plan', async () => {
    await createPlan();
    const res = await request(app)
      .get(`${PUBLIC}/fixed-income-note`)
      .set('Authorization', customer);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      roiBasisPoints: 1800,
      roiType: 'per_annum',
      durationValue: 6,
      durationUnit: 'months',
      minAmount: plan.minAmount,
    });
    expect(res.body.data).not.toHaveProperty('createdBy');

    const list = await request(app).get(PUBLIC).set('Authorization', customer);
    expect(list.body.data[0]).toHaveProperty('durationDays', 180);
    expect(list.body.data[0]).not.toHaveProperty('createdBy');
  });

  it('filters, sorts and rejects unknown sort fields', async () => {
    await createPlan({ name: 'Low', riskLevel: 'low', roiBasisPoints: 1000, category: 'Bonds' });
    await createPlan({ name: 'High', riskLevel: 'high', roiBasisPoints: 3000, category: 'Bonds' });
    await createPlan({ name: 'Mid', riskLevel: 'medium', roiBasisPoints: 2000, category: 'Farm' });

    expect(await listSlugs('?riskLevel=high')).toEqual(['high']);
    expect(await listSlugs('?category=Farm')).toEqual(['mid']);
    expect(await listSlugs('?sort=-roiBasisPoints')).toEqual(['high', 'mid', 'low']);
    const bad = await request(app).get(`${PUBLIC}?sort=createdBy`).set('Authorization', customer);
    expect(bad.status).toBe(422);

    const categories = await request(app).get(`${API}/categories`).set('Authorization', customer);
    expect(categories.body.data).toEqual([
      { name: 'Bonds', count: 2 },
      { name: 'Farm', count: 1 },
    ]);
  });
});

describe('projecting a return', () => {
  const quote = (slug: string, amount: number | string) =>
    request(app).get(`${PUBLIC}/${slug}/quote?amount=${amount}`).set('Authorization', customer);

  it('prorates a yearly rate over the duration', async () => {
    await createPlan({ maxAmount: 50_000_000 });
    const res = await quote('fixed-income-note', 10_000_000);
    expect(res.status).toBe(200);
    // 18% a year for half a year is 9%.
    expect(res.body.data).toMatchObject({
      amount: 10_000_000,
      projectedReturn: 900_000,
      projectedTotal: 10_900_000,
      currency: 'NGN',
    });
  });

  it('keeps to the plan limits, and hides plans that are not available', async () => {
    await createPlan({ maxAmount: 50_000_000 });
    await createPlan({ name: 'Hidden', status: 'draft' });
    expect((await quote('fixed-income-note', 9_999_999)).status).toBe(422);
    expect((await quote('fixed-income-note', 50_000_001)).status).toBe(422);
    expect((await quote('fixed-income-note', 'abc')).status).toBe(422);
    expect((await quote('hidden', 10_000_000)).status).toBe(404);
  });

  it('calculates each kind of rate exactly, rounding down', () => {
    const base = { roiBasisPoints: 1200, roiType: 'per_annum' } as const;
    const amount = 100_000_00;
    const per = (durationValue: number, durationUnit: 'days' | 'months' | 'years') =>
      calculateReturn(amount, { ...base, durationValue, durationUnit });

    expect(per(1, 'years')).toBe(1_200_000);
    expect(per(12, 'months')).toBe(1_200_000);
    expect(per(365, 'days')).toBe(1_200_000);
    expect(per(1, 'days')).toBe(3287); // 3287.67
    expect(
      calculateReturn(amount, {
        roiBasisPoints: 1200,
        roiType: 'flat',
        durationValue: 5,
        durationUnit: 'years',
      }),
    ).toBe(1_200_000);
    // The largest amount, rate and duration stay exact.
    const largest = calculateReturn(10_000_000_000_000, {
      roiBasisPoints: 100_000,
      roiType: 'per_annum',
      durationValue: 50,
      durationUnit: 'years',
    });
    expect(largest).toBe(5_000_000_000_000_000);
    expect(Number.isSafeInteger(largest + 10_000_000_000_000)).toBe(true);
  });
});
