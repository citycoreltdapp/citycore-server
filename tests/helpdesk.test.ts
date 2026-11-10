import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { SessionModel } from '@/modules/auth/session.model';
import { TicketCounterModel, TicketModel } from '@/modules/helpdesk/ticket.model';
import { TicketMessageModel } from '@/modules/helpdesk/ticketMessage.model';
import { UserModel } from '@/modules/user/user.model';

const app = createApp();
const API = '/api/v1/helpdesk';
const IMAGE_URL =
  'https://res.cloudinary.com/test-cloud/image/upload/v1/citycore/images/0f8fad5b-d9cb-469f-a165-70867728950e.png';
const PDF_URL =
  'https://res.cloudinary.com/test-cloud/raw/upload/v1/citycore/documents/0f8fad5b-d9cb-469f-a165-70867728950e.pdf';
const TICKETS = `${API}/tickets`;
const ADMIN = `${API}/admin/tickets`;
const PASSWORD = 'Passw0rd123';
const ID = '507f1f77bcf86cd799439011';

const signIn = async (name: string, role: string) => {
  const email = `${name}@example.com`;
  const user = await UserModel.create({ name: `Test ${name}`, email, password: PASSWORD, role });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: user.id as string, auth: `Bearer ${res.body.data.accessToken as string}` };
};

const ticket = { subject: 'Payment missing', description: 'My wallet has not changed.' };

let customer: { id: string; auth: string };
let other: { id: string; auth: string };
let agent: { id: string; auth: string };
let admin: { id: string; auth: string };

const raise = async (body: object = ticket, auth = customer.auth) => {
  const res = await request(app).post(TICKETS).set('Authorization', auth).send(body);
  expect(res.status).toBe(201);
  return res.body.data as { id: string; number: string };
};

const staffPatch = (id: string, body: object, auth = agent.auth) =>
  request(app).patch(`${ADMIN}/${id}`).set('Authorization', auth).send(body);

const staffPost = (id: string, body: object, auth = agent.auth) =>
  request(app).post(`${ADMIN}/${id}/messages`).set('Authorization', auth).send(body);

const customerPost = (id: string, body: object, auth = customer.auth) =>
  request(app).post(`${TICKETS}/${id}/messages`).set('Authorization', auth).send(body);

const getTicket = async (id: string) =>
  (await request(app).get(`${ADMIN}/${id}`).set('Authorization', agent.auth)).body.data;

