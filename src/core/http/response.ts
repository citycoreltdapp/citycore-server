import type { Response } from 'express';
import { HttpStatus, type HttpStatusCode } from '@/constants/http';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface SuccessOptions<T> {
  data?: T;
  message?: string;
  meta?: unknown;
  status?: HttpStatusCode;
}

const send = <T>(res: Response, { data, message, meta, status }: SuccessOptions<T>): void => {
  res.status(status ?? HttpStatus.OK).json({ success: true, message, data, meta });
};

export const ok = <T>(res: Response, data?: T, message?: string): void =>
  send(res, { data, message });

export const created = <T>(res: Response, data?: T, message?: string): void =>
  send(res, { data, message, status: HttpStatus.CREATED });

export const accepted = <T>(res: Response, data?: T, message?: string): void =>
  send(res, { data, message, status: HttpStatus.ACCEPTED });

export const paginated = <T>(res: Response, data: T[], meta: PaginationMeta): void =>
  send(res, { data, meta });

export const noContent = (res: Response): void => {
  res.status(HttpStatus.NO_CONTENT).end();
};
