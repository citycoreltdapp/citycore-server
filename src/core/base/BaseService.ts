import type { HydratedDocument, Model, QueryFilter } from 'mongoose';
import { AppError } from '@/core/errors/AppError';
import type { PaginationMeta } from '@/core/http/response';
import type { ListQuery } from '@/core/validation/common.schemas';

interface BaseServiceOptions {
  /** Name used in error messages, e.g. "User not found". */
  resourceName: string;
  /** Fields matched by the `search` query parameter. */
  searchFields?: readonly string[];
}

export interface PaginatedResult<T> {
  items: T[];
  meta: PaginationMeta;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** CRUD operations shared by every resource. Extend it and add the resource's own rules. */
export class BaseService<T> {
  protected readonly resourceName: string;
  protected readonly searchFields: readonly string[];

  constructor(
    protected readonly model: Model<T>,
    { resourceName, searchFields = [] }: BaseServiceOptions,
  ) {
    this.resourceName = resourceName;
    this.searchFields = searchFields;
  }

  protected notFound(): AppError {
    return AppError.notFound(`${this.resourceName} not found`);
  }

  async paginate(
    { page, limit, sort, search, ...filters }: ListQuery,
    scope: QueryFilter<T> = {},
    select?: string,
  ): Promise<PaginatedResult<HydratedDocument<T>>> {
    const filter = {
      ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)),
      ...scope,
      ...this.buildSearchFilter(search),
    } as QueryFilter<T>;

    const [items, total] = await Promise.all([
      this.model
        .find(filter)
        // `_id` keeps the order stable, so records can't repeat or vanish between pages.
        .sort(`${sort.replaceAll(',', ' ')} _id`)
        .skip((page - 1) * limit)
        .limit(limit)
        .select(select ?? '')
        .exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      items: items as HydratedDocument<T>[],
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  async findById(id: string, select?: string): Promise<HydratedDocument<T>> {
    const query = this.model.findById(id);
    if (select) query.select(select);
    const document = await query.exec();
    if (!document) throw this.notFound();
    return document as HydratedDocument<T>;
  }

  async findOne(filter: QueryFilter<T>, select?: string): Promise<HydratedDocument<T> | null> {
    const query = this.model.findOne(filter);
    if (select) query.select(select);
    return (await query.exec()) as HydratedDocument<T> | null;
  }

  async create(data: Partial<T>): Promise<HydratedDocument<T>> {
    return (await new this.model(data).save()) as HydratedDocument<T>;
  }

  /** Loads then saves, rather than using findOneAndUpdate, so schema hooks and validators run. */
  async updateById(id: string, data: Partial<T>): Promise<HydratedDocument<T>> {
    const document = await this.findById(id);
    document.set(data);
    await document.save();
    return document;
  }

  async deleteById(id: string): Promise<void> {
    const deleted = await this.model.findByIdAndDelete(id).exec();
    if (!deleted) throw this.notFound();
  }

  private buildSearchFilter(search?: string): Record<string, unknown> {
    if (!search || this.searchFields.length === 0) return {};
    const pattern = new RegExp(escapeRegex(search), 'i');
    return { $or: this.searchFields.map((field) => ({ [field]: pattern })) };
  }
}
