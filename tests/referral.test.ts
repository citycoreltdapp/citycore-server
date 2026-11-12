import { generateKeyPairSync } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import { signupBody } from './signup';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { googleApi } from '@/integrations/google/google.client';
import { EmailLogModel } from '@/modules/email/email.model';
import { SessionModel } from '@/modules/auth/session.model';
import { InvestmentPlanModel } from '@/modules/investment/investment.model';
import { PlatformConfigModel } from '@/modules/platformConfig/platformConfig.model';
import { platformConfigService } from '@/modules/platformConfig/platformConfig.service';
import { ReferralCommissionModel, ReferralModel } from '@/modules/referral/referral.model';
import { referralService } from '@/modules/referral/referral.service';
import { UserModel } from '@/modules/user/user.model';
import { WalletModel } from '@/modules/wallet/wallet.model';
import { WalletTransactionModel } from '@/modules/wallet/walletTransaction.model';

const app = createApp();
const API = '/api/v1';
const REFERRALS = `${API}/referrals`;
const ADMIN = `${REFERRALS}/admin`;
const PASSWORD = 'Passw0rd123';
const ID = '507f1f77bcf86cd799439011';
const GOOGLE_AUDIENCE = 'test-google-client.apps.googleusercontent.com';

interface Account {
  id: string;
  auth: string;
  code: string;
}

const register = async (email: string, body: object = {}): Promise<Account> => {
  const res = await request(app)
    .post(`${API}/auth/register`)
    .send(signupBody({ email, password: PASSWORD, ...body }));
  expect(res.status).toBe(201);
  return {
    id: res.body.data.user.id as string,
    auth: `Bearer ${res.body.data.accessToken as string}`,
    code: res.body.data.user.referralCode as string,
  };
};

const signInStaff = async (role: string): Promise<Account> => {
  const email = `${role}@example.com`;
  const user = await UserModel.create({ name: `Test ${role}`, email, password: PASSWORD, role });
  const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
  return {
    id: user.id as string,
    auth: `Bearer ${res.body.data.accessToken as string}`,
    code: user.referralCode as string,
  };
};

const googleIdentity = (overrides: object = {}) => ({
  googleId: 'google-1',
  email: 'gina.green@gmail.com',
  emailVerified: true,
  name: 'Gina Green',
  ...overrides,
});

const google = (body: object = {}) =>
  request(app)
    .post(`${API}/auth/google`)
    .send({ idToken: 'a-token', ...body });

const setSetting = (key: string, value: number) =>
  PlatformConfigModel.updateOne({ key }, { value }).exec();

const setRate = (basisPoints: number) =>
  setSetting('referral.commission.basis_points', basisPoints);

let admin: Account;

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([
    UserModel.init(),
    SessionModel.init(),
    ReferralModel.init(),
    ReferralCommissionModel.init(),
    WalletModel.init(),
    WalletTransactionModel.init(),
    PlatformConfigModel.init(),
  ]);
});

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    ReferralModel.deleteMany({}),
    ReferralCommissionModel.deleteMany({}),
    WalletModel.deleteMany({}),
    WalletTransactionModel.deleteMany({}),
    PlatformConfigModel.deleteMany({}),
    InvestmentPlanModel.deleteMany({}),
  ]);
  await platformConfigService.seedManagedConfigs();
  admin = await signInStaff('admin');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('signing up with email', () => {
  it('needs only an email and password, and gives every account a code', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send(signupBody({ email: 'jane.doe@example.com', password: PASSWORD }));

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      name: 'Jane Doe',
      hasPassword: true,
      googleLinked: false,
      referralPromptPending: false,
    });
    expect(res.body.data.user.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(res.body.data.user.googleId).toBeUndefined();
  });

  it('falls back to a placeholder when the email has no usable name', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send(signupBody({ email: '12345@example.com', password: PASSWORD }));
    expect(res.body.data.user.name).toBe('New Customer');
  });

  it('links the new account to whoever owns the code, in any case', async () => {
    const referrer = await register('ref@example.com');
    const referee = await register('new@example.com', {
      referrer: ` ${referrer.code.toLowerCase()} `,
    });

    const referral = await ReferralModel.findOne({ referee: referee.id }).lean();
    expect(String(referral?.referrer)).toBe(referrer.id);
    expect(referral).toMatchObject({
      codeUsed: referrer.code,
      source: 'signup',
      status: 'pending',
    });
  });

  it.each([
    ['blank', ''],
    ['null', null],
  ])('treats a %s code as no code', async (_label, referralCode) => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send(signupBody({ email: 'new@example.com', password: PASSWORD, referrer: referralCode }));
    expect(res.status).toBe(201);
    expect(await ReferralModel.countDocuments()).toBe(0);
  });

  it('refuses an unknown code without creating the account', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send(signupBody({ email: 'new@example.com', password: PASSWORD, referrer: 'NOPE1234' }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REFERRAL_CODE');
    expect(await UserModel.exists({ email: 'new@example.com' })).toBeNull();
  });

  it('refuses the code of a closed account', async () => {
    const referrer = await register('ref@example.com');
    await UserModel.updateOne({ _id: referrer.id }, { isActive: false });

    const res = await request(app)
      .post(`${API}/auth/register`)
      .send(signupBody({ email: 'new@example.com', password: PASSWORD, referrer: referrer.code }));
    expect(res.body.code).toBe('INVALID_REFERRAL_CODE');
  });
});

