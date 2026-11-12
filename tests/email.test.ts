import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app';
import { signupBody } from './signup';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { env } from '@/config/env';
import { SessionModel } from '@/modules/auth/session.model';
import { EmailCodeModel } from '@/modules/auth/emailCode.model';
import { birthdayService } from '@/modules/email/birthday.service';
import { BirthdaySettingsModel, EmailLogModel } from '@/modules/email/email.model';
import { emailService } from '@/modules/email/email.service';
import { TicketCounterModel, TicketModel } from '@/modules/helpdesk/ticket.model';
import { TicketMessageModel } from '@/modules/helpdesk/ticketMessage.model';
import { UserModel } from '@/modules/user/user.model';
import { FakeResend } from './fakeResend';

const app = createApp();
const API = '/api/v1';
const ADMIN = `${API}/emails/admin`;
const PASSWORD = 'Passw0rd123';
const NEW_PASSWORD = 'Different456';
const resend = new FakeResend();

const signIn = async (role: string, overrides: object = {}) => {
  const email = `${role}@example.com`;
  const user = await UserModel.create({
    name: `Test ${role}`,
    email,
    password: PASSWORD,
    role,
    ...overrides,
  });
  const res = await request(app)
    .post(`${API}/auth/login`)
    .send(signupBody({ email, password: PASSWORD }));
  return { id: user.id as string, email, auth: `Bearer ${res.body.data.accessToken as string}` };
};

const register = async (email: string) => {
  const res = await request(app)
    .post(`${API}/auth/register`)
    .send(signupBody({ email, password: PASSWORD }));
  expect(res.status).toBe(201);
  return {
    id: res.body.data.user.id as string,
    auth: `Bearer ${res.body.data.accessToken as string}`,
  };
};

const addCustomer = (name: string, email: string, dateOfBirth: string | null, extra: object = {}) =>
  UserModel.create({
    name,
    email,
    password: PASSWORD,
    dateOfBirth: dateOfBirth && new Date(dateOfBirth),
    ...extra,
  });

/** Sends everything waiting, as the worker would. */
const flush = async () => {
  while ((await emailService.processQueue()) > 0);
};

beforeAll(async () => {
  await connectDatabase();
  await resend.start(4596);
});

afterAll(async () => {
  await resend.stop();
  await disconnectDatabase();
});

beforeEach(async () => {
  resend.reset();
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    EmailLogModel.deleteMany({}),
    EmailCodeModel.deleteMany({}),
    BirthdaySettingsModel.deleteMany({}),
    TicketModel.deleteMany({}),
    TicketMessageModel.deleteMany({}),
    TicketCounterModel.deleteMany({}),
  ]);
});

