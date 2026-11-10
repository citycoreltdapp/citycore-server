import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { env } from '@/config/env';
import { SessionModel } from '@/modules/auth/session.model';
import { DEFAULT_WALLET_SETTINGS as SETTINGS } from '@/modules/platformConfig/platformConfig.managed';
import { PlatformConfigModel } from '@/modules/platformConfig/platformConfig.model';
import { platformConfigService } from '@/modules/platformConfig/platformConfig.service';
import { UserModel } from '@/modules/user/user.model';
import { calculateCheckoutFee, quoteFunding } from '@/modules/wallet/wallet.fees';
import { WalletModel } from '@/modules/wallet/wallet.model';
import { walletService } from '@/modules/wallet/wallet.service';
import { WalletTransactionModel } from '@/modules/wallet/walletTransaction.model';
import { EmailLogModel } from '@/modules/email/email.model';
import { decrypt } from '@/utils/encryption';
import { FakePaystack } from './fakePaystack';

const API = '/api/v1/wallet';
const WEBHOOK = '/webhooks/paystack';
const AMOUNT = 500_000;
/** What the customer pays for AMOUNT to reach their wallet. */
const CHARGED = 517_767;

const app = createApp();
const paystack = new FakePaystack();

const signUpWithoutKyc = async (email = 'ada@example.com') => {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Ada Lovelace', email, password: 'Passw0rd123' });
  return {
    id: res.body.data.user.id as string,
    auth: `Bearer ${res.body.data.accessToken as string}`,
  };
};

const setKyc = (id: string, kycCompleted: boolean) =>
  UserModel.updateOne({ _id: id }, { kycCompleted });

/** A customer who has passed KYC, which funding requires. */
const signUp = async (email?: string) => {
  const user = await signUpWithoutKyc(email);
  await setKyc(user.id, true);
  return user;
};

const signUpAdmin = async () => {
  await UserModel.create({
    name: 'Admin User',
    email: 'admin@example.com',
    password: 'Passw0rd123',
    role: 'admin',
  });
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'admin@example.com', password: 'Passw0rd123' });
  return `Bearer ${res.body.data.accessToken as string}`;
};

const startFunding = async (auth: string, amount = AMOUNT) => {
  const res = await request(app).post(`${API}/fund`).set('Authorization', auth).send({ amount });
  expect(res.status).toBe(201);
  return res.body.data.reference as string;
};

/** Signs the way Paystack does: an HMAC of `t.` plus the raw body, with the signing secret. */
const signedHeader = (
  raw: string,
  t = Math.floor(Date.now() / 1000),
  secret = 'whsec_fake_secret',
) => `t=${t},v1=whk_key1:${createHmac('sha512', secret).update(`${t}.`).update(raw).digest('hex')}`;

const postEvent = (event: unknown, header?: string) => {
  const raw = JSON.stringify(event);
  return request(app)
    .post(WEBHOOK)
    .set('Content-Type', 'application/json')
    .set('Paystack-Signature', header ?? signedHeader(raw))
    .send(raw);
};

const chargeSuccess = (reference: string) => ({ event: 'charge.success', data: { reference } });

const balanceOf = async (auth: string) =>
  (await request(app).get(API).set('Authorization', auth)).body.data.balance as number;

beforeAll(async () => {
  await paystack.start(4598);
  await connectDatabase();
  await Promise.all([
    UserModel.init(),
    SessionModel.init(),
    WalletModel.init(),
    WalletTransactionModel.init(),
  ]);
});

beforeEach(async () => {
  paystack.reset();
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    WalletModel.deleteMany({}),
    WalletTransactionModel.deleteMany({}),
    PlatformConfigModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await disconnectDatabase();
  await paystack.stop();
});