describe('checking a code before signup', () => {
  it('answers without signing in, and reveals nothing about the owner', async () => {
    const { code } = await register('ref@example.com');
    const res = await request(app).get(`${REFERRALS}/codes/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ valid: true });
  });

  it('answers the same for a code that does not exist', async () => {
    const res = await request(app).get(`${REFERRALS}/codes/NOPE1234`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REFERRAL_CODE');
  });
});

describe('signing up with Google', () => {
  it('creates an account with no password and asks for a referral code', async () => {
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());

    const res = await google();

    expect(res.status).toBe(201);
    expect(res.body.data.isNewUser).toBe(true);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({
      name: 'Gina Green',
      email: 'gina.green@gmail.com',
      hasPassword: false,
      googleLinked: true,
      referralPromptPending: true,
    });
    expect(res.headers['set-cookie']?.[0]).toContain('refreshToken=');
  });

  it('skips the prompt when the code came with the signup, as from a referral link', async () => {
    const referrer = await register('ref@example.com');
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());

    const res = await google({ referralCode: referrer.code });

    expect(res.body.data.user.referralPromptPending).toBe(false);
    const referral = await ReferralModel.findOne({ referee: res.body.data.user.id }).lean();
    expect(referral?.source).toBe('google_signup');
  });

  it('refuses a bad code without creating the account', async () => {
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());
    const res = await google({ referralCode: 'NOPE1234' });
    expect(res.body.code).toBe('INVALID_REFERRAL_CODE');
    expect(await UserModel.exists({ googleId: 'google-1' })).toBeNull();
  });

  it('signs the same person in again, keeping the prompt until it is answered', async () => {
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());
    const first = await google();
    const second = await google();

    expect(second.status).toBe(200);
    expect(second.body.data.isNewUser).toBe(false);
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
    expect(second.body.data.user.referralPromptPending).toBe(true);
  });

  it('ignores a code sent by someone who already has an account', async () => {
    const referrer = await register('ref@example.com');
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());
    await google();
    await google({ referralCode: referrer.code });
    expect(await ReferralModel.countDocuments()).toBe(0);
  });

  it('does not take over an existing account with the same email', async () => {
    await register('gina.green@gmail.com');
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());

    const res = await google();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GOOGLE_LINK_REQUIRED');
    expect(await UserModel.exists({ googleId: 'google-1' })).toBeNull();
  });

  it('refuses an unverified Google email', async () => {
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(
      googleIdentity({ emailVerified: false }),
    );
    const res = await google();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED');
  });

  it('refuses a disabled account', async () => {
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());
    await google();
    await UserModel.updateOne({ googleId: 'google-1' }, { isActive: false });
    expect((await google()).body.code).toBe('ACCOUNT_DISABLED');
  });

  it('needs a token', async () => {
    const res = await request(app).post(`${API}/auth/google`).send({});
    expect(res.status).toBe(422);
  });
});

describe('verifying a Google token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const sign = (claims: object = {}, key = privateKey, expiresIn = 3600) =>
    jwt.sign(
      {
        iss: 'https://accounts.google.com',
        aud: GOOGLE_AUDIENCE,
        sub: 'google-real',
        email: 'Real.Person@gmail.com',
        email_verified: true,
        name: 'Real Person',
        ...claims,
      },
      key,
      { algorithm: 'RS256', keyid: 'key-1', expiresIn },
    );

  // Only Google's published keys are faked. The library's real checks all still run.
  beforeEach(() => {
    vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs: { 'key-1': publicKey.export({ type: 'spki', format: 'pem' }) as string },
      res: null,
    } as never);
  });

  it('accepts a token signed by Google for this app', async () => {
    await expect(googleApi.verifyIdToken(sign())).resolves.toEqual({
      googleId: 'google-real',
      email: 'real.person@gmail.com',
      emailVerified: true,
      name: 'Real Person',
    });
  });

  it.each([
    ['another app', () => sign({ aud: 'someone-elses-app' })],
    ['another issuer', () => sign({ iss: 'https://evil.example.com' })],
    ['a forged signature', () => sign({}, otherKey)],
    ['an expired token', () => sign({}, privateKey, -7200)],
    ['garbage', () => 'not-a-jwt'],
  ])('refuses a token from %s', async (_label, token) => {
    const res = await request(app).post(`${API}/auth/google`).send({ idToken: token() });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_GOOGLE_TOKEN');
    expect(await UserModel.exists({ googleId: 'google-real' })).toBeNull();
  });
});

describe('an account made with Google', () => {
  const makeAccount = async () => {
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());
    const res = await google();
    return `Bearer ${res.body.data.accessToken as string}`;
  };

  it('cannot be signed into with any password', async () => {
    await makeAccount();
    const res = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'gina.green@gmail.com', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('can edit its profile', async () => {
    const auth = await makeAccount();
    const res = await request(app)
      .patch(`${API}/users/me`)
      .set('Authorization', auth)
      .send({ occupation: 'Engineer' });
    expect(res.status).toBe(200);
  });

  it('must set a password before anything that asks for one', async () => {
    const auth = await makeAccount();
    const res = await request(app)
      .post(`${API}/auth/change-password`)
      .set('Authorization', auth)
      .send({ currentPassword: 'anything1', newPassword: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSWORD_NOT_SET');
  });

  it('can set a password once, and then use both ways in', async () => {
    const auth = await makeAccount();
    const set = await request(app)
      .post(`${API}/auth/set-password`)
      .set('Authorization', auth)
      .send({ newPassword: PASSWORD });
    expect(set.status).toBe(200);
    expect(set.body.data.user.hasPassword).toBe(true);

    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'gina.green@gmail.com', password: PASSWORD });
    expect(login.status).toBe(200);
    expect((await google()).status).toBe(200);

    const again = await request(app)
      .post(`${API}/auth/set-password`)
      .set('Authorization', `Bearer ${set.body.data.accessToken as string}`)
      .send({ newPassword: 'Another1234' });
    expect(again.body.code).toBe('PASSWORD_ALREADY_SET');
  });
});

describe('linking Google to a password account', () => {
  const link = (auth: string) =>
    request(app)
      .post(`${API}/auth/google/link`)
      .set('Authorization', auth)
      .send({ idToken: 'a-token' });

  it('lets its owner sign in with Google afterwards', async () => {
    const { id, auth } = await register('gina.green@gmail.com');
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());

    const res = await link(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.googleLinked).toBe(true);

    const signIn = await google();
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user.id).toBe(id);
  });

  it('refuses a Google account someone else has linked', async () => {
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());
    await google();
    const { auth } = await register('other@example.com');
    expect((await link(auth)).body.code).toBe('GOOGLE_ACCOUNT_IN_USE');
  });

  it('refuses a second link', async () => {
    const { auth } = await register('a@example.com');
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());
    await link(auth);
    expect((await link(auth)).body.code).toBe('GOOGLE_ALREADY_LINKED');
  });
});

describe('the prompt after a Google signup', () => {
  const signUp = async (identity: object = {}) => {
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity(identity));
    const res = await google();
    return {
      id: res.body.data.user.id as string,
      auth: `Bearer ${res.body.data.accessToken as string}`,
      code: res.body.data.user.referralCode as string,
    };
  };
  const apply = (auth: string, code: string) =>
    request(app).post(`${REFERRALS}/me/apply`).set('Authorization', auth).send({ code });

  it('takes a code, and closes', async () => {
    const referrer = await register('ref@example.com');
    const { id, auth } = await signUp();

    const res = await apply(auth, referrer.code);
    expect(res.status).toBe(200);
    expect(res.body.data.promptPending).toBe(false);
    expect(res.body.data.referredBy.name).toBe('Ref');
    const referral = await ReferralModel.findOne({ referee: id }).lean();
    expect(referral?.source).toBe('google_prompt');

    const other = await register('other@example.com');
    expect((await apply(auth, other.code)).body.code).toBe('REFERRAL_WINDOW_CLOSED');
  });

  it('can be skipped, after which no code can be added', async () => {
    const referrer = await register('ref@example.com');
    const { auth } = await signUp();

    const skip = await request(app).post(`${REFERRALS}/me/skip`).set('Authorization', auth);
    expect(skip.status).toBe(200);
    expect(skip.body.data.promptPending).toBe(false);

    expect((await apply(auth, referrer.code)).body.code).toBe('REFERRAL_WINDOW_CLOSED');
    expect(await ReferralModel.countDocuments()).toBe(0);
  });

  it('stays open after a wrong code', async () => {
    const { auth } = await signUp();
    expect((await apply(auth, 'NOPE1234')).body.code).toBe('INVALID_REFERRAL_CODE');
    const page = await request(app).get(`${REFERRALS}/me`).set('Authorization', auth);
    expect(page.body.data.promptPending).toBe(true);
  });

  it('refuses your own code', async () => {
    const { auth, code } = await signUp();
    expect((await apply(auth, code)).body.code).toBe('SELF_REFERRAL');
  });

  it('refuses a code from someone you referred', async () => {
    const first = await signUp();
    const second = await signUp({ googleId: 'google-2', email: 'second@gmail.com' });
    expect((await apply(second.auth, first.code)).status).toBe(200);
    expect((await apply(first.auth, second.code)).body.code).toBe('CIRCULAR_REFERRAL');
  });

  it('is never open to an account that signed up with a password', async () => {
    const referrer = await register('ref@example.com');
    const { auth } = await register('old@example.com');
    expect((await apply(auth, referrer.code)).body.code).toBe('REFERRAL_WINDOW_CLOSED');
  });
});

/** Links a referrer and referee, with a rate set, ready for commissions. */
const setUpReferral = async () => {
  await setRate(500);
  const referrer = await register('ref@example.com');
  const referee = await register('sam.bell@example.com', { referrer: referrer.code });
  return { referrer, referee };
};

const recordInvestment = (referee: string, body: object = {}, auth = admin.auth) =>
  request(app)
    .post(`${ADMIN}/commissions`)
    .set('Authorization', auth)
    .send({
      referee,
      investmentReference: 'INV-1',
      investmentAmount: 10_000_000,
      ...body,
    });

const act = (id: string, action: string, body: object = {}, auth = admin.auth) =>
  request(app).post(`${ADMIN}/commissions/${id}/${action}`).set('Authorization', auth).send(body);

const paidCommission = async (referee: string) => {
  const created = await recordInvestment(referee);
  const id = created.body.data.id as string;
  await act(id, 'approve').expect(200);
  await act(id, 'pay').expect(200);
  return id;
};

describe('the referral page', () => {
  const page = (auth: string) => request(app).get(`${REFERRALS}/me`).set('Authorization', auth);

  it('needs signing in', async () => {
    expect((await request(app).get(`${REFERRALS}/me`)).status).toBe(401);
  });

  it('gives everyone their code and link', async () => {
    const { auth, code } = await register('a@example.com');
    const res = await page(auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      code,
      link: `https://app.example.com/signup?ref=${code}`,
      referredBy: null,
      promptPending: false,
      referrals: { total: 0, pending: 0, qualified: 0, rejected: 0 },
      earnings: { scheduled: 0, pending: 0, approved: 0, paid: 0, currency: 'NGN' },
      programme: { commissionBasisPoints: 0, minInvestmentAmount: 0, currency: 'NGN' },
    });
  });

  it('works for staff too', async () => {
    expect((await page(admin.auth)).body.data.code).toBe(admin.code);
  });

  it('gives a code to an account from before the programme, and keeps it', async () => {
    const { id, auth } = await register('old@example.com');
    await UserModel.updateOne({ _id: id }, { referralCode: null });

    const first = await page(auth);
    expect(first.body.data.code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await page(auth)).body.data.code).toBe(first.body.data.code);
    // The new code works straight away.
    await register('friend@example.com', { referrer: first.body.data.code });
  });

  it('adds up referrals and earnings', async () => {
    const { referrer, referee } = await setUpReferral();
    await register('two@example.com', { referrer: referrer.code });
    await paidCommission(referee.id);

    const res = await page(referrer.auth);
    expect(res.body.data.referrals).toEqual({ total: 2, pending: 1, qualified: 1, rejected: 0 });
    expect(res.body.data.earnings).toMatchObject({ paid: 500_000, pending: 0, approved: 0 });
    expect(res.body.data.programme.commissionBasisPoints).toBe(500);
  });

  it('lists who you referred by first name only', async () => {
    const { referrer, referee } = await setUpReferral();
    const res = await request(app)
      .get(`${REFERRALS}/me/referrals`)
      .set('Authorization', referrer.auth);

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ name: 'Sam', status: 'pending' });
    expect(JSON.stringify(res.body.data)).not.toContain('sam.bell@example.com');
    expect(res.body.data[0].referee).toBeUndefined();
    expect(referee.id).not.toBe(referrer.id);
  });

  it('shows only your own referrals', async () => {
    await setUpReferral();
    const stranger = await register('stranger@example.com');
    const res = await request(app)
      .get(`${REFERRALS}/me/referrals`)
      .set('Authorization', stranger.auth);
    expect(res.body.data).toEqual([]);
  });

  it("lists commissions without the investment's details", async () => {
    const { referrer, referee } = await setUpReferral();
    await recordInvestment(referee.id, { note: 'staff only' }).expect(201);

    const res = await request(app)
      .get(`${REFERRALS}/me/commissions?status=pending`)
      .set('Authorization', referrer.auth);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ name: 'Sam', amount: 500_000, status: 'pending' });
    for (const hidden of ['investmentAmount', 'investmentReference', 'note', 'rateBasisPoints']) {
      expect(res.body.data[0][hidden]).toBeUndefined();
    }
  });
});