const ageMessage = (id: string) =>
  TicketMessageModel.collection.updateOne(
    { _id: new TicketMessageModel.base.Types.ObjectId(id) },
    { $set: { createdAt: new Date(Date.now() - 16 * 60 * 1000) } },
  );

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([UserModel.init(), SessionModel.init(), TicketModel.init()]);
});

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    TicketModel.deleteMany({}),
    TicketMessageModel.deleteMany({}),
    TicketCounterModel.deleteMany({}),
  ]);
  customer = await signIn('customer', 'user');
  other = await signIn('other', 'user');
  agent = await signIn('agent', 'customer_support');
  admin = await signIn('admin', 'admin');
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('customer tickets', () => {
  it('raises a ticket, ignoring fields only staff may set', async () => {
    const res = await request(app)
      .post(TICKETS)
      .set('Authorization', customer.auth)
      .send({
        ...ticket,
        category: 'wallet',
        attachments: [IMAGE_URL, PDF_URL],
        priority: 'urgent',
        status: 'closed',
        assignee: agent.id,
        requester: other.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      number: 'TKT-000001',
      category: 'wallet',
      priority: 'normal',
      status: 'open',
      assignee: null,
      requester: { id: customer.id, name: 'Test customer', email: 'customer@example.com' },
      createdBy: { id: customer.id, name: 'Test customer' },
    });
    expect(res.body.data.requester).not.toHaveProperty('permissions');
    expect(res.body.data).not.toHaveProperty('priorityRank');
  });

  it('gives concurrent tickets different numbers', async () => {
    const tickets = await Promise.all(Array.from({ length: 10 }, () => raise()));
    expect(new Set(tickets.map((t) => t.number)).size).toBe(10);
  });

  it.each([
    ['a short subject', { ...ticket, subject: 'a' }],
    ['no description', { subject: 'Payment missing' }],
    ['an unknown category', { ...ticket, category: 'nope' }],
    ['an outside attachment', { ...ticket, attachments: ['https://evil.example/a.png'] }],
    ['a traversal attachment', { ...ticket, attachments: [`${IMAGE_URL}/../../secret.png`] }],
    [
      'a transformed attachment',
      { ...ticket, attachments: [IMAGE_URL.replace('upload/', 'upload/w_1/')] },
    ],
    [
      "another account's file",
      { ...ticket, attachments: [IMAGE_URL.replace('test-cloud', 'other')] },
    ],
    ['too many attachments', { ...ticket, attachments: Array(6).fill(IMAGE_URL) }],
  ])('rejects %s', async (_name, body) => {
    const res = await request(app).post(TICKETS).set('Authorization', customer.auth).send(body);
    expect(res.status).toBe(422);
  });

  it('requires a token', async () => {
    expect((await request(app).get(TICKETS)).status).toBe(401);
  });

  it('lists only your own tickets, without descriptions, and filters them', async () => {
    const mine = await raise({ ...ticket, category: 'wallet' });
    await raise({ ...ticket, subject: 'Login trouble', category: 'account' });
    await raise(ticket, other.auth);

    const list = await request(app).get(TICKETS).set('Authorization', customer.auth);
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data[0]).not.toHaveProperty('description');

    const filtered = await request(app)
      .get(`${TICKETS}?category=wallet`)
      .set('Authorization', customer.auth);
    expect(filtered.body.data.map((t: { id: string }) => t.id)).toEqual([mine.id]);

    const searched = await request(app)
      .get(`${TICKETS}?search=login`)
      .set('Authorization', customer.auth);
    expect(searched.body.meta.total).toBe(1);
  });

  it("hides other customers' tickets as if they did not exist", async () => {
    const { id } = await raise();
    const a = other.auth;
    const attempts = [
      request(app).get(`${TICKETS}/${id}`).set('Authorization', a),
      request(app).patch(`${TICKETS}/${id}`).set('Authorization', a).send({ subject: 'Hacked' }),
      request(app).post(`${TICKETS}/${id}/close`).set('Authorization', a),
      request(app).post(`${TICKETS}/${id}/reopen`).set('Authorization', a),
      request(app).get(`${TICKETS}/${id}/messages`).set('Authorization', a),
      customerPost(id, { body: 'Hello' }, a),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);
  });

  it("does not let a staff member reach others' tickets through customer routes", async () => {
    const { id } = await raise();
    const res = await request(app).get(`${TICKETS}/${id}`).set('Authorization', admin.auth);
    expect(res.status).toBe(404);
  });

  it('edits a ticket until staff reply, then locks it', async () => {
    const { id } = await raise();
    const edit = () =>
      request(app)
        .patch(`${TICKETS}/${id}`)
        .set('Authorization', customer.auth)
        .send({ subject: 'Updated subject', priority: 'urgent' });

    const res = await edit();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ subject: 'Updated subject', priority: 'normal' });

    await staffPost(id, { body: 'Looking into it' });
    const locked = await edit();
    expect(locked.status).toBe(409);
    expect(locked.body.error?.code ?? locked.body.code).toBe('TICKET_LOCKED');
  });

  it('rejects an empty update', async () => {
    const { id } = await raise();
    const res = await request(app)
      .patch(`${TICKETS}/${id}`)
      .set('Authorization', customer.auth)
      .send({});
    expect(res.status).toBe(422);
  });

  it('cannot delete a ticket', async () => {
    const { id } = await raise();
    const res = await request(app).delete(`${TICKETS}/${id}`).set('Authorization', customer.auth);
    expect(res.status).toBe(404);
    expect(await TicketModel.exists({ _id: id })).toBeTruthy();
  });

  it('closes and reopens a ticket', async () => {
    const { id } = await raise();
    const post = (action: string) =>
      request(app).post(`${TICKETS}/${id}/${action}`).set('Authorization', customer.auth);

    expect((await post('reopen')).status).toBe(409);

    const closed = await post('close');
    expect(closed.body.data.status).toBe('closed');
    expect(closed.body.data.closedAt).not.toBeNull();
    expect((await post('close')).status).toBe(409);

    const reopened = await post('reopen');
    expect(reopened.body.data).toMatchObject({ status: 'open', closedAt: null });
  });
});

