import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { SessionModel } from '@/modules/auth/session.model';
import { TicketModel } from '@/modules/helpdesk/ticket.model';
import { CustomerLinkModel, type LinkStatus } from '@/modules/symplus/customerLink.model';
import { UserModel } from '@/modules/user/user.model';
import { WalletModel } from '@/modules/wallet/wallet.model';
import { FakeCloudinary } from './fakeCloudinary';

const app = createApp();
const cloudinary = new FakeCloudinary();
const API = '/api/v1';
const ME = `${API}/users/me`;
const PASSWORD = 'Passw0rd123';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);
const ID = '507f1f77bcf86cd799439011';

const address = { line1: '12 Marina Road', city: 'Lagos', state: 'Lagos', country: 'ng' };

const login = (email: string, agent = 'test-device') =>
  request(app)
    .post(`${API}/auth/login`)
    .set('User-Agent', agent)
    .send({ email, password: PASSWORD });

const cookieOf = (res: request.Response): string => {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find((value) => value.startsWith('refreshToken='));
  if (!cookie) throw new Error('No refresh cookie');
  return cookie.split(';')[0] as string;
};

const signIn = async (name: string, role: string) => {
  const email = `${name}@example.com`;
  const user = await UserModel.create({ name: `Test ${name}`, email, password: PASSWORD, role });
  const res = await login(email);
  return {
    id: user.id as string,
    email,
    auth: `Bearer ${res.body.data.accessToken as string}`,
    cookie: cookieOf(res),
  };
};

let customer: Awaited<ReturnType<typeof signIn>>;
let admin: Awaited<ReturnType<typeof signIn>>;

const patchMe = (body: object, auth = customer.auth) =>
  request(app).patch(ME).set('Authorization', auth).send(body);

const uploadAvatar = (url: string, auth: string) =>
  request(app)
    .put(url)
    .set('Authorization', auth)
    .attach('avatar', PNG, { filename: 'a.png', contentType: 'image/png' });

beforeAll(async () => {
  await cloudinary.start(4597);
  await connectDatabase();
  await Promise.all([UserModel.init(), SessionModel.init()]);
});

beforeEach(async () => {
  cloudinary.reset();
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    CustomerLinkModel.deleteMany({}),
    WalletModel.deleteMany({}),
    TicketModel.deleteMany({}),
  ]);
  customer = await signIn('customer', 'user');
  admin = await signIn('admin', 'admin');
});

afterAll(async () => {
  await cloudinary.stop();
  await disconnectDatabase();
});

