import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { HttpStatus } from '@/constants/http';
import { AppError } from '@/core/errors/AppError';
import { fetchWithTimeout, parseJsonBody } from '@/utils/http';

/** What Dojah holds for a NIN, in our own shape. Any field Dojah leaves out is null. */
export interface NinIdentity {
  nin: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  gender: 'male' | 'female' | null;
  /** E.164, such as +2348012345678. */
  phone: string | null;
}

/** The entity Dojah returns for GET /api/v1/kyc/nin. Only the fields we use. */
interface DojahNinEntity {
  nin?: string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  date_of_birth?: string;
  gender?: string;
  phone_number?: string;
}

export const dojahDisabled = () =>
  new AppError(
    'Identity verification is not available right now',
    HttpStatus.SERVICE_UNAVAILABLE,
    'IDENTITY_VERIFICATION_DISABLED',
  );

const unavailable = () =>
  new AppError(
    'Identity verification is temporarily unavailable',
    HttpStatus.BAD_GATEWAY,
    'IDENTITY_PROVIDER_UNAVAILABLE',
  );

const timedOut = () =>
  new AppError(
    'Identity verification took too long, please try again',
    HttpStatus.GATEWAY_TIMEOUT,
    'IDENTITY_PROVIDER_TIMEOUT',
  );

export const ninNotFound = () =>
  AppError.badRequest('We could not find a record for that NIN', 'NIN_NOT_FOUND');

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** NIMC names come in capitals, so ADA LOVELACE becomes Ada Lovelace. */
const titleCase = (value: unknown): string | null =>
  clean(value)
    ?.toLowerCase()
    .replace(
      /(^|[\s'-])(\p{L})/gu,
      (_, start: string, letter: string) => start + letter.toUpperCase(),
    ) ?? null;

/** Dojah sends YYYY-MM-DD, though some records come as DD-MM-YYYY. */
const parseDate = (value: unknown): Date | null => {
  const text = clean(value);
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const dayFirst = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(text);
  const [year, month, day] = iso
    ? [iso[1], iso[2], iso[3]]
    : dayFirst
      ? [dayFirst[3], dayFirst[2], dayFirst[1]]
      : [];
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day) ? null : date;
};

const parseGender = (value: unknown): NinIdentity['gender'] => {
  const text = clean(value)?.toLowerCase();
  if (text === 'm' || text === 'male') return 'male';
  if (text === 'f' || text === 'female') return 'female';
  return null;
};

/** Nigerian numbers come as 08012345678 or 2348012345678. */
const parsePhone = (value: unknown): string | null => {
  const digits = clean(value)?.replace(/\D/g, '');
  if (!digits) return null;
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  return null;
};

export const dojahApi = {
  /**
   * Looks up a NIN with NIMC through Dojah. The photo Dojah also returns is dropped: it's large, and
   * the passport photograph is what reviewers compare against.
   */
  async lookupNin(nin: string): Promise<NinIdentity> {
    if (!env.DOJAH_ENABLED) throw dojahDisabled();

    const url = new URL('/api/v1/kyc/nin', env.DOJAH_BASE_URL);
    url.searchParams.set('nin', nin);

    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers: {
          AppId: env.DOJAH_APP_ID ?? '',
          Authorization: env.DOJAH_SECRET_KEY ?? '',
          Accept: 'application/json',
        },
      },
      env.DOJAH_TIMEOUT_MS,
      { timeout: timedOut, network: unavailable },
    );

    const { status } = response;
    const parsed = parseJsonBody(await response.text()) as
      { entity?: DojahNinEntity; error?: string } | null | undefined;

    // Never log the NIN or the response: both are personal data.
    if (status === 401 || status === 403) {
      logger.error({ status }, 'Dojah denied access. Check DOJAH_APP_ID and DOJAH_SECRET_KEY');
      throw new AppError(
        'Identity verification could not be reached',
        HttpStatus.BAD_GATEWAY,
        'IDENTITY_PROVIDER_AUTH_FAILED',
      );
    }
    if (status === 429 || status >= 500) {
      logger.warn({ status }, 'Dojah NIN lookup failed');
      throw unavailable();
    }
    // Dojah answers 400 or 404 with { error } for a NIN it can't find.
    if (status >= 400) throw ninNotFound();

    const entity = parsed?.entity;
    if (!entity || typeof entity !== 'object') {
      logger.warn({ status }, 'Dojah returned an unexpected NIN response');
      throw new AppError(
        'Identity verification returned an unexpected response',
        HttpStatus.BAD_GATEWAY,
        'IDENTITY_PROVIDER_BAD_RESPONSE',
      );
    }
    if (!clean(entity.first_name) && !clean(entity.last_name)) throw ninNotFound();

    return {
      nin,
      firstName: titleCase(entity.first_name),
      middleName: titleCase(entity.middle_name),
      lastName: titleCase(entity.last_name),
      dateOfBirth: parseDate(entity.date_of_birth),
      gender: parseGender(entity.gender),
      phone: parsePhone(entity.phone_number),
    };
  },
};
