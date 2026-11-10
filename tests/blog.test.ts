import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { connectDatabase, disconnectDatabase } from '@/config/database';
import { SessionModel } from '@/modules/auth/session.model';
import { BlogPostModel } from '@/modules/blog/blog.model';
import { UserModel } from '@/modules/user/user.model';

const app = createApp();
const API = '/api/v1';
const ADMIN = `${API}/blog/admin/posts`;
const PUBLIC = `${API}/blog/posts`;
const PASSWORD = 'Passw0rd123';
const ID = '507f1f77bcf86cd799439011';

const signIn = async (role: string) => {
  const email = `${role}@example.com`;
  const user = await UserModel.create({ name: `Test ${role}`, email, password: PASSWORD, role });
  const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
  return { id: user.id as string, auth: `Bearer ${res.body.data.accessToken as string}` };
};

const post = { title: 'City Core launches', content: '# Hello\n\nBody text.' };

let editor: string;
let editorId: string;

const createPost = async (body: object = post) => {
  const res = await request(app).post(ADMIN).set('Authorization', editor).send(body);
  expect(res.status).toBe(201);
  return res.body.data as { id: string; slug: string };
};

const publish = (id: string, body?: object) =>
  request(app).post(`${ADMIN}/${id}/publish`).set('Authorization', editor).send(body);

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([UserModel.init(), SessionModel.init(), BlogPostModel.init()]);
});

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    BlogPostModel.deleteMany({}),
  ]);
  ({ auth: editor, id: editorId } = await signIn('editor'));
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('managing posts', () => {
  it('creates a draft owned by the caller, ignoring status and author in the body', async () => {
    const res = await request(app)
      .post(ADMIN)
      .set('Authorization', editor)
      .send({
        ...post,
        excerpt: 'Short',
        coverImage: 'https://res.cloudinary.com/test-cloud/image/upload/v1/citycore/images/a.png',
        category: 'News',
        tags: ['Launch', 'launch', 'city'],
        status: 'published',
        publishedAt: new Date().toISOString(),
        author: ID,
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      slug: 'city-core-launches',
      status: 'draft',
      publishedAt: null,
      tags: ['launch', 'city'],
      author: { id: editorId, name: 'Test editor', avatar: null },
    });
    expect(res.body.data.author).not.toHaveProperty('email');
    expect(res.body.data.author).not.toHaveProperty('permissions');
  });

  it('makes slugs unique, and handles titles with nothing to slug', async () => {
    expect((await createPost()).slug).toBe('city-core-launches');
    expect((await createPost()).slug).toBe('city-core-launches-2');
    expect((await createPost()).slug).toBe('city-core-launches-3');
    expect((await createPost({ title: 'Café & Crème!' })).slug).toBe('cafe-creme');
    expect((await createPost({ title: '日本語のタイトル' })).slug).toBe('post');
  });

  it('answers 409 when a chosen slug is taken', async () => {
    const { id } = await createPost({ ...post, slug: 'taken' });
    const other = await createPost({ title: 'Another post' });
    expect(
      (
        await request(app)
          .post(ADMIN)
          .set('Authorization', editor)
          .send({ ...post, slug: 'taken' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(`${ADMIN}/${other.id}`)
          .set('Authorization', editor)
          .send({ slug: 'taken' })
      ).status,
    ).toBe(409);
    expect((await BlogPostModel.findById(id))?.slug).toBe('taken');
  });

  it('rejects invalid input, including images a browser could run', async () => {
    const bad = [
      {},
      { title: 'x' },
      { ...post, slug: 'Not A Slug' },
      { ...post, coverImage: 'javascript:alert(1)' },
      { ...post, coverImage: 'http://example.com/a.png' },
      { ...post, coverImage: '/uploads/images/a.png' },
    ];
    for (const body of bad) {
      const res = await request(app).post(ADMIN).set('Authorization', editor).send(body);
      expect(res.status).toBe(422);
    }
    await createPost({ ...post, coverImage: 'https://cdn.example.com/a.png' });
  });

  it('reads, updates and deletes a post', async () => {
    const { id, slug } = await createPost();

    const read = await request(app).get(`${ADMIN}/${id}`).set('Authorization', editor);
    expect(read.body.data.content).toBe(post.content);

    const updated = await request(app)
      .patch(`${ADMIN}/${id}`)
      .set('Authorization', editor)
      .send({ title: 'New title', status: 'published', coverImage: null });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ title: 'New title', slug, status: 'draft' });

    const empty = await request(app).patch(`${ADMIN}/${id}`).set('Authorization', editor).send({});
    expect(empty.status).toBe(422);

    expect((await request(app).delete(`${ADMIN}/${id}`).set('Authorization', editor)).status).toBe(
      204,
    );
    expect((await request(app).get(`${ADMIN}/${id}`).set('Authorization', editor)).status).toBe(
      404,
    );
    expect((await request(app).delete(`${ADMIN}/${id}`).set('Authorization', editor)).status).toBe(
      404,
    );
  });

  it('lists every status with filters, without the post bodies', async () => {
    const draft = await createPost({ ...post, category: 'News', tags: ['a'] });
    const live = await createPost({ title: 'Second post', content: 'Text', tags: ['b'] });
    await publish(live.id);

    const all = await request(app).get(ADMIN).set('Authorization', editor);
    expect(all.body.meta.total).toBe(2);
    expect(all.body.data[0]).not.toHaveProperty('content');
    expect(all.body.data[0].author.name).toBe('Test editor');

    const ids = async (query: string) => {
      const res = await request(app).get(`${ADMIN}?${query}`).set('Authorization', editor);
      expect(res.status).toBe(200);
      return (res.body.data as { id: string }[]).map((p) => p.id);
    };
    expect(await ids('status=draft')).toEqual([draft.id]);
    expect(await ids('status=published')).toEqual([live.id]);
    expect(await ids('category=News')).toEqual([draft.id]);
    expect(await ids('tag=b')).toEqual([live.id]);
    expect(await ids('search=second')).toEqual([live.id]);
    expect(await ids(`author=${ID}`)).toEqual([]);
    expect(
      (await request(app).get(`${ADMIN}?status=bogus`).set('Authorization', editor)).status,
    ).toBe(422);
    expect(
      (await request(app).get(`${ADMIN}?sort=password`).set('Authorization', editor)).status,
    ).toBe(422);
  });
});