describe('your own profile', () => {
  it('starts empty, and saves and clears each field', async () => {
    const empty = await request(app).get(ME).set('Authorization', customer.auth);
    expect(empty.body.data).toMatchObject({ phone: null, dateOfBirth: null, address: null });
    expect(empty.body.data).not.toHaveProperty('password');

    const saved = await patchMe({
      name: 'New Name',
      phone: '+2348012345678',
      dateOfBirth: '1990-04-12',
      address,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      name: 'New Name',
      phone: '+2348012345678',
      address: { line1: '12 Marina Road', country: 'NG' },
    });
    expect(saved.body.data.dateOfBirth).toMatch(/^1990-04-12/);
    expect(saved.body.data.address).not.toHaveProperty('id');

    const read = await request(app).get(ME).set('Authorization', customer.auth);
    expect(read.body.data.phone).toBe('+2348012345678');

    const cleared = await patchMe({ phone: null, dateOfBirth: null, address: null });
    expect(cleared.body.data).toMatchObject({ phone: null, dateOfBirth: null, address: null });
    expect(cleared.body.data.name).toBe('New Name');
  });

  it('leaves untouched fields alone', async () => {
    await patchMe({ phone: '+2348012345678' });
    const res = await patchMe({ name: 'Another Name' });
    expect(res.body.data.phone).toBe('+2348012345678');
  });

  it.each([
    ['nothing', {}],
    ['a name that is null', { name: null }],
    ['a phone with no country code', { phone: '08012345678' }],
    ['a future birth date', { dateOfBirth: '2999-01-01' }],
    ['an ancient birth date', { dateOfBirth: '1800-01-01' }],
    ['a birth date that is not a date', { dateOfBirth: '2020-13-45' }],
    ['an incomplete address', { address: { line1: 'Somewhere' } }],
    ['a bad country', { address: { ...address, country: 'Nigeria' } }],
  ])('rejects %s', async (_name, body) => {
    expect((await patchMe(body)).status).toBe(422);
  });

  it('cannot change role, email, status or password through the profile', async () => {
    const res = await patchMe({
      name: 'Still Me',
      role: 'admin',
      email: 'new@example.com',
      isActive: false,
      password: 'Another123',
      tokenVersion: 9,
    });
    expect(res.body.data).toMatchObject({
      role: 'user',
      email: customer.email,
      isActive: true,
    });
    expect((await login(customer.email)).status).toBe(200);
  });

  it('gives work details to staff but not customers', async () => {
    const staff = await patchMe({ jobTitle: 'Head of Support', department: 'CX' }, admin.auth);
    expect(staff.body.data).toMatchObject({ jobTitle: 'Head of Support', department: 'CX' });

    const mixed = await patchMe({ name: 'Mixed Up', jobTitle: 'CEO' });
    expect(mixed.body.data).toMatchObject({ name: 'Mixed Up', jobTitle: null });

    expect((await patchMe({ jobTitle: 'CEO' })).status).toBe(403);
  });

  it('removes the avatar and its file', async () => {
    const { body } = await uploadAvatar(`${ME}/avatar`, customer.auth);
    const url = body.data.avatar as string;
    expect(cloudinary.files).toContain(url);

    const res = await request(app).delete(`${ME}/avatar`).set('Authorization', customer.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.avatar).toBeNull();
    expect(cloudinary.files).not.toContain(url);

    const again = await request(app).delete(`${ME}/avatar`).set('Authorization', customer.auth);
    expect(again.status).toBe(200);
  });
});

describe('personal details', () => {
  const nextOfKin = { name: 'Ada Obi', relationship: 'Sister', phone: '+2348011111111' };

  it('saves and clears every field', async () => {
    const saved = await patchMe({
      alternatePhone: '+2348087654321',
      gender: 'female',
      maritalStatus: 'single',
      nationality: 'ng',
      occupation: 'Engineer',
      employer: 'Acme Ltd',
      nextOfKin,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      alternatePhone: '+2348087654321',
      gender: 'female',
      maritalStatus: 'single',
      nationality: 'NG',
      occupation: 'Engineer',
      employer: 'Acme Ltd',
      nextOfKin: { ...nextOfKin, email: null, address: null },
    });
    expect(saved.body.data.nextOfKin).not.toHaveProperty('id');

    const read = await request(app).get(ME).set('Authorization', customer.auth);
    expect(read.body.data).toMatchObject({ gender: 'female', nextOfKin });

    const cleared = await patchMe({
      alternatePhone: null,
      gender: null,
      maritalStatus: null,
      nationality: null,
      occupation: null,
      employer: null,
      nextOfKin: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ gender: null, nextOfKin: null, employer: null });
  });

  it('has default preferences, and changes one without resetting the rest', async () => {
    const first = await patchMe({ preferences: { language: 'fr', smsNotifications: false } });
    expect(first.body.data.preferences).toEqual({
      language: 'fr',
      timezone: 'Africa/Lagos',
      emailNotifications: true,
      smsNotifications: false,
      pushNotifications: true,
    });

    const second = await patchMe({ preferences: { timezone: 'Europe/London' } });
    expect(second.body.data.preferences).toMatchObject({
      language: 'fr',
      timezone: 'Europe/London',
      smsNotifications: false,
    });
  });

  it.each([
    ['an unknown gender', { gender: 'robot' }],
    ['an unknown marital status', { maritalStatus: 'it is complicated' }],
    ['a bad nationality', { nationality: 'Nigeria' }],
    ['a bad alternate phone', { alternatePhone: '0801' }],
    ['an incomplete next of kin', { nextOfKin: { name: 'Ada Obi' } }],
    ['a bad next of kin phone', { nextOfKin: { ...nextOfKin, phone: '0801' } }],
    ['an unknown time zone', { preferences: { timezone: 'Mars/Olympus' } }],
    ['a bad language', { preferences: { language: 'english' } }],
    ['preferences that are null', { preferences: null }],
  ])('rejects %s', async (_name, body) => {
    expect((await patchMe(body)).status).toBe(422);
  });

  it('does not let anyone set their own employee ID', async () => {
    const res = await patchMe({ name: 'Still Admin', employeeId: 'EMP-1' }, admin.auth);
    expect(res.body.data).toMatchObject({ name: 'Still Admin', employeeId: null });
  });
});

