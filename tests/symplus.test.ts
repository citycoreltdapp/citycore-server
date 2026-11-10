import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { env } from '@/config/env';
import { SessionModel } from '@/modules/auth/session.model';
import { CustomerLinkModel } from '@/modules/symplus/customerLink.model';
import { SyncJobModel } from '@/modules/symplus/syncJob.model';
import { syncQueue } from '@/modules/symplus/syncQueue.service';
import { scheduleRecurringSync } from '@/modules/symplus/symplus.worker';
import { UserModel } from '@/modules/user/user.model';
import { decrypt } from '@/utils/encryption';
import { FakeSymplus } from './fakeSymplus';

const API = '/api/v1/symplus';
const ONBOARDING_DETAILS = '/api/v1/onboarding/details';
const ONBOARDING_DOCUMENTS = '/api/v1/onboarding/documents';
const ONBOARDING_REFRESH = '/api/v1/onboarding/refresh';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SERVER_ERROR = { status: 500, body: { message: 'boom' } };

const app = createApp();
const fake = new FakeSymplus();

const onboarding = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  mobile_phone_no: '08012345678',
  gender_cd: 'F',
  address_street: '1 Marina',
  address_city: 'Lagos',
  address_country_cd: 'NGA',
  bank_bvn_no: '12345678901',
};

const created = (reference: Record<string, string>) => ({
  status: 201,
  body: { status: 'success', result: [{ code: 'A', remarks: 'Created', reference }] },
});

const signUp = async (email = 'ada@example.com') => {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Ada Lovelace', email, password: 'Passw0rd123' });
  return {
    id: res.body.data.user.id as string,
    auth: `Bearer ${res.body.data.accessToken as string}`,
  };
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

const onboardActive = async (customerId = 'CUS001') => {
  const user = await signUp();
  fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_id: customerId }));
  await request(app).post(ONBOARDING_DETAILS).set('Authorization', user.auth).send(onboarding);
  return { ...user, customerId };
};

/** Makes every waiting job due now, then runs the queue. */
const runQueue = async () => {
  await SyncJobModel.updateMany({ status: 'pending' }, { runAt: new Date(0) });
  return syncQueue.processDue();
};

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

describe('authentication with Symplus', () => {
  it('requests a token with Basic auth and client_credentials, then reuses it', async () => {
    fake.on('GetCRCSBanks', () => ({ status: 200, body: { GetCRCSBanks: [] } }));
    fake.on('GetCRCSTitle', () => ({ status: 200, body: { GetCRCSTitle: [] } }));
    const { auth } = await signUp();
    fake.revokeTokens();

    await request(app).get(`${API}/reference/banks`).set('Authorization', auth).expect(200);
    await request(app).get(`${API}/reference/titles`).set('Authorization', auth).expect(200);

    const expected = Buffer.from('test-client-key:test-client-secret').toString('base64');
    expect(fake.tokenRequests).toHaveLength(1);
    expect(fake.tokenRequests[0]).toEqual({
      authorization: `Basic ${expected}`,
      body: 'grant_type=client_credentials',
    });
  });

  it('gets a new token and retries when Symplus revokes the current one', async () => {
    const { auth } = await onboardActive();
    fake.on('GetCRCSCustomerDetails', () => ({
      status: 200,
      body: { GetCRCSCustomerDetails: [{ customer_id: 'CUS001' }] },
    }));
    fake.revokeTokens();

    await request(app).get(`${API}/me/details`).set('Authorization', auth).expect(200);
    expect(fake.tokenRequests.length).toBeGreaterThanOrEqual(1);
  });
});