describe('recording a commission', () => {
  it('works out the amount, and qualifies the referral', async () => {
    const { referrer, referee } = await setUpReferral();
    const res = await recordInvestment(referee.id);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      investmentAmount: 10_000_000,
      rateBasisPoints: 500,
      amount: 500_000,
      status: 'pending',
      referrer: { id: referrer.id, email: 'ref@example.com' },
      referee: { id: referee.id, email: 'sam.bell@example.com' },
    });
    const referral = await ReferralModel.findOne({ referee: referee.id }).lean();
    expect(referral?.status).toBe('qualified');
    expect(referral?.qualifiedAt).toBeInstanceOf(Date);
  });

  it('rounds down to whole kobo', async () => {
    const { referee } = await setUpReferral();
    const res = await recordInvestment(referee.id, { investmentAmount: 333 });
    expect(res.body.data.amount).toBe(16);
  });

  it('keeps the rate it was earned at', async () => {
    const { referee } = await setUpReferral();
    const { body } = await recordInvestment(referee.id);
    await setRate(100);
    const res = await request(app)
      .get(`${ADMIN}/commissions/${body.data.id as string}`)
      .set('Authorization', admin.auth);
    expect(res.body.data).toMatchObject({ rateBasisPoints: 500, amount: 500_000 });
  });

  it('can name the plan', async () => {
    const { referee } = await setUpReferral();
    const plan = await InvestmentPlanModel.create({
      name: 'Note',
      slug: 'note',
      description: 'A note',
      riskLevel: 'low',
      roiBasisPoints: 1000,
      roiType: 'flat',
      payoutFrequency: 'at_maturity',
      durationValue: 1,
      durationUnit: 'years',
      durationDays: 365,
      minAmount: 1,
      createdBy: admin.id,
    });
    const res = await recordInvestment(referee.id, { plan: plan.id });
    expect(res.body.data.plan).toEqual({ id: plan.id, name: 'Note' });
    expect((await recordInvestment(referee.id, { plan: ID })).status).toBe(404);
  });

  it('refuses someone who was not referred', async () => {
    const { id } = await register('solo@example.com');
    const res = await recordInvestment(id);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_REFERRED');
  });

  it('earns nothing until a rate is set', async () => {
    const referrer = await register('ref@example.com');
    const referee = await register('new@example.com', { referrer: referrer.code });
    const res = await recordInvestment(referee.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMMISSION_RATE_NOT_SET');
    expect((await ReferralModel.findOne({ referee: referee.id }).lean())?.status).toBe('pending');
  });

  it('allows staff to set the amount, up to the investment', async () => {
    const { referee } = await setUpReferral();
    const tooMuch = await recordInvestment(referee.id, { amount: 10_000_001 });
    expect(tooMuch.status).toBe(422);
    const res = await recordInvestment(referee.id, { amount: 1000 });
    expect(res.body.data.amount).toBe(1000);
  });

  it('never counts the same investment twice', async () => {
    const { referee } = await setUpReferral();
    await setSetting('referral.commission.max_investments', 0);
    await recordInvestment(referee.id).expect(201);
    const res = await recordInvestment(referee.id);
    expect(res.status).toBe(409);
    expect(await ReferralCommissionModel.countDocuments()).toBe(1);
  });

  it('applies the minimum investment', async () => {
    const { referee } = await setUpReferral();
    await setSetting('referral.commission.min_investment_kobo', 20_000_000);
    expect((await recordInvestment(referee.id)).body.code).toBe('BELOW_MIN_INVESTMENT');
  });

  it('stops at the limit, not counting rejected commissions', async () => {
    const { referee } = await setUpReferral();
    const first = await recordInvestment(referee.id);
    const second = { investmentReference: 'INV-2' };
    expect((await recordInvestment(referee.id, second)).body.code).toBe('COMMISSION_LIMIT_REACHED');

    await act(first.body.data.id, 'reject', { note: 'Refunded' }).expect(200);
    expect((await recordInvestment(referee.id, second)).status).toBe(201);
  });

  it('allows any number when the limit is 0', async () => {
    const { referee } = await setUpReferral();
    await setSetting('referral.commission.max_investments', 0);
    await recordInvestment(referee.id).expect(201);
    await recordInvestment(referee.id, { investmentReference: 'INV-2' }).expect(201);
  });

  it('refuses a rejected referral', async () => {
    const { referee } = await setUpReferral();
    await ReferralModel.updateOne({ referee: referee.id }, { status: 'rejected' });
    expect((await recordInvestment(referee.id)).body.code).toBe('REFERRAL_REJECTED');
  });

  it('can be called without a member of staff, for a future checkout', async () => {
    const { referee } = await setUpReferral();
    const commission = await referralService.recordInvestment({
      referee: referee.id,
      investmentReference: 'CHECKOUT-1',
      investmentAmount: 1_000_000,
    });
    expect(commission).toMatchObject({ amount: 50_000, status: 'pending', createdBy: null });
  });

  it('validates its input', async () => {
    const { referee } = await setUpReferral();
    expect((await recordInvestment(referee.id, { investmentAmount: 1.5 })).status).toBe(422);
    expect((await recordInvestment(referee.id, { investmentAmount: -1 })).status).toBe(422);
    expect((await recordInvestment('nope')).status).toBe(422);
  });
});

