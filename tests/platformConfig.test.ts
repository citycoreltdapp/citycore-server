import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { env } from '@/config/env';
import { SessionModel } from '@/modules/auth/session.model';
import {
  DEFAULT_WALLET_SETTINGS,
  MANAGED_CONFIGS,
  MANAGED_CONFIG_NAMES,
} from '@/modules/platformConfig/platformConfig.managed';
import { PlatformConfigModel } from '@/modules/platformConfig/platformConfig.model';
import { platformConfigService } from '@/modules/platformConfig/platformConfig.service';
import { UserModel } from '@/modules/user/user.model';

const app = createApp();
const API = '/api/v1';
const ADMIN = `${API}/platform-config/admin`;
const PASSWORD = 'Passw0rd123';

const signIn = async (role: string) => {
  const email = `${role}@example.com`;
  const user = await UserModel.create({ name: 'Test User', email, password: PASSWORD, role });
  const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
  return { id: user.id as string, auth: `Bearer ${res.body.data.accessToken as string}` };
};

const validConfig = {
  key: 'support.email',
  label: 'Support email',
  description: 'Shown in the app footer',
  category: 'support',
  type: 'string',
  value: 'help@example.com',
};

let admin: { id: string; auth: string };

const post = (body: object) => request(app).post(ADMIN).set('Authorization', admin.auth).send(body);
const patch = (key: string, body: object) =>
  request(app).patch(`${ADMIN}/${key}`).set('Authorization', admin.auth).send(body);
const get = (path = '') => request(app).get(`${ADMIN}${path}`).set('Authorization', admin.auth);

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([UserModel.init(), SessionModel.init(), PlatformConfigModel.init()]);
});

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    PlatformConfigModel.deleteMany({}),
  ]);
  admin = await signIn('admin');
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('create', () => {
  it('stores the setting, private by default, and records who made it', async () => {
    const res = await post(validConfig);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      ...validConfig,
      isPublic: false,
      createdBy: admin.id,
      updatedBy: admin.id,
    });
    expect(res.body.data.id).toBeTruthy();
  });

  it('defaults the category', async () => {
    const res = await post({ ...validConfig, category: undefined });
    expect(res.body.data.category).toBe('general');
  });

  it.each([
    ['string', ''],
    ['number', 0],
    ['number', -1.5],
    ['boolean', false],
    ['boolean', true],
    ['json', {}],
    ['json', []],
    ['json', { nested: { empty: {} }, list: [1, null, 'a'] }],
  ])('round-trips a %s value of %j', async (type, value) => {
    const created = await post({ ...validConfig, type, value });
    expect(created.status).toBe(201);
    expect(created.body.data.value).toEqual(value);
    expect((await get(`/${validConfig.key}`)).body.data.value).toEqual(value);
  });

  it.each([
    ['string', 5],
    ['string', null],
    ['string', 'x'.repeat(10_001)],
    ['number', '5'],
    ['boolean', 'true'],
    ['boolean', 0],
    ['json', 'text'],
    ['json', 5],
    ['json', null],
    ['json', { $where: '1' }],
    ['json', { nested: { 'a.b': 1 } }],
  ])('rejects a %s value of %j', async (type, value) => {
    const res = await post({ ...validConfig, type, value });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('body.value');
  });

  it('rejects a __proto__ key in a JSON value', async () => {
    const res = await request(app)
      .post(ADMIN)
      .set('Authorization', admin.auth)
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({ ...validConfig, type: 'json', value: 'PLACEHOLDER' }).replace(
          '"PLACEHOLDER"',
          '{"__proto__":{"polluted":true}}',
        ),
      );
    expect(res.status).toBe(422);
  });

  it('rejects a value nested too deeply, rather than failing in the database', async () => {
    let value: object = {};
    for (let depth = 0; depth < 150; depth += 1) value = { a: value };
    const res = await post({ ...validConfig, type: 'json', value });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('body.value');
  });

  it('requires a value', async () => {
    expect((await post({ ...validConfig, value: undefined })).status).toBe(422);
  });

  it.each(['1abc', 'has space', 'a..b', '.a', 'a.', 'a/b', '$a', '__proto__'])(
    'rejects the key %j',
    async (key) => {
      expect((await post({ ...validConfig, key })).status).toBe(422);
    },
  );

  it('normalises the key, and refuses a duplicate', async () => {
    expect((await post({ ...validConfig, key: 'Support.Email' })).body.data.key).toBe(
      'support.email',
    );
    const again = await post(validConfig);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE_VALUE');
  });

  it('ignores audit fields sent by the client', async () => {
    const res = await post({ ...validConfig, createdBy: '507f1f77bcf86cd799439011' });
    expect(res.body.data.createdBy).toBe(admin.id);
  });
});