describe('onboarding', () => {
  it('creates a pending customer using server-controlled fields', async () => {
    const { id, auth } = await signUp();
    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_source_reference: 'REF123' }));

    const res = await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send({ ...onboarding, primary_email_address: 'spoof@example.com', officer_id: 'HACK' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'pending',
      sourceReference: 'REF123',
      customerId: null,
    });

    const [call] = fake.callsTo('DoCRCSNewIndividualCustomer');
    expect(call?.body).toEqual({
      customer: [
        {
          ...onboarding,
          primary_email_address: 'ada@example.com',
          external_crm_id: id,
          officer_id: 'OFF1',
        },
      ],
    });
  });

  it('percent-encodes the @ when looking up by email', async () => {
    const { auth } = await signUp();
    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_id: 'CUS001' }));
    await request(app).post(ONBOARDING_DETAILS).set('Authorization', auth).send(onboarding);
    expect(fake.callsTo('GetCRCSCustomerByEmail')[0]?.path).toBe(
      'GetCRCSCustomerByEmail/ada%40example.com',
    );
  });

  it('validates before calling Symplus', async () => {
    const { auth } = await signUp();
    const res = await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send({ ...onboarding, first_name: undefined, bank_bvn_no: '123' });
    expect(res.status).toBe(422);
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['body.first_name', 'body.bank_bvn_no']));
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses to link a Symplus record that belongs to someone else with the same email', async () => {
    const { auth } = await signUp('victim@example.com');
    fake.on('GetCRCSCustomerByEmail', () => ({
      status: 200,
      body: { GetCRCSCustomerByEmail: [{ customer_id: 'VICTIM1' }] },
    }));
    fake.on('GetCRCSCustomerDetails', () => ({
      status: 200,
      body: {
        GetCRCSCustomerDetails: [{ customer_id: 'VICTIM1', external_crm_id: 'someone-else' }],
      },
    }));

    const res = await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYMPLUS_CUSTOMER_EXISTS');
    expect(fake.callsTo('DoCRCSNewIndividualCustomer')).toHaveLength(0);
    const link = await CustomerLinkModel.findOne({});
    expect(link).toMatchObject({ status: 'failed', customerId: null });
  });

  it('marks the link failed and allows a corrected retry when Symplus rejects the data', async () => {
    const { auth } = await signUp();
    fake.failNext('DoCRCSNewIndividualCustomer', {
      status: 400,
      body: { message: 'Invalid gender code' },
    });

    const rejected = await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding);
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({
      code: 'SYMPLUS_REJECTED',
      message: 'Invalid gender code',
    });
    expect(await SyncJobModel.countDocuments()).toBe(0);

    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_id: 'CUS001' }));
    const retried = await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding);
    expect(retried.status).toBe(201);
    expect(retried.body.data.status).toBe('active');
  });

  it('treats a 2xx response with a failure status as a rejection', async () => {
    const { auth } = await signUp();
    fake.on('DoCRCSNewIndividualCustomer', () => ({
      status: 201,
      body: { status: 'failed', result: [{ code: 'E', remarks: 'Duplicate BVN' }] },
    }));
    const res = await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Duplicate BVN');
  });

  it('stops a user onboarding twice', async () => {
    const { auth } = await onboardActive();
    const res = await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_LINKED');
  });
});

