import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app';
import { signupBody } from './signup';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { errorHandler } from '@/middlewares/errorHandler';
import { createRateLimiter } from '@/middlewares/rateLimiter';
import { requestLogger } from '@/middlewares/requestLogger';
import { SessionModel } from '@/modules/auth/session.model';
import { UserModel } from '@/modules/user/user.model';
import { FakeCloudinary } from './fakeCloudinary';

const API = '/api/v1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);

const app = createApp();
const validUser = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'Passw0rd123' };

const register = (overrides: object = {}) =>
  request(app)
    .post(`${API}/auth/register`)
    .send(signupBody({ ...validUser, ...overrides }));

const refreshCookieOf = (res: request.Response): string => {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find((value) => value.startsWith('refreshToken='));
  if (!cookie) throw new Error('No refresh cookie');
  return cookie.split(';')[0] as string;
};

const bearer = (res: request.Response) => `Bearer ${res.body.data.accessToken as string}`;

const createAdmin = async () => {
  await UserModel.create({
    name: 'Admin User',
    email: 'admin@example.com',
    password: 'Passw0rd123',
    role: 'admin',
  });
  return request(app)
    .post(`${API}/auth/login`)
    .send({ email: 'admin@example.com', password: 'Passw0rd123' });
};

const cloudinary = new FakeCloudinary();

beforeAll(async () => {
  await cloudinary.start(4597);
  await connectDatabase();
  await Promise.all([UserModel.init(), SessionModel.init()]);
});

beforeEach(async () => {
  cloudinary.reset();
  await Promise.all([UserModel.deleteMany({}), SessionModel.deleteMany({})]);
});

afterAll(async () => {
  await cloudinary.stop();
  await disconnectDatabase();
});

describe('infrastructure', () => {
  it('reports health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('connected');
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await request(app).get(`${API}/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });
    expect(res.body.requestId).toBeTruthy();
  });

  it('handles malformed JSON', async () => {
    const res = await request(app)
      .post(`${API}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MALFORMED_JSON');
  });

  it('rate limits with the standard error shape', async () => {
    const limited = express();
    limited.use(requestLogger);
    limited.get('/', createRateLimiter({ max: 1, message: 'Slow down' }), (_req, res) => {
      res.json({});
    });
    limited.use(errorHandler);

    expect((await request(limited).get('/')).status).toBe(200);
    const res = await request(limited).get('/');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'Slow down' });
  });
});