describe('changing email', () => {
  const change = (body: object, auth = customer.auth) =>
    request(app).post(`${API}/auth/change-email`).set('Authorization', auth).send(body);

  it('changes the sign-in email once the password is confirmed', async () => {
    const wrong = await change({ email: 'new@example.com', currentPassword: 'Wrong1234' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_CURRENT_PASSWORD');

    const res = await change({ email: 'NEW@example.com', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('new@example.com');
    expect(res.body.data).not.toHaveProperty('password');

    expect((await login('new@example.com')).status).toBe(200);
    expect((await login(customer.email)).status).toBe(401);
  });

  it('keeps the password working after the change', async () => {
    await change({ email: 'new@example.com', currentPassword: PASSWORD });
    const again = await change({ email: 'newer@example.com', currentPassword: PASSWORD });
    expect(again.status).toBe(200);
  });

  it('rejects an email in use, or the same one', async () => {
    const taken = await change({ email: admin.email, currentPassword: PASSWORD });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('DUPLICATE_VALUE');

    const same = await change({ email: customer.email, currentPassword: PASSWORD });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('EMAIL_UNCHANGED');
  });

  it.each([
    ['queued', 409],
    ['pending', 409],
    ['active', 409],
    ['failed', 200],
    ['rejected', 200],
  ])('with a %s core banking profile, responds %i', async (status, expected) => {
    await CustomerLinkModel.create({
      user: customer.id,
      status: status as LinkStatus,
      customerType: 'individual',
    });
    const res = await change({ email: 'new@example.com', currentPassword: PASSWORD });
    expect(res.status).toBe(expected);
    if (expected === 409) expect(res.body.code).toBe('EMAIL_LOCKED');
  });
});

describe('sessions', () => {
  const list = (auth = customer.auth, cookie = customer.cookie) =>
    request(app).get(`${API}/auth/sessions`).set('Authorization', auth).set('Cookie', cookie);

  it('lists your devices, marks this one, and never shows the token hash', async () => {
    await login(customer.email, 'other-device');
    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const current = (res.body.data as { current: boolean; userAgent: string }[]).filter(
      (session) => session.current,
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.userAgent).toBe('test-device');
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');
  });

  it('shows the same device once after a refresh', async () => {
    const refreshed = await request(app).post(`${API}/auth/refresh`).set('Cookie', customer.cookie);
    const res = await list(customer.auth, cookieOf(refreshed));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].current).toBe(true);
  });

  it('signs out one device without tripping theft detection on the others', async () => {
    const otherDevice = await login(customer.email, 'other-device');
    const sessions = (await list()).body.data as { id: string; current: boolean }[];
    const other = sessions.find((session) => !session.current);

    const removed = await request(app)
      .delete(`${API}/auth/sessions/${other?.id as string}`)
      .set('Authorization', customer.auth)
      .set('Cookie', customer.cookie);
    expect(removed.status).toBe(204);

    // The signed-out device tries to refresh, as it would by itself.
    const stale = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', cookieOf(otherDevice));
    expect(stale.status).toBe(401);

    const thisDevice = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', customer.cookie);
    expect(thisDevice.status).toBe(200);
  });

  it('clears the cookie when you sign out this device', async () => {
    const [current] = (await list()).body.data as { id: string }[];
    const res = await request(app)
      .delete(`${API}/auth/sessions/${current?.id as string}`)
      .set('Authorization', customer.auth)
      .set('Cookie', customer.cookie);
    expect(res.status).toBe(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/^refreshToken=;/);
  });

  it("cannot touch someone else's session", async () => {
    const [theirs] = (await list(admin.auth, admin.cookie)).body.data as { id: string }[];
    const url = `${API}/auth/sessions/${theirs?.id as string}`;
    const res = await request(app).delete(url).set('Authorization', customer.auth);
    expect(res.status).toBe(404);
    expect((await list(admin.auth, admin.cookie)).body.data).toHaveLength(1);
  });

  it('requires a token', async () => {
    expect((await request(app).get(`${API}/auth/sessions`)).status).toBe(401);
  });
});

describe('closing an account', () => {
  const close = (auth: string, currentPassword = PASSWORD) =>
    request(app)
      .post(`${API}/auth/close-account`)
      .set('Authorization', auth)
      .send({ currentPassword });

  it('needs the password', async () => {
    const res = await close(customer.auth, 'Wrong1234');
    expect(res.status).toBe(400);
    expect((await UserModel.findById(customer.id))?.isActive).toBe(true);
  });

  it('deactivates the account and ends every session at once', async () => {
    const res = await close(customer.auth);
    expect(res.status).toBe(204);

    const stored = await UserModel.findById(customer.id);
    expect(stored?.isActive).toBe(false);

    expect((await request(app).get(ME).set('Authorization', customer.auth)).status).toBe(401);
    const refresh = await request(app).post(`${API}/auth/refresh`).set('Cookie', customer.cookie);
    expect(refresh.status).toBe(401);
    const again = await login(customer.email);
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('ACCOUNT_DISABLED');
  });

  it('can be undone by an admin', async () => {
    await close(customer.auth);
    const restored = await request(app)
      .patch(`${API}/users/${customer.id}`)
      .set('Authorization', admin.auth)
      .send({ isActive: true });
    expect(restored.status).toBe(200);
    expect((await login(customer.email)).status).toBe(200);
  });

  it('refuses while the wallet holds money', async () => {
    await WalletModel.create({ user: customer.id, balance: 500 });
    const res = await close(customer.auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WALLET_NOT_EMPTY');
    expect((await UserModel.findById(customer.id))?.isActive).toBe(true);
  });

  it('does not let the last super admin leave', async () => {
    const first = await signIn('root', 'super_admin');
    const res = await close(first.auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_SUPER_ADMIN');

    await signIn('root2', 'super_admin');
    expect((await close(first.auth)).status).toBe(204);
  });
});

describe('staff working on a profile', () => {
  const url = () => `${API}/users/${customer.id}`;

  it('reads and updates all profile fields', async () => {
    const res = await request(app)
      .patch(url())
      .set('Authorization', admin.auth)
      .send({ phone: '+2348012345678', address, jobTitle: 'Teller', department: 'Ops' });
    expect(res.status).toBe(200);

    const read = await request(app).get(url()).set('Authorization', admin.auth);
    expect(read.body.data).toMatchObject({
      phone: '+2348012345678',
      address: { city: 'Lagos', country: 'NG' },
      jobTitle: 'Teller',
      department: 'Ops',
    });
  });

  it.each([
    ['queued', 409],
    ['pending', 409],
    ['active', 409],
    ['failed', 200],
    ['rejected', 200],
  ])('changing email with a %s core banking profile responds %i', async (status, expected) => {
    await CustomerLinkModel.create({
      user: customer.id,
      status: status as LinkStatus,
      customerType: 'individual',
    });
    const res = await request(app)
      .patch(url())
      .set('Authorization', admin.auth)
      .send({ email: 'new@example.com' });

    expect(res.status).toBe(expected);
    const stored = await UserModel.findById(customer.id);
    if (expected === 409) {
      expect(res.body.code).toBe('EMAIL_LOCKED');
      expect(stored?.email).toBe(customer.email);
    } else {
      expect(stored?.email).toBe('new@example.com');
    }
  });

  it('still updates a linked user when their email is not changing', async () => {
    await CustomerLinkModel.create({
      user: customer.id,
      status: 'active',
      customerType: 'individual',
    });
    const res = await request(app)
      .patch(url())
      .set('Authorization', admin.auth)
      .send({ email: customer.email, phone: '+2348012345678' });

    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('+2348012345678');
  });

  it('creates an account complete with its profile', async () => {
    const res = await request(app)
      .post(`${API}/users`)
      .set('Authorization', admin.auth)
      .send({
        name: 'New Teller',
        email: 'teller@example.com',
        password: PASSWORD,
        role: 'customer_support',
        phone: '+2348012345678',
        address,
        gender: 'male',
        jobTitle: 'Teller',
        department: 'Ops',
        employeeId: 'EMP-100',
        preferences: { language: 'fr' },
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      phone: '+2348012345678',
      gender: 'male',
      jobTitle: 'Teller',
      employeeId: 'EMP-100',
      preferences: { language: 'fr', timezone: 'Africa/Lagos' },
    });
    expect((await login('teller@example.com')).status).toBe(200);
  });

  it('still creates an account from the required fields alone', async () => {
    const res = await request(app)
      .post(`${API}/users`)
      .set('Authorization', admin.auth)
      .send({ name: 'Bare Minimum', email: 'bare@example.com', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ phone: null, employeeId: null });
  });

  it('keeps employee IDs unique, while any number of people can have none', async () => {
    const set = (id: string, employeeId: string | null) =>
      request(app)
        .patch(`${API}/users/${id}`)
        .set('Authorization', admin.auth)
        .send({ employeeId });
    const other = await signIn('other', 'customer_support');

    expect((await set(customer.id, 'EMP-1')).body.data.employeeId).toBe('EMP-1');
    const taken = await set(other.id, 'EMP-1');
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('DUPLICATE_VALUE');

    expect((await set(customer.id, null)).status).toBe(200);
    expect((await set(other.id, null)).status).toBe(200);
    expect((await set(other.id, 'EMP-1')).status).toBe(200);
  });

  it('finds staff by department and employee ID', async () => {
    const other = await signIn('other', 'customer_support');
    await request(app)
      .patch(`${API}/users/${other.id}`)
      .set('Authorization', admin.auth)
      .send({ department: 'Ops', employeeId: 'EMP-77' });

    for (const query of ['department=Ops', 'search=EMP-77']) {
      const res = await request(app).get(`${API}/users?${query}`).set('Authorization', admin.auth);
      expect(res.body.data.map((u: { id: string }) => u.id)).toEqual([other.id]);
    }
  });

  it('signs a user out everywhere when deactivating them', async () => {
    const res = await request(app)
      .patch(url())
      .set('Authorization', admin.auth)
      .send({ isActive: false });
    expect(res.status).toBe(200);

    await request(app).patch(url()).set('Authorization', admin.auth).send({ isActive: true });

    expect((await request(app).get(ME).set('Authorization', customer.auth)).status).toBe(401);
    const refresh = await request(app).post(`${API}/auth/refresh`).set('Cookie', customer.cookie);
    expect(refresh.status).toBe(401);
    expect((await login(customer.email)).status).toBe(200);
  });

  describe('their devices', () => {
    const sessions = (auth = admin.auth, id = customer.id) =>
      request(app).get(`${API}/users/${id}/sessions`).set('Authorization', auth);

    it('lists them without the token hash', async () => {
      await login(customer.email, 'other-device');
      const res = await sessions();
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(JSON.stringify(res.body)).not.toContain('tokenHash');
    });

    it('signs out one and leaves the others', async () => {
      const otherDevice = await login(customer.email, 'other-device');
      const list = (await sessions()).body.data as { id: string; userAgent: string }[];
      const target = list.find((session) => session.userAgent === 'other-device');

      const removed = await request(app)
        .delete(`${url()}/sessions/${target?.id as string}`)
        .set('Authorization', admin.auth);
      expect(removed.status).toBe(204);

      const stale = await request(app)
        .post(`${API}/auth/refresh`)
        .set('Cookie', cookieOf(otherDevice));
      expect(stale.status).toBe(401);
      const kept = await request(app).post(`${API}/auth/refresh`).set('Cookie', customer.cookie);
      expect(kept.status).toBe(200);
    });

    it("can't end a session through the wrong user", async () => {
      const [theirs] = (await request(app)
        .get(`${API}/auth/sessions`)
        .set('Authorization', customer.auth)
        .then((res) => res.body.data)) as { id: string }[];
      const other = await signIn('other', 'user');

      const res = await request(app)
        .delete(`${API}/users/${other.id}/sessions/${theirs?.id as string}`)
        .set('Authorization', admin.auth);
      expect(res.status).toBe(404);
      expect((await sessions()).body.data).toHaveLength(1);
    });

    it('stays out of reach above your level, and of those without the permission', async () => {
      const peer = await signIn('peer', 'admin');
      expect((await sessions(admin.auth, peer.id)).status).toBe(403);
      expect((await sessions(admin.auth, admin.id)).status).toBe(403);
      expect((await sessions(customer.auth, admin.id)).status).toBe(403);

      const support = await signIn('support', 'customer_support');
      expect((await sessions(support.auth)).status).toBe(200);
      const [session] = (await sessions()).body.data as { id: string }[];
      const res = await request(app)
        .delete(`${url()}/sessions/${session?.id as string}`)
        .set('Authorization', support.auth);
      expect(res.status).toBe(403);
    });
  });

  describe('overview', () => {
    const overview = (auth = admin.auth) =>
      request(app).get(`${url()}/overview`).set('Authorization', auth);

    it('summarises what is linked to the account', async () => {
      await WalletModel.create({ user: customer.id, balance: 500 });
      await CustomerLinkModel.create({
        user: customer.id,
        status: 'active',
        customerType: 'individual',
        customerId: 'C1',
      });
      await TicketModel.collection.insertMany([
        { number: 'TKT-1', requester: new Types.ObjectId(customer.id), status: 'open' },
        { number: 'TKT-2', requester: new Types.ObjectId(customer.id), status: 'closed' },
      ]);

      const res = await overview();
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        user: { id: customer.id, email: customer.email },
        activeSessions: 1,
        wallet: { balance: 500, currency: 'NGN', virtualAccountStatus: 'none' },
        coreBanking: { status: 'active', customerId: 'C1' },
        tickets: { active: 1, total: 2 },
      });
      expect(JSON.stringify(res.body)).not.toContain('paystackCustomerCode');
    });

    it('is empty rather than failing for a new account', async () => {
      const res = await overview();
      expect(res.body.data).toMatchObject({
        wallet: { balance: 0 },
        coreBanking: null,
        tickets: { active: 0, total: 0 },
      });
    });

    it('leaves out what the caller may not see', async () => {
      const support = await signIn('support', 'customer_support');
      const res = await overview(support.auth);
      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty('wallet');
      expect(res.body.data).toHaveProperty('coreBanking');
      expect(res.body.data).toHaveProperty('tickets');

      const accountant = await signIn('accountant', 'accountant');
      const money = await overview(accountant.auth);
      expect(money.body.data).toHaveProperty('wallet');
      expect(money.body.data).not.toHaveProperty('tickets');
    });

    it('is closed to customers and those without users.read', async () => {
      expect((await overview(customer.auth)).status).toBe(403);
      const editor = await signIn('editor', 'editor');
      expect((await overview(editor.auth)).status).toBe(403);
    });
  });

  it('validates fields the same way', async () => {
    const res = await request(app)
      .patch(url())
      .set('Authorization', admin.auth)
      .send({ phone: 'nope' });
    expect(res.status).toBe(422);
  });

  it('searches by phone', async () => {
    await patchMe({ phone: '+2348012345678' });
    const res = await request(app)
      .get(`${API}/users?search=${encodeURIComponent('+2348012345678')}`)
      .set('Authorization', admin.auth);
    expect(res.body.data.map((u: { id: string }) => u.id)).toEqual([customer.id]);
  });

  it("replaces and removes a user's avatar", async () => {
    const replaced = await uploadAvatar(`${url()}/avatar`, admin.auth);
    expect(replaced.status).toBe(200);
    const file = replaced.body.data.avatar as string;
    expect(cloudinary.files).toContain(file);

    const removed = await request(app).delete(`${url()}/avatar`).set('Authorization', admin.auth);
    expect(removed.body.data.avatar).toBeNull();
    expect(cloudinary.files).not.toContain(file);
  });

  it('signs a user out of everything at once', async () => {
    const res = await request(app).post(`${url()}/sign-out`).set('Authorization', admin.auth);
    expect(res.status).toBe(204);
    expect((await request(app).get(ME).set('Authorization', customer.auth)).status).toBe(401);
    const refresh = await request(app).post(`${API}/auth/refresh`).set('Cookie', customer.cookie);
    expect(refresh.status).toBe(401);
    expect((await login(customer.email)).status).toBe(200);
  });

  it('cannot act on a peer, a superior, or themselves', async () => {
    const peer = await signIn('peer', 'admin');
    const root = await signIn('root', 'super_admin');

    for (const target of [peer.id, root.id, admin.id]) {
      const base = `${API}/users/${target}`;
      const a = admin.auth;
      const results = [
        await request(app).post(`${base}/sign-out`).set('Authorization', a),
        await request(app).delete(`${base}/avatar`).set('Authorization', a),
        await uploadAvatar(`${base}/avatar`, a),
      ];
      for (const res of results) expect(res.status).toBe(403);
    }
    // Still signed in and unchanged.
    expect((await request(app).get(ME).set('Authorization', peer.auth)).status).toBe(200);
  });

  it('leaves no file behind when an upload is refused', async () => {
    const peer = await signIn('peer', 'admin');
    const before = cloudinary.files.size;

    const res = await uploadAvatar(`${API}/users/${peer.id}/avatar`, admin.auth);

    expect(res.status).toBe(403);
    expect((await UserModel.findById(peer.id))?.avatar).toBeNull();
    expect(cloudinary.files.size).toBe(before);
  });

  it('does not let customers or read-only staff in', async () => {
    const support = await signIn('support', 'customer_support');
    for (const auth of [customer.auth, support.auth]) {
      const target = `${API}/users/${admin.id}`;
      expect(
        (await request(app).post(`${target}/sign-out`).set('Authorization', auth)).status,
      ).toBe(403);
      expect(
        (await request(app).delete(`${target}/avatar`).set('Authorization', auth)).status,
      ).toBe(403);
      expect((await uploadAvatar(`${target}/avatar`, auth)).status).toBe(403);
    }
  });

  it('returns 404 for a missing user', async () => {
    const res = await request(app)
      .post(`${API}/users/${ID}/sign-out`)
      .set('Authorization', admin.auth);
    expect(res.status).toBe(404);
  });
});