describe('sending', () => {
  it('sends through Resend with the key, sender and an idempotency key', async () => {
    await register('ada@example.com');
    await flush();

    const [email] = resend.to('ada@example.com');
    expect(email).toMatchObject({
      from: 'City Core <hello@example.com>',
      authorization: 'Bearer re_test_fake_key',
      subject: 'Verify your email address',
    });
    expect(email?.idempotencyKey).toBeTruthy();

    const log = await EmailLogModel.findOne({ to: 'ada@example.com' }).orFail();
    expect(log).toMatchObject({ status: 'sent', providerId: 're_0', attempts: 1 });
    expect(log.sentAt).toBeInstanceOf(Date);
  });

  it('retries a temporary failure with a later attempt, using the same idempotency key', async () => {
    await register('ada@example.com');
    resend.outage = { status: 500, body: { message: 'Internal error' } };
    await flush();

    const waiting = await EmailLogModel.findOne({ to: 'ada@example.com' }).orFail();
    expect(waiting).toMatchObject({ status: 'queued', attempts: 1, lastError: 'Internal error' });
    expect(waiting.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    resend.outage = undefined;
    await flush();
    expect(resend.sent).toHaveLength(0);

    await EmailLogModel.updateOne({ _id: waiting.id }, { nextAttemptAt: new Date() });
    await flush();
    expect(resend.to('ada@example.com')[0]?.idempotencyKey).toBe(`${waiting.id}-0`);
  });

  it('fails straight away when Resend refuses, and a retry sends it as a new request', async () => {
    const admin = await signIn('admin');
    await request(app).post(`${ADMIN}/test`).set('Authorization', admin.auth).expect(202);
    resend.outage = { status: 403, body: { message: 'The domain is not verified' } };
    await flush();

    const failed = await EmailLogModel.findOne({ template: 'test' }).orFail();
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'The domain is not verified',
    });

    resend.outage = undefined;
    await request(app)
      .post(`${ADMIN}/activity/${failed.id}/retry`)
      .set('Authorization', admin.auth)
      .expect(202);
    await flush();

    const [sent] = resend.to(admin.email);
    expect(sent?.idempotencyKey).toBe(`${failed.id}-1`);
    expect((await EmailLogModel.findById(failed.id).orFail()).status).toBe('sent');

    const again = await request(app)
      .post(`${ADMIN}/activity/${failed.id}/retry`)
      .set('Authorization', admin.auth);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EMAIL_NOT_FAILED');
  });

  it('holds everything back when rate limited, without using up attempts', async () => {
    await register('one@example.com');
    await register('two@example.com');
    resend.outage = {
      status: 429,
      body: { message: 'Slow down' },
      headers: { 'retry-after': '0' },
    };
    await emailService.processQueue(1);

    const log = await EmailLogModel.findOne({ lastError: 'Slow down' }).orFail();
    expect(log).toMatchObject({ status: 'queued', attempts: 0 });

    resend.outage = undefined;
    await flush();
    expect(resend.sent).toHaveLength(2);
  });

  it('picks up an email whose worker died, but leaves one still being worked on', async () => {
    await register('ada@example.com');
    await EmailLogModel.updateOne(
      { to: 'ada@example.com' },
      { status: 'sending', lockedUntil: new Date(Date.now() + 60_000) },
    );
    await flush();
    expect(resend.sent).toHaveLength(0);

    await EmailLogModel.updateOne(
      { to: 'ada@example.com' },
      { lockedUntil: new Date(Date.now() - 1) },
    );
    await flush();
    expect(resend.sent).toHaveLength(1);
  });

  it('never sends an expired code', async () => {
    await register('ada@example.com');
    await EmailLogModel.updateOne(
      { to: 'ada@example.com' },
      { expiresAt: new Date(Date.now() - 1) },
    );
    await flush();

    expect(resend.sent).toHaveLength(0);
    const log = await EmailLogModel.findOne({ to: 'ada@example.com' }).select('+content').orFail();
    expect(log.status).toBe('failed');
    expect(log.content).toBeNull();
  });
});

describe('email verification', () => {
  it('sends a code at signup, verifies it, then welcomes them', async () => {
    const { auth } = await register('ada@example.com');
    await flush();

    const me = () => request(app).get(`${API}/users/me`).set('Authorization', auth);
    expect((await me()).body.data.emailVerified).toBe(false);

    const res = await request(app)
      .post(`${API}/auth/verify-email`)
      .send({ email: 'ada@example.com', code: resend.codeFor('ada@example.com') });
    expect(res.status).toBe(200);
    // Signs them in, so the app can go straight to the dashboard.
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user.emailVerified).toBe(true);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^refreshToken=/);
    expect((await me()).body.data.emailVerified).toBe(true);

    await flush();
    expect(resend.to('ada@example.com').map((email) => email.subject)).toEqual([
      'Verify your email address',
      'Welcome to City Core',
    ]);
  });

  it('holds back a resend for a moment, and says the same for an unknown address', async () => {
    await register('ada@example.com');
    const ask = (email: string) =>
      request(app).post(`${API}/auth/verify-email/request`).send({ email });

    const known = await ask('ada@example.com');
    const unknown = await ask('nobody@example.com');
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body.message).toBe(known.body.message);

    await flush();
    expect(resend.sent).toHaveLength(1);
  });

  it('keeps the code secret at rest and from staff', async () => {
    const admin = await signIn('admin');
    await register('ada@example.com');

    const queued = await EmailLogModel.findOne({ to: 'ada@example.com' })
      .select('+content')
      .orFail();
    expect(queued.sensitive).toBe(true);
    await flush();
    const code = resend.codeFor('ada@example.com');
    expect(queued.content).not.toContain(code);
    expect(queued.subject).not.toContain(code);

    const sent = await EmailLogModel.findById(queued.id).select('+content').orFail();
    expect(sent.content).toBeNull();

    const details = await request(app)
      .get(`${ADMIN}/activity/${queued.id}`)
      .set('Authorization', admin.auth);
    expect(details.body.data).toMatchObject({ html: null, text: null });
    expect(JSON.stringify(details.body)).not.toContain(code);

    const stored = await EmailCodeModel.findOne({ purpose: 'verify_email' }).orFail();
    expect(stored.codeHash).not.toContain(code);
  });
});