describe('moving a commission along', () => {
  const setUp = async () => {
    const { referrer, referee } = await setUpReferral();
    const res = await recordInvestment(referee.id);
    return { referrer, referee, id: res.body.data.id as string };
  };
  const walletOf = (user: string) => WalletModel.findOne({ user }).lean();

  it('pays the referrer once approved, with a ledger entry', async () => {
    const { referrer, id } = await setUp();

    const approved = await act(id, 'approve');
    expect(approved.body.data).toMatchObject({ status: 'approved', approvedBy: admin.id });

    const paid = await act(id, 'pay');
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({
      status: 'paid',
      paidBy: admin.id,
      walletReference: `CCR-${id}`,
    });

    expect((await walletOf(referrer.id))?.balance).toBe(500_000);
    const entry = await WalletTransactionModel.findOne({ reference: `CCR-${id}` }).lean();
    expect(entry).toMatchObject({
      type: 'referral_commission',
      provider: 'internal',
      amount: 500_000,
      status: 'success',
      balanceAfter: 500_000,
    });

    const own = await request(app)
      .get(`${API}/wallet/transactions?type=referral_commission`)
      .set('Authorization', referrer.auth);
    expect(own.body.data).toHaveLength(1);
  });

  it('tells the referrer once when it is paid, however many requests overlap', async () => {
    const { referrer, id } = await setUp();
    await act(id, 'approve');
    await Promise.all([act(id, 'pay'), act(id, 'pay'), act(id, 'pay')]);
    expect(
      await EmailLogModel.countDocuments({
        user: referrer.id,
        template: 'referral_commission_paid',
      }),
    ).toBe(1);
  });

  it('adds to what is already in the wallet', async () => {
    const { referrer, id } = await setUp();
    await WalletModel.create({ user: referrer.id, balance: 100 });
    await act(id, 'approve');
    await act(id, 'pay').expect(200);
    expect((await walletOf(referrer.id))?.balance).toBe(500_100);
  });

  it('cannot pay before approval', async () => {
    const { referrer, id } = await setUp();
    expect((await act(id, 'pay')).body.code).toBe('INVALID_COMMISSION_STATUS');
    expect(await walletOf(referrer.id)).toBeNull();
  });

  it('pays once, however many requests arrive together', async () => {
    const { referrer, id } = await setUp();
    await act(id, 'approve');

    const results = await Promise.all([act(id, 'pay'), act(id, 'pay'), act(id, 'pay')]);

    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect((await walletOf(referrer.id))?.balance).toBe(500_000);
    expect(await WalletTransactionModel.countDocuments({ type: 'referral_commission' })).toBe(1);
    expect((await act(id, 'pay')).body.code).toBe('INVALID_COMMISSION_STATUS');
  });

  it('leaves nothing changed when the payout fails partway', async () => {
    const { referrer, id } = await setUp();
    await act(id, 'approve');
    vi.spyOn(WalletTransactionModel, 'create').mockRejectedValueOnce(new Error('Disk full'));

    expect((await act(id, 'pay')).status).toBe(500);

    expect((await walletOf(referrer.id))?.balance).toBe(0);
    expect((await ReferralCommissionModel.findById(id).lean())?.status).toBe('approved');
    await act(id, 'pay').expect(200);
    expect((await walletOf(referrer.id))?.balance).toBe(500_000);
  });

  it('will not pay a closed account', async () => {
    const { referrer, id } = await setUp();
    await act(id, 'approve');
    await UserModel.updateOne({ _id: referrer.id }, { isActive: false });
    expect((await act(id, 'pay')).body.code).toBe('REFERRER_INACTIVE');
  });

  it('will not pay an account that no longer exists', async () => {
    const { referrer, id } = await setUp();
    await act(id, 'approve');
    await UserModel.deleteOne({ _id: referrer.id });
    expect((await act(id, 'pay')).body.code).toBe('REFERRER_INACTIVE');
  });

  it('can reject before payment, with a reason', async () => {
    const { id } = await setUp();
    expect((await act(id, 'reject')).status).toBe(422);
    await act(id, 'approve');
    const res = await act(id, 'reject', { note: 'Investment refunded' });
    expect(res.body.data).toMatchObject({ status: 'rejected', note: 'Investment refunded' });
    expect((await act(id, 'pay')).status).toBe(409);
    expect((await act(id, 'approve')).status).toBe(409);
  });

  it('cannot reject what has been paid', async () => {
    const { id } = await setUp();
    await act(id, 'approve');
    await act(id, 'pay');
    expect((await act(id, 'reject', { note: 'Too late' })).status).toBe(409);
  });

  it('can edit only while pending', async () => {
    const { id } = await setUp();
    const patch = (body: object) =>
      request(app).patch(`${ADMIN}/commissions/${id}`).set('Authorization', admin.auth).send(body);

    expect((await patch({ amount: 1000, note: 'Agreed' })).body.data).toMatchObject({
      amount: 1000,
      note: 'Agreed',
    });
    expect((await patch({ amount: 10_000_001 })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    await act(id, 'approve');
    expect((await patch({ amount: 2000 })).body.code).toBe('COMMISSION_LOCKED');
  });

  it('can delete only what is pending or rejected', async () => {
    const { id } = await setUp();
    const remove = () =>
      request(app).delete(`${ADMIN}/commissions/${id}`).set('Authorization', admin.auth);

    await act(id, 'approve');
    expect((await remove()).body.code).toBe('COMMISSION_LOCKED');
    await act(id, 'reject', { note: 'No' });
    expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(404);
  });

  it('stops staff acting on their own earnings', async () => {
    await setRate(500);
    const staffReferee = await register('sam@example.com', { referrer: admin.code });

    const created = await recordInvestment(staffReferee.id);
    expect(created.status).toBe(403);
    expect(created.body.code).toBe('SELF_DEALING');

    const other = await signInStaff('super_admin');
    const made = await recordInvestment(staffReferee.id, {}, other.auth);
    const id = made.body.data.id as string;
    expect((await act(id, 'approve')).body.code).toBe('SELF_DEALING');
    expect((await act(id, 'reject', { note: 'x' })).body.code).toBe('SELF_DEALING');
    await act(id, 'approve', {}, other.auth).expect(200);
    expect((await act(id, 'pay')).body.code).toBe('SELF_DEALING');
    await act(id, 'pay', {}, other.auth).expect(200);
  });
});

describe('managing referrals', () => {
  const list = (query = '') =>
    request(app).get(`${ADMIN}/referrals${query}`).set('Authorization', admin.auth);
  const patch = (id: string, body: object) =>
    request(app).patch(`${ADMIN}/referrals/${id}`).set('Authorization', admin.auth).send(body);
  const remove = (id: string) =>
    request(app).delete(`${ADMIN}/referrals/${id}`).set('Authorization', admin.auth);
  const create = (body: object) =>
    request(app).post(`${ADMIN}/referrals`).set('Authorization', admin.auth).send(body);

  it('lists with both people, and filters', async () => {
    const { referrer, referee } = await setUpReferral();
    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      codeUsed: referrer.code,
      source: 'signup',
      status: 'pending',
      referrer: { id: referrer.id, email: 'ref@example.com' },
      referee: { id: referee.id, name: 'Sam Bell' },
    });
    expect(res.body.data[0].referrer.password).toBeUndefined();

    expect((await list('?status=qualified')).body.data).toHaveLength(0);
    expect((await list(`?referrer=${referrer.id}`)).body.data).toHaveLength(1);
    expect((await list(`?referee=${referrer.id}`)).body.data).toHaveLength(0);
    expect((await list('?source=admin')).body.data).toHaveLength(0);
    expect((await list('?status=nonsense')).status).toBe(422);
  });

  it('searches by either person and by code', async () => {
    const { referrer } = await setUpReferral();
    await register('unrelated@example.com');

    expect((await list('?search=sam.bell')).body.data).toHaveLength(1);
    expect((await list('?search=ref@example')).body.data).toHaveLength(1);
    expect((await list(`?search=${referrer.code}`)).body.data).toHaveLength(1);
    expect((await list('?search=unrelated')).body.data).toHaveLength(0);
    expect((await list('?search=.*')).body.data).toHaveLength(0);
  });

  it('reads one, with its commissions', async () => {
    const { referee } = await setUpReferral();
    await recordInvestment(referee.id);
    const id = (await list()).body.data[0].id as string;

    const res = await request(app).get(`${ADMIN}/referrals/${id}`).set('Authorization', admin.auth);
    expect(res.body.data.commissions).toHaveLength(1);
    expect(res.body.data.commissions[0].amount).toBe(500_000);

    const missing = await request(app)
      .get(`${ADMIN}/referrals/${ID}`)
      .set('Authorization', admin.auth);
    expect(missing.status).toBe(404);
  });

  it('survives someone in it being deleted', async () => {
    const { referee } = await setUpReferral();
    await UserModel.deleteOne({ _id: referee.id });
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data[0].referee).toBeNull();
  });

  it('assigns a referrer by hand, closing any open prompt', async () => {
    const referrer = await register('ref@example.com');
    vi.spyOn(googleApi, 'verifyIdToken').mockResolvedValue(googleIdentity());
    const signUp = await google();
    const refereeId = signUp.body.data.user.id as string;

    const res = await create({ referrer: referrer.id, referee: refereeId, note: 'Phoned in' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      source: 'admin',
      note: 'Phoned in',
      createdBy: admin.id,
      codeUsed: referrer.code,
    });
    expect((await UserModel.findById(refereeId).lean())?.referralPromptPending).toBe(false);
  });

  it('applies the same rules to a referrer assigned by hand', async () => {
    const { referrer, referee } = await setUpReferral();
    const other = await register('other@example.com');

    const cases = [
      [{ referrer: referrer.id, referee: referrer.id }, 'SELF_REFERRAL'],
      [{ referrer: other.id, referee: referee.id }, 'ALREADY_REFERRED'],
      [{ referrer: referee.id, referee: referrer.id }, 'CIRCULAR_REFERRAL'],
      [{ referrer: ID, referee: other.id }, 'NOT_FOUND'],
      [{ referrer: admin.id, referee: other.id }, 'SELF_DEALING'],
    ] as const;
    for (const [body, code] of cases) expect((await create(body)).body.code).toBe(code);
  });

  it('updates status and notes', async () => {
    await setUpReferral();
    const id = (await list()).body.data[0].id as string;

    const qualified = await patch(id, { status: 'qualified', note: 'Checked' });
    expect(qualified.body.data).toMatchObject({ status: 'qualified', note: 'Checked' });
    expect(qualified.body.data.qualifiedAt).not.toBeNull();

    const pending = await patch(id, { status: 'pending', note: null });
    expect(pending.body.data).toMatchObject({ status: 'pending', note: null, qualifiedAt: null });
    expect((await patch(id, {})).status).toBe(422);
    expect((await patch(id, { codeUsed: 'HACKED' })).status).toBe(422);
  });

  it('cancels unpaid commissions when rejected, and leaves paid ones', async () => {
    const { referrer, referee } = await setUpReferral();
    await setSetting('referral.commission.max_investments', 0);
    await paidCommission(referee.id);
    const open = await recordInvestment(referee.id, { investmentReference: 'INV-2' });
    const id = (await list()).body.data[0].id as string;

    const res = await patch(id, { status: 'rejected' });

    expect(res.status).toBe(200);
    const statuses = (res.body.data.commissions as { status: string }[]).map((c) => c.status);
    expect(statuses.toSorted()).toEqual(['paid', 'rejected']);
    expect((await ReferralCommissionModel.findById(open.body.data.id).lean())?.status).toBe(
      'rejected',
    );
    expect((await WalletModel.findOne({ user: referrer.id }).lean())?.balance).toBe(500_000);
  });

  it('deletes only without live commissions', async () => {
    const { referee } = await setUpReferral();
    const made = await recordInvestment(referee.id);
    const id = (await list()).body.data[0].id as string;

    expect((await remove(id)).body.code).toBe('REFERRAL_HAS_COMMISSIONS');
    await act(made.body.data.id, 'reject', { note: 'No' });
    expect((await remove(id)).status).toBe(204);
    expect(await ReferralCommissionModel.countDocuments()).toBe(0);
    expect((await remove(id)).status).toBe(404);
  });

  it('lists and searches commissions', async () => {
    const { referrer, referee } = await setUpReferral();
    await recordInvestment(referee.id);
    const get = (query: string) =>
      request(app).get(`${ADMIN}/commissions${query}`).set('Authorization', admin.auth);

    expect((await get('')).body.data[0].referee.name).toBe('Sam Bell');
    expect((await get('?status=paid')).body.data).toHaveLength(0);
    expect((await get(`?referrer=${referrer.id}`)).body.data).toHaveLength(1);
    expect((await get('?search=INV-1')).body.data).toHaveLength(1);
    expect((await get('?search=sam.bell')).body.data).toHaveLength(1);
    expect((await get('?sort=-amount')).status).toBe(200);
    expect((await get('?sort=note')).status).toBe(422);
  });

  it('adds up the whole programme', async () => {
    const { referrer, referee } = await setUpReferral();
    await register('two@example.com', { referrer: referrer.code });
    await paidCommission(referee.id);

    const res = await request(app).get(`${ADMIN}/stats`).set('Authorization', admin.auth);

    expect(res.body.data).toMatchObject({
      referrals: { pending: 1, qualified: 1 },
      commissions: { paid: { count: 1, amount: 500_000 } },
      settings: {
        commissionBasisPoints: 500,
        minInvestmentAmount: 0,
        maxCommissionedInvestments: 1,
      },
    });
    expect(res.body.data.topReferrers).toEqual([
      expect.objectContaining({
        referrals: 2,
        qualified: 1,
        user: expect.objectContaining({ id: referrer.id }),
      }),
    ]);
  });

  it("shows one person's summary", async () => {
    const { referrer, referee } = await setUpReferral();
    const get = (id: string) =>
      request(app).get(`${ADMIN}/users/${id}`).set('Authorization', admin.auth);

    expect((await get(referrer.id)).body.data).toMatchObject({
      code: referrer.code,
      referredBy: null,
      referrals: { total: 1 },
    });
    const summary = (await get(referee.id)).body.data;
    expect(summary.referredBy.referrer.id).toBe(referrer.id);
    expect((await get(ID)).status).toBe(404);
  });

  it('sets a custom code or generates a new one, and the old one stops working', async () => {
    const { id, code } = await register('ref@example.com');
    const taken = await register('taken@example.com');
    const put = (body: object) =>
      request(app).put(`${ADMIN}/users/${id}/code`).set('Authorization', admin.auth).send(body);

    const custom = await put({ code: 'temple25' });
    expect(custom.body.data.code).toBe('TEMPLE25');
    expect(custom.body.data.link).toContain('ref=TEMPLE25');
    expect((await request(app).get(`${REFERRALS}/codes/${code}`)).status).toBe(400);
    expect((await request(app).get(`${REFERRALS}/codes/temple25`)).status).toBe(200);

    expect((await put({ code: taken.code })).body.code).toBe('REFERRAL_CODE_TAKEN');
    expect((await put({ code: 'no spaces!' })).status).toBe(422);

    const generated = await put({});
    expect(generated.body.data.code).not.toBe('TEMPLE25');
    expect(generated.body.data.code).toMatch(/^[A-Z2-9]{8}$/);
  });
});