describe('auth', () => {
  it('registers a user, hashes the password and hides private fields', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email: validUser.email, role: 'user' });
    expect(res.body.data.user.id).toBeTruthy();
    for (const field of ['password', 'tokenVersion', '_id', '__v']) {
      expect(res.body.data.user).not.toHaveProperty(field);
    }
    expect(res.body.data).not.toHaveProperty('refreshToken');
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('HttpOnly');

    const stored = await UserModel.findOne({ email: validUser.email }).select('+password');
    expect(stored?.password).toMatch(/^\$2[aby]\$/);
  });

  it('ignores a role sent during registration', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send(signupBody({ ...validUser, role: 'admin' }));
    expect(res.body.data.user.role).toBe('user');
  });

  it('stores the account type and when the terms were accepted, without granting staff access', async () => {
    const res = await register({ accountType: 'staff' });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ accountType: 'staff', role: 'user' });
    expect(res.body.data.user.termsAcceptedAt).toBeTruthy();
  });

  it.each([
    ['unaccepted terms', { terms: false }, 'terms'],
    ['a mismatched confirmation', { confirmPassword: 'Different123' }, 'confirmPassword'],
    ['an unknown account type', { accountType: 'vip' }, 'accountType'],
  ])('rejects %s', async (_label, overrides, field) => {
    const res = await register(overrides);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { path: string }) => error.path)).toContain(`body.${field}`);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('reports every invalid field', async () => {
    const res = await register({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['body.email', 'body.password']));
  });

  it('rejects a duplicate email with 409', async () => {
    await register();
    const res = await register({ email: validUser.email.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_VALUE');
  });

  it('rejects NoSQL operators in login', async () => {
    await register();
    const res = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: { $ne: null }, password: { $ne: null } });
    expect(res.status).toBe(422);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    await register();
    const wrong = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: validUser.email, password: 'wrong' });
    const unknown = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'nobody@example.com', password: 'wrong' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('requires a valid token', async () => {
    expect((await request(app).get(`${API}/users/me`)).status).toBe(401);
    const res = await request(app).get(`${API}/users/me`).set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('rotates refresh tokens and revokes everything when one is reused', async () => {
    const first = await register();
    const cookie = refreshCookieOf(first);

    const second = await request(app).post(`${API}/auth/refresh`).set('Cookie', cookie);
    expect(second.status).toBe(200);
    expect(second.body.data.accessToken).toBeTruthy();
    const nextCookie = refreshCookieOf(second);
    expect(nextCookie).not.toBe(cookie);

    const replay = await request(app).post(`${API}/auth/refresh`).set('Cookie', cookie);
    expect(replay.status).toBe(401);

    const afterReplay = await request(app).post(`${API}/auth/refresh`).set('Cookie', nextCookie);
    expect(afterReplay.status).toBe(401);
  });

  it('logs out', async () => {
    const cookie = refreshCookieOf(await register());
    expect((await request(app).post(`${API}/auth/logout`).set('Cookie', cookie)).status).toBe(204);
    expect((await request(app).post(`${API}/auth/refresh`).set('Cookie', cookie)).status).toBe(401);
  });

  it('invalidates old tokens when the password changes', async () => {
    const session = await register();
    const res = await request(app)
      .post(`${API}/auth/change-password`)
      .set('Authorization', bearer(session))
      .send({ currentPassword: validUser.password, newPassword: 'N3wPassword456' });
    expect(res.status).toBe(200);

    const oldToken = await request(app)
      .get(`${API}/users/me`)
      .set('Authorization', bearer(session));
    expect(oldToken.status).toBe(401);

    const newToken = await request(app).get(`${API}/users/me`).set('Authorization', bearer(res));
    expect(newToken.status).toBe(200);

    const relogin = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: validUser.email, password: 'N3wPassword456' });
    expect(relogin.status).toBe(200);
  });

  it('blocks a deactivated user immediately', async () => {
    const admin = await createAdmin();
    const session = await register();

    await request(app)
      .patch(`${API}/users/${session.body.data.user.id as string}`)
      .set('Authorization', bearer(admin))
      .send({ isActive: false });

    const res = await request(app).get(`${API}/users/me`).set('Authorization', bearer(session));
    expect(res.status).toBe(401);
    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: validUser.email, password: validUser.password });
    expect(login.status).toBe(403);
  });
});

describe('users', () => {
  it('restricts admin routes', async () => {
    const session = await register();
    const res = await request(app).get(`${API}/users`).set('Authorization', bearer(session));
    expect(res.status).toBe(403);
  });

  it('lists with pagination, search, filters and sorting', async () => {
    const admin = await createAdmin();
    await register();
    await register({ name: 'Grace Hopper', email: 'grace@example.com' });
    const auth = bearer(admin);

    const page = await request(app)
      .get(`${API}/users`)
      .query({ limit: 2, sort: 'name' })
      .set('Authorization', auth);
    expect(page.status).toBe(200);
    expect(page.body.data.map((u: { name: string }) => u.name)).toEqual([
      'Ada Lovelace',
      'Admin User',
    ]);
    expect(page.body.meta).toMatchObject({ total: 3, totalPages: 2, hasNextPage: true });

    const search = await request(app)
      .get(`${API}/users`)
      .query({ search: 'GRACE' })
      .set('Authorization', auth);
    expect(search.body.data).toHaveLength(1);

    const filtered = await request(app)
      .get(`${API}/users`)
      .query({ role: 'admin', isActive: 'true' })
      .set('Authorization', auth);
    expect(filtered.body.meta.total).toBe(1);

    const badSort = await request(app)
      .get(`${API}/users`)
      .query({ sort: 'password' })
      .set('Authorization', auth);
    expect(badSort.status).toBe(422);
  });

  it('handles bad and unknown ids', async () => {
    const admin = await createAdmin();
    const auth = bearer(admin);

    const bad = await request(app).get(`${API}/users/123`).set('Authorization', auth);
    expect(bad.status).toBe(422);

    const missing = await request(app)
      .get(`${API}/users/${new mongoose.Types.ObjectId().toString()}`)
      .set('Authorization', auth);
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('User not found');
  });

  it('supports admin create, update and delete', async () => {
    const auth = bearer(await createAdmin());

    const createdUser = await request(app)
      .post(`${API}/users`)
      .set('Authorization', auth)
      .send({ ...validUser, role: 'accountant' });
    expect(createdUser.status).toBe(201);
    expect(createdUser.body.data.role).toBe('accountant');
    const url = `${API}/users/${createdUser.body.data.id as string}`;

    const updated = await request(app)
      .patch(url)
      .set('Authorization', auth)
      .send({ name: 'Ada L' });
    expect(updated.body.data.name).toBe('Ada L');

    const empty = await request(app).patch(url).set('Authorization', auth).send({});
    expect(empty.status).toBe(422);

    expect((await request(app).delete(url).set('Authorization', auth)).status).toBe(204);
    expect((await request(app).get(url).set('Authorization', auth)).status).toBe(404);
  });

  it('stops an admin from deleting themselves', async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .delete(`${API}/users/${admin.body.data.user.id as string}`)
      .set('Authorization', bearer(admin));
    expect(res.status).toBe(403);
  });

  it('only lets users change their own name through the profile', async () => {
    const session = await register();
    const res = await request(app)
      .patch(`${API}/users/me`)
      .set('Authorization', bearer(session))
      .send({ name: 'New Name', role: 'admin' });
    expect(res.body.data).toMatchObject({ name: 'New Name', role: 'user' });
  });
});