describe('password reset', () => {
  const forgot = (email: string) =>
    request(app).post(`${API}/auth/forgot-password`).send({ email });

  it('resets end to end, signing out other sessions and alerting the owner', async () => {
    const { auth } = await register('ada@example.com');
    await forgot('ada@example.com').expect(200);
    await flush();
    const code = resend.codeFor('ada@example.com');

    await request(app)
      .post(`${API}/auth/reset-password/verify`)
      .send({ email: 'ada@example.com', code })
      .expect(200);

    await request(app)
      .post(`${API}/auth/reset-password`)
      .send({ email: 'ada@example.com', code, newPassword: NEW_PASSWORD })
      .expect(200);

    await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(401);
    await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'ada@example.com', password: NEW_PASSWORD })
      .expect(200);
    await request(app).get(`${API}/users/me`).set('Authorization', auth).expect(401);

    await flush();
    expect(resend.to('ada@example.com').at(-1)?.subject).toBe('Your password was changed');

    // A code only works once.
    const reused = await request(app)
      .post(`${API}/auth/reset-password`)
      .send({ email: 'ada@example.com', code, newPassword: 'Another7890' });
    expect(reused.body.code).toBe('INVALID_CODE');
  });

  it('gives nothing away about whether an account exists', async () => {
    await register('ada@example.com');
    const known = await forgot('ada@example.com');
    const unknown = await forgot('nobody@example.com');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body.message).toBe(known.body.message);

    const check = await request(app)
      .post(`${API}/auth/reset-password/verify`)
      .send({ email: 'nobody@example.com', code: '123456' });
    expect(check.status).toBe(400);
    expect(check.body.code).toBe('INVALID_CODE');
  });

  it('stops accepting a code after too many wrong guesses', async () => {
    await register('ada@example.com');
    await forgot('ada@example.com');
    await flush();
    const code = resend.codeFor('ada@example.com');
    const wrong = code === '000000' ? '000001' : '000000';
    const guess = (value: string) =>
      request(app)
        .post(`${API}/auth/reset-password/verify`)
        .send({ email: 'ada@example.com', code: value });

    for (let i = 0; i < 5; i += 1) await guess(wrong).expect(400);
    await guess(code).expect(400);
  });

  it('does not count a right answer against the limit', async () => {
    await register('ada@example.com');
    await forgot('ada@example.com');
    await flush();
    const code = resend.codeFor('ada@example.com');
    for (let i = 0; i < 8; i += 1) {
      await request(app)
        .post(`${API}/auth/reset-password/verify`)
        .send({ email: 'ada@example.com', code })
        .expect(200);
    }
  });

  it('refuses a code once it has expired', async () => {
    await register('ada@example.com');
    await forgot('ada@example.com');
    await flush();
    await EmailCodeModel.updateMany({}, { expiresAt: new Date(Date.now() - 1) });
    const res = await request(app)
      .post(`${API}/auth/reset-password/verify`)
      .send({ email: 'ada@example.com', code: resend.codeFor('ada@example.com') });
    expect(res.status).toBe(400);
  });

  it('sends nothing for a closed account', async () => {
    await addCustomer('Gone', 'gone@example.com', null, { isActive: false });
    await forgot('gone@example.com').expect(200);
    await flush();
    expect(resend.sent).toHaveLength(0);
  });
});

