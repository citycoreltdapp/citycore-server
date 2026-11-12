import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { signupBody } from './signup';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { SessionModel } from '@/modules/auth/session.model';
import { CustomerLinkModel } from '@/modules/symplus/customerLink.model';
import { SyncJobModel } from '@/modules/symplus/syncJob.model';
import { syncQueue } from '@/modules/symplus/syncQueue.service';
import { scheduleRecurringSync } from '@/modules/symplus/symplus.worker';
import { UserModel } from '@/modules/user/user.model';
import { FakeSymplus } from './fakeSymplus';

const API = '/api/v1/onboarding';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const EMAIL = 'ada@example.com';
const PASSWORD = 'Passw0rd123';

const app = createApp();
const fake = new FakeSymplus();

const details = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  mobile_phone_no: '08012345678',
  gender_cd: 'F',
  address_street: '1 Marina',
  address_city: 'Lagos',
  address_country_cd: 'NGA',
};

const created = (reference: Record<string, string>) => ({
  status: 201,
  body: { status: 'success', result: [{ code: 'A', remarks: 'Created', reference }] },
});

const signUp = async () => {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send(signupBody({ name: 'Ada Lovelace', email: EMAIL, password: PASSWORD }));
  return {
    id: res.body.data.user.id as string,
    auth: `Bearer ${res.body.data.accessToken as string}`,
    user: res.body.data.user as Record<string, unknown>,
  };
};

const getState = async (auth: string) =>
  (await request(app).get(API).set('Authorization', auth)).body.data;

const submitDetails = (auth: string) =>
  request(app).post(`${API}/details`).set('Authorization', auth).send(details);

const uploadDocument = (auth: string, type: string) =>
  request(app)
    .post(`${API}/documents`)
    .set('Authorization', auth)
    .field('document_type', type)
    .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });

/** Makes Symplus report this customer, with the given KYC values. */
const symplusReports = (kyc: string, extra: Record<string, unknown> = {}) =>
  fake.on('GetCRCSCustomerDetails', () => ({
    status: 200,
    body: {
      GetCRCSCustomerDetails: [{ customer_id: 'CUS1', kyc_completed: kyc, ...extra }],
    },
  }));

const activate = async () => {
  const user = await signUp();
  fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_id: 'CUS1' }));
  await submitDetails(user.auth).expect(201);
  return user;
};

const pending = async () => {
  const user = await signUp();
  fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_source_reference: 'REF1' }));
  await submitDetails(user.auth).expect(201);
  return user;
};

const registrationStatus = (status: string) =>
  fake.on('GetCRCSNewIndividualCustomerStatus', () => ({
    status: 200,
    body: { GetCRCSNewIndividualCustomerStatus: [{ reference_id: 'REF1', status }] },
  }));

beforeAll(async () => {
  await fake.start(4599);
  await connectDatabase();
  await Promise.all([
    UserModel.init(),
    SessionModel.init(),
    CustomerLinkModel.init(),
    SyncJobModel.init(),
  ]);
});

beforeEach(async () => {
  fake.reset();
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    CustomerLinkModel.deleteMany({}),
    SyncJobModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await disconnectDatabase();
  await fake.stop();
});