describe('retry queue', () => {
  it('queues onboarding during an outage, encrypts it, and completes it later', async () => {
    const { auth } = await signUp();
    fake.on('GetCRCSCustomerByEmail', () => SERVER_ERROR);

    const res = await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding);
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('queued');

    const job = await SyncJobModel.findOne({ type: 'customer.create' });
    expect(job?.payload).not.toContain('12345678901');
    expect(decrypt(job?.payload as string)).toContain('12345678901');

    // Still down: the job stays queued, with the failure recorded and a later retry time.
    expect(await runQueue()).toBe(1);
    const stillPending = await SyncJobModel.findById(job?.id);
    expect(stillPending).toMatchObject({ status: 'pending', attempts: 1 });
    expect(stillPending?.lastError).toContain('SYMPLUS_UNAVAILABLE');
    expect(stillPending?.runAt.getTime()).toBeGreaterThan(Date.now());

    // Symplus recovers.
    fake.routes.delete('GetCRCSCustomerByEmail');
    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_source_reference: 'REF9' }));
    await runQueue();

    expect(await SyncJobModel.findById(job?.id)).toMatchObject({ status: 'succeeded' });
    expect((await SyncJobModel.findById(job?.id))?.payload).toBeUndefined();
    expect(await CustomerLinkModel.findOne({})).toMatchObject({
      status: 'pending',
      sourceReference: 'REF9',
    });
  });

  it('does not create a duplicate if the earlier attempt actually got through', async () => {
    const { id, auth } = await signUp();
    fake.failNext('DoCRCSNewIndividualCustomer', SERVER_ERROR);
    await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding)
      .expect(202);

    // The failed request did reach Symplus, so the customer now shows up by email.
    fake.on('GetCRCSCustomerByEmail', () => ({
      status: 200,
      body: { GetCRCSCustomerByEmail: [{ customer_id: 'CUS777' }] },
    }));
    fake.on('GetCRCSCustomerDetails', () => ({
      status: 200,
      body: { GetCRCSCustomerDetails: [{ customer_id: 'CUS777', external_crm_id: id }] },
    }));

    await runQueue();

    expect(fake.callsTo('DoCRCSNewIndividualCustomer')).toHaveLength(1);
    expect(await CustomerLinkModel.findOne({})).toMatchObject({
      status: 'active',
      customerId: 'CUS777',
    });
  });

  it('never retries a write automatically inside the client', async () => {
    const { auth } = await onboardActive();
    fake.failNext('DoCRCSCustomerTINUpdate', SERVER_ERROR);
    await request(app)
      .patch(`${API}/me/tin`)
      .set('Authorization', auth)
      .send({ tax_identification_no: 'TIN1' })
      .expect(202);
    expect(fake.callsTo('DoCRCSCustomerTINUpdate')).toHaveLength(1);
  });

  it('sends only the newest queued update for a section', async () => {
    const { auth } = await onboardActive();
    fake.on('DoCRCSCustomerTINUpdate', () => SERVER_ERROR);
    for (const tin of ['OLD', 'NEW']) {
      await request(app)
        .patch(`${API}/me/tin`)
        .set('Authorization', auth)
        .send({ tax_identification_no: tin })
        .expect(202);
    }
    expect(await SyncJobModel.countDocuments({ type: 'customer.update' })).toBe(1);

    fake.routes.delete('DoCRCSCustomerTINUpdate');
    fake.requests = [];
    await runQueue();

    const calls = fake.callsTo('DoCRCSCustomerTINUpdate');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      customer: [{ customer_id: 'CUS001', tax_identification_no: 'NEW' }],
    });
  });

  it('gives up after the attempt limit, marks the link failed, and an admin can retry', async () => {
    const { auth } = await signUp();
    const admin = await signUpAdmin();
    fake.on('GetCRCSCustomerByEmail', () => SERVER_ERROR);
    await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding)
      .expect(202);

    for (let i = 0; i < env.SYMPLUS_QUEUE_MAX_ATTEMPTS; i += 1) await runQueue();

    const job = await SyncJobModel.findOne({ type: 'customer.create' });
    expect(job?.status).toBe('dead');
    expect(await CustomerLinkModel.findOne({})).toMatchObject({ status: 'failed' });

    const listed = await request(app)
      .get(`${API}/admin/jobs`)
      .query({ status: 'dead' })
      .set('Authorization', admin);
    expect(listed.body.meta.total).toBe(1);
    expect(listed.body.data[0]).not.toHaveProperty('payload');

    fake.routes.delete('GetCRCSCustomerByEmail');
    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_id: 'CUS5' }));
    await request(app)
      .post(`${API}/admin/jobs/${job?.id as string}/retry`)
      .set('Authorization', admin)
      .expect(200);
    await runQueue();

    expect(await CustomerLinkModel.findOne({})).toMatchObject({
      status: 'active',
      customerId: 'CUS5',
    });
  });

  it('does not queue the same recurring work twice', async () => {
    await onboardActive();
    await scheduleRecurringSync();
    await scheduleRecurringSync();
    expect(await SyncJobModel.countDocuments({ type: 'balance.sync' })).toBe(1);
  });

  it('recovers a job left processing by a crashed server', async () => {
    const { auth } = await signUp();
    fake.failNext('GetCRCSCustomerByEmail', SERVER_ERROR, SERVER_ERROR);
    await request(app)
      .post(ONBOARDING_DETAILS)
      .set('Authorization', auth)
      .send(onboarding)
      .expect(202);
    await SyncJobModel.updateMany({}, { status: 'processing', lockedUntil: new Date(0) });

    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_id: 'CUS8' }));
    expect(await syncQueue.processDue()).toBe(1);
    expect(await CustomerLinkModel.findOne({})).toMatchObject({ customerId: 'CUS8' });
  });
});

