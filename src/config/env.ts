import 'dotenv/config';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    API_PREFIX: z.string().startsWith('/').default('/api/v1'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    MONGODB_URI: z.string().min(1),

    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(16).default(12),

    // Client ids of the web and mobile apps. Google sign-in is off while this is empty.
    GOOGLE_CLIENT_IDS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),

    // The signup page referral links open. Defaults to /signup on the first CORS origin.
    REFERRAL_SIGNUP_URL: z.url().optional(),
    // These only give the first values of settings kept in platform config. The commission starts
    // at nothing, so that no commission is promised until someone chooses a rate.
    REFERRAL_COMMISSION_BASIS_POINTS: z.coerce.number().int().min(0).max(2_000).default(0),
    REFERRAL_MIN_INVESTMENT_KOBO: z.coerce.number().int().min(0).default(0),
    REFERRAL_MAX_COMMISSIONED_INVESTMENTS: z.coerce.number().int().min(0).default(1),

    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().positive().default(15),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    HELPDESK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

    // Where uploaded files are stored. Required in production. Without it, uploads answer 503.
    CLOUDINARY_URL: z
      .string()
      .regex(
        /^cloudinary:\/\/[^:@/\s]+:[^:@/\s]+@[^:@/?\s]+(\?\S*)?$/,
        'must look like cloudinary://<api_key>:<api_secret>@<cloud_name>',
      )
      .optional(),
    CLOUDINARY_FOLDER: z
      .string()
      .regex(/^[\w-]+(\/[\w-]+)*$/, 'must be a folder path, without leading or trailing slashes')
      .default('citycore'),
    CLOUDINARY_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    MAX_IMAGE_SIZE_MB: z.coerce.number().positive().default(5),
    MAX_DOCUMENT_SIZE_MB: z.coerce.number().positive().default(20),

    // Encrypts sensitive data stored at rest. 32 bytes, base64 encoded.
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => Buffer.from(value, 'base64').length === 32,
        'must be 32 bytes, base64 encoded',
      )
      .optional(),

    PAYSTACK_ENABLED: z.stringbool().default(false),
    PAYSTACK_BASE_URL: z.url().default('https://api.paystack.co'),
    PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
    PAYSTACK_WEBHOOK_SECRET: z.string().min(1).optional(),
    PAYSTACK_CALLBACK_URL: z.url().optional(),
    PAYSTACK_DVA_PROVIDER: z.string().min(1).optional(),
    PAYSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    PAYSTACK_RECONCILE_MINUTES: z.coerce.number().positive().default(10),

    // Paystack's Nigerian pricing. Change these if your account gets different rates.
    PAYSTACK_FEE_BASIS_POINTS: z.coerce.number().int().min(0).max(9_999).default(150),
    PAYSTACK_FEE_FLAT_KOBO: z.coerce.number().int().min(0).default(10_000),
    PAYSTACK_FEE_FLAT_WAIVED_BELOW_KOBO: z.coerce.number().int().min(0).default(250_000),
    PAYSTACK_FEE_CAP_KOBO: z.coerce.number().int().min(0).default(200_000),
    PAYSTACK_DVA_FEE_BASIS_POINTS: z.coerce.number().int().min(0).max(9_999).default(100),
    PAYSTACK_DVA_FEE_CAP_KOBO: z.coerce.number().int().min(0).default(30_000),

    // Amounts are in kobo. The defaults are 100 naira and 5 million naira. These and the fees above
    // only give the first values of settings kept in platform config: see platformConfig.managed.ts.
    WALLET_MIN_FUNDING_KOBO: z.coerce.number().int().positive().default(10_000),
    WALLET_MAX_FUNDING_KOBO: z.coerce.number().int().positive().default(500_000_000),
    WALLET_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

    INVESTMENT_PAYOUT_MINUTES: z.coerce.number().positive().default(15),

    // Email goes out through Resend. While this is off, emails are recorded as skipped.
    RESEND_ENABLED: z.stringbool().default(false),
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_BASE_URL: z.url().default('https://api.resend.com'),
    // Must be on a domain verified in Resend. The default can only reach the Resend account's owner.
    RESEND_FROM: z.string().min(3).default('City Core <onboarding@resend.dev>'),
    RESEND_REPLY_TO: z.email().optional(),
    RESEND_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    EMAIL_QUEUE_POLL_SECONDS: z.coerce.number().positive().default(5),
    EMAIL_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
    // The gap between sends, to stay under Resend's rate limit.
    EMAIL_SEND_INTERVAL_MS: z.coerce.number().int().min(0).default(600),
    EMAIL_BIRTHDAY_CHECK_MINUTES: z.coerce.number().positive().default(15),
    EMAIL_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    EMAIL_SEND_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

    // Dojah verifies a customer's NIN during KYC. While this is off, the NIN step answers 503.
    DOJAH_ENABLED: z.stringbool().default(false),
    // https://sandbox.dojah.io for test keys, https://api.dojah.io for live ones.
    DOJAH_BASE_URL: z.url().default('https://api.dojah.io'),
    DOJAH_APP_ID: z.string().min(1).optional(),
    DOJAH_SECRET_KEY: z.string().min(1).optional(),
    DOJAH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    // Each NIN lookup is billed, so a customer gets this many before staff must step in.
    KYC_MAX_NIN_LOOKUPS: z.coerce.number().int().positive().default(5),
    KYC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

    SYMPLUS_ENABLED: z.stringbool().default(false),
    // Which documents onboarding asks for: PIX, IDN, SIG and UBL.
    SYMPLUS_REQUIRED_DOCUMENTS: z
      .string()
      .default('PIX,IDN,SIG,UBL')
      .transform((value) =>
        value
          .split(',')
          .map((type) => type.trim().toUpperCase())
          .filter(Boolean),
      ),
    SYMPLUS_BASE_URL: z.url().optional(),
    SYMPLUS_TOKEN_URL: z.url().optional(),
    SYMPLUS_CLIENT_KEY: z.string().min(1).optional(),
    SYMPLUS_CLIENT_SECRET: z.string().min(1).optional(),
    SYMPLUS_SESSION_KEY: z.string().min(1).optional(),
    SYMPLUS_DEFAULT_OFFICER_ID: z.string().min(1).optional(),
    SYMPLUS_DEFAULT_LOCATION_CD: z.string().min(1).optional(),
    SYMPLUS_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    SYMPLUS_MAX_READ_RETRIES: z.coerce.number().int().min(0).default(2),
    SYMPLUS_REFERENCE_CACHE_MINUTES: z.coerce.number().positive().default(60),
    SYMPLUS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    SYMPLUS_QUEUE_POLL_SECONDS: z.coerce.number().positive().default(10),
    SYMPLUS_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
    SYMPLUS_SYNC_INTERVAL_MINUTES: z.coerce.number().positive().default(15),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && !value.CLOUDINARY_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOUDINARY_URL'],
        message: 'required in production',
      });
    }

    if (value.PAYSTACK_ENABLED) {
      for (const key of ['PAYSTACK_SECRET_KEY', 'PAYSTACK_DVA_PROVIDER'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when PAYSTACK_ENABLED is true',
          });
        }
      }
    }

    if (value.RESEND_ENABLED) {
      // Emails holding a code or financial details are encrypted while they wait in the queue.
      for (const key of ['RESEND_API_KEY', 'DATA_ENCRYPTION_KEY'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when RESEND_ENABLED is true',
          });
        }
      }
    }

    if (value.DOJAH_ENABLED) {
      // A NIN is kept encrypted, and its keyed hash stops one NIN verifying two accounts.
      for (const key of ['DOJAH_APP_ID', 'DOJAH_SECRET_KEY', 'DATA_ENCRYPTION_KEY'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when DOJAH_ENABLED is true',
          });
        }
      }
    }

    if (!value.SYMPLUS_ENABLED) return;
    const required = [
      'SYMPLUS_BASE_URL',
      'SYMPLUS_TOKEN_URL',
      'SYMPLUS_CLIENT_KEY',
      'SYMPLUS_CLIENT_SECRET',
      'DATA_ENCRYPTION_KEY',
    ] as const;
    for (const key of required) {
      if (!value[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when SYMPLUS_ENABLED is true',
        });
      }
    }
  });

// Blank lines in .env, such as `SYMPLUS_CLIENT_KEY=`, mean the value isn't set.
const definedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== ''),
);

const parsed = envSchema.safeParse(definedEnv);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