describe('before onboarding', () => {
  it('starts with KYC false, and still lets the user in', async () => {
    const { auth, user } = await signUp();
    expect(user.kycCompleted).toBe(false);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.kycCompleted).toBe(false);

    const profile = await request(app).get('/api/v1/users/me').set('Authorization', auth);
    expect(profile.status).toBe(200);
    expect(profile.body.data.kycCompleted).toBe(false);
    await request(app).get('/api/v1/wallet').set('Authorization', auth).expect(200);
  });

  it('tells the frontend to start with the details step, without calling Symplus', async () => {
    const { auth } = await signUp();
    expect(await getState(auth)).toMatchObject({
      available: true,
      kycCompleted: false,
      status: 'not_started',
      nextStep: 'submit_details',
      documents: [
        { type: 'PIX', label: 'Passport photograph', submitted: false },
        { type: 'IDN', label: 'Means of identification', submitted: false },
        { type: 'SIG', label: 'Signature', submitted: false },
        { type: 'UBL', label: 'Utility bill', submitted: false },
      ],
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('requires a signed-in user', async () => {
    await request(app).get(API).expect(401);
    await request(app).post(`${API}/details`).send(details).expect(401);
  });
});

describe('the onboarding flow', () => {
  it('goes from sign up to KYC complete, following Symplus', async () => {
    const { auth } = await pending();

    let state = await getState(auth);
    expect(state).toMatchObject({
      status: 'pending',
      nextStep: 'upload_documents',
      sourceReference: 'REF1',
      kycCompleted: false,
    });

    fake.on('DoCRCSIndividualCustomerDoc', () => created({ customer_id: '' }));
    for (const type of ['PIX', 'IDN', 'SIG']) await uploadDocument(auth, type).expect(201);
    state = await getState(auth);
    expect(state.nextStep).toBe('upload_documents');
    expect(state.documents.map((d: { submitted: boolean }) => d.submitted)).toEqual([
      true,
      true,
      true,
      false,
    ]);

    const last = await uploadDocument(auth, 'UBL');
    expect(last.body.data.nextStep).toBe('await_review');
    expect(fake.callsTo('DoCRCSIndividualCustomerDoc')[0]?.body).toMatchObject({
      customer_source_reference: 'REF1',
      document_type: 'PIX',
    });

    registrationStatus('Pending');
    let refreshed = await request(app).post(`${API}/refresh`).set('Authorization', auth);
    expect(refreshed.body.data).toMatchObject({ status: 'pending', nextStep: 'await_review' });

    // Approved as a customer, but Symplus hasn't finished KYC.
    const { id } = await UserModel.findOne({ email: EMAIL }).orFail();
    registrationStatus('Approved');
    fake.on('GetCRCSCustomerByEmail', () => ({
      status: 200,
      body: { GetCRCSCustomerByEmail: [{ customer_id: 'CUS1' }] },
    }));
    symplusReports('NO', { external_crm_id: id });
    refreshed = await request(app).post(`${API}/refresh`).set('Authorization', auth);
    expect(refreshed.body.data).toMatchObject({
      status: 'active',
      customerId: 'CUS1',
      kycCompleted: false,
      nextStep: 'await_review',
    });

    // Symplus completes KYC.
    symplusReports('YES', { external_crm_id: id });
    refreshed = await request(app).post(`${API}/refresh`).set('Authorization', auth);
    expect(refreshed.body.data).toMatchObject({ kycCompleted: true, nextStep: 'complete' });
    expect(refreshed.body.data.kycCompletedAt).toBeTruthy();

    const profile = await request(app).get('/api/v1/users/me').set('Authorization', auth);
    expect(profile.body.data.kycCompleted).toBe(true);
  });

  it('completes straight away if Symplus has already finished KYC', async () => {
    symplusReports('Y');
    const { auth } = await activate();
    expect(await getState(auth)).toMatchObject({ kycCompleted: true, nextStep: 'complete' });
  });

  it('tells the frontend when details are queued during an outage', async () => {
    const { auth } = await signUp();
    fake.on('GetCRCSCustomerByEmail', () => ({ status: 500, body: {} }));
    const res = await submitDetails(auth);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'queued', nextStep: 'processing' });
  });

  it('stops documents being uploaded before the details step', async () => {
    const { auth } = await signUp();
    await uploadDocument(auth, 'PIX').expect(404);
    expect(fake.requests).toHaveLength(0);
  });

  it('does not count a document Symplus refused', async () => {
    const { auth } = await pending();
    fake.failNext('DoCRCSIndividualCustomerDoc', { status: 400, body: { message: 'Too large' } });
    await uploadDocument(auth, 'PIX').expect(400);
    const state = await getState(auth);
    expect(state.documents[0].submitted).toBe(false);
  });

  it('sends rejected customers back to the start, as a genuinely new registration', async () => {
    const { auth } = await pending();
    fake.on('DoCRCSIndividualCustomerDoc', () => created({ customer_id: '' }));
    await uploadDocument(auth, 'PIX').expect(201);

    registrationStatus('Rejected');
    const rejected = await request(app).post(`${API}/refresh`).set('Authorization', auth);
    expect(rejected.body.data).toMatchObject({ status: 'rejected', nextStep: 'submit_details' });

    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_source_reference: 'REF2' }));
    const again = await submitDetails(auth);
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({
      status: 'pending',
      sourceReference: 'REF2',
      nextStep: 'upload_documents',
    });
    expect(again.body.data.documents[0].submitted).toBe(false);
    expect(fake.callsTo('DoCRCSNewIndividualCustomer')).toHaveLength(2);
  });

  it('shows the reason when Symplus turns the details down', async () => {
    const { auth } = await signUp();
    fake.failNext('DoCRCSNewIndividualCustomer', {
      status: 400,
      body: { message: 'Invalid gender code' },
    });
    await submitDetails(auth).expect(400);
    expect(await getState(auth)).toMatchObject({
      status: 'failed',
      nextStep: 'submit_details',
      lastError: 'Invalid gender code',
    });
  });
});

