import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { ROLES, type Role } from '@/constants/roles';
import { SessionModel } from '@/modules/auth/session.model';
import { BlogPostModel } from '@/modules/blog/blog.model';
import { MediaModel } from '@/modules/media/media.model';
import { CustomRoleModel } from '@/modules/role/role.model';
import { UserModel } from '@/modules/user/user.model';
import { FakeCloudinary } from './fakeCloudinary';

const app = createApp();
const cloudinary = new FakeCloudinary();
const API = '/api/v1';
const PASSWORD = 'Passw0rd123';
const ID = '507f1f77bcf86cd799439011';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.7 test file');

const signIn = async (role: string) => {
  const email = `${role}@example.com`;
  await UserModel.create({ name: 'Test User', email, password: PASSWORD, role });
  const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
  return `Bearer ${res.body.data.accessToken as string}`;
};

const send = (auth: string, method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
  request(app)[method](`${API}${path}`).set('Authorization', auth);

const uploadImage = async (auth: string) => {
  const res = await send(auth, 'post', '/media/images')
    .field('altText', 'A branch')
    .attach('file', PNG, { filename: 'branch.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; url: string; uploadedBy: string; altText: string };
};

beforeAll(async () => {
  await cloudinary.start(4597);
  await connectDatabase();
  await Promise.all([
    UserModel.init(),
    SessionModel.init(),
    MediaModel.init(),
    BlogPostModel.init(),
    CustomRoleModel.init(),
  ]);
});

beforeEach(async () => {
  cloudinary.reset();
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    MediaModel.deleteMany({}),
    BlogPostModel.deleteMany({}),
    CustomRoleModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await cloudinary.stop();
  await disconnectDatabase();
});

const ADMINS: Role[] = ['admin', 'super_admin'];
const READERS: Role[] = ['auditor', 'editor', 'media_publicity', ...ADMINS];
const WRITERS: Role[] = ['editor', 'media_publicity', ...ADMINS];

const ACCESS: [string, 'get' | 'post' | 'patch' | 'delete', string, Role[]][] = [
  ['list media', 'get', '/media', READERS],
  ['read media', 'get', `/media/${ID}`, READERS],
  ['upload an image', 'post', '/media/images', WRITERS],
  ['upload a document', 'post', '/media/documents', WRITERS],
  ['edit media', 'patch', `/media/${ID}`, WRITERS],
  ['delete media', 'delete', `/media/${ID}`, ['media_publicity', ...ADMINS]],
];

describe('route access', () => {
  for (const role of ROLES) {
    it(`applies the access table to ${role}`, async () => {
      const auth = await signIn(role);
      const wrong: string[] = [];
      for (const [name, method, path, allowed] of ACCESS) {
        const { status } = await send(auth, method, path);
        if ((status === 403) === allowed.includes(role)) wrong.push(`${name}: ${status}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it('requires a token', async () => {
    expect((await request(app).get(`${API}/media`)).status).toBe(401);
  });

  it('works for a custom role holding the permission', async () => {
    await CustomRoleModel.create({
      key: 'photographer',
      label: 'Photographer',
      permissions: ['media.read', 'media.write'],
    });
    const auth = await signIn('photographer');
    const media = await uploadImage(auth);
    expect((await send(auth, 'get', '/media')).status).toBe(200);
    expect((await send(auth, 'delete', `/media/${media.id}`)).status).toBe(403);
  });
});

describe('media library', () => {
  it('stores an upload in Cloudinary and records who sent it', async () => {
    const auth = await signIn('media_publicity');
    const media = await uploadImage(auth);
    const userId = (await UserModel.findOne({ role: 'media_publicity' }))?.id as string;
    expect(media.uploadedBy).toBe(userId);
    expect(media.altText).toBe('A branch');
    expect(cloudinary.files).toContain(media.url);

    expect((await send(auth, 'get', '/media').query({ kind: 'image' })).body.meta.total).toBe(1);
    expect((await send(auth, 'get', '/media').query({ kind: 'document' })).body.meta.total).toBe(0);
    expect((await send(auth, 'get', '/media').query({ search: 'branch' })).body.meta.total).toBe(1);
  });

  it('accepts PDFs as documents and rejects them as images', async () => {
    const auth = await signIn('media_publicity');
    const attachment = { filename: 'kit.pdf', contentType: 'application/pdf' };
    const doc = await send(auth, 'post', '/media/documents').attach('file', PDF, attachment);
    expect(doc.status).toBe(201);
    expect(doc.body.data.kind).toBe('document');

    const image = await send(auth, 'post', '/media/images').attach('file', PDF, attachment);
    expect(image.status).toBe(400);
  });

  it('asks for a file when none is sent', async () => {
    const auth = await signIn('editor');
    const res = await send(auth, 'post', '/media/images');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_REQUIRED');
  });

  it('removes the stored file when the details are invalid', async () => {
    const auth = await signIn('editor');
    const res = await send(auth, 'post', '/media/images')
      .field('altText', 'x'.repeat(301))
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(422);
    expect(await MediaModel.countDocuments()).toBe(0);
    expect(cloudinary.files.size).toBe(0);
  });

  it('stores nothing when the role is refused', async () => {
    const auth = await signIn('accountant');
    const res = await send(auth, 'post', '/media/images').attach('file', PNG, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(403);
    expect(await MediaModel.countDocuments()).toBe(0);
    expect(cloudinary.files.size).toBe(0);
  });

  it('updates details, and deletes both the record and the file', async () => {
    const auth = await signIn('media_publicity');
    const media = await uploadImage(auth);

    const updated = await send(auth, 'patch', `/media/${media.id}`).send({ title: 'Branch photo' });
    expect(updated.body.data.title).toBe('Branch photo');
    expect((await send(auth, 'patch', `/media/${media.id}`).send({})).status).toBe(422);

    await send(auth, 'delete', `/media/${media.id}`).expect(204);
    expect((await send(auth, 'get', `/media/${media.id}`)).status).toBe(404);
    expect(cloudinary.files).not.toContain(media.url);
  });
});

describe('media used by blog posts', () => {
  it('can be a post cover, and cannot be deleted until the post stops using it', async () => {
    const editor = await signIn('editor');
    const publicity = await signIn('media_publicity');
    const media = await uploadImage(publicity);

    const post = await send(editor, 'post', '/blog/admin/posts').send({
      title: 'Our new branch',
      content: 'Now open.',
      coverImage: media.url,
    });
    expect(post.status).toBe(201);

    const refused = await send(publicity, 'delete', `/media/${media.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('MEDIA_IN_USE');
    expect(cloudinary.files).toContain(media.url);

    await send(editor, 'patch', `/blog/admin/posts/${post.body.data.id as string}`)
      .send({ coverImage: null })
      .expect(200);
    await send(publicity, 'delete', `/media/${media.id}`).expect(204);
  });

  it('cannot be deleted while a post shows it in its text', async () => {
    const editor = await signIn('editor');
    const publicity = await signIn('media_publicity');
    const media = await uploadImage(publicity);

    await send(editor, 'post', '/blog/admin/posts')
      .send({ title: 'Photo story', content: `Look: ![branch](${media.url})` })
      .expect(201);

    expect((await send(publicity, 'delete', `/media/${media.id}`)).status).toBe(409);
  });
});