describe('who can do what', () => {
  it('keeps every staff route from customers', async () => {
    const { id, auth } = await register('customer@example.com');
    const routes = [
      ['get', '/stats'],
      ['get', '/referrals'],
      ['post', '/referrals'],
      ['get', `/referrals/${ID}`],
      ['patch', `/referrals/${ID}`],
      ['delete', `/referrals/${ID}`],
      ['get', '/commissions'],
      ['post', '/commissions'],
      ['get', `/commissions/${ID}`],
      ['patch', `/commissions/${ID}`],
      ['delete', `/commissions/${ID}`],
      ['post', `/commissions/${ID}/approve`],
      ['post', `/commissions/${ID}/reject`],
      ['post', `/commissions/${ID}/pay`],
      ['get', `/users/${id}`],
      ['put', `/users/${id}/code`],
    ] as const;
    for (const [method, path] of routes) {
      const res = await request(app)[method](`${ADMIN}${path}`).set('Authorization', auth).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lets an auditor read but not change', async () => {
    const auditor = await signInStaff('auditor');
    const get = request(app).get(`${ADMIN}/referrals`).set('Authorization', auditor.auth);
    expect((await get).status).toBe(200);
    const post = await request(app)
      .post(`${ADMIN}/commissions`)
      .set('Authorization', auditor.auth)
      .send({});
    expect(post.status).toBe(403);
  });

  it('lets an accountant pay but not approve', async () => {
    const { referee } = await setUpReferral();
    const accountant = await signInStaff('accountant');
    const { body } = await recordInvestment(referee.id);
    const id = body.data.id as string;

    expect((await act(id, 'approve', {}, accountant.auth)).status).toBe(403);
    await act(id, 'approve').expect(200);
    await act(id, 'pay', {}, accountant.auth).expect(200);
  });

  it('keeps the settings locked to their own rules', async () => {
    const patch = (key: string, value: number) =>
      request(app)
        .patch(`${API}/platform-config/admin/${key}`)
        .set('Authorization', admin.auth)
        .send({ value });

    await patch('referral.commission.basis_points', 500).expect(200);
    expect((await patch('referral.commission.basis_points', 2_001)).status).toBe(422);
    expect((await patch('referral.commission.max_investments', -1)).status).toBe(422);

    const del = await request(app)
      .delete(`${API}/platform-config/admin/referral.commission.basis_points`)
      .set('Authorization', admin.auth);
    expect(del.body.code).toBe('CONFIG_LOCKED');
    const stored = await PlatformConfigModel.findOne({ key: 'referral.commission.basis_points' });
    expect(stored?.category).toBe('referral');
  });
});