describe('read', () => {
  beforeEach(async () => {
    await post(validConfig);
    await post({
      key: 'features.blog',
      label: 'Blog on',
      category: 'features',
      type: 'boolean',
      value: true,
      isPublic: true,
    });
    await post({
      key: 'limits.max',
      label: 'Maximum',
      category: 'limits',
      type: 'number',
      value: 3,
    });
  });

  it('lists by key, with pagination', async () => {
    const res = await get('?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { key: string }) => c.key)).toEqual([
      'features.blog',
      'limits.max',
    ]);
    expect(res.body.meta).toMatchObject({ total: 3, totalPages: 2, hasNextPage: true });
  });

  it.each([
    ['category=limits', ['limits.max']],
    ['type=boolean', ['features.blog']],
    ['isPublic=true', ['features.blog']],
    ['isPublic=false', ['limits.max', 'support.email']],
    ['search=footer', ['support.email']],
    ['search=MAX', ['limits.max']],
  ])('filters with %s', async (query, keys) => {
    const res = await get(`?${query}`);
    expect(res.body.data.map((c: { key: string }) => c.key)).toEqual(keys);
  });

  it('sorts', async () => {
    const res = await get('?sort=-key');
    expect(res.body.data[0].key).toBe('support.email');
  });

  it('rejects an unknown sort or filter value', async () => {
    expect((await get('?sort=value')).status).toBe(422);
    expect((await get('?type=date')).status).toBe(422);
  });

  it('reads one by key, and answers 404 for an unknown key', async () => {
    expect((await get('/limits.max')).body.data.value).toBe(3);
    const missing = await get('/limits.none');
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('Platform config not found');
  });
});

describe('update', () => {
  beforeEach(async () => {
    await post(validConfig);
  });

  it('changes only what was sent, and records who changed it', async () => {
    const editor = await signIn('super_admin');
    const res = await request(app)
      .patch(`${ADMIN}/support.email`)
      .set('Authorization', editor.auth)
      .send({ value: 'new@example.com', isPublic: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      label: validConfig.label,
      value: 'new@example.com',
      isPublic: true,
      createdBy: admin.id,
      updatedBy: editor.id,
    });
  });

  it('can set a falsy value', async () => {
    await post({ key: 'a.flag', label: 'Flag', type: 'boolean', value: true });
    await post({ key: 'a.count', label: 'Count', type: 'number', value: 9 });
    expect((await patch('a.flag', { value: false })).body.data.value).toBe(false);
    expect((await patch('a.count', { value: 0 })).body.data.value).toBe(0);
    expect((await patch('support.email', { value: '' })).body.data.value).toBe('');
    expect((await get('/a.flag')).body.data.value).toBe(false);
  });

  it('replaces a JSON value entirely', async () => {
    await post({ key: 'a.json', label: 'Json', type: 'json', value: { old: 1, kept: 2 } });
    await patch('a.json', { value: { fresh: {} } });
    expect((await get('/a.json')).body.data.value).toEqual({ fresh: {} });
  });

  it('checks a new value against the stored type', async () => {
    const res = await patch('support.email', { value: 5 });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('body.value');
    expect((await get('/support.email')).body.data.value).toBe(validConfig.value);
  });

  it('refuses null, which no type allows', async () => {
    expect((await patch('support.email', { value: null })).status).toBe(422);
  });

  it('checks a new type against the stored value', async () => {
    expect((await patch('support.email', { type: 'number' })).status).toBe(422);
    expect((await get('/support.email')).body.data.type).toBe('string');
  });

  it('can change type and value together', async () => {
    const res = await patch('support.email', { type: 'number', value: 7 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: 'number', value: 7 });
  });

  it('never changes the key', async () => {
    expect((await patch('support.email', { key: 'other.key' })).status).toBe(422);
    const res = await patch('support.email', { key: 'other.key', label: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ key: 'support.email', label: 'Renamed' });
  });

  it('refuses an empty update and an unknown key', async () => {
    expect((await patch('support.email', {})).status).toBe(422);
    expect((await patch('nothing.here', { label: 'Label' })).status).toBe(404);
  });
});

