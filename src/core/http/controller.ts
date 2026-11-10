import type { Request, RequestHandler, Response } from 'express';
import type { z, ZodType } from 'zod';
import { AppError, type ErrorDetail } from '@/core/errors/AppError';

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

type Output<S extends RequestSchemas, K extends keyof RequestSchemas> = S[K] extends ZodType
  ? z.output<S[K]>
  : unknown;

export type ValidatedRequest<S extends RequestSchemas> = Request<
  Output<S, 'params'>,
  unknown,
  Output<S, 'body'>,
  Output<S, 'query'>
>;

const PARTS = ['params', 'query', 'body'] as const;

const parseRequest = (req: Request, schemas: RequestSchemas): void => {
  const details: ErrorDetail[] = [];

  for (const part of PARTS) {
    const schema = schemas[part];
    if (!schema) continue;

    const result = schema.safeParse(req[part]);
    if (!result.success) {
      details.push(
        ...result.error.issues.map((issue) => ({
          path: [part, ...issue.path].join('.'),
          message: issue.message,
        })),
      );
      continue;
    }

    // Express 5 exposes req.query through a getter, so it can't be assigned directly.
    Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
  }

  if (details.length > 0) throw AppError.validation(details);
};

/**
 * Builds a route handler that validates the request first, then gives the handler a request whose
 * body, query and params carry the schemas' output types. Rejections reach the error middleware
 * because Express 5 forwards them.
 */
export const controller =
  <S extends RequestSchemas>(
    schemas: S,
    handler: (req: ValidatedRequest<S>, res: Response) => unknown,
  ): RequestHandler =>
  async (req, res) => {
    parseRequest(req, schemas);
    await handler(req as unknown as ValidatedRequest<S>, res);
  };
