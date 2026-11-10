import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { PERMISSIONS } from '@/constants/permissions';
import { ROLES, Role } from '@/constants/roles';
import { SessionModel } from '@/modules/auth/session.model';
import { CustomRoleModel } from '@/modules/role/role.model';
import { UserModel } from '@/modules/user/user.model';
import { userService } from '@/modules/user/user.service';

const app = createApp();
const API = '/api/v1';
const PASSWORD = 'Passw0rd123';
const ID = '507f1f77bcf86cd799439011';

const createUser = (role: string, email = `${role}@example.com`) =>
  UserModel.create({ name: 'Test User', email, password: PASSWORD, role });

const signIn = async (role: Role, email = `${role}@example.com`) => {
  const user = await createUser(role, email);
  const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
  return { id: user.id as string, auth: `Bearer ${res.body.data.accessToken as string}` };
};

const send = (auth: string, method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
  request(app)[method](`${API}${path}`).set('Authorization', auth);

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([UserModel.init(), SessionModel.init(), CustomRoleModel.init()]);
});

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    CustomRoleModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await disconnectDatabase();
});

const ADMINS: Role[] = ['admin', 'super_admin'];
const CONTENT_READERS: Role[] = ['auditor', 'editor', 'media_publicity', ...ADMINS];
const CONTENT_WRITERS: Role[] = ['editor', 'media_publicity', ...ADMINS];
const CONTENT_PUBLISHERS: Role[] = ['editor', ...ADMINS];