describe('registration status', () => {
  const pendingUser = async () => {
    const user = await signUp();
    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_source_reference: 'REF1' }));
    await request(app).post(ONBOARDING_DETAILS).set('Authorization', user.auth).send(onboarding);
    return user;
  };

  const statusIs = (status: string) =>
    fake.on('GetCRCSNewIndividualCustomerStatus', () => ({
      status: 200,
      body: { GetCRCSNewIndividualCustomerStatus: [{ reference_id: 'REF1', status }] },
    }));

  it('activates the link on approval and finds the customer ID', async () => {
    const { id, auth } = await pendingUser();
    statusIs('Approved');
    fake.on('GetCRCSCustomerByEmail', () => ({
      status: 200,
      body: { GetCRCSCustomerByEmail: [{ customer_id: 'CUS42' }] },
    }));
    fake.on('GetCRCSCustomerDetails', () => ({
      status: 200,
      body: { GetCRCSCustomerDetails: [{ customer_id: 'CUS42', external_crm_id: id }] },
    }));

    const res = await request(app).post(ONBOARDING_REFRESH).set('Authorization', auth);
    expect(res.body.data).toMatchObject({
      status: 'active',
      customerId: 'CUS42',
      upstreamStatus: 'Approved',
    });
  });

  it('records a rejection, which allows onboarding again', async () => {
    const { auth } = await pendingUser();
    statusIs('Rejected');
    const res = await request(app).post(ONBOARDING_REFRESH).set('Authorization', auth);
    expect(res.body.data.status).toBe('rejected');
  });

  it('stays pending on an unrecognised status', async () => {
    const { auth } = await pendingUser();
    statusIs('Awaiting Review');
    const res = await request(app).post(ONBOARDING_REFRESH).set('Authorization', auth);
    expect(res.body.data).toMatchObject({ status: 'pending', upstreamStatus: 'Awaiting Review' });
  });

  it('checks pending links through the recurring sync', async () => {
    await pendingUser();
    statusIs('Rejected');
    await scheduleRecurringSync();
    await runQueue();
    expect(await CustomerLinkModel.findOne({})).toMatchObject({ status: 'rejected' });
  });
});

