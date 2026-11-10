import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { SessionModel } from '@/modules/auth/session.model';
import { EmailLogModel } from '@/modules/email/email.model';
import { emailService } from '@/modules/email/email.service';
import { KycVerificationModel } from '@/modules/kyc/kyc.model';
import { UserModel } from '@/modules/user/user.model';
import { FakeCloudinary } from './fakeCloudinary';
import { FakeDojah } from './fakeDojah';
import { FakeResend } from './fakeResend';

const API = '/api/v1/kyc';
const PASSWORD = 'Passw0rd123';
const NIN = '70123456789';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.4\n%fake\n');

const app = createApp();
const dojah = new FakeDojah();
const cloudinary = new FakeCloudinary();
const resend = new FakeResend();

/** Sends everything waiting, as the worker would, and returns the subjects sent to this address. */
const subjectsTo = async (email: string) => {
  while ((await emailService.processQueue()) > 0);
  return resend.to(email).map((sent) => sent.subject);
};

const ADA = {
  first_name: 'ADA',
  middle_name: 'AUGUSTA',
  last_name: 'LOVELACE',
  date_of_birth: '1990-12-10',
  gender: 'F',
  phone_number: '08012345678',
};

const address = {
  line1: '1 Marina',
  city: 'Lagos Island',
  state: 'Lagos',
  country: 'NG',
};

const signIn = async (email: string, extra: object = {}) => {
  const user = await UserModel.create({
    name: 'Jane Doe',
    email,
    password: PASSWORD,
    emailVerified: true,
    ...extra,
  });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id as string, auth: `Bearer ${res.body.data.accessToken as string}` };
};

const state = async (auth: string) =>
  (await request(app).get(API).set('Authorization', auth).expect(200)).body.data;

const verifyNin = (auth: string, nin = NIN) =>
  request(app).post(`${API}/nin`).set('Authorization', auth).send({ nin });

const saveDetails = (auth: string, body: object = { phone: '+2348099999999', address }) =>
  request(app).put(`${API}/details`).set('Authorization', auth).send(body);

const uploadPassport = (auth: string) =>
  request(app)
    .put(`${API}/passport-photo`)
    .set('Authorization', auth)
    .attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });

const uploadBill = (auth: string) =>
  request(app)
    .put(`${API}/utility-bill`)
    .set('Authorization', auth)
    .attach('file', PDF, { filename: 'bill.pdf', contentType: 'application/pdf' });

/** Takes a customer through every step and submits. */
const submitted = async (email = 'ada@example.com') => {
  const user = await signIn(email);
  await verifyNin(user.auth).expect(200);
  await saveDetails(user.auth).expect(200);
  await uploadPassport(user.auth).expect(200);
  await uploadBill(user.auth).expect(200);
  await request(app).post(`${API}/submit`).set('Authorization', user.auth).expect(200);
  return user;
};

beforeAll(async () => {
  await Promise.all([dojah.start(4595), cloudinary.start(4597), resend.start(4596)]);
  await connectDatabase();
  await Promise.all([UserModel.init(), SessionModel.init(), KycVerificationModel.init()]);
});

beforeEach(async () => {
  dojah.reset();
  cloudinary.reset();
  resend.reset();
  dojah.records.set(NIN, ADA);
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    KycVerificationModel.deleteMany({}),
    EmailLogModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await disconnectDatabase();
  await Promise.all([dojah.stop(), cloudinary.stop(), resend.stop()]);
});