describe('KYC requirement', () => {
  const virtualAccount = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+2348100000000',
    consent: true,
  };

  it('stops funding without KYC, telling the frontend why, and without calling Paystack', async () => {
    const { auth } = await signUpWithoutKyc();

    const fund = await request(app)
      .post(`${API}/fund`)
      .set('Authorization', auth)
      .send({ amount: AMOUNT });
    expect(fund.status).toBe(403);
    expect(fund.body.code).toBe('KYC_REQUIRED');

    const account = await request(app)
      .post(`${API}/virtual-account`)
      .set('Authorization', auth)
      .send(virtualAccount);
    expect(account.status).toBe(403);
    expect(account.body.code).toBe('KYC_REQUIRED');

    expect(paystack.requests).toHaveLength(0);
    expect(await WalletTransactionModel.countDocuments()).toBe(0);
  });

  it('allows funding as soon as KYC completes, and stops it as soon as it is withdrawn', async () => {
    const { id, auth } = await signUpWithoutKyc();
    const fund = () =>
      request(app).post(`${API}/fund`).set('Authorization', auth).send({ amount: AMOUNT });

    await fund().expect(403);
    await setKyc(id, true);
    await fund().expect(201);
    await setKyc(id, false);
    await fund().expect(403);
  });

  it('leaves the dashboard open without KYC', async () => {
    const { auth } = await signUpWithoutKyc();
    await request(app).get(API).set('Authorization', auth).expect(200);
    await request(app).get(`${API}/transactions`).set('Authorization', auth).expect(200);
    await request(app)
      .get(`${API}/fund/quote`)
      .query({ amount: AMOUNT })
      .set('Authorization', auth)
      .expect(200);
    await request(app).get('/api/v1/investments/plans').set('Authorization', auth).expect(200);
  });

  it('still credits a payment already made if KYC is withdrawn before it settles', async () => {
    const { id, auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    await setKyc(id, false);

    await request(app)
      .post(`${API}/fund/${reference}/verify`)
      .set('Authorization', auth)
      .expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it('still credits a transfer to an existing virtual account if KYC is withdrawn', async () => {
    const { id, auth } = await signUp();
    await request(app)
      .post(`${API}/virtual-account`)
      .set('Authorization', auth)
      .send(virtualAccount)
      .expect(202);
    await postEvent({
      event: 'dedicatedaccount.assign.success',
      data: {
        customer: { email: 'ada@example.com', customer_code: 'CUS_ada' },
        dedicated_account: { account_number: '9930000902', bank: { slug: 'test-bank' } },
      },
    }).expect(200);
    await setKyc(id, false);

    paystack.setTransaction('T_after', {
      status: 'success',
      amount: 100_000,
      channel: 'dedicated_nuban',
      customer: { customer_code: 'CUS_ada' },
    });
    await postEvent(chargeSuccess('T_after')).expect(200);
    expect(await balanceOf(auth)).toBe(99_850);

    // They can still ask Paystack to look for a transfer they've made.
    await request(app)
      .post(`${API}/virtual-account/requery`)
      .set('Authorization', auth)
      .expect(202);
  });
});

describe('customer-paid fees', () => {
  // Worked out by hand from Paystack's pricing: 1.5% + 100 naira, the 100 naira waived under
  // 2,500 naira, and capped at 2,000 naira.
  it.each([
    ['under the waiver, so percentage only', 200_000, 203_046],
    ['just under the waiver', 245_000, 248_731],
    ['pushed over the waiver by its own fee', 246_500, 260_407],
    ['percentage and flat fee', AMOUNT, CHARGED],
    ['at the cap', 50_000_000, 50_200_000],
  ])('charges the right total when %s', (_name, amount, total) => {
    expect(quoteFunding(amount, SETTINGS)).toEqual({ amount, fee: total - amount, total });
  });

  it('always leaves at least the amount requested, and at most a kobo or two over', () => {
    for (let amount = 10_000; amount < 16_000_000; amount += 7_919) {
      const { total } = quoteFunding(amount, SETTINGS);
      const left = total - calculateCheckoutFee(total, SETTINGS);
      expect(left).toBeGreaterThanOrEqual(amount);
      expect(left - amount).toBeLessThanOrEqual(2);
    }
  });

  it('quotes through the API without creating anything', async () => {
    const { auth } = await signUp();
    const res = await request(app)
      .get(`${API}/fund/quote`)
      .query({ amount: AMOUNT })
      .set('Authorization', auth);
    expect(res.body.data).toEqual({ amount: AMOUNT, fee: CHARGED - AMOUNT, total: CHARGED });
    expect(paystack.requests).toHaveLength(0);
    expect(await WalletTransactionModel.countDocuments()).toBe(0);

    await request(app)
      .get(`${API}/fund/quote`)
      .query({ amount: 1 })
      .set('Authorization', auth)
      .expect(422);
  });

  it('returns the fee and total when starting, and credits only the amount requested', async () => {
    const { auth } = await signUp();
    const start = await request(app)
      .post(`${API}/fund`)
      .set('Authorization', auth)
      .send({ amount: AMOUNT });
    const { reference, fee, total } = start.body.data;
    expect({ fee, total }).toEqual({ fee: CHARGED - AMOUNT, total: CHARGED });

    paystack.setTransaction(reference, {
      status: 'success',
      amount: CHARGED,
      fees: CHARGED - AMOUNT,
    });
    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it('flags a payment that skipped the fee', async () => {
    const { auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: AMOUNT });
    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(0);
    expect(await WalletTransactionModel.findOne({ reference })).toMatchObject({
      status: 'flagged',
    });
  });

  it('credits the requested amount when a foreign card costs more than the customer paid', async () => {
    const { auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED, fees: 30_193 });
    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
    expect(await WalletTransactionModel.findOne({ reference })).toMatchObject({
      customerFee: CHARGED - AMOUNT,
      fees: 30_193,
    });
  });
});

describe('starting a payment', () => {
  it('initialises with Paystack and returns the checkout page, without crediting', async () => {
    const { id, auth } = await signUp();
    const res = await request(app)
      .post(`${API}/fund`)
      .set('Authorization', auth)
      .send({ amount: AMOUNT, channels: ['card'], reference: 'CHOSEN-BY-CLIENT', email: 'x@y.co' });

    expect(res.status).toBe(201);
    const { reference, authorizationUrl } = res.body.data;
    expect(reference).toMatch(/^CCF-/);
    expect(authorizationUrl).toContain('checkout.paystack.com');

    const [call] = paystack.callsTo('/transaction/initialize');
    expect(call?.authorization).toBe('Bearer sk_test_fake_secret');
    expect(call?.body).toMatchObject({
      email: 'ada@example.com',
      amount: CHARGED,
      reference,
      currency: 'NGN',
      channels: ['card'],
      callback_url: env.PAYSTACK_CALLBACK_URL,
    });
    expect((call?.body.metadata as Record<string, string>).userId).toBe(id);

    expect(await balanceOf(auth)).toBe(0);
    expect(await WalletTransactionModel.findOne({ reference })).toMatchObject({
      status: 'pending',
      amount: AMOUNT,
      chargedAmount: CHARGED,
      customerFee: CHARGED - AMOUNT,
    });
  });

  it.each([
    ['below the minimum', env.WALLET_MIN_FUNDING_KOBO - 1],
    ['above the maximum', env.WALLET_MAX_FUNDING_KOBO + 1],
    ['a fraction of a kobo', 10000.5],
    ['negative', -500],
    ['a string', '50000'],
  ])('rejects an amount that is %s', async (_name, amount) => {
    const { auth } = await signUp();
    await request(app).post(`${API}/fund`).set('Authorization', auth).send({ amount }).expect(422);
    expect(paystack.requests).toHaveLength(0);
  });

  it('records a failure when Paystack is down', async () => {
    const { auth } = await signUp();
    paystack.outage = { status: 500, body: { status: false, message: 'boom' } };
    const res = await request(app)
      .post(`${API}/fund`)
      .set('Authorization', auth)
      .send({ amount: AMOUNT });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PAYSTACK_UNAVAILABLE');
    expect(await WalletTransactionModel.findOne({})).toMatchObject({ status: 'failed' });
  });

  it('does not treat a bad Paystack key as the user being signed out', async () => {
    const { auth } = await signUp();
    paystack.outage = { status: 401, body: { status: false, message: 'Invalid key' } };
    const res = await request(app)
      .post(`${API}/fund`)
      .set('Authorization', auth)
      .send({ amount: AMOUNT });
    expect(res.status).toBe(502);
  });

  it('requires a signed-in user', async () => {
    await request(app).post(`${API}/fund`).send({ amount: AMOUNT }).expect(401);
  });
});

describe('webhook authenticity', () => {
  const setup = async () => {
    const { auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    return { auth, reference, event: chargeSuccess(reference) };
  };

  it('accepts a valid signature and credits the wallet', async () => {
    const { auth, event } = await setup();
    await postEvent(event).expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it('accepts a matching signature among several, as during a secret rotation', async () => {
    const { auth, event } = await setup();
    const raw = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const stale = `v1=whk_old:${'0'.repeat(128)}`;
    const good = signedHeader(raw, t).split(',')[1] as string;
    await postEvent(event, `t=${t},${stale},${good}`).expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it('accepts the older x-paystack-signature header', async () => {
    const { auth, event } = await setup();
    const raw = JSON.stringify(event);
    await request(app)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set(
        'x-paystack-signature',
        createHmac('sha512', 'sk_test_fake_secret').update(raw).digest('hex'),
      )
      .send(raw)
      .expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it.each([
    ['the wrong secret', (raw: string) => signedHeader(raw, undefined, 'whsec_wrong')],
    ['an old timestamp', (raw: string) => signedHeader(raw, Math.floor(Date.now() / 1000) - 301)],
    ['a future timestamp', (raw: string) => signedHeader(raw, Math.floor(Date.now() / 1000) + 301)],
    ['a tampered body', (raw: string) => signedHeader(`${raw} `)],
    ['a malformed header', () => 't=abc,v1=nope'],
    ['a signature of the wrong length', () => `t=${Math.floor(Date.now() / 1000)},v1=k:abcd`],
  ])('rejects an event signed with %s', async (_name, sign) => {
    const { auth, event } = await setup();
    const res = await postEvent(event, sign(JSON.stringify(event)));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
    expect(await balanceOf(auth)).toBe(0);
  });

  it('rejects an event with no signature', async () => {
    const { auth, event } = await setup();
    await request(app)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(401);
    expect(await balanceOf(auth)).toBe(0);
  });

  it('still needs Paystack to confirm a validly signed event', async () => {
    const { auth, reference, event } = await setup();
    paystack.setTransaction(reference, { status: 'failed', amount: CHARGED });
    await postEvent(event).expect(200);
    expect(await balanceOf(auth)).toBe(0);
    expect(await WalletTransactionModel.findOne({ reference })).toMatchObject({ status: 'failed' });
  });

  it('returns an error if Paystack cannot confirm, so the event is sent again', async () => {
    const { auth, reference, event } = await setup();
    paystack.outage = { status: 500, body: {} };
    await postEvent(event).expect(502);
    expect(await balanceOf(auth)).toBe(0);

    paystack.outage = undefined;
    await postEvent(event).expect(200);
    expect(await WalletTransactionModel.findOne({ reference })).toMatchObject({
      status: 'success',
    });
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it('acknowledges events it does not use, and unknown references', async () => {
    await postEvent({ event: 'transfer.success', data: {} }).expect(200);
    paystack.setTransaction('OTHER', { status: 'success', amount: 100 });
    await postEvent(chargeSuccess('OTHER')).expect(200);
    await postEvent(chargeSuccess('MISSING')).expect(200);
    expect(await WalletTransactionModel.countDocuments()).toBe(0);
  });
});

describe('crediting', () => {
  const paid = async (amount = CHARGED) => {
    const user = await signUp();
    const reference = await startFunding(user.auth);
    paystack.setTransaction(reference, { status: 'success', amount });
    return { ...user, reference };
  };

  it('credits once for repeated webhooks', async () => {
    const { auth, reference } = await paid();
    for (let i = 0; i < 3; i += 1) await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it('credits once when webhooks and the callback arrive at the same moment', async () => {
    const { auth, reference } = await paid();
    await Promise.all([
      ...Array.from({ length: 8 }, () => postEvent(chargeSuccess(reference))),
      ...Array.from({ length: 4 }, () =>
        request(app).post(`${API}/fund/${reference}/verify`).set('Authorization', auth),
      ),
    ]);
    expect(await balanceOf(auth)).toBe(AMOUNT);
    expect(await WalletTransactionModel.countDocuments({ reference, status: 'success' })).toBe(1);
  });

  it('adds up concurrent different payments correctly', async () => {
    const { auth } = await signUp();
    const references = await Promise.all(Array.from({ length: 6 }, () => startFunding(auth)));
    for (const reference of references) {
      paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    }
    await Promise.all(references.map((reference) => postEvent(chargeSuccess(reference))));
    expect(await balanceOf(auth)).toBe(AMOUNT * 6);
  });

  it('records the ledger details, ending with the balance after each entry', async () => {
    const { auth, reference } = await paid();
    await postEvent(chargeSuccess(reference)).expect(200);

    const second = await startFunding(auth, 100_000);
    paystack.setTransaction(second, {
      status: 'success',
      amount: quoteFunding(100_000, SETTINGS).total,
    });
    await postEvent(chargeSuccess(second)).expect(200);

    const list = await request(app)
      .get(`${API}/transactions`)
      .query({ sort: '-amount' })
      .set('Authorization', auth);
    expect(list.body.data.map((t: { balanceAfter: number }) => t.balanceAfter)).toEqual([
      AMOUNT,
      AMOUNT + 100_000,
    ]);
    expect(list.body.data[0]).toMatchObject({
      status: 'success',
      channel: 'card',
      fees: 150,
      providerTransactionId: 1001,
    });
  });

  it('flags a payment for the wrong amount rather than crediting it', async () => {
    const { auth, reference } = await paid(100);
    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(0);
    const transaction = await WalletTransactionModel.findOne({ reference });
    expect(transaction?.status).toBe('flagged');
    expect(transaction?.reviewNote).toContain(`Expected ${CHARGED} kobo but 100`);

    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(0);
  });

  it('flags a payment in the wrong currency', async () => {
    const { auth, reference } = await paid();
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED, currency: 'USD' });
    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(0);
    expect(await WalletTransactionModel.findOne({ reference })).toMatchObject({
      status: 'flagged',
    });
  });

  it('still credits a payment that succeeds after being marked failed', async () => {
    const { auth, reference } = await paid();
    paystack.setTransaction(reference, { status: 'failed', amount: CHARGED });
    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(0);

    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it('notes a reversal of a credited payment, without silently changing the balance', async () => {
    const { auth, reference } = await paid();
    await postEvent(chargeSuccess(reference)).expect(200);

    paystack.setTransaction(reference, { status: 'reversed', amount: CHARGED });
    await request(app)
      .post(`${API}/fund/${reference}/verify`)
      .set('Authorization', auth)
      .expect(200);

    expect(await balanceOf(auth)).toBe(AMOUNT);
    const transaction = await WalletTransactionModel.findOne({ reference });
    expect(transaction?.status).toBe('success');
    expect(transaction?.reviewNote).toContain('reversed');
  });
});

describe('the verify callback', () => {
  it('settles the payment for its owner', async () => {
    const { auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });

    const res = await request(app)
      .post(`${API}/fund/${reference}/verify`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('success');
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it("hides another user's payment", async () => {
    const { auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    const other = await signUp('other@example.com');

    await request(app)
      .post(`${API}/fund/${reference}/verify`)
      .set('Authorization', other.auth)
      .expect(404);
    await request(app)
      .get(`${API}/transactions/${reference}`)
      .set('Authorization', other.auth)
      .expect(404);
    const list = await request(app).get(`${API}/transactions`).set('Authorization', other.auth);
    expect(list.body.data).toEqual([]);
  });

  it('leaves an unfinished payment pending', async () => {
    const { auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'abandoned', amount: CHARGED });
    const res = await request(app)
      .post(`${API}/fund/${reference}/verify`)
      .set('Authorization', auth);
    expect(res.body.data.status).toBe('pending');
  });

  it('rejects a malformed reference', async () => {
    const { auth } = await signUp();
    await request(app).post(`${API}/fund/bad%20ref/verify`).set('Authorization', auth).expect(422);
  });
});

describe('reconciliation', () => {
  const age = (reference: string, ms: number) =>
    WalletTransactionModel.collection.updateOne(
      { reference },
      { $set: { createdAt: new Date(Date.now() - ms) } },
    );

  it('credits a payment whose webhook never arrived', async () => {
    const { auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    await age(reference, 11 * 60 * 1000);

    expect(await walletService.reconcilePending()).toBe(1);
    expect(await balanceOf(auth)).toBe(AMOUNT);
  });

  it('leaves recent payments alone, as the customer may still be paying', async () => {
    const { auth } = await signUp();
    await startFunding(auth);
    expect(await walletService.reconcilePending()).toBe(0);
  });

  it('marks a long-unfinished payment abandoned, and keeps going after an error', async () => {
    const { auth } = await signUp();
    const old = await startFunding(auth);
    const missing = await startFunding(auth);
    paystack.setTransaction(old, { status: 'abandoned', amount: CHARGED });
    await age(old, 25 * 60 * 60 * 1000);
    await age(missing, 11 * 60 * 1000);

    await walletService.reconcilePending();
    expect(await WalletTransactionModel.findOne({ reference: old })).toMatchObject({
      status: 'abandoned',
    });
    expect(await WalletTransactionModel.findOne({ reference: missing })).toMatchObject({
      status: 'pending',
    });
  });
});

describe('virtual accounts', () => {
  const details = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+2348100000000',
    bvn: '20012345678',
    accountNumber: '0123456789',
    bankCode: '007',
    consent: true,
  };

  const account = {
    bank: { name: 'Test Bank', id: 24, slug: 'test-bank' },
    account_name: 'CITY CORE/ADA LOVELACE',
    account_number: '9930000902',
  };

  const activate = async () => {
    const user = await signUp();
    await request(app)
      .post(`${API}/virtual-account`)
      .set('Authorization', user.auth)
      .send(details)
      .expect(202);
    await postEvent({
      event: 'dedicatedaccount.assign.success',
      data: {
        customer: { email: 'ada@example.com', customer_code: 'CUS_ada' },
        dedicated_account: account,
      },
    }).expect(200);
    return user;
  };

  const transferEvent = (reference: string, amount: number, customerCode = 'CUS_ada') => {
    paystack.setTransaction(reference, {
      status: 'success',
      amount,
      channel: 'dedicated_nuban',
      customer: { customer_code: customerCode },
      authorization: { channel: 'dedicated_nuban', receiver_bank_account_number: '0000' },
    });
    return chargeSuccess(reference);
  };

  it('sends the assignment and stays pending until Paystack confirms', async () => {
    const { auth } = await signUp();
    const res = await request(app)
      .post(`${API}/virtual-account`)
      .set('Authorization', auth)
      .send(details);

    expect(res.status).toBe(202);
    expect(res.body.data.virtualAccountStatus).toBe('pending');
    expect(paystack.callsTo('/dedicated_account/assign')[0]?.body).toEqual({
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone: '+2348100000000',
      bvn: '20012345678',
      account_number: '0123456789',
      bank_code: '007',
      country: 'NG',
      preferred_bank: 'test-bank',
    });
  });

  it('never stores the BVN', async () => {
    const { auth } = await signUp();
    await request(app).post(`${API}/virtual-account`).set('Authorization', auth).send(details);
    const stored = await WalletModel.collection.findOne({});
    expect(JSON.stringify(stored)).not.toContain('20012345678');
  });

  it('requires consent, and bank details all together', async () => {
    const { auth } = await signUp();
    const post = (body: object) =>
      request(app).post(`${API}/virtual-account`).set('Authorization', auth).send(body);

    await post({ ...details, consent: false }).expect(422);
    await post({ ...details, bvn: undefined }).expect(422);
    expect(paystack.requests).toHaveLength(0);
  });

  it('saves the account when Paystack assigns it, hiding internal fields', async () => {
    const { auth } = await activate();
    const res = await request(app).get(API).set('Authorization', auth);
    expect(res.body.data).toMatchObject({
      virtualAccountStatus: 'active',
      virtualAccount: { bankName: 'Test Bank', accountNumber: '9930000902' },
    });
    expect(res.body.data).not.toHaveProperty('paystackCustomerCode');
    expect(res.body.data).not.toHaveProperty('virtualAccountEmail');
  });

  it('stops a second request, and records a failure so the user can try again', async () => {
    const { auth } = await signUp();
    const post = () =>
      request(app).post(`${API}/virtual-account`).set('Authorization', auth).send(details);

    await post().expect(202);
    await post().expect(409);

    await postEvent({
      event: 'customeridentification.failed',
      data: { email: 'ada@example.com', reason: 'Account number or BVN is incorrect' },
    }).expect(200);
    const failed = await request(app).get(API).set('Authorization', auth);
    expect(failed.body.data).toMatchObject({
      virtualAccountStatus: 'failed',
      virtualAccountError: 'Account number or BVN is incorrect',
    });

    await post().expect(202);
  });

  it('credits a transfer once, whatever amount it is, with no record beforehand', async () => {
    const { auth } = await activate();
    const event = transferEvent('T_transfer1', 275_000);
    await postEvent(event).expect(200);
    await postEvent(event).expect(200);

    expect(await balanceOf(auth)).toBe(274_850);
    const [transaction] = (await request(app).get(`${API}/transactions`).set('Authorization', auth))
      .body.data;
    expect(transaction).toMatchObject({
      reference: 'T_transfer1',
      status: 'success',
      channel: 'dedicated_nuban',
      amount: 274_850,
      chargedAmount: 275_000,
      customerFee: 150,
      balanceAfter: 274_850,
    });
  });

  it('credits a burst of the same transfer only once', async () => {
    const { auth } = await activate();
    const event = transferEvent('T_burst', 100_000);
    await Promise.all(Array.from({ length: 8 }, () => postEvent(event)));
    expect(await balanceOf(auth)).toBe(99_850);
    expect(await WalletTransactionModel.countDocuments({ reference: 'T_burst' })).toBe(1);
  });

  it('calculates the fee, 1% capped at 300 naira, if Paystack leaves it out', async () => {
    const { auth } = await activate();
    const send = (reference: string, amount: number) => {
      paystack.setTransaction(reference, {
        status: 'success',
        amount,
        fees: null,
        channel: 'dedicated_nuban',
        customer: { customer_code: 'CUS_ada' },
      });
      return postEvent(chargeSuccess(reference)).expect(200);
    };

    await send('T_small', 100_000);
    expect(await balanceOf(auth)).toBe(99_000);

    await send('T_large', 10_000_000);
    expect(await balanceOf(auth)).toBe(99_000 + 9_970_000);
  });

  it('flags a transfer too small to cover its fee, rather than crediting nothing', async () => {
    const { auth } = await activate();
    paystack.setTransaction('T_tiny', {
      status: 'success',
      amount: 100,
      fees: 100,
      channel: 'dedicated_nuban',
      customer: { customer_code: 'CUS_ada' },
    });
    await postEvent(chargeSuccess('T_tiny')).expect(200);
    expect(await balanceOf(auth)).toBe(0);
    expect(await WalletTransactionModel.findOne({ reference: 'T_tiny' })).toMatchObject({
      status: 'flagged',
      amount: 100,
      customerFee: 0,
    });
  });

  it('matches by account number too', async () => {
    const { auth } = await activate();
    paystack.setTransaction('T_acct', {
      status: 'success',
      amount: 50_000,
      channel: 'dedicated_nuban',
      authorization: { receiver_bank_account_number: '9930000902' },
    });
    await postEvent(chargeSuccess('T_acct')).expect(200);
    expect(await balanceOf(auth)).toBe(49_850);
  });

  it('keeps a transfer it cannot match as flagged, so the money is not lost', async () => {
    await postEvent(transferEvent('T_orphan', 90_000, 'CUS_unknown')).expect(200);
    expect(await WalletTransactionModel.findOne({ reference: 'T_orphan' })).toMatchObject({
      status: 'flagged',
      user: null,
      amount: 90_000,
    });
  });

  it('asks Paystack to re-check the account', async () => {
    const { auth } = await activate();
    await request(app)
      .post(`${API}/virtual-account/requery`)
      .set('Authorization', auth)
      .expect(202);
    expect(paystack.callsTo('/dedicated_account/requery')[0]?.path).toContain(
      'account_number=9930000902&provider_slug=test-bank',
    );
  });
});

describe('admin', () => {
  it('keeps admin routes from ordinary users', async () => {
    const { auth } = await signUp();
    await request(app).get(`${API}/admin/transactions`).set('Authorization', auth).expect(403);
  });

  it('lists flagged payments and can re-check one', async () => {
    const admin = await signUpAdmin();
    const { auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: 1 });
    await postEvent(chargeSuccess(reference)).expect(200);

    const flagged = await request(app)
      .get(`${API}/admin/transactions`)
      .query({ status: 'flagged' })
      .set('Authorization', admin);
    expect(flagged.body.meta.total).toBe(1);

    const recheck = await request(app)
      .post(`${API}/admin/transactions/${reference}/recheck`)
      .set('Authorization', admin);
    expect(recheck.status).toBe(200);
    expect(recheck.body.data.status).toBe('flagged');
    expect(await balanceOf(auth)).toBe(0);
  });

  it('reports status without exposing keys', async () => {
    const admin = await signUpAdmin();
    const res = await request(app).get(`${API}/admin/status`).set('Authorization', admin);
    expect(res.body.data).toMatchObject({ enabled: true, mode: 'test', signedWebhooks: true });
    expect(JSON.stringify(res.body)).not.toContain('sk_test');
  });

  it('will not delete a user who still has money', async () => {
    const admin = await signUpAdmin();
    const { id, auth } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    await postEvent(chargeSuccess(reference)).expect(200);

    const res = await request(app).delete(`/api/v1/users/${id}`).set('Authorization', admin);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WALLET_NOT_EMPTY');
  });
});

describe('limits and fees from platform config', () => {
  const setConfig = async (auth: string, key: string, value: number) =>
    request(app)
      .patch(`/api/v1/platform-config/admin/${key}`)
      .set('Authorization', auth)
      .send({ value })
      .expect(200);

  const quote = (auth: string, amount: number) =>
    request(app).get(`${API}/fund/quote`).query({ amount }).set('Authorization', auth);

  beforeEach(async () => {
    await platformConfigService.seedManagedConfigs();
  });

  it('applies a new fee straight away, to quotes and to new payments', async () => {
    const admin = await signUpAdmin();
    const { auth } = await signUp();
    expect((await quote(auth, AMOUNT)).body.data.total).toBe(CHARGED);

    await setConfig(admin, 'wallet.fees.checkout.flat_kobo', 0);
    await setConfig(admin, 'wallet.fees.checkout.basis_points', 200);

    // 500,000 / 0.98, rounded up, so 2% of it leaves exactly the amount requested.
    const expected = { amount: AMOUNT, fee: 10_205, total: 510_205 };
    expect((await quote(auth, AMOUNT)).body.data).toEqual(expected);

    const start = await request(app)
      .post(`${API}/fund`)
      .set('Authorization', auth)
      .send({ amount: AMOUNT })
      .expect(201);
    expect(start.body.data).toMatchObject(expected);
    expect(
      await WalletTransactionModel.findOne({ reference: start.body.data.reference }).lean(),
    ).toMatchObject({ amount: AMOUNT, chargedAmount: 510_205, customerFee: 10_205 });
  });

  it('applies new limits straight away', async () => {
    const admin = await signUpAdmin();
    const { auth } = await signUp();
    const fund = (amount: number) =>
      request(app).post(`${API}/fund`).set('Authorization', auth).send({ amount });

    await setConfig(admin, 'wallet.funding.min_kobo', 100_000);
    await setConfig(admin, 'wallet.funding.max_kobo', 200_000);

    for (const amount of [99_999, 200_001]) {
      const res = await quote(auth, amount);
      expect(res.status).toBe(422);
      expect(res.body.errors[0].path).toBe('query.amount');
      const started = await fund(amount);
      expect(started.status).toBe(422);
      expect(started.body.errors[0].path).toBe('body.amount');
    }
    expect(paystack.requests).toHaveLength(0);

    expect((await quote(auth, 100_000)).status).toBe(200);
    expect((await fund(200_000)).status).toBe(201);
  });

  it('settles a payment already under way at the fee it was started with', async () => {
    const admin = await signUpAdmin();
    const { auth } = await signUp();
    const reference = await startFunding(auth);

    await setConfig(admin, 'wallet.fees.checkout.basis_points', 500);

    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    await postEvent(chargeSuccess(reference)).expect(200);
    expect(await balanceOf(auth)).toBe(AMOUNT);
    expect(await WalletTransactionModel.findOne({ reference }).lean()).toMatchObject({
      status: 'success',
      customerFee: CHARGED - AMOUNT,
    });
  });

  it('uses the stored transfer fee if Paystack leaves its figure out', async () => {
    const admin = await signUpAdmin();
    const { auth } = await signUp();
    await walletService.getOrCreateForUser(
      (await UserModel.findOne({ email: 'ada@example.com' }).orFail()).id as string,
    );
    await WalletModel.updateOne({}, { paystackCustomerCode: 'CUS_ada' });

    await setConfig(admin, 'wallet.fees.transfer.basis_points', 200);

    paystack.setTransaction('T_new_rate', {
      status: 'success',
      amount: 100_000,
      fees: null,
      channel: 'dedicated_nuban',
      customer: { customer_code: 'CUS_ada' },
    });
    await postEvent(chargeSuccess('T_new_rate')).expect(200);
    expect(await balanceOf(auth)).toBe(98_000);
  });
});

describe('the funding email', () => {
  it('goes out once when money is credited, not on each settlement that finds it done', async () => {
    const { auth, id } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED });
    const verify = () =>
      request(app).post(`${API}/fund/${reference}/verify`).set('Authorization', auth).expect(200);

    await verify();
    await verify();

    const emails = await EmailLogModel.find({ user: id, template: 'wallet_funded' })
      .select('+content')
      .lean();
    expect(emails).toHaveLength(1);
    expect(emails[0]?.sensitive).toBe(true);
    expect(emails[0]?.content).not.toContain(reference);
    const { text } = JSON.parse(decrypt(emails[0]?.content as string)) as { text: string };
    expect(text).toContain(reference);
  });

  it('stays quiet when a payment is flagged rather than credited', async () => {
    const { auth, id } = await signUp();
    const reference = await startFunding(auth);
    paystack.setTransaction(reference, { status: 'success', amount: CHARGED + 1 });
    await request(app).post(`${API}/fund/${reference}/verify`).set('Authorization', auth);
    expect(await EmailLogModel.countDocuments({ user: id, template: 'wallet_funded' })).toBe(0);
  });
});