describe('balances', () => {
  const positionsBody = {
    GetCRCSCustomerPosition2: [
      {
        customer_id: 'CUS001',
        product_id: 'P1',
        product_name: 'Golden Estate',
        account_id: 'A1',
        currency_id: 'NGN',
        currency_name: 'Naira',
        current_balance: '1500.50',
        current_value: 1600,
      },
    ],
  };
  const netWorthBody = {
    GetCRCSCustomerPosition: [
      { module_name: 'CASH', currency_id: 'NGN', currency_name: 'Naira', net_worth_amount: 1600 },
    ],
  };

  it('syncs balances, converting amounts to numbers, and serves the snapshot', async () => {
    const { auth } = await onboardActive();
    fake.on('GetCRCSCustomerPosition', () => ({ status: 200, body: netWorthBody }));
    fake.on('GetCRCSCustomerPosition2', () => ({ status: 200, body: positionsBody }));

    const synced = await request(app).post(`${API}/me/balances/sync`).set('Authorization', auth);
    expect(synced.status).toBe(200);
    expect(synced.body.data.positions[0]).toMatchObject({
      productName: 'Golden Estate',
      currentBalance: 1500.5,
    });

    fake.requests = [];
    const stored = await request(app).get(`${API}/me/balances`).set('Authorization', auth);
    expect(stored.body.data.netWorth[0].netWorth).toBe(1600);
    expect(stored.body.data.balancesSyncedAt).toBeTruthy();
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps the last good balances when Symplus sends an unusable amount', async () => {
    const { auth } = await onboardActive();
    fake.on('GetCRCSCustomerPosition', () => ({ status: 200, body: netWorthBody }));
    fake.on('GetCRCSCustomerPosition2', () => ({ status: 200, body: positionsBody }));
    await request(app).post(`${API}/me/balances/sync`).set('Authorization', auth).expect(200);

    fake.on('GetCRCSCustomerPosition2', () => ({
      status: 200,
      body: {
        GetCRCSCustomerPosition2: [
          { ...positionsBody.GetCRCSCustomerPosition2[0], current_balance: 'n/a' },
        ],
      },
    }));
    await request(app).post(`${API}/me/balances/sync`).set('Authorization', auth).expect(502);

    const stored = await request(app).get(`${API}/me/balances`).set('Authorization', auth);
    expect(stored.body.data.positions[0].currentBalance).toBe(1500.5);
  });

  it('syncs active customers through the recurring sync', async () => {
    await onboardActive();
    fake.on('GetCRCSCustomerPosition', () => ({ status: 200, body: netWorthBody }));
    fake.on('GetCRCSCustomerPosition2', () => ({ status: 200, body: positionsBody }));
    await scheduleRecurringSync();
    await runQueue();
    const link = await CustomerLinkModel.findOne({});
    expect(link?.positions).toHaveLength(1);
    expect(link?.balancesSyncedAt).toBeTruthy();
  });

  it('treats a 204 as no holdings', async () => {
    const { auth } = await onboardActive();
    const res = await request(app).post(`${API}/me/balances/sync`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data.positions).toEqual([]);
  });

  it('refuses to sync before the customer is active', async () => {
    const { auth } = await signUp();
    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_source_reference: 'REF1' }));
    await request(app).post(ONBOARDING_DETAILS).set('Authorization', auth).send(onboarding);
    const res = await request(app).post(`${API}/me/balances/sync`).set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_NOT_ACTIVE');
  });
});

describe('customer updates and access', () => {
  it('uses the customer ID from the link, ignoring one in the body', async () => {
    const { auth } = await onboardActive();
    fake.on('DoCRCSUpdateIndividualAddress', () => created({ customer_id: 'CUS001' }));
    await request(app)
      .patch(`${API}/me/address`)
      .set('Authorization', auth)
      .send({ customer_id: 'SOMEONE_ELSE', primary_city: 'Abuja' })
      .expect(200);
    expect(fake.callsTo('DoCRCSUpdateIndividualAddress')[0]?.body).toEqual({
      customer: [{ customer_id: 'CUS001', primary_city: 'Abuja' }],
    });
  });

  it('sends the misspelled adress_city that Symplus expects', async () => {
    const { auth } = await onboardActive();
    await request(app)
      .patch(`${API}/me/employment`)
      .set('Authorization', auth)
      .send({
        employer_name: 'Acme',
        address_street: '1 Road',
        adress_city: 'Lagos',
        address_country_cd: 'NGA',
      })
      .expect(200);
    const [call] = fake.callsTo('DoCRCSUpdateIndividualEmploy');
    expect((call?.body as { customer: Record<string, string>[] }).customer[0]).toHaveProperty(
      'adress_city',
      'Lagos',
    );
  });

  it('keeps admin routes away from ordinary users', async () => {
    const { auth } = await signUp();
    await request(app).get(`${API}/admin/status`).set('Authorization', auth).expect(403);
    await request(app)
      .post(`${API}/admin/customers/search`)
      .set('Authorization', auth)
      .send({ by: 'bvn', value: '12345678901' })
      .expect(403);
    expect(fake.requests).toHaveLength(0);
  });

  it('requires a signed-in user', async () => {
    await request(app).get(`${API}/me`).expect(401);
    await request(app).get(`${API}/reference/banks`).expect(401);
  });
});