describe('changing email', () => {
  it('alerts the old address, verifies the new one, and kills codes sent to the old one', async () => {
    const { auth } = await register('old@example.com');
    await request(app).post(`${API}/auth/forgot-password`).send({ email: 'old@example.com' });
    await flush();
    const oldResetCode = resend
      .to('old@example.com')
      .at(-1)
      ?.text.match(/\b\d{6}\b/)?.[0];

    await request(app)
      .post(`${API}/auth/change-email`)
      .set('Authorization', auth)
      .send({ email: 'new@example.com', currentPassword: PASSWORD })
      .expect(200);
    await flush();

    expect(resend.to('old@example.com').at(-1)?.text).toContain('new@example.com');
    // Sent at once, even though a code went out moments ago: that one was to another address.
    expect(resend.to('new@example.com')[0]?.subject).toBe('Verify your email address');

    const stolen = await request(app)
      .post(`${API}/auth/reset-password`)
      .send({ email: 'new@example.com', code: oldResetCode, newPassword: NEW_PASSWORD });
    expect(stolen.body.code).toBe('INVALID_CODE');

    const me = await request(app).get(`${API}/users/me`).set('Authorization', auth);
    expect(me.body.data.emailVerified).toBe(false);
  });
});

describe('platform notifications', () => {
  it('tells a customer about their ticket and staff replies, but never internal notes', async () => {
    const customer = await register('ada@example.com');
    const staff = await signIn('customer_support');

    const ticket = await request(app)
      .post(`${API}/helpdesk/tickets`)
      .set('Authorization', customer.auth)
      .send({ subject: 'Cannot fund', description: 'My card is declined at checkout' });
    expect(ticket.status).toBe(201);
    const { id, number } = ticket.body.data as { id: string; number: string };
    const messages = `${API}/helpdesk/admin/tickets/${id}/messages`;

    await request(app)
      .post(messages)
      .set('Authorization', staff.auth)
      .send({ body: 'SECRET note about this customer', internal: true })
      .expect(201);
    await request(app)
      .post(messages)
      .set('Authorization', staff.auth)
      .send({ body: 'Please try <b>again</b>' })
      .expect(201);
    await request(app)
      .patch(`${API}/helpdesk/admin/tickets/${id}`)
      .set('Authorization', staff.auth)
      .send({ status: 'resolved' })
      .expect(200);
    await flush();

    const subjects = resend.to('ada@example.com').map((email) => email.subject);
    expect(subjects).toEqual([
      'Verify your email address',
      `We received your request (${number})`,
      `New reply on your request (${number})`,
      `Your request was resolved (${number})`,
    ]);
    const all = JSON.stringify(resend.sent);
    expect(all).not.toContain('SECRET');
    // What people type can't inject markup.
    expect(resend.to('ada@example.com')[2]?.html).toContain('&lt;b&gt;again&lt;/b&gt;');
  });

  it('respects the opt out, except for what protects the account', async () => {
    const customer = await register('ada@example.com');
    await UserModel.updateOne({ _id: customer.id }, { 'preferences.emailNotifications': false });
    await request(app)
      .post(`${API}/helpdesk/tickets`)
      .set('Authorization', customer.auth)
      .send({ subject: 'Cannot fund', description: 'My card is declined at checkout' })
      .expect(201);
    await request(app).post(`${API}/auth/forgot-password`).send({ email: 'ada@example.com' });
    await flush();

    expect(resend.to('ada@example.com').map((email) => email.subject)).toEqual([
      'Verify your email address',
      'Reset your password',
    ]);
    const skipped = await EmailLogModel.findOne({ template: 'ticket_created' }).orFail();
    expect(skipped.status).toBe('skipped');
    expect(skipped.lastError).toMatch(/turned off/);
  });

  it('tells someone when staff open an account for them', async () => {
    const admin = await signIn('admin');
    await request(app)
      .post(`${API}/users`)
      .set('Authorization', admin.auth)
      .send({ name: 'New Person', email: 'new@example.com', password: PASSWORD })
      .expect(201);
    await flush();
    const [email] = resend.to('new@example.com');
    expect(email?.subject).toBe('Your City Core account is ready');
    expect(email?.text).not.toContain(PASSWORD);
  });
});

