import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { HttpStatus } from '@/constants/http';
import { AppError } from '@/core/errors/AppError';
import { fetchWithTimeout, parseJsonBody } from '@/utils/http';

export interface PersonIdentity {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  gender: 'male' | 'female' | null;
  phone: string | null;
}

export type NinIdentity = PersonIdentity & { nin: string };

export const DOJAH_COMPANY_TYPES = {
  limited: 'COMPANY',
  businessName: 'BUSINESS_NAME',
  trustees: 'INCORPORATED_TRUSTEES',
  limitedPartnership: 'LIMITED_PARTNERSHIP',
  llp: 'LIMITED_LIABILITY_PARTNERSHIP',
} as const;

export type CompanyType = keyof typeof DOJAH_COMPANY_TYPES;

export interface CacAffiliate {
  fullName: string;
  role: string;
}

export interface CacCompany {
  companyName: string;
  registrationNumber: string;
  registeredOn: Date | null;
  address: string | null;
  city: string | null;
  lga: string | null;
  state: string | null;
  email: string | null;
  status: string | null;
  affiliates: CacAffiliate[];
}

type Entity = Record<string, unknown>;

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

const badResponse = () =>
  new AppError(
    'Identity verification returned an unexpected response',
    HttpStatus.BAD_GATEWAY,
    'IDENTITY_PROVIDER_BAD_RESPONSE',
  );

export const ninNotFound = () =>
  AppError.badRequest('We could not find a record for that NIN', 'NIN_NOT_FOUND');

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const titleCase = (value: unknown): string | null =>
  clean(value)
    ?.toLowerCase()
    .replace(
      /(^|[\s'-])(\p{L})/gu,
      (_, start: string, letter: string) => start + letter.toUpperCase(),
    ) ?? null;

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

const parseGender = (value: unknown): PersonIdentity['gender'] => {
  const text = clean(value)?.toLowerCase();
  if (text === 'm' || text === 'male') return 'male';
  if (text === 'f' || text === 'female') return 'female';
  return null;
};

const parsePhone = (value: unknown): string | null => {
  const digits = clean(value)?.replace(/\D/g, '');
  if (!digits) return null;
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  return null;
};

const toIdentity = (entity: Entity, phone: unknown): PersonIdentity => ({
  firstName: titleCase(entity.first_name),
  middleName: titleCase(entity.middle_name),
  lastName: titleCase(entity.last_name),
  dateOfBirth: parseDate(entity.date_of_birth),
  gender: parseGender(entity.gender),
  phone: parsePhone(phone),
});

const lookup = async (
  path: string,
  params: Record<string, string>,
  notFound: () => AppError,
): Promise<Entity> => {
  if (!env.DOJAH_ENABLED) throw dojahDisabled();

  const url = new URL(path, env.DOJAH_BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

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
  const parsed = parseJsonBody(await response.text()) as { entity?: unknown } | null | undefined;

  if (status === 401 || status === 403) {
    logger.error({ status, path }, 'Dojah denied access. Check DOJAH_APP_ID and DOJAH_SECRET_KEY');
    throw new AppError(
      'Identity verification could not be reached',
      HttpStatus.BAD_GATEWAY,
      'IDENTITY_PROVIDER_AUTH_FAILED',
    );
  }
  if (status === 402) {
    logger.error({ path }, 'Dojah wallet balance is too low. Top up the Dojah wallet');
    throw unavailable();
  }
  if (status === 424 || status === 429 || status >= 500) {
    logger.warn({ status, path }, 'Dojah lookup failed');
    throw unavailable();
  }
  if (status >= 400) throw notFound();

  const entity = parsed?.entity;
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    logger.warn({ status, path }, 'Dojah returned an unexpected response');
    throw badResponse();
  }
  return entity as Entity;
};

const assertNamed = (identity: PersonIdentity, notFound: () => AppError) => {
  if (!identity.firstName && !identity.lastName) throw notFound();
  return identity;
};

export const bvnNotFound = () =>
  AppError.badRequest('We could not find a record for that BVN', 'BVN_NOT_FOUND');

export const companyNotFound = () =>
  AppError.badRequest(
    'We could not find a company with that registration number and type',
    'COMPANY_NOT_FOUND',
  );

export const accountNotFound = () =>
  AppError.badRequest('We could not find that bank account', 'ACCOUNT_NOT_FOUND');

export const dojahApi = {
  async lookupNin(nin: string): Promise<NinIdentity> {
    const entity = await lookup('/api/v1/kyc/nin', { nin }, ninNotFound);
    return { nin, ...assertNamed(toIdentity(entity, entity.phone_number), ninNotFound) };
  },

  async lookupBvn(bvn: string): Promise<PersonIdentity> {
    const entity = await lookup('/api/v1/kyc/bvn/full', { bvn }, bvnNotFound);
    return assertNamed(toIdentity(entity, entity.phone_number1), bvnNotFound);
  },

  async lookupCompany(type: CompanyType, registrationNumber: string): Promise<CacCompany> {
    const entity = await lookup(
      '/api/v1/kyc/cac/advance',
      { rc_number: registrationNumber, company_type: DOJAH_COMPANY_TYPES[type] },
      companyNotFound,
    );
    const companyName = clean(entity.company_name);
    if (!companyName) throw companyNotFound();

    const affiliates = Array.isArray(entity.affiliates) ? (entity.affiliates as Entity[]) : [];
    return {
      companyName: titleCase(companyName) ?? companyName,
      registrationNumber,
      registeredOn: parseDate(entity.date_of_registration),
      address: clean(entity.address),
      city: clean(entity.city),
      lga: clean(entity.lga),
      state: clean(entity.state),
      email: clean(entity.email)?.toLowerCase() ?? null,
      status: clean(entity.status),
      affiliates: affiliates
        .map((affiliate) => ({
          fullName: [titleCase(affiliate.first_name), titleCase(affiliate.last_name)]
            .filter(Boolean)
            .join(' '),
          role: clean(affiliate.affiliate_type)?.toUpperCase() ?? 'DIRECTOR',
        }))
        .filter((affiliate) => affiliate.fullName.length > 1),
    };
  },

  async lookupTin(type: CompanyType, registrationNumber: string): Promise<string | null> {
    try {
      const entity = await lookup(
        '/api/v1/kyc/cac/tin',
        { rc_number: registrationNumber, company_type: DOJAH_COMPANY_TYPES[type] },
        companyNotFound,
      );
      return clean(entity.tax_id);
    } catch (err) {
      if (err instanceof AppError && err.code === 'COMPANY_NOT_FOUND') return null;
      throw err;
    }
  },

  async resolveAccount(accountNumber: string, bankCode: string): Promise<string> {
    const entity = await lookup(
      '/api/v1/general/account',
      { account_number: accountNumber, bank_code: bankCode },
      accountNotFound,
    );
    const name = clean(entity.account_name);
    if (!name) throw accountNotFound();
    return name;
  },
};