/** Every guarded route, and exactly which roles may reach it. Anyone else must get 403. */
const ACCESS: [string, 'get' | 'post' | 'patch' | 'delete', string, Role[]][] = [
  ['list users', 'get', '/users', ['customer_support', 'accountant', 'auditor', ...ADMINS]],
  ['read a user', 'get', `/users/${ID}`, ['customer_support', 'accountant', 'auditor', ...ADMINS]],
  ['create a user', 'post', '/users', ADMINS],
  ['update a user', 'patch', `/users/${ID}`, ADMINS],
  ['delete a user', 'delete', `/users/${ID}`, ADMINS],
  ['replace a user avatar', 'delete', `/users/${ID}/avatar`, ADMINS],
  ['sign out a user', 'post', `/users/${ID}/sign-out`, ADMINS],
  ['read roles', 'get', '/roles', ['auditor', ...ADMINS]],
  ['read a role', 'get', '/roles/editor', ['auditor', ...ADMINS]],
  ['create a role', 'post', '/roles', ['super_admin']],
  ['update a role', 'patch', '/roles/some_role', ['super_admin']],
  ['delete a role', 'delete', '/roles/some_role', ['super_admin']],

  ['list all posts', 'get', '/blog/admin/posts', CONTENT_READERS],
  ['read any post', 'get', `/blog/admin/posts/${ID}`, CONTENT_READERS],
  ['create a post', 'post', '/blog/admin/posts', CONTENT_WRITERS],
  ['update a post', 'patch', `/blog/admin/posts/${ID}`, CONTENT_WRITERS],
  ['publish a post', 'post', `/blog/admin/posts/${ID}/publish`, CONTENT_PUBLISHERS],
  ['unpublish a post', 'post', `/blog/admin/posts/${ID}/unpublish`, CONTENT_PUBLISHERS],
  ['archive a post', 'post', `/blog/admin/posts/${ID}/archive`, CONTENT_PUBLISHERS],
  ['delete a post', 'delete', `/blog/admin/posts/${ID}`, CONTENT_PUBLISHERS],

  ['wallet status', 'get', '/wallet/admin/status', ['accountant', 'auditor', ...ADMINS]],
  ['all transactions', 'get', '/wallet/admin/transactions', ['accountant', 'auditor', ...ADMINS]],
  ['recheck', 'post', '/wallet/admin/transactions/ref/recheck', ['accountant', ...ADMINS]],

  ['list configs', 'get', '/platform-config/admin', ['auditor', ...ADMINS]],
  ['read a config', 'get', '/platform-config/admin/a.key', ['auditor', ...ADMINS]],
  ['create a config', 'post', '/platform-config/admin', ADMINS],
  ['update a config', 'patch', '/platform-config/admin/a.key', ADMINS],
  ['delete a config', 'delete', '/platform-config/admin/a.key', ADMINS],

  ['ticket stats', 'get', '/helpdesk/admin/stats', ['customer_support', 'auditor', ...ADMINS]],
  ['all tickets', 'get', '/helpdesk/admin/tickets', ['customer_support', 'auditor', ...ADMINS]],
  [
    'read any ticket',
    'get',
    `/helpdesk/admin/tickets/${ID}`,
    ['customer_support', 'auditor', ...ADMINS],
  ],
  [
    'raise a ticket for someone',
    'post',
    '/helpdesk/admin/tickets',
    ['customer_support', ...ADMINS],
  ],
  ['update any ticket', 'patch', `/helpdesk/admin/tickets/${ID}`, ['customer_support', ...ADMINS]],
  ['delete a ticket', 'delete', `/helpdesk/admin/tickets/${ID}`, ADMINS],
  [
    'read any conversation',
    'get',
    `/helpdesk/admin/tickets/${ID}/messages`,
    ['customer_support', 'auditor', ...ADMINS],
  ],
  [
    'reply as staff',
    'post',
    `/helpdesk/admin/tickets/${ID}/messages`,
    ['customer_support', ...ADMINS],
  ],
  ['my tickets', 'get', '/helpdesk/tickets', [...ROLES]],
  ['symplus status', 'get', '/symplus/admin/status', ['auditor', ...ADMINS]],
  ['symplus jobs', 'get', '/symplus/admin/jobs', ['auditor', ...ADMINS]],
  ['retry a job', 'post', `/symplus/admin/jobs/${ID}/retry`, ADMINS],
  ['link a customer', 'post', '/symplus/admin/links', ADMINS],
  [
    'read a link',
    'get',
    `/symplus/admin/links/${ID}`,
    ['customer_support', 'accountant', 'auditor', ...ADMINS],
  ],
  [
    'list customers',
    'get',
    '/symplus/admin/customers',
    ['customer_support', 'accountant', 'auditor', ...ADMINS],
  ],
  [
    'search customers',
    'post',
    '/symplus/admin/customers/search',
    ['customer_support', 'accountant', 'auditor', ...ADMINS],
  ],
  [
    'read a customer',
    'get',
    '/symplus/admin/customers/1',
    ['customer_support', 'accountant', 'auditor', ...ADMINS],
  ],
  [
    'customer balances',
    'get',
    '/symplus/admin/customers/1/balances',
    ['accountant', 'auditor', ...ADMINS],
  ],
  [
    'document status',
    'get',
    '/symplus/admin/customers/1/documents',
    ['customer_support', 'auditor', ...ADMINS],
  ],
  [
    'download a document',
    'get',
    '/symplus/admin/customers/1/documents/PIX',
    ['customer_support', 'auditor', ...ADMINS],
  ],
  ['update a customer', 'patch', '/symplus/admin/customers/1/bank', ADMINS],
  ['remove employment', 'delete', '/symplus/admin/customers/1/employment', ADMINS],
  ['register a customer', 'post', '/symplus/admin/registrations/individual', ADMINS],
  ['upgrade a minor', 'post', '/symplus/admin/minors/upgrade', ADMINS],
];

