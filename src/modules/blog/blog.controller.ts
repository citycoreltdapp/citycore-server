import { logger } from '@/config/logger';
import { Permission } from '@/constants/permissions';
import { controller } from '@/core/http/controller';
import { created, noContent, ok, paginated } from '@/core/http/response';
import { idParamsSchema } from '@/core/validation/common.schemas';
import { currentUser, hasPermission } from '@/middlewares/auth';
import {
  createPostBodySchema,
  listAdminPostsQuerySchema,
  listPublicPostsQuerySchema,
  publishPostBodySchema,
  slugParamsSchema,
  updatePostBodySchema,
} from './blog.schemas';
import { blogService } from './blog.service';

export const blogController = {
  list: controller({ query: listPublicPostsQuerySchema }, async (req, res) => {
    const { items, meta } = await blogService.listLive(req.query);
    paginated(res, items, meta);
  }),

  getBySlug: controller({ params: slugParamsSchema }, async (req, res) => {
    ok(res, await blogService.getLiveBySlug(req.params.slug));
  }),

  listCategories: controller({}, async (_req, res) => {
    ok(res, await blogService.listCategories());
  }),

  listTags: controller({}, async (_req, res) => {
    ok(res, await blogService.listTags());
  }),
};

export const blogAdminController = {
  list: controller({ query: listAdminPostsQuerySchema }, async (req, res) => {
    const { items, meta } = await blogService.listAll(req.query);
    paginated(res, items, meta);
  }),

  getById: controller({ params: idParamsSchema }, async (req, res) => {
    ok(res, await blogService.getWithAuthor(req.params.id));
  }),

  create: controller({ body: createPostBodySchema }, async (req, res) => {
    created(res, await blogService.createPost(req.body, currentUser(req).id));
  }),

  update: controller({ params: idParamsSchema, body: updatePostBodySchema }, async (req, res) => {
    const canPublish = hasPermission(currentUser(req), Permission.CONTENT_PUBLISH);
    ok(res, await blogService.updatePost(req.params.id, req.body, canPublish));
  }),

  publish: controller({ params: idParamsSchema, body: publishPostBodySchema }, async (req, res) => {
    const post = await blogService.publish(req.params.id, req.body.publishAt);
    logger.info(
      { actorId: currentUser(req).id, postId: post.id, publishedAt: post.publishedAt },
      'Post published',
    );
    ok(res, post);
  }),

  unpublish: controller({ params: idParamsSchema }, async (req, res) => {
    const post = await blogService.unpublish(req.params.id);
    logger.info({ actorId: currentUser(req).id, postId: post.id }, 'Post unpublished');
    ok(res, post);
  }),

  archive: controller({ params: idParamsSchema }, async (req, res) => {
    const post = await blogService.archive(req.params.id);
    logger.info({ actorId: currentUser(req).id, postId: post.id }, 'Post archived');
    ok(res, post);
  }),

  remove: controller({ params: idParamsSchema }, async (req, res) => {
    await blogService.deleteById(req.params.id);
    logger.info({ actorId: currentUser(req).id, postId: req.params.id }, 'Post deleted');
    noContent(res);
  }),
};
