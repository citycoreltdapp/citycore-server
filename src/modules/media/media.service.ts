import { BaseService } from '@/core/base/BaseService';
import { AppError } from '@/core/errors/AppError';
import { BlogPostModel } from '@/modules/blog/blog.model';
import { cloudinaryStorage } from '@/integrations/cloudinary/cloudinary.client';
import { MediaModel, type IMedia } from './media.model';

class MediaService extends BaseService<IMedia> {
  constructor() {
    super(MediaModel, { resourceName: 'Media', searchFields: ['title', 'originalName'] });
  }

  /** Refuses while a blog post shows the file, as its cover or within its text. */
  override async deleteById(id: string): Promise<void> {
    const media = await this.findById(id);
    const usedByPost = await BlogPostModel.exists({
      $or: [
        { coverImage: media.url },
        { content: { $regex: media.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } },
      ],
    });
    if (usedByPost) throw AppError.conflict('A blog post is using this file', 'MEDIA_IN_USE');

    await media.deleteOne();
    await cloudinaryStorage.remove(media.url);
  }
}

export const mediaService = new MediaService();
