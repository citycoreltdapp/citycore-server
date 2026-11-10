import { Schema, type SchemaDefinition, type SchemaOptions } from 'mongoose';

interface CreateSchemaOptions {
  /** Fields removed whenever a document is serialised to JSON. */
  hiddenFields?: readonly string[];
  options?: SchemaOptions;
}

/**
 * Creates a schema with the project's defaults: timestamps, no `__v`, and JSON output that uses
 * `id` in place of `_id`.
 */
export const createSchema = <T>(
  definition: SchemaDefinition<T>,
  { hiddenFields = [], options }: CreateSchemaOptions = {},
): Schema<T> =>
  new Schema(definition as SchemaDefinition, {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        const output = ret as unknown as Record<string, unknown>;
        delete output._id;
        for (const field of hiddenFields) delete output[field];
        return output;
      },
    },
    ...(options as object),
  }) as unknown as Schema<T>;