describe('documents', () => {
  it('uploads base64 for an active customer, using the Symplus format name', async () => {
    const { auth } = await onboardActive();
    fake.on('DoCRCSIndividualCustomerDoc', () => ({
      status: 201,
      body: { status: 'success', result: [{ code: 'A', remarks: 'Saved' }] },
    }));

    const res = await request(app)
      .post(ONBOARDING_DOCUMENTS)
      .set('Authorization', auth)
      .field('document_type', 'PIX')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(fake.callsTo('DoCRCSIndividualCustomerDoc')[0]?.body).toEqual({
      customer_id: 'CUS001',
      document_type: 'PIX',
      document_mime_type: 'png',
      document_content_base64: PNG.toString('base64'),
    });
  });

  it('uses the source reference while the customer is pending', async () => {
    const { auth } = await signUp();
    fake.on('DoCRCSNewIndividualCustomer', () => created({ customer_source_reference: 'REF1' }));
    await request(app).post(ONBOARDING_DETAILS).set('Authorization', auth).send(onboarding);

    await request(app)
      .post(ONBOARDING_DOCUMENTS)
      .set('Authorization', auth)
      .field('document_type', 'UBL')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);

    expect(fake.callsTo('DoCRCSIndividualCustomerDoc')[0]?.body).toMatchObject({
      customer_source_reference: 'REF1',
    });
  });

  it('enforces the 1MB limit, allowed types and real file contents', async () => {
    const { auth } = await onboardActive();
    const upload = (file: Buffer, contentType: string, type = 'PIX') =>
      request(app)
        .post(ONBOARDING_DOCUMENTS)
        .set('Authorization', auth)
        .field('document_type', type)
        .attach('file', file, { filename: 'f', contentType });

    const tooBig = await upload(Buffer.alloc(1024 * 1024 + 1), 'image/png');
    expect(tooBig.status).toBe(413);

    const gif = await upload(Buffer.from('GIF89a'), 'image/gif');
    expect(gif.body.code).toBe('UNSUPPORTED_FILE_TYPE');

    const fakePng = await upload(Buffer.from('<script>'), 'image/png');
    expect(fakePng.body.code).toBe('INVALID_FILE_CONTENT');

    const wrongType = await upload(PNG, 'image/png', 'XXX');
    expect(wrongType.status).toBe(422);

    expect(fake.callsTo('DoCRCSIndividualCustomerDoc')).toHaveLength(0);
  });

  it('normalises the picture endpoint, which spells its field differently', async () => {
    const { auth } = await onboardActive();
    fake.on('GetCRCSIndividualCusPICBase64', () => ({
      status: 200,
      body: {
        status: 'success',
        result: [
          { GetCRCSIndividualCusPICBase64: [{ image_mime_type: 'png', image_base64: 'QUJD' }] },
        ],
      },
    }));
    const res = await request(app).get(`${API}/me/documents/PIX`).set('Authorization', auth);
    expect(res.body.data).toEqual({ mimeType: 'png', contentBase64: 'QUJD' });
  });
});

describe('reference data', () => {
  it('caches lists and rejects unknown ones', async () => {
    const { auth } = await signUp();
    fake.on('GetCRCSCountries', () => ({
      status: 200,
      body: { GetCRCSCountries: [{ COUNTRY_CODE: 'NGA' }] },
    }));
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).get(`${API}/reference/countries`).set('Authorization', auth);
      expect(res.body.data[0].COUNTRY_CODE).toBe('NGA');
    }
    expect(fake.callsTo('GetCRCSCountries')).toHaveLength(1);
    await request(app).get(`${API}/reference/nope`).set('Authorization', auth).expect(422);
  });
});