describe('activity', () => {
  it('lists what was sent, when and by whom, with filters', async () => {
    const admin = await signIn('admin');
    await register('ada@example.com');
    await request(app).post(`${ADMIN}/test`).set('Authorization', admin.auth).expect(202);
    await flush();

    const list = (query = '') =>
      request(app).get(`${ADMIN}/activity${query}`).set('Authorization', admin.auth);

    const all = await list();
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(2);

    const test = await list('?category=system');
    expect(test.body.data).toHaveLength(1);
    expect(test.body.data[0]).toMatchObject({
      to: admin.email,
      subject: 'City Core test email',
      template: 'test',
      status: 'sent',
      triggeredBy: { id: admin.id, name: 'Test admin' },
    });
    expect(test.body.data[0].sentAt).toBeTruthy();
    expect(test.body.data[0].content).toBeUndefined();

    expect((await list('?search=ada@')).body.meta.total).toBe(1);
    expect((await list('?status=failed')).body.meta.total).toBe(0);
    expect((await list('?dateTo=2000-01-01')).body.meta.total).toBe(0);
    expect((await list('?status=nope')).status).toBe(422);

    const details = await request(app)
      .get(`${ADMIN}/activity/${test.body.data[0].id as string}`)
      .set('Authorization', admin.auth);
    expect(details.body.data.text).toContain('email sending is working');
  });

  it('counts by status and category', async () => {
    const admin = await signIn('admin');
    await request(app).post(`${ADMIN}/test`).set('Authorization', admin.auth);
    await flush();
    const res = await request(app).get(`${ADMIN}/stats`).set('Authorization', admin.auth);
    expect(res.body.data).toMatchObject({
      byStatus: { sent: 1, failed: 0, queued: 0 },
      byCategory: { system: 1, birthday: 0 },
      lastDay: { sent: 1, failed: 0 },
    });
  });

  it('is for staff with the right permission', async () => {
    const customer = await register('ada@example.com');
    const support = await signIn('customer_support');

    await request(app).get(`${ADMIN}/activity`).expect(401);
    await request(app).get(`${ADMIN}/activity`).set('Authorization', customer.auth).expect(403);
    await request(app).get(`${ADMIN}/activity`).set('Authorization', support.auth).expect(200);
    await request(app).post(`${ADMIN}/test`).set('Authorization', support.auth).expect(403);
    await request(app)
      .post(`${ADMIN}/birthdays/send`)
      .set('Authorization', support.auth)
      .send({})
      .expect(403);
  });
});