describe('the publishing workflow', () => {
  it('moves a post through publish, unpublish and archive', async () => {
    const { id, slug } = await createPost();
    const readPublic = () => request(app).get(`${PUBLIC}/${slug}`);
    expect((await readPublic()).status).toBe(404);

    const published = await publish(id);
    expect(published.body.data.status).toBe('published');
    expect(published.body.data.publishedAt).not.toBeNull();
    expect((await readPublic()).status).toBe(200);

    const again = await publish(id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('POST_ALREADY_PUBLISHED');

    const unpublished = await request(app)
      .post(`${ADMIN}/${id}/unpublish`)
      .set('Authorization', editor);
    expect(unpublished.body.data).toMatchObject({ status: 'draft', publishedAt: null });
    expect((await readPublic()).status).toBe(404);

    await publish(id);
    const archived = await request(app).post(`${ADMIN}/${id}/archive`).set('Authorization', editor);
    expect(archived.body.data.status).toBe('archived');
    expect((await readPublic()).status).toBe(404);

    expect((await publish(id)).status).toBe(200);
    expect((await readPublic()).status).toBe(200);
  });

  it('keeps a scheduled post hidden until its time, and can bring it forward', async () => {
    const { id, slug } = await createPost();
    const publishAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    expect((await publish(id, { publishAt })).status).toBe(200);
    expect((await request(app).get(`${PUBLIC}/${slug}`)).status).toBe(404);
    expect((await request(app).get(PUBLIC)).body.meta.total).toBe(0);

    expect((await publish(id)).status).toBe(200);
    expect((await request(app).get(`${PUBLIC}/${slug}`)).status).toBe(200);
  });

  it('goes live by itself when the scheduled time passes', async () => {
    const { id, slug } = await createPost();
    await publish(id, { publishAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    await BlogPostModel.updateOne({ _id: id }, { publishedAt: new Date(Date.now() - 1000) });
    expect((await request(app).get(`${PUBLIC}/${slug}`)).status).toBe(200);
  });

  it('refuses to publish an empty post or a bad date', async () => {
    const { id } = await createPost({ title: 'Just a title' });
    const empty = await publish(id);
    expect(empty.status).toBe(409);
    expect(empty.body.code).toBe('POST_INCOMPLETE');

    const full = await createPost();
    expect((await publish(full.id, { publishAt: 'tomorrow' })).status).toBe(422);
    expect((await publish(ID)).status).toBe(404);
  });

  it('lets a writer edit drafts but not published posts', async () => {
    const { auth: writer } = await signIn('media_publicity');
    const { id } = await createPost();
    const edit = () =>
      request(app).patch(`${ADMIN}/${id}`).set('Authorization', writer).send({ title: 'Changed' });

    expect((await edit()).status).toBe(200);
    await publish(id);

    const refused = await edit();
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('POST_EDIT_FORBIDDEN');
    expect(
      (
        await request(app)
          .patch(`${ADMIN}/${id}`)
          .set('Authorization', editor)
          .send({ title: 'By an editor' })
      ).status,
    ).toBe(200);
  });

  it('lets a super admin do everything', async () => {
    const { auth } = await signIn('super_admin');
    const created = await request(app).post(ADMIN).set('Authorization', auth).send(post);
    const url = `${ADMIN}/${created.body.data.id as string}`;
    expect((await request(app).post(`${url}/publish`).set('Authorization', auth)).status).toBe(200);
    expect(
      (await request(app).patch(url).set('Authorization', auth).send({ title: 'Edited' })).status,
    ).toBe(200);
    expect((await request(app).post(`${url}/archive`).set('Authorization', auth)).status).toBe(200);
    expect((await request(app).delete(url).set('Authorization', auth)).status).toBe(204);
  });

  it('requires a token for every admin route', async () => {
    expect((await request(app).get(ADMIN)).status).toBe(401);
    expect((await request(app).post(ADMIN).send(post)).status).toBe(401);
    expect((await request(app).delete(`${ADMIN}/${ID}`)).status).toBe(401);
  });
});

describe('the public blog', () => {
  it('needs no token and shows only live posts, without bodies in the list', async () => {
    await createPost({ title: 'Still a draft', content: 'Text' });
    const live = await createPost({ ...post, category: 'News', tags: ['launch'] });
    await publish(live.id);

    const list = await request(app).get(PUBLIC);
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0]).not.toHaveProperty('content');
    expect(list.body.data[0].author).toEqual({ id: editorId, name: 'Test editor', avatar: null });

    const read = await request(app).get(`${PUBLIC}/${live.slug}`);
    expect(read.body.data.content).toBe(post.content);
    expect(read.body.data.author).not.toHaveProperty('email');
  });

  it('ignores any attempt to filter its way to a draft', async () => {
    const draft = await createPost({ title: 'Secret draft', content: 'Text' });
    const res = await request(app).get(`${PUBLIC}?status=draft&author=${editorId}`);
    expect(res.body.data).toEqual([]);
    expect((await request(app).get(`${PUBLIC}/${draft.slug}`)).status).toBe(404);
  });

  it('filters by category, tag and search, newest first', async () => {
    const a = await createPost({
      title: 'Alpha story',
      content: 'x',
      category: 'News',
      tags: ['a'],
    });
    const b = await createPost({
      title: 'Beta story',
      content: 'x',
      category: 'Guides',
      tags: ['b'],
    });
    await publish(a.id, { publishAt: new Date(Date.now() - 60_000).toISOString() });
    await publish(b.id);

    const ids = async (query = '') =>
      ((await request(app).get(`${PUBLIC}?${query}`)).body.data as { id: string }[]).map(
        (p) => p.id,
      );
    expect(await ids()).toEqual([b.id, a.id]);
    expect(await ids('category=News')).toEqual([a.id]);
    expect(await ids('tag=b')).toEqual([b.id]);
    expect(await ids('search=alpha')).toEqual([a.id]);
  });

  it('counts categories and tags from live posts only', async () => {
    await createPost({ title: 'Draft one', content: 'x', category: 'Hidden', tags: ['hidden'] });
    const a = await createPost({
      title: 'Live one',
      content: 'x',
      category: 'News',
      tags: ['a', 'b'],
    });
    const b = await createPost({ title: 'Live two', content: 'x', category: 'News', tags: ['a'] });
    const c = await createPost({ title: 'Live three', content: 'x' });
    await Promise.all([publish(a.id), publish(b.id), publish(c.id)]);

    const categories = await request(app).get(`${API}/blog/categories`);
    expect(categories.body.data).toEqual([{ name: 'News', count: 2 }]);
    const tags = await request(app).get(`${API}/blog/tags`);
    expect(tags.body.data).toEqual([
      { name: 'a', count: 2 },
      { name: 'b', count: 1 },
    ]);
  });

  it('keeps a post readable after its author is deleted', async () => {
    const { auth } = await signIn('super_admin');
    const { id, slug } = await createPost();
    await publish(id);
    expect(
      (await request(app).delete(`${API}/users/${editorId}`).set('Authorization', auth)).status,
    ).toBe(204);

    const read = await request(app).get(`${PUBLIC}/${slug}`);
    expect(read.status).toBe(200);
    expect(read.body.data.author).toBeNull();
    expect((await request(app).get(PUBLIC)).body.data[0].author).toBeNull();
  });
});