describe('conversation', () => {
  it('moves the ticket along as each side replies', async () => {
    const { id } = await raise();

    await staffPatch(id, { assignee: agent.id });
    expect((await getTicket(id)).status).toBe('in_progress');

    const reply = await staffPost(id, { body: 'Can you send a receipt?' });
    expect(reply.status).toBe(201);
    expect(reply.body.data).toMatchObject({
      fromStaff: true,
      internal: false,
      author: { id: agent.id, name: 'Test agent' },
    });
    let current = await getTicket(id);
    expect(current.status).toBe('waiting_customer');
    expect(current.firstResponseAt).not.toBeNull();
    expect(current.lastMessageAt).not.toBeNull();
    const firstResponseAt = current.firstResponseAt as string;

    const answer = await customerPost(id, { body: 'Here it is', internal: true });
    expect(answer.body.data).toMatchObject({ fromStaff: false, internal: false });
    current = await getTicket(id);
    expect(current.status).toBe('in_progress');

    await staffPost(id, { body: 'Thanks' });
    expect((await getTicket(id)).firstResponseAt).toBe(firstResponseAt);

    await staffPatch(id, { status: 'resolved' });
    current = await getTicket(id);
    expect(current.resolvedAt).not.toBeNull();

    await customerPost(id, { body: 'Still broken' });
    current = await getTicket(id);
    expect(current).toMatchObject({ status: 'in_progress', resolvedAt: null });
  });

  it('never shows internal notes to the customer, or any sign of them', async () => {
    const { id } = await raise();
    const before = await getTicket(id);
    const note = await staffPost(id, { body: 'Looks like fraud', internal: true });
    expect(note.body.data.internal).toBe(true);

    const after = await getTicket(id);
    expect(after).toMatchObject({
      status: 'open',
      firstResponseAt: null,
      lastMessageAt: null,
      updatedAt: before.updatedAt,
    });

    const seen = await request(app)
      .get(`${TICKETS}/${id}/messages`)
      .set('Authorization', customer.auth);
    expect(seen.body.meta.total).toBe(0);

    const noteId = note.body.data.id as string;
    const url = `${TICKETS}/${id}/messages/${noteId}`;
    const a = customer.auth;
    expect((await request(app).get(url).set('Authorization', a)).status).toBe(404);
    expect((await request(app).patch(url).set('Authorization', a).send({ body: 'x' })).status).toBe(
      404,
    );
    expect((await request(app).delete(url).set('Authorization', a)).status).toBe(404);

    const staffSees = await request(app)
      .get(`${ADMIN}/${id}/messages`)
      .set('Authorization', agent.auth);
    expect(staffSees.body.meta.total).toBe(1);
  });

  it('lists messages oldest first', async () => {
    const { id } = await raise();
    await customerPost(id, { body: 'First' });
    await customerPost(id, { body: 'Second' });
    const res = await request(app)
      .get(`${TICKETS}/${id}/messages`)
      .set('Authorization', customer.auth);
    expect(res.body.data.map((m: { body: string }) => m.body)).toEqual(['First', 'Second']);
  });

  it('stops replies on a closed ticket, but not internal notes', async () => {
    const { id } = await raise();
    await staffPatch(id, { status: 'closed' });

    expect((await customerPost(id, { body: 'Hello' })).status).toBe(409);
    expect((await staffPost(id, { body: 'Hello' })).status).toBe(409);
    expect((await staffPost(id, { body: 'Note', internal: true })).status).toBe(201);
  });

  it('does not find a message through a different ticket', async () => {
    const first = await raise();
    const second = await raise();
    const message = await customerPost(first.id, { body: 'Hello' });
    const res = await request(app)
      .get(`${TICKETS}/${second.id}/messages/${message.body.data.id as string}`)
      .set('Authorization', customer.auth);
    expect(res.status).toBe(404);
  });

  it('lets an author edit and delete their message', async () => {
    const { id } = await raise();
    const { body } = await customerPost(id, { body: 'Typo' });
    const url = `${TICKETS}/${id}/messages/${body.data.id as string}`;

    const edited = await request(app)
      .patch(url)
      .set('Authorization', customer.auth)
      .send({ body: 'Fixed' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.body).toBe('Fixed');
    expect(edited.body.data.editedAt).not.toBeNull();

    const read = await request(app).get(url).set('Authorization', customer.auth);
    expect(read.body.data.body).toBe('Fixed');

    expect((await request(app).delete(url).set('Authorization', customer.auth)).status).toBe(204);
    expect((await request(app).get(url).set('Authorization', customer.auth)).status).toBe(404);
  });

  it('does not let a customer change a staff reply', async () => {
    const { id } = await raise();
    const reply = await staffPost(id, { body: 'Reply' });
    const url = `${TICKETS}/${id}/messages/${reply.body.data.id as string}`;
    const a = customer.auth;
    expect((await request(app).patch(url).set('Authorization', a).send({ body: 'x' })).status).toBe(
      403,
    );
    expect((await request(app).delete(url).set('Authorization', a)).status).toBe(403);
  });

  it('locks messages after the edit window', async () => {
    const { id } = await raise();
    const { body } = await customerPost(id, { body: 'Old' });
    const messageId = body.data.id as string;
    await ageMessage(messageId);
    const url = `${TICKETS}/${id}/messages/${messageId}`;
    const a = customer.auth;

    expect(
      (await request(app).patch(url).set('Authorization', a).send({ body: 'New' })).status,
    ).toBe(409);
    expect((await request(app).delete(url).set('Authorization', a)).status).toBe(409);
  });

  it('lets helpdesk.delete remove any message, and nobody else', async () => {
    const { id } = await raise();
    const { body } = await customerPost(id, { body: 'My card is 4242...' });
    const messageId = body.data.id as string;
    await ageMessage(messageId);
    const url = `${ADMIN}/${id}/messages/${messageId}`;

    expect((await request(app).delete(url).set('Authorization', agent.auth)).status).toBe(403);
    expect((await request(app).delete(url).set('Authorization', admin.auth)).status).toBe(204);
    expect(await TicketMessageModel.exists({ _id: messageId })).toBeNull();
  });

  it('lets staff edit their own message only', async () => {
    const { id } = await raise();
    const reply = await staffPost(id, { body: 'Typo' });
    const url = `${ADMIN}/${id}/messages/${reply.body.data.id as string}`;

    const own = await request(app)
      .patch(url)
      .set('Authorization', agent.auth)
      .send({ body: 'Fixed' });
    expect(own.body.data.body).toBe('Fixed');

    const notOwn = await request(app)
      .patch(url)
      .set('Authorization', admin.auth)
      .send({ body: 'Mine now' });
    expect(notOwn.status).toBe(403);
  });
});

describe('staff tickets', () => {
  it('raises a ticket for a customer', async () => {
    const res = await request(app)
      .post(ADMIN)
      .set('Authorization', agent.auth)
      .send({ ...ticket, requester: customer.id, priority: 'high', assignee: agent.id });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      priority: 'high',
      status: 'in_progress',
      requester: { id: customer.id },
      assignee: { id: agent.id, name: 'Test agent' },
      createdBy: { id: agent.id },
    });
    expect(res.body.data.assignee).not.toHaveProperty('email');

    const seen = await request(app).get(TICKETS).set('Authorization', customer.auth);
    expect(seen.body.meta.total).toBe(1);
  });

  it('rejects a requester that does not exist', async () => {
    const res = await request(app)
      .post(ADMIN)
      .set('Authorization', agent.auth)
      .send({ ...ticket, requester: ID });
    expect(res.status).toBe(400);
  });

  it('assigns only to active staff who can work tickets', async () => {
    const { id } = await raise();
    const editor = await signIn('editor', 'editor');
    const auditor = await signIn('auditor', 'auditor');
    const gone = await signIn('gone', 'customer_support');
    await UserModel.updateOne({ _id: gone.id }, { isActive: false });

    for (const assignee of [customer.id, editor.id, auditor.id, gone.id, ID]) {
      const res = await staffPatch(id, { assignee });
      expect(res.status).toBe(400);
    }
    expect((await getTicket(id)).assignee).toBeNull();

    expect((await staffPatch(id, { assignee: admin.id })).body.data.assignee.id).toBe(admin.id);
    expect((await staffPatch(id, { assignee: null })).body.data.assignee).toBeNull();
  });

  it('keeps timestamps in step with status', async () => {
    const { id } = await raise();

    const resolved = (await staffPatch(id, { status: 'resolved' })).body.data;
    expect(resolved.resolvedAt).not.toBeNull();

    const closed = (await staffPatch(id, { status: 'closed' })).body.data;
    expect(closed.closedAt).not.toBeNull();
    expect(closed.resolvedAt).toBe(resolved.resolvedAt);

    const open = (await staffPatch(id, { status: 'open' })).body.data;
    expect(open).toMatchObject({ resolvedAt: null, closedAt: null });
  });

  it('only allows a closed ticket to be reopened', async () => {
    const { id } = await raise();
    await staffPatch(id, { status: 'closed' });

    expect((await staffPatch(id, { subject: 'Changed subject' })).status).toBe(409);
    expect((await staffPatch(id, { status: 'closed' })).status).toBe(409);

    const reopened = await staffPatch(id, { status: 'open', subject: 'Changed subject' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.subject).toBe('Changed subject');
  });

  it('filters and sorts the queue', async () => {
    const low = await raise();
    const urgent = await raise();
    const normal = await raise(ticket, other.auth);
    await staffPatch(low.id, { priority: 'low' });
    await staffPatch(urgent.id, { priority: 'urgent', assignee: agent.id });
    await staffPatch(normal.id, { status: 'closed' });

    const query = async (qs: string) => {
      const res = await request(app).get(`${ADMIN}?${qs}`).set('Authorization', agent.auth);
      expect(res.status).toBe(200);
      return (res.body.data as { id: string }[]).map((t) => t.id);
    };

    expect(await query('sort=-priorityRank')).toEqual([urgent.id, normal.id, low.id]);
    expect(await query(`assignee=${agent.id}`)).toEqual([urgent.id]);
    expect(await query('unassigned=true&sort=createdAt')).toEqual([low.id, normal.id]);
    expect(await query('unassigned=false')).toEqual([urgent.id]);
    expect(await query(`requester=${other.id}`)).toEqual([normal.id]);
    expect(await query('status=closed')).toEqual([normal.id]);
    expect(await query('status=open,in_progress&sort=createdAt')).toEqual([low.id, urgent.id]);
    expect(await query('priority=urgent')).toEqual([urgent.id]);

    const bad = await request(app).get(`${ADMIN}?status=nope`).set('Authorization', agent.auth);
    expect(bad.status).toBe(422);
  });

  it('counts tickets', async () => {
    const urgent = await raise();
    const closed = await raise();
    await raise();
    await staffPatch(urgent.id, { priority: 'urgent', assignee: agent.id });
    await staffPatch(closed.id, { status: 'closed', priority: 'high' });

    const res = await request(app).get(`${API}/admin/stats`).set('Authorization', agent.auth);
    expect(res.body.data).toEqual({
      byStatus: { open: 1, in_progress: 1, waiting_customer: 0, resolved: 0, closed: 1 },
      activeByPriority: { low: 0, normal: 1, high: 0, urgent: 1 },
      unassignedActive: 1,
    });
  });

  it('deletes a ticket along with its conversation', async () => {
    const { id } = await raise();
    const survivor = await raise();
    await customerPost(id, { body: 'Hello' });
    await customerPost(survivor.id, { body: 'Hello' });

    const url = `${ADMIN}/${id}`;
    expect((await request(app).delete(url).set('Authorization', agent.auth)).status).toBe(403);
    expect((await request(app).delete(url).set('Authorization', admin.auth)).status).toBe(204);
    expect((await request(app).get(url).set('Authorization', admin.auth)).status).toBe(404);
    expect((await request(app).delete(url).set('Authorization', admin.auth)).status).toBe(404);

    expect(await TicketMessageModel.countDocuments({ ticket: id })).toBe(0);
    expect(await TicketMessageModel.countDocuments({ ticket: survivor.id })).toBe(1);
  });

  it('keeps a ticket readable once the customer has been deleted', async () => {
    const { id } = await raise();
    await customerPost(id, { body: 'Hello' });
    await UserModel.deleteOne({ _id: customer.id });

    expect((await getTicket(id)).requester).toBeNull();
    const messages = await request(app)
      .get(`${ADMIN}/${id}/messages`)
      .set('Authorization', agent.auth);
    expect(messages.body.data[0].author).toBeNull();
  });

  it('lets a read-only auditor look but not touch', async () => {
    const auditor = await signIn('auditor', 'auditor');
    const { id } = await raise();
    const a = auditor.auth;

    expect((await request(app).get(`${ADMIN}/${id}`).set('Authorization', a)).status).toBe(200);
    expect((await staffPatch(id, { priority: 'low' }, a)).status).toBe(403);
    expect((await staffPost(id, { body: 'Hello' }, a)).status).toBe(403);
  });

  it('returns 404 for a missing ticket and 422 for a bad id', async () => {
    const a = agent.auth;
    expect((await request(app).get(`${ADMIN}/${ID}`).set('Authorization', a)).status).toBe(404);
    expect((await request(app).get(`${ADMIN}/nope`).set('Authorization', a)).status).toBe(422);
  });
});