describe('birthdays', () => {
  // 09:30 in Lagos on 15 June 2026.
  const JUNE_15 = new Date('2026-06-15T08:30:00.000Z');

  /** Today, so the routes (which use the real clock) find them. */
  const todayInLagos = () => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return `1990-${parts.slice(5)}`;
  };

  it('starts switched off, and the wording can be changed', async () => {
    const admin = await signIn('admin');
    const get = await request(app)
      .get(`${ADMIN}/birthdays/settings`)
      .set('Authorization', admin.auth);
    expect(get.body.data).toMatchObject({ autoSendEnabled: false, sendHour: 9 });

    const patch = await request(app)
      .patch(`${ADMIN}/birthdays/settings`)
      .set('Authorization', admin.auth)
      .send({ subject: 'Cheers {{firstName}}', sendHour: 7, timezone: 'Africa/Accra' });
    expect(patch.body.data).toMatchObject({
      subject: 'Cheers {{firstName}}',
      sendHour: 7,
      timezone: 'Africa/Accra',
    });

    for (const body of [{ timezone: 'Mars/Base' }, { sendHour: 24 }, { subject: 'a\nb' }, {}]) {
      await request(app)
        .patch(`${ADMIN}/birthdays/settings`)
        .set('Authorization', admin.auth)
        .send(body)
        .expect(422);
    }
  });

  it('sends nothing automatically while off, and at the set hour once on', async () => {
    await addCustomer('Ada Obi', 'ada@example.com', '1990-06-15');
    expect(await birthdayService.runScheduled(JUNE_15)).toBeNull();

    await birthdayService.updateSettings({ autoSendEnabled: true }, '507f1f77bcf86cd799439011');
    // 08:30 in Lagos, before the 09:00 send.
    expect(await birthdayService.runScheduled(new Date('2026-06-15T07:30:00.000Z'))).toBeNull();

    expect(await birthdayService.runScheduled(JUNE_15)).toMatchObject({ queued: 1 });
    await flush();
    expect(resend.to('ada@example.com')[0]).toMatchObject({ subject: 'Happy birthday, Ada!' });
    expect(resend.to('ada@example.com')[0]?.text).toContain('Ada');
    expect((await EmailLogModel.findOne({ category: 'birthday' }).orFail()).triggeredBy).toBeNull();
  });

  it('sends each person one a year however many runs overlap, and again next year', async () => {
    await addCustomer('Ada Obi', 'ada@example.com', '1990-06-15');
    await birthdayService.updateSettings({ autoSendEnabled: true }, '507f1f77bcf86cd799439011');

    const runs = await Promise.all([
      birthdayService.runScheduled(JUNE_15),
      birthdayService.runScheduled(JUNE_15),
      birthdayService.runScheduled(JUNE_15),
    ]);
    expect(runs.reduce((sum, run) => sum + (run?.queued ?? 0), 0)).toBe(1);
    expect(await birthdayService.runScheduled(JUNE_15)).toMatchObject({
      queued: 0,
      alreadySent: 1,
    });

    const nextYear = new Date('2027-06-15T08:30:00.000Z');
    expect(await birthdayService.runScheduled(nextYear)).toMatchObject({ queued: 1 });
  });

  it('uses the local date, not UTC, to decide whose birthday it is', async () => {
    await addCustomer('Ada Obi', 'ada@example.com', '1990-06-16');
    // 23:30 UTC on the 15th is already 00:30 on the 16th in Lagos.
    const result = await birthdayService.send({}, null, new Date('2026-06-15T23:30:00.000Z'));
    expect(result.queued).toBe(1);
  });

  it('celebrates 29 February on the 28th in other years', async () => {
    await addCustomer('Leap Person', 'leap@example.com', '2000-02-29');
    const onThe28th = (year: number) => new Date(`${year}-02-28T12:00:00.000Z`);

    expect((await birthdayService.send({}, null, onThe28th(2028))).queued).toBe(0);
    expect(
      (await birthdayService.send({}, null, new Date('2028-02-29T12:00:00.000Z'))).queued,
    ).toBe(1);
    expect((await birthdayService.send({}, null, onThe28th(2027))).queued).toBe(1);
  });

  it('leaves out closed accounts and anyone who opted out', async () => {
    await addCustomer('Closed', 'closed@example.com', '1990-06-15', { isActive: false });
    await addCustomer('Quiet', 'quiet@example.com', '1990-06-15', {
      preferences: { emailNotifications: false },
    });
    const result = await birthdayService.send({}, null, JUNE_15);
    expect(result).toMatchObject({ queued: 0, optedOut: 1 });
    await flush();
    expect(resend.sent).toHaveLength(0);
  });

  it('lets staff send today, with their own wording, and records who did', async () => {
    const admin = await signIn('admin');
    await addCustomer('Ada <b>Obi</b>', 'ada@example.com', todayInLagos());
    await addCustomer('Not Today', 'later@example.com', '1990-01-01');

    const res = await request(app)
      .post(`${ADMIN}/birthdays/send`)
      .set('Authorization', admin.auth)
      .send({ subject: 'For {{name}}', message: 'Dear {{firstName}}, enjoy your day!' });
    expect(res.status).toBe(202);
    expect(res.body.data.queued).toBeGreaterThanOrEqual(1);
    await flush();

    const [email] = resend.to('ada@example.com');
    expect(email?.subject).toBe('For Ada <b>Obi</b>');
    expect(email?.html).not.toContain('<b>');
    expect(email?.html).toContain('&lt;b&gt;');

    const log = await EmailLogModel.findOne({ to: 'ada@example.com' }).orFail();
    expect(String(log.triggeredBy)).toBe(admin.id);
  });

  it('lets staff pick people, and reports on the ones it could not send to', async () => {
    const admin = await signIn('admin');
    const ada = await addCustomer('Ada', 'ada@example.com', '1990-03-01');
    const noDate = await addCustomer('No Date', 'nodate@example.com', null);
    const send = () =>
      request(app)
        .post(`${ADMIN}/birthdays/send`)
        .set('Authorization', admin.auth)
        .send({ userIds: [ada.id, noDate.id, '507f1f77bcf86cd799439011'] });

    expect((await send()).body.data).toEqual({
      queued: 1,
      alreadySent: 0,
      optedOut: 0,
      noDateOfBirth: 1,
      notFound: 1,
    });
    expect((await send()).body.data).toMatchObject({ queued: 0, alreadySent: 1 });
  });

  it('lists upcoming birthdays soonest first, without showing ages', async () => {
    const admin = await signIn('admin');
    const today = todayInLagos();
    const inDays = (days: number) => {
      const date = new Date(`2026${today.slice(4)}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return `1990-${date.toISOString().slice(5, 10)}`;
    };
    await addCustomer('Soon', 'soon@example.com', inDays(3));
    const now = await addCustomer('Now', 'now@example.com', today);
    await addCustomer('Later', 'later@example.com', inDays(20));
    await birthdayService.send({ userIds: [now.id] }, admin.id);

    const res = await request(app)
      .get(`${ADMIN}/birthdays/upcoming?days=7`)
      .set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((row: { name: string }) => row.name)).toEqual(['Now', 'Soon']);
    expect(res.body.data[0]).toMatchObject({ daysUntil: 0, emailStatus: 'queued' });
    expect(res.body.data[1]).toMatchObject({ daysUntil: 3, emailStatus: null });
    expect(JSON.stringify(res.body.data)).not.toContain('1990');
    expect(res.body.meta).toMatchObject({ total: 2, page: 1 });
  });

  it('previews the wording without sending', async () => {
    const admin = await signIn('admin');
    const res = await request(app)
      .post(`${ADMIN}/birthdays/preview`)
      .set('Authorization', admin.auth)
      .send({ message: 'Hello {{firstName}}!' });
    expect(res.body.data.text).toBe('Hello Ada!');
    expect(res.body.data.subject).toBe('Happy birthday, Ada!');
    expect(await EmailLogModel.countDocuments()).toBe(0);
  });
});

describe('sign-in code', () => {
  const EMAIL = 'ada@example.com';
  const login = () =>
    request(app).post(`${API}/auth/login`).send({ email: EMAIL, password: PASSWORD });
  const verify = (code: string) =>
    request(app).post(`${API}/auth/login/verify`).send({ email: EMAIL, code });

  beforeEach(() => {
    env.AUTH_LOGIN_CODE = true;
  });
  afterEach(() => {
    env.AUTH_LOGIN_CODE = false;
  });

  it('emails a code instead of signing in, and signs in once it is entered', async () => {
    await addCustomer('Ada Lovelace', EMAIL, null, { emailVerified: false });

    const res = await login().expect(200);
    expect(res.body.data).toEqual({ verificationRequired: true, email: EMAIL });
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();

    await flush();
    const code = resend.codeFor(EMAIL);
    expect((await verify(code === '000000' ? '000001' : '000000')).body.code).toBe('INVALID_CODE');

    const done = await verify(code).expect(200);
    expect(done.body.data.accessToken).toBeTruthy();
    expect(done.headers['set-cookie']?.[0]).toContain('refreshToken=');
    expect((await UserModel.findOne({ email: EMAIL }).orFail()).emailVerified).toBe(true);
    await verify(code).expect(400);
  });

  it('still refuses a wrong password without sending a code', async () => {
    await addCustomer('Ada Lovelace', EMAIL, null);
    await request(app)
      .post(`${API}/auth/login`)
      .send({ email: EMAIL, password: 'WrongPass1' })
      .expect(401);
    await flush();
    expect(resend.to(EMAIL)).toHaveLength(0);
  });

  it('resends only while a sign-in is waiting for its code', async () => {
    await addCustomer('Ada Lovelace', EMAIL, null);
    await request(app).post(`${API}/auth/login/resend`).send({ email: EMAIL }).expect(200);
    await flush();
    expect(resend.to(EMAIL)).toHaveLength(0);

    await login().expect(200);
    await EmailCodeModel.updateOne({ purpose: 'sign_in' }, { lastSentAt: new Date(0) });
    await request(app).post(`${API}/auth/login/resend`).send({ email: EMAIL }).expect(200);
    await flush();
    expect(resend.to(EMAIL)).toHaveLength(2);
  });
});