describe('route access', () => {
  for (const role of ROLES) {
    it(`applies the access table to ${role}`, async () => {
      const { auth } = await signIn(role);
      const wrong: string[] = [];
      for (const [name, method, path, allowed] of ACCESS) {
        const { status } = await send(auth, method, path).send();
        // A 4xx or 503 from further in is fine for an allowed role: it got past the guard.
        if ((status === 403) === allowed.includes(role)) wrong.push(`${name}: ${status}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it('still requires a token', async () => {
    expect((await request(app).get(`${API}/roles`)).status).toBe(401);
  });
});

describe('GET /roles', () => {
  it('lists every role and what the caller may assign', async () => {
    const { auth } = await signIn('admin');
    const res = await send(auth, 'get', '/roles');
    const assignable = Object.fromEntries(
      (res.body.data.roles as { role: Role; assignable: boolean }[]).map((r) => [
        r.role,
        r.assignable,
      ]),
    );
    expect(Object.keys(assignable).sort()).toEqual([...ROLES].sort());
    expect(assignable).toMatchObject({ accountant: true, admin: false, super_admin: false });
  });
});

describe('permissions on the user', () => {
  it('comes back on login and on the profile', async () => {
    await createUser('accountant');
    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'accountant@example.com', password: PASSWORD });
    expect(login.body.data.user.permissions).toContain('wallet.read');

    const me = await send(`Bearer ${login.body.data.accessToken as string}`, 'get', '/users/me');
    expect(me.body.data.permissions).toContain('wallet.reconcile');
    expect(me.body.data.permissions).not.toContain('users.write');
  });

  it('is empty for a customer', async () => {
    const { auth } = await signIn('user');
    expect((await send(auth, 'get', '/users/me')).body.data.permissions).toEqual([]);
  });
});

describe('who can manage whom', () => {
  const newUser = { name: 'New User', email: 'new@example.com', password: PASSWORD };

  it('lets an admin create staff but not admins', async () => {
    const { auth } = await signIn('admin');
    const staff = await send(auth, 'post', '/users').send({ ...newUser, role: 'editor' });
    expect(staff.status).toBe(201);

    for (const role of ADMINS) {
      const res = await send(auth, 'post', '/users').send({
        ...newUser,
        email: `${role}2@example.com`,
        role,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_ASSIGNMENT_FORBIDDEN');
    }
    expect(await UserModel.countDocuments({ email: /2@example/ })).toBe(0);
  });

  it('stops an admin promoting anyone to admin', async () => {
    const { auth } = await signIn('admin');
    const { id } = await signIn('editor');
    for (const role of ADMINS) {
      const res = await send(auth, 'patch', `/users/${id}`).send({ role });
      expect(res.status).toBe(403);
    }
    expect((await UserModel.findById(id))?.role).toBe('editor');
  });

  it('stops an admin changing or deleting a peer or a super admin', async () => {
    const { auth } = await signIn('admin');
    for (const [role, email] of [
      ['admin', 'peer@example.com'],
      ['super_admin', 'boss@example.com'],
    ] as const) {
      const { id } = await signIn(role, email);
      for (const body of [{ role: 'user' }, { isActive: false }, { email: 'taken@example.com' }]) {
        expect((await send(auth, 'patch', `/users/${id}`).send(body)).status).toBe(403);
      }
      expect((await send(auth, 'delete', `/users/${id}`)).status).toBe(403);
      expect(await UserModel.findById(id)).toMatchObject({ role, email, isActive: true });
    }
  });

  it('lets a super admin manage admins and other super admins', async () => {
    const { auth } = await signIn('super_admin');
    const { id: adminId } = await signIn('admin');
    const { id: otherId } = await signIn('super_admin', 'other@example.com');

    expect((await send(auth, 'patch', `/users/${adminId}`).send({ role: 'user' })).status).toBe(
      200,
    );
    expect((await send(auth, 'patch', `/users/${otherId}`).send({ isActive: false })).status).toBe(
      200,
    );
    const created = await send(auth, 'post', '/users').send({ ...newUser, role: 'super_admin' });
    expect(created.status).toBe(201);
  });

  it('stops a super admin demoting, deactivating or deleting themselves', async () => {
    const { auth, id } = await signIn('super_admin');
    expect((await send(auth, 'patch', `/users/${id}`).send({ role: 'user' })).status).toBe(403);
    expect((await send(auth, 'patch', `/users/${id}`).send({ isActive: false })).status).toBe(403);
    expect((await send(auth, 'delete', `/users/${id}`)).status).toBe(403);
  });

  it('applies a demotion on the very next request, with the same token', async () => {
    const { auth: superAdmin } = await signIn('super_admin');
    const { auth, id } = await signIn('admin');
    expect((await send(auth, 'get', '/users')).status).toBe(200);

    await send(superAdmin, 'patch', `/users/${id}`).send({ role: 'user' });
    expect((await send(auth, 'get', '/users')).status).toBe(403);
  });

  it('still answers 404 for a user that does not exist', async () => {
    const { auth } = await signIn('admin');
    expect((await send(auth, 'patch', `/users/${ID}`).send({ name: 'Nobody' })).status).toBe(404);
  });

  it('still ignores a role sent at registration', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ ...newUser, role: 'super_admin' });
    expect(res.body.data.user.role).toBe('user');
  });
});

describe('super admin access', () => {
  it('holds every permission, and an admin holds all but managing roles', async () => {
    const superAdmin = await signIn('super_admin');
    const admin = await signIn('admin');
    const permissions = async (auth: string) =>
      (await send(auth, 'get', '/users/me')).body.data.permissions as string[];

    expect((await permissions(superAdmin.auth)).sort()).toEqual([...PERMISSIONS].sort());
    expect((await permissions(admin.auth)).sort()).toEqual(
      PERMISSIONS.filter((p) => p !== 'roles.write').sort(),
    );
  });
});

describe('role manager', () => {
  const blogWriter = {
    key: 'blog_writer',
    label: 'Blog Writer',
    description: 'Drafts posts',
    permissions: ['content.read', 'content.write'],
  };

  it('creates, reads, updates and deletes a custom role', async () => {
    const { auth } = await signIn('super_admin');

    const created = await send(auth, 'post', '/roles').send(blogWriter);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      role: 'blog_writer',
      builtIn: false,
      assignable: true,
      userCount: 0,
    });

    const listed = await send(auth, 'get', '/roles');
    const roles = listed.body.data.roles as { role: string }[];
    expect(roles.map((r) => r.role)).toContain('blog_writer');
    expect(listed.body.data.grantablePermissions).not.toContain('roles.write');

    const updated = await send(auth, 'patch', '/roles/blog_writer').send({
      permissions: ['content.read'],
    });
    expect(updated.body.data.permissions).toEqual(['content.read']);
    expect(updated.body.data.label).toBe('Blog Writer');
    expect((await send(auth, 'get', '/roles/blog_writer')).body.data.permissions).toEqual([
      'content.read',
    ]);

    expect((await send(auth, 'delete', '/roles/blog_writer')).status).toBe(204);
    expect((await send(auth, 'get', '/roles/blog_writer')).status).toBe(404);
  });

  it('refuses duplicate keys, unknown permissions and roles.write', async () => {
    const { auth } = await signIn('super_admin');
    await send(auth, 'post', '/roles').send(blogWriter);

    expect((await send(auth, 'post', '/roles').send(blogWriter)).status).toBe(409);
    expect((await send(auth, 'post', '/roles').send({ ...blogWriter, key: 'editor' })).status).toBe(
      409,
    );
    for (const permissions of [['nope.read'], ['roles.write']]) {
      const res = await send(auth, 'post', '/roles').send({
        ...blogWriter,
        key: 'x_y',
        permissions,
      });
      expect(res.status).toBe(422);
    }
    for (const key of ['Has Space', '1abc', 'a', '$ne']) {
      expect((await send(auth, 'post', '/roles').send({ ...blogWriter, key })).status).toBe(422);
    }
  });

  it('leaves built-in roles locked', async () => {
    const { auth } = await signIn('super_admin');
    const updated = await send(auth, 'patch', '/roles/admin').send({ permissions: [] });
    expect(updated.status).toBe(403);
    expect(updated.body.code).toBe('ROLE_LOCKED');
    expect((await send(auth, 'delete', '/roles/editor')).body.code).toBe('ROLE_LOCKED');
  });

  it('gives a holder exactly the role permissions, and applies edits on the next request', async () => {
    const { auth: superAdmin } = await signIn('super_admin');
    await send(superAdmin, 'post', '/roles').send(blogWriter);
    const { auth, id } = await signIn('user', 'writer@example.com');

    expect((await send(auth, 'get', '/blog/admin/posts')).status).toBe(403);
    const assigned = await send(superAdmin, 'patch', `/users/${id}`).send({ role: 'blog_writer' });
    expect(assigned.body.data.permissions).toEqual(blogWriter.permissions);

    expect((await send(auth, 'get', '/blog/admin/posts')).status).toBe(200);
    expect((await send(auth, 'get', '/users/me')).body.data.permissions).toEqual(
      blogWriter.permissions,
    );
    expect((await send(auth, 'get', '/users')).status).toBe(403);

    await send(superAdmin, 'patch', '/roles/blog_writer').send({ permissions: [] });
    expect((await send(auth, 'get', '/blog/admin/posts')).status).toBe(403);
  });

  it('shows custom role permissions when listing users and at login', async () => {
    const { auth: superAdmin } = await signIn('super_admin');
    await send(superAdmin, 'post', '/roles').send(blogWriter);
    await createUser('blog_writer', 'writer@example.com');

    const list = await send(superAdmin, 'get', '/users?role=blog_writer');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].permissions).toEqual(blogWriter.permissions);

    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'writer@example.com', password: PASSWORD });
    expect(login.body.data.user.permissions).toEqual(blogWriter.permissions);
  });

  it('refuses to delete a role people hold', async () => {
    const { auth } = await signIn('super_admin');
    await send(auth, 'post', '/roles').send(blogWriter);
    await createUser('blog_writer', 'writer@example.com');

    const res = await send(auth, 'delete', '/roles/blog_writer');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLE_IN_USE');
    expect((await send(auth, 'get', '/roles/blog_writer')).body.data.userCount).toBe(1);
  });

  it('refuses to assign a role that does not exist', async () => {
    const { auth } = await signIn('super_admin');
    const { id } = await signIn('user', 'someone@example.com');
    expect((await send(auth, 'patch', `/users/${id}`).send({ role: 'ghost' })).status).toBe(422);
    expect(
      (
        await send(auth, 'post', '/users').send({
          name: 'New User',
          email: 'new@example.com',
          password: PASSWORD,
          role: 'constructor',
        })
      ).status,
    ).toBe(422);
  });

  it('lets an admin assign a custom role, but keeps its holders below admins', async () => {
    const { auth: superAdmin } = await signIn('super_admin');
    const { auth: admin, id: adminId } = await signIn('admin');
    await send(superAdmin, 'post', '/roles').send({
      ...blogWriter,
      key: 'people_ops',
      permissions: ['users.read', 'users.write', 'users.assign_role'],
    });
    const { auth, id } = await signIn('user', 'ops@example.com');

    expect((await send(admin, 'patch', `/users/${id}`).send({ role: 'people_ops' })).status).toBe(
      200,
    );
    const target = await signIn('user', 'target@example.com');
    expect((await send(auth, 'patch', `/users/${target.id}`).send({ role: 'admin' })).status).toBe(
      403,
    );
    expect(
      (await send(auth, 'patch', `/users/${target.id}`).send({ role: 'people_ops' })).status,
    ).toBe(403);
    expect((await send(auth, 'patch', `/users/${adminId}`).send({ role: 'user' })).status).toBe(
      403,
    );
  });

  it('leaves a holder with nothing if their role disappears', async () => {
    const { auth: superAdmin } = await signIn('super_admin');
    await send(superAdmin, 'post', '/roles').send(blogWriter);
    const { auth } = await signIn('blog_writer' as Role, 'writer@example.com');
    await CustomRoleModel.deleteMany({});
    expect((await send(auth, 'get', '/blog/admin/posts')).status).toBe(403);
    expect((await send(auth, 'get', '/users/me')).body.data.permissions).toEqual([]);
  });
});

describe('seeding the super admin', () => {
  const seed = { name: 'Owner', email: 'owner@example.com', password: PASSWORD };

  it('creates the account', async () => {
    expect(await userService.ensureSuperAdmin(seed)).toBe('created');
    expect((await UserModel.findOne({ email: seed.email }))?.role).toBe('super_admin');
  });

  it('promotes and reactivates an account when the password matches', async () => {
    const user = await createUser('admin', seed.email);
    await UserModel.updateOne({ _id: user.id }, { isActive: false });
    expect(await userService.ensureSuperAdmin(seed)).toBe('promoted');
    expect(await UserModel.findById(user.id)).toMatchObject({
      role: 'super_admin',
      isActive: true,
    });
    expect(await userService.ensureSuperAdmin(seed)).toBe('unchanged');
  });

  it('refuses to promote an account registered with another password', async () => {
    const user = await createUser('user', seed.email);
    await expect(
      userService.ensureSuperAdmin({ ...seed, password: 'Different123' }),
    ).rejects.toMatchObject({ code: 'SEED_PASSWORD_MISMATCH' });
    expect((await UserModel.findById(user.id))?.role).toBe('user');
  });
});