describe('delete', () => {
  it('removes the setting, and then answers 404', async () => {
    await post({ ...validConfig, isPublic: true });
    const remove = () =>
      request(app).delete(`${ADMIN}/support.email`).set('Authorization', admin.auth);

    expect((await remove()).status).toBe(204);
    expect((await get('/support.email')).status).toBe(404);
    expect((await request(app).get(`${API}/platform-config`)).body.data).toEqual({});
    expect((await remove()).status).toBe(404);
  });
});

describe('GET /platform-config', () => {
  it('shows only public settings, as key and value, without signing in', async () => {
    await post(validConfig);
    await post({ key: 'a.off', label: 'Off', type: 'boolean', value: false, isPublic: true });
    await post({ key: 'a.obj', label: 'Obj', type: 'json', value: { x: 1 }, isPublic: true });

    const res = await request(app).get(`${API}/platform-config`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ 'a.obj': { x: 1 }, 'a.off': false });
  });

  it('stops showing a setting made private', async () => {
    await post({ ...validConfig, isPublic: true });
    await patch('support.email', { isPublic: false });
    expect((await request(app).get(`${API}/platform-config`)).body.data).toEqual({});
  });
});

describe('managed wallet settings', () => {
  const MIN = 'wallet.funding.min_kobo';
  const remove = (key: string) =>
    request(app).delete(`${ADMIN}/${key}`).set('Authorization', admin.auth);

  beforeEach(async () => {
    await platformConfigService.seedManagedConfigs();
  });

  it('starts from .env, private and marked as managed, with no author', async () => {
    const res = await get('?limit=100');
    expect(res.body.data).toHaveLength(MANAGED_CONFIG_NAMES.length);
    for (const config of res.body.data) {
      expect(config).toMatchObject({
        type: 'number',
        isPublic: false,
        managed: true,
        createdBy: null,
        updatedBy: null,
      });
    }
    expect((await get(`/${MIN}`)).body.data.value).toBe(env.WALLET_MIN_FUNDING_KOBO);
    expect((await request(app).get(`${API}/platform-config`)).body.data).toEqual({});
  });

  it('marks other settings as not managed', async () => {
    expect((await post(validConfig)).body.data.managed).toBe(false);
  });

  it('keeps a changed value when the server starts again', async () => {
    await patch(MIN, { value: 20_000 }).expect(200);
    await platformConfigService.seedManagedConfigs();
    expect((await get(`/${MIN}`)).body.data.value).toBe(20_000);
    expect(await PlatformConfigModel.countDocuments()).toBe(MANAGED_CONFIG_NAMES.length);
  });

  it('survives several servers starting at once', async () => {
    await PlatformConfigModel.deleteMany({});
    await Promise.all([1, 2, 3].map(() => platformConfigService.seedManagedConfigs()));
    expect(await PlatformConfigModel.countDocuments()).toBe(MANAGED_CONFIG_NAMES.length);
  });

  it('records who changed a value', async () => {
    const res = await patch(MIN, { value: 20_000 });
    expect(res.body.data).toMatchObject({ value: 20_000, createdBy: null, updatedBy: admin.id });
  });

  it('cannot be deleted', async () => {
    const res = await remove(MIN);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CONFIG_LOCKED');
    expect((await get(`/${MIN}`)).status).toBe(200);
  });

  it('cannot be created by hand, even with the key in another case', async () => {
    await PlatformConfigModel.deleteMany({});
    const res = await post({ ...validConfig, key: MIN.toUpperCase(), type: 'number', value: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CONFIG_LOCKED');
  });

  it.each([
    ['label', { label: 'Renamed' }],
    ['description', { description: 'Changed' }],
    ['category', { category: 'other' }],
    ['type', { type: 'string' }],
    ['isPublic', { isPublic: true }],
    ['value and another field', { value: 20_000, isPublic: true }],
  ])('refuses a change to %s', async (_name, body) => {
    const res = await patch(MIN, body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CONFIG_LOCKED');
    expect((await get(`/${MIN}`)).body.data).toMatchObject({
      value: env.WALLET_MIN_FUNDING_KOBO,
      isPublic: false,
    });
  });

  it.each([
    ['a fraction', MIN, 100.5],
    ['zero for a limit', MIN, 0],
    ['a negative limit', 'wallet.funding.max_kobo', -1],
    ['an absurd limit', 'wallet.funding.max_kobo', 10_000_000_001],
    ['a string', MIN, '20000'],
    ['null', MIN, null],
    ['a percentage over 10%', 'wallet.fees.checkout.basis_points', 1_001],
    ['a transfer percentage over 10%', 'wallet.fees.transfer.basis_points', 1_001],
    ['a negative fee', 'wallet.fees.checkout.flat_kobo', -1],
    ['a cap over 100,000 naira', 'wallet.fees.transfer.cap_kobo', 10_000_001],
  ])('refuses %s', async (_name, key, value) => {
    const res = await patch(key, { value });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('body.value');
  });

  it('accepts the ends of the allowed ranges', async () => {
    await patch('wallet.fees.checkout.basis_points', { value: 0 }).expect(200);
    await patch('wallet.fees.checkout.basis_points', { value: 1_000 }).expect(200);
    await patch('wallet.fees.transfer.cap_kobo', { value: 0 }).expect(200);
    await patch('wallet.funding.max_kobo', { value: 10_000_000_000 }).expect(200);
  });

  it('keeps the minimum at or below the maximum, from either side', async () => {
    const tooHigh = await patch(MIN, { value: env.WALLET_MAX_FUNDING_KOBO + 1 });
    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body.errors[0].message).toMatch(/Minimum funding/);

    const tooLow = await patch('wallet.funding.max_kobo', {
      value: env.WALLET_MIN_FUNDING_KOBO - 1,
    });
    expect(tooLow.status).toBe(422);

    await patch(MIN, { value: env.WALLET_MAX_FUNDING_KOBO }).expect(200);
  });

  it('keeps the flat fee at or below the cap, from either side', async () => {
    const flat = await patch('wallet.fees.checkout.flat_kobo', {
      value: env.PAYSTACK_FEE_CAP_KOBO + 1,
    });
    expect(flat.status).toBe(422);
    const cap = await patch('wallet.fees.checkout.cap_kobo', {
      value: env.PAYSTACK_FEE_FLAT_KOBO - 1,
    });
    expect(cap.status).toBe(422);
  });

  describe('reading them', () => {
    it('uses a stored value', async () => {
      await patch(MIN, { value: 20_000 });
      expect((await platformConfigService.walletSettings()).minFundingKobo).toBe(20_000);
    });

    it('falls back to .env when none are stored', async () => {
      await PlatformConfigModel.deleteMany({});
      expect(await platformConfigService.walletSettings()).toEqual(DEFAULT_WALLET_SETTINGS);
    });

    it.each([
      ['a string', '150'],
      ['outside its rule', 99_999],
      ['null-like', {}],
    ])('falls back to .env when the stored value is %s', async (_name, value) => {
      const { key } = MANAGED_CONFIGS.checkoutFeeBasisPoints;
      await PlatformConfigModel.updateOne({ key }, { value });
      const settings = await platformConfigService.walletSettings();
      expect(settings.checkoutFeeBasisPoints).toBe(env.PAYSTACK_FEE_BASIS_POINTS);
    });
  });
});
