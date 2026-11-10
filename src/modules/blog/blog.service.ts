import type { HydratedDocument, QueryFilter } from 'mongoose';
import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import type { ListQuery } from '@/core/validation/common.schemas';
import { toSlug } from '@/utils/slug';
import { BlogPostModel, type IBlogPost } from './blog.model';

type Post = HydratedDocument<IBlogPost>;
type PostInput = Partial<Omit<IBlogPost, 'author' | 'status' | 'publishedAt'>>;

const FALLBACK_SLUG = 'post';

// Only what a reader should see. Lean, so that no user fields or virtuals come along with it.
const AUTHOR_POPULATE = {
  path: 'author',
  select: 'name avatar',
  options: { lean: true },
  transform: (author: { _id: unknown; name: string; avatar: string | null } | null) =>
    author && { id: String(author._id), name: author.name, avatar: author.avatar },
};

const liveFilter = (): QueryFilter<IBlogPost> => ({
  status: 'published',
  publishedAt: { $lte: new Date() },
});

class BlogService extends BaseService<IBlogPost> {
  constructor() {
    super(BlogPostModel, { resourceName: 'Post', searchFields: ['title', 'excerpt'] });
  }

  private async list({ tag, ...query }: ListQuery, scope: QueryFilter<IBlogPost>, select?: string) {
    const result = await this.paginate(
      query,
      { ...scope, ...(tag ? { tags: tag as string } : {}) },
      select,
    );
    await BlogPostModel.populate(result.items, AUTHOR_POPULATE);
    return result;
  }

  private async uniqueSlug(title: string): Promise<string> {
    const base = toSlug(title, FALLBACK_SLUG);
    let slug = base;
    for (let n = 2; await BlogPostModel.exists({ slug }); n += 1) slug = `${base}-${n}`;
    return slug;
  }

  // Readers: only what is live, so drafts and scheduled posts look the same as missing ones.

  /** Leaves out the post bodies, which a listing doesn't need. */
  listLive(query: ListQuery) {
    return this.list(query, liveFilter(), '-content');
  }

  async getLiveBySlug(slug: string): Promise<Post> {
    const post = await this.findOne({ ...liveFilter(), slug });
    if (!post) throw this.notFound();
    return post.populate(AUTHOR_POPULATE);
  }

  private async countLive(field: 'category' | 'tags') {
    const counts = await BlogPostModel.aggregate<{ _id: string; count: number }>([
      { $match: liveFilter() },
      { $unwind: `$${field}` },
      { $match: { [field]: { $ne: null } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]).exec();
    return counts.map(({ _id, count }) => ({ name: _id, count }));
  }

  listCategories() {
    return this.countLive('category');
  }

  listTags() {
    return this.countLive('tags');
  }

  // Staff.

  listAll(query: ListQuery) {
    return this.list(query, {}, '-content');
  }

  async getWithAuthor(id: string): Promise<Post> {
    return (await this.findById(id)).populate(AUTHOR_POPULATE);
  }

  async createPost(data: PostInput & { title: string }, authorId: string): Promise<Post> {
    const slug = data.slug ?? (await this.uniqueSlug(data.title));
    const post = await this.create({ ...data, slug, author: authorId as never });
    return post.populate(AUTHOR_POPULATE);
  }

  /** `canPublish` is needed to edit a published post, or writers could change a live page. */
  async updatePost(id: string, data: PostInput, canPublish: boolean): Promise<Post> {
    const post = await this.findById(id);
    if (post.status === 'published' && !canPublish) {
      throw AppError.forbidden(
        'Only someone who can publish may edit a published post',
        'POST_EDIT_FORBIDDEN',
      );
    }
    post.set(data);
    await post.save();
    return post.populate(AUTHOR_POPULATE);
  }

  async publish(id: string, publishAt?: Date): Promise<Post> {
    const post = await this.findById(id);
    if (!post.content.trim()) {
      throw AppError.conflict('A post needs content before it can be published', 'POST_INCOMPLETE');
    }
    const now = new Date();
    const isLive = post.status === 'published' && post.publishedAt && post.publishedAt <= now;
    if (isLive && !publishAt) {
      throw AppError.conflict('This post is already published', 'POST_ALREADY_PUBLISHED');
    }
    post.status = 'published';
    post.publishedAt = publishAt ?? now;
    await post.save();
    return post.populate(AUTHOR_POPULATE);
  }

  async unpublish(id: string): Promise<Post> {
    const post = await this.findById(id);
    post.status = 'draft';
    post.publishedAt = null;
    await post.save();
    return post.populate(AUTHOR_POPULATE);
  }

  /** Keeps `publishedAt` as a record of when the post was last out. */
  async archive(id: string): Promise<Post> {
    const post = await this.findById(id);
    post.status = 'archived';
    await post.save();
    return post.populate(AUTHOR_POPULATE);
  }
}

export const blogService = new BlogService();