describe('customer KYC', () => {
  it('starts at the NIN step', async () => {
    const { auth } = await signIn('ada@example.com');
    const data = await state(auth);
    expect(data).toMatchObject({
      available: true,
      status: 'not_started',
      nextStep: 'verify_nin',
      editable: true,
      kycCompleted: false,
      nin: { verified: false, lookupsRemaining: 3 },
    });
  });

  it('asks for a verified email first', async () => {
    const { auth } = await signIn('ada@example.com', { emailVerified: false });
    const res = await verifyNin(auth);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(dojah.lookups).toHaveLength(0);
  });

  it('verifies a NIN with Dojah, prefills the form and fills empty profile fields', async () => {
    const { auth, id } = await signIn('ada@example.com', { phone: '+2347000000000' });
    const res = await verifyNin(auth);

    expect(res.status).toBe(200);
    expect(dojah.lookups).toEqual([
      { nin: NIN, appId: 'test-app-id', authorization: 'test_sk_fake' },
    ]);
    expect(res.body.data).toMatchObject({
      status: 'draft',
      nextStep: 'personal_details',
      nin: { verified: true, last4: '6789', lookupsRemaining: 2 },
      identity: { firstName: 'Ada', middleName: 'Augusta', lastName: 'Lovelace', gender: 'female' },
      prefill: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        gender: 'female',
        // The number they already had is kept.
        phone: '+2347000000000',
        locked: { firstName: true, lastName: true, dateOfBirth: true, gender: true },
      },
    });
    expect(res.body.data.prefill.dateOfBirth).toMatch(/^1990-12-10/);
    expect(JSON.stringify(res.body)).not.toContain(NIN);

    const user = await UserModel.findById(id).lean();
    expect(user?.phone).toBe('+2347000000000');
    expect(user?.gender).toBe('female');
    expect(user?.dateOfBirth?.toISOString()).toMatch(/^1990-12-10/);

    // Stored encrypted, never in plain text.
    const raw = await KycVerificationModel.findOne({ user: id }).select('+ninEncrypted +ninHash');
    expect(raw?.ninEncrypted).toBeTruthy();
    expect(raw?.ninEncrypted).not.toContain(NIN);
  });

  it('refuses an unknown NIN, and counts each lookup', async () => {
    const { auth } = await signIn('ada@example.com');
    for (const nin of ['11111111111', '22222222222', '33333333333']) {
      const res = await verifyNin(auth, nin);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NIN_NOT_FOUND');
    }
    const res = await verifyNin(auth);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('NIN_LOOKUP_LIMIT');
    expect(dojah.lookups).toHaveLength(3);
  });

  it('rejects a malformed NIN without calling Dojah', async () => {
    const { auth } = await signIn('ada@example.com');
    await verifyNin(auth, '12345').expect(422);
    expect(dojah.lookups).toHaveLength(0);
  });

  it('does not look up the same NIN twice', async () => {
    const { auth } = await signIn('ada@example.com');
    await verifyNin(auth).expect(200);
    await verifyNin(auth).expect(200);
    expect(dojah.lookups).toHaveLength(1);
  });

  it('lets one NIN verify only one account', async () => {
    const first = await signIn('ada@example.com');
    await verifyNin(first.auth).expect(200);

    const second = await signIn('eve@example.com');
    const res = await verifyNin(second.auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NIN_IN_USE');
    expect(dojah.lookups).toHaveLength(1);
  });

  it('answers 502 when Dojah is down', async () => {
    const { auth } = await signIn('ada@example.com');
    dojah.outage = { status: 503, body: { error: 'down' } };
    const res = await verifyNin(auth);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
  });

  it('saves details, takes the legal name from the NIN and updates the profile', async () => {
    const { auth, id } = await signIn('ada@example.com');
    await saveDetails(auth).expect(409);
    await verifyNin(auth).expect(200);

    const res = await saveDetails(auth, {
      phone: '+2348099999999',
      address,
      occupation: 'Engineer',
      // Ignored, because the NIN record has these.
      gender: 'male',
      dateOfBirth: '2001-01-01',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.nextStep).toBe('upload_documents');
    expect(res.body.data.details).toMatchObject({ phone: '+2348099999999', gender: 'female' });

    const user = await UserModel.findById(id).lean();
    expect(user).toMatchObject({
      name: 'Ada Augusta Lovelace',
      phone: '+2348099999999',
      gender: 'female',
      occupation: 'Engineer',
      address: { line1: '1 Marina', country: 'NG' },
    });
  });

  it('asks for what the NIN record lacks', async () => {
    dojah.records.set(NIN, { first_name: 'ADA', last_name: 'LOVELACE' });
    const { auth } = await signIn('ada@example.com');
    await verifyNin(auth).expect(200);

    const missing = await saveDetails(auth);
    expect(missing.status).toBe(422);
    expect(missing.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'body.gender',
      'body.dateOfBirth',
    ]);

    const minor = await saveDetails(auth, {
      phone: '+2348099999999',
      address,
      gender: 'female',
      dateOfBirth: new Date(Date.now() - 10 * 365 * 24 * 3600 * 1000).toISOString(),
    });
    expect(minor.status).toBe(403);
    expect(minor.body.code).toBe('UNDERAGE');

    await saveDetails(auth, {
      phone: '+2348099999999',
      address,
      gender: 'female',
      dateOfBirth: '1990-12-10',
    }).expect(200);
  });

  it('uploads a passport photograph, which becomes the avatar, and a utility bill', async () => {
    const { auth, id } = await signIn('ada@example.com');
    await verifyNin(auth).expect(200);

    const early = await uploadPassport(auth);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('DETAILS_REQUIRED');
    expect(cloudinary.files.size).toBe(0);

    await saveDetails(auth).expect(200);
    const photo = await uploadPassport(auth);
    expect(photo.status).toBe(200);
    const photoUrl = photo.body.data.documents.passportPhoto.url as string;
    expect(cloudinary.files).toContain(photoUrl);
    expect((await UserModel.findById(id).lean())?.avatar).toBe(photoUrl);

    const bill = await uploadBill(auth);
    expect(bill.status).toBe(200);
    expect(bill.body.data.documents.utilityBill.mimeType).toBe('application/pdf');
    expect(bill.body.data.nextStep).toBe('submit');

    // A new passport photograph replaces the old one, and the old file goes.
    const again = await uploadPassport(auth);
    const newUrl = again.body.data.documents.passportPhoto.url as string;
    expect(newUrl).not.toBe(photoUrl);
    expect(cloudinary.files).not.toContain(photoUrl);
    expect((await UserModel.findById(id).lean())?.avatar).toBe(newUrl);
  });

  it('keeps the passport photograph when the customer changes their avatar', async () => {
    const { auth } = await submitted();
    const before = (await state(auth)).documents.passportPhoto.url as string;

    await request(app)
      .delete('/api/v1/users/me/avatar')
      .set('Authorization', auth)
      .expect((res) => expect(res.status).toBeLessThan(300));
    expect(cloudinary.files).toContain(before);
  });

  it('refuses to submit until every step is done', async () => {
    const { auth } = await signIn('ada@example.com');
    await verifyNin(auth).expect(200);
    const res = await request(app).post(`${API}/submit`).set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('KYC_INCOMPLETE');
  });

  it('sends the decision even to customers who turned off notifications', async () => {
    const customer = await submitted();
    await subjectsTo('ada@example.com');
    resend.reset();
    await UserModel.updateOne({ _id: customer.id }, { 'preferences.emailNotifications': false });
    const admin = await signIn('admin@example.com', { role: 'admin' });
    const kyc = await KycVerificationModel.findOne({ user: customer.id });
    await request(app)
      .post(`${API}/admin/verifications/${kyc?.id as string}/approve`)
      .set('Authorization', admin.auth)
      .send({})
      .expect(200);

    expect(await subjectsTo('ada@example.com')).toEqual(['Your identity is verified']);
  });

  it('submits for review, then locks everything', async () => {
    const { auth } = await submitted();
    const data = await state(auth);
    expect(data).toMatchObject({ status: 'in_review', nextStep: 'await_review', editable: false });
    expect(data.submittedAt).toBeTruthy();

    const res = await saveDetails(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('KYC_IN_REVIEW');
    await uploadBill(auth).expect(409);
    await request(app).post(`${API}/submit`).set('Authorization', auth).expect(409);
  });
});

describe('staff review', () => {
  const staff = (role = 'admin') => signIn(`${role}@example.com`, { role });

  it('lists submissions waiting for review, with the full NIN only on the record', async () => {
    const customer = await submitted();
    const admin = await staff();

    const list = await request(app)
      .get(`${API}/admin/verifications?status=in_review&search=jane`)
      .set('Authorization', admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(0);

    const all = await request(app)
      .get(`${API}/admin/verifications?status=in_review&search=ada`)
      .set('Authorization', admin.auth);
    expect(all.body.meta.total).toBe(1);
    const [item] = all.body.data;
    expect(item.user).toMatchObject({ id: customer.id, email: 'ada@example.com' });
    expect(JSON.stringify(all.body)).not.toContain(NIN);

    const one = await request(app)
      .get(`${API}/admin/verifications/${item.id as string}`)
      .set('Authorization', admin.auth);
    expect(one.status).toBe(200);
    expect(one.body.data.nin).toBe(NIN);
    expect(one.body.data.passportPhoto.url).toBeTruthy();
  });

  it('approves, which completes KYC for the customer', async () => {
    const customer = await submitted();
    const admin = await staff();
    const kyc = await KycVerificationModel.findOne({ user: customer.id });

    const res = await request(app)
      .post(`${API}/admin/verifications/${kyc?.id as string}/approve`)
      .set('Authorization', admin.auth)
      .send({ note: 'Photo matches' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', reviewNote: 'Photo matches' });

    const data = await state(customer.auth);
    expect(data).toMatchObject({ status: 'approved', nextStep: 'complete', kycCompleted: true });
    expect(await subjectsTo('ada@example.com')).toEqual([
      'We received your verification',
      'Your identity is verified',
    ]);
    expect(data).not.toHaveProperty('reviewNote');

    const twice = await request(app)
      .post(`${API}/admin/verifications/${kyc?.id as string}/approve`)
      .set('Authorization', admin.auth)
      .send({});
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('KYC_NOT_IN_REVIEW');
  });

  it('rejects with a reason, and the customer can fix it and resubmit', async () => {
    const customer = await submitted();
    const admin = await staff();
    const kyc = await KycVerificationModel.findOne({ user: customer.id });

    await request(app)
      .post(`${API}/admin/verifications/${kyc?.id as string}/reject`)
      .set('Authorization', admin.auth)
      .send({ reason: 'The utility bill is older than three months', note: 'internal' })
      .expect(200);

    const data = await state(customer.auth);
    expect(data).toMatchObject({
      status: 'rejected',
      nextStep: 'submit',
      editable: true,
      kycCompleted: false,
      rejectionReason: 'The utility bill is older than three months',
    });

    // The reason reaches the customer, the staff note doesn't.
    await subjectsTo('ada@example.com');
    const rejection = resend.to('ada@example.com').at(-1);
    expect(rejection?.subject).toBe('We could not verify your identity');
    expect(rejection?.text).toContain('The utility bill is older than three months');
    expect(rejection?.text).not.toContain('internal');

    await uploadBill(customer.auth).expect(200);
    await request(app).post(`${API}/submit`).set('Authorization', customer.auth).expect(200);
    expect((await state(customer.auth)).status).toBe('in_review');
  });

  it('keeps reviews to staff with the right permissions, and not of themselves', async () => {
    const customer = await submitted();
    const kyc = await KycVerificationModel.findOne({ user: customer.id });

    await request(app)
      .get(`${API}/admin/verifications`)
      .set('Authorization', customer.auth)
      .expect(403);

    // Customer support can see the queue but not decide.
    const support = await staff('customer_support');
    await request(app)
      .get(`${API}/admin/verifications`)
      .set('Authorization', support.auth)
      .expect(200);
    await request(app)
      .post(`${API}/admin/verifications/${kyc?.id as string}/approve`)
      .set('Authorization', support.auth)
      .send({})
      .expect(403);

    // An admin who submitted their own KYC can't approve it.
    const admin = await staff();
    await KycVerificationModel.updateOne({ _id: kyc?._id }, { user: admin.id });
    const self = await request(app)
      .post(`${API}/admin/verifications/${kyc?.id as string}/approve`)
      .set('Authorization', admin.auth)
      .send({});
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_REVIEW');
  });
});