describe('who decides KYC is complete', () => {
  it('cannot be set by the user', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(signupBody({ name: 'Ada Lovelace', email: EMAIL, password: PASSWORD, kycCompleted: true }));
    expect(res.body.data.user.kycCompleted).toBe(false);
    const auth = `Bearer ${res.body.data.accessToken as string}`;

    const update = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', auth)
      .send({ name: 'New Name', kycCompleted: true, kycCompletedAt: new Date() });
    expect(update.body.data.kycCompleted).toBe(false);
    expect((await UserModel.findOne({ email: EMAIL }))?.kycCompleted).toBe(false);
  });

  it('is not implied by uploading every document', async () => {
    const { auth } = await activate();
    fake.on('DoCRCSIndividualCustomerDoc', () => created({ customer_id: 'CUS1' }));
    for (const type of ['PIX', 'IDN', 'SIG', 'UBL']) await uploadDocument(auth, type).expect(201);
    expect(await getState(auth)).toMatchObject({ kycCompleted: false, nextStep: 'await_review' });
  });

  it.each([
    ['YES', true],
    ['Y', true],
    ['yes', true],
    ['NO', false],
    ['N', false],
    ['', false],
    ['Pending', false],
  ])('treats a Symplus value of "%s" as %s', async (value, expected) => {
    const { auth } = await activate();
    symplusReports(value);
    const res = await request(app).post(`${API}/refresh`).set('Authorization', auth);
    expect(res.body.data.kycCompleted).toBe(expected);
    expect(await CustomerLinkModel.findOne({})).toMatchObject({ upstreamKyc: value });
  });

  it('is off for a blacklisted customer, and turns off if Symplus withdraws it', async () => {
    const { auth } = await activate();
    const refresh = () => request(app).post(`${API}/refresh`).set('Authorization', auth);

    symplusReports('YES');
    expect((await refresh()).body.data.kycCompleted).toBe(true);

    symplusReports('YES', { is_blacklisted_yesno: 'YES' });
    const blacklisted = await refresh();
    expect(blacklisted.body.data.kycCompleted).toBe(false);
    expect(blacklisted.body.data.kycCompletedAt).toBeNull();

    symplusReports('YES');
    expect((await refresh()).body.data.kycCompleted).toBe(true);
    symplusReports('NO');
    expect((await refresh()).body.data.kycCompleted).toBe(false);
  });

  it('leaves the status alone if Symplus returns nothing or fails', async () => {
    const { auth } = await activate();
    symplusReports('YES');
    await request(app).post(`${API}/refresh`).set('Authorization', auth).expect(200);

    fake.routes.delete('GetCRCSCustomerDetails');
    await request(app).post(`${API}/refresh`).set('Authorization', auth).expect(200);
    expect((await getState(auth)).kycCompleted).toBe(true);

    fake.on('GetCRCSCustomerDetails', () => ({ status: 500, body: {} }));
    await request(app).post(`${API}/refresh`).set('Authorization', auth).expect(502);
    expect((await getState(auth)).kycCompleted).toBe(true);
  });

  it('does not lose an approval just because the KYC check failed', async () => {
    const { id, auth } = await pending();
    registrationStatus('Approved');
    fake.on('GetCRCSCustomerByEmail', () => ({
      status: 200,
      body: { GetCRCSCustomerByEmail: [{ customer_id: 'CUS1' }] },
    }));
    // The first lookup confirms it's their record. The KYC check straight after it fails.
    fake.failNext('GetCRCSCustomerDetails', {
      status: 200,
      body: { GetCRCSCustomerDetails: [{ customer_id: 'CUS1', external_crm_id: id }] },
    });
    fake.on('GetCRCSCustomerDetails', () => ({ status: 500, body: {} }));

    const res = await request(app).post(`${API}/refresh`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'active',
      customerId: 'CUS1',
      kycCompleted: false,
    });
  });

  it('is kept up to date in the background', async () => {
    const { auth } = await activate();
    symplusReports('YES');

    await scheduleRecurringSync();
    await SyncJobModel.updateMany({ status: 'pending' }, { runAt: new Date(0) });
    await syncQueue.processDue();

    expect((await getState(auth)).kycCompleted).toBe(true);
  });
});