describe('uploads', () => {
  it('stores a valid image in Cloudinary under a generated name', async () => {
    const session = await register();
    const res = await request(app)
      .post(`${API}/uploads/images`)
      .set('Authorization', bearer(session))
      .attach('file', PNG, { filename: '../../evil.html', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.data.url).toMatch(
      /^https:\/\/res\.cloudinary\.com\/test-cloud\/image\/upload\/v1\/citycore\/images\/[0-9a-f-]{36}\.png$/,
    );
    expect(cloudinary.files).toContain(res.body.data.url);
  });

  it('stores a PDF as a raw file that keeps its extension', async () => {
    const res = await request(app)
      .post(`${API}/uploads/documents`)
      .set('Authorization', bearer(await register()))
      .attach('file', Buffer.from('%PDF-1.7 test'), {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.url).toMatch(
      /\/raw\/upload\/v1\/citycore\/documents\/[0-9a-f-]{36}\.pdf$/,
    );
    expect(cloudinary.files).toContain(res.body.data.url);
  });

  it('reports a Cloudinary outage, and an image Cloudinary refuses', async () => {
    const auth = bearer(await register());
    const upload = () =>
      request(app)
        .post(`${API}/uploads/images`)
        .set('Authorization', auth)
        .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });

    cloudinary.outage = { status: 500, body: { error: { message: 'Down' } } };
    const down = await upload();
    expect(down.status).toBe(502);
    expect(down.body.code).toBe('STORAGE_UPLOAD_FAILED');

    cloudinary.outage = { status: 400, body: { error: { message: 'Invalid image file' } } };
    const refused = await upload();
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('INVALID_FILE_CONTENT');
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post(`${API}/uploads/images`)
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('rejects disallowed types', async () => {
    const session = await register();
    const res = await request(app)
      .post(`${API}/uploads/images`)
      .set('Authorization', bearer(session))
      .attach('file', Buffer.from('<script>'), { filename: 'a.html', contentType: 'text/html' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('rejects a file whose contents contradict its type, without storing it', async () => {
    const session = await register();
    const res = await request(app)
      .post(`${API}/uploads/images`)
      .set('Authorization', bearer(session))
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'a.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_CONTENT');
    expect(cloudinary.files.size).toBe(0);
  });

  it('rejects a request with no file and an unexpected field', async () => {
    const auth = bearer(await register());
    const none = await request(app).post(`${API}/uploads/images`).set('Authorization', auth);
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('FILE_REQUIRED');

    const wrongField = await request(app)
      .post(`${API}/uploads/images`)
      .set('Authorization', auth)
      .attach('other', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.code).toBe('LIMIT_UNEXPECTED_FILE');
  });

  it('replaces the avatar and deletes the previous file', async () => {
    const auth = bearer(await register());
    const upload = () =>
      request(app)
        .put(`${API}/users/me/avatar`)
        .set('Authorization', auth)
        .attach('avatar', PNG, { filename: 'a.png', contentType: 'image/png' });

    const first = await upload();
    expect(first.status).toBe(200);
    const second = await upload();
    expect(second.body.data.avatar).not.toBe(first.body.data.avatar);

    expect([...cloudinary.files]).toEqual([second.body.data.avatar]);
  });
});