describe('admin', () => {
  it('reports connection and queue status', async () => {
    const admin = await signUpAdmin();
    const res = await request(app).get(`${API}/admin/status`).set('Authorization', admin);
    expect(res.body.data).toMatchObject({ enabled: true, connected: true, environment: 'sandbox' });
  });

  it('searches by BVN, using the response key that differs from the endpoint name', async () => {
    const admin = await signUpAdmin();
    fake.on('GetCRCSCustomerByBVN', () => ({
      status: 200,
      body: { GetCRCSCustomerByBank: [{ customer_id: 'CUS1' }] },
    }));
    const res = await request(app)
      .post(`${API}/admin/customers/search`)
      .set('Authorization', admin)
      .send({ by: 'bvn', value: '12345678901' });
    expect(res.body.data).toEqual([{ customer_id: 'CUS1' }]);
  });

  it('links a user to an existing customer only if Symplus confirms the ID', async () => {
    const admin = await signUpAdmin();
    const { id } = await signUp();

    fake.on('GetCRCSIsValidCustomerID', () => ({ status: 200, body: { IsValidCustomerID: 'NO' } }));
    await request(app)
      .post(`${API}/admin/links`)
      .set('Authorization', admin)
      .send({ userId: id, customerId: 'BAD' })
      .expect(422);

    fake.on('GetCRCSIsValidCustomerID', () => ({
      status: 200,
      body: { IsValidCustomerID: 'YES' },
    }));
    const res = await request(app)
      .post(`${API}/admin/links`)
      .set('Authorization', admin)
      .send({ userId: id, customerId: 'CUS9' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'active', customerId: 'CUS9' });
  });

  it('stops one customer being linked to two users', async () => {
    const admin = await signUpAdmin();
    const first = await signUp('first@example.com');
    const second = await signUp('second@example.com');
    fake.on('GetCRCSIsValidCustomerID', () => ({
      status: 200,
      body: { IsValidCustomerID: 'YES' },
    }));

    const link = (userId: string) =>
      request(app)
        .post(`${API}/admin/links`)
        .set('Authorization', admin)
        .send({ userId, customerId: 'CUS9' });

    await link(first.id).expect(201);
    const res = await link(second.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_VALUE');
  });

  it.each([
    [
      'corporate',
      'DoCRCSNewCorporate',
      {
        organization_name: 'Acme',
        primary_email_address: 'a@b.co',
        address_street: 'x',
        address_city: 'y',
        address_country_cd: 'NGA',
        primary_phone_no: '1',
        bank_cd: 'B',
        bank_account_no: '1',
        bank_account_name: 'A',
      },
    ],
    ['minor', 'DoCRCSNewMinor', { prt_exist_yn: '1', p_customer_id: 'CUS1', remarks_text: 'Note' }],
  ])('creates a %s customer', async (kind, endpoint, body) => {
    const admin = await signUpAdmin();
    fake.on(endpoint, () => created({ customer_source_reference: 'REF' }));
    const res = await request(app)
      .post(`${API}/admin/registrations/${kind}`)
      .set('Authorization', admin)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.sourceReference).toBe('REF');
    expect(fake.callsTo(endpoint)[0]?.body).toEqual({ customer: [body] });
  });

  it('applies the rules for a joint or minor registration', async () => {
    const admin = await signUpAdmin();
    const joint = await request(app)
      .post(`${API}/admin/registrations/joint`)
      .set('Authorization', admin)
      .send({ account_name: 'Us' });
    expect(joint.status).toBe(422);
    expect(joint.body.errors.map((e: { path: string }) => e.path)).toContain(
      'body.person2_birth_date',
    );

    const minor = await request(app)
      .post(`${API}/admin/registrations/minor`)
      .set('Authorization', admin)
      .send({ prt_exist_yn: '1', remarks_text: 'x' });
    expect(minor.status).toBe(422);
  });
});
