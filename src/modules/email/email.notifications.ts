import { env } from '@/config/env';
import { logger } from '@/config/logger';
import type { EmailCodePurpose } from '@/modules/auth/emailCode.model';
import { emailCodeService } from '@/modules/auth/emailCode.service';
import { UserModel, type IUser } from '@/modules/user/user.model';
import { emailService } from './email.service';
import { emailTemplates, type EmailTemplate } from './email.templates';

type Recipient = Pick<IUser, 'name' | 'email' | 'preferences'> & { id?: string; _id?: unknown };

interface SendOptions {
  /** Goes out whatever the customer's preferences say, because it protects their account. */
  essential?: boolean;
  to?: string;
  expiresAt?: Date;
}

export const OPTED_OUT_REASON = 'The customer has turned off email notifications';

const optedOut = (user: Pick<IUser, 'preferences'>): boolean =>
  user.preferences?.emailNotifications === false;

const send = (user: Recipient, email: EmailTemplate, options: SendOptions = {}) =>
  emailService.queue({
    to: options.to ?? user.email,
    email,
    user: String(user.id ?? user._id),
    expiresAt: options.expiresAt ?? null,
    skipReason: !options.essential && optedOut(user) ? OPTED_OUT_REASON : null,
  });

/** Whatever happens with an email, it mustn't undo or fail what it's reporting. */
const safely =
  <A extends unknown[]>(name: string, run: (...args: A) => Promise<unknown>) =>
  async (...args: A): Promise<void> => {
    try {
      await run(...args);
    } catch (err) {
      logger.error({ err, notification: name }, 'Could not queue an email');
    }
  };

/** Loads the customer for a record that only has their id. Closed accounts get no updates. */
const toActiveUser = <I extends { userId: string }>(
  name: string,
  build: (user: Recipient, input: I) => EmailTemplate,
  options: Pick<SendOptions, 'essential'> = {},
) =>
  safely(name, async (input: I) => {
    const user = await UserModel.findOne({ _id: input.userId, isActive: true })
      .select('name email preferences')
      .exec();
    if (user) await send(user, build(user, input), options);
  });

const codeExpiry = () => new Date(Date.now() + env.EMAIL_CODE_TTL_MINUTES * 60 * 1000);

const sendCode = async (
  user: Recipient,
  purpose: EmailCodePurpose,
  template: (code: string, ttlMinutes: number) => EmailTemplate,
) => {
  const code = await emailCodeService.issue(String(user.id ?? user._id), user.email, purpose);
  if (!code) return;
  await send(user, template(code, env.EMAIL_CODE_TTL_MINUTES), {
    essential: true,
    expiresAt: codeExpiry(),
  });
};

export const emailNotifications = {
  verificationCode: safely('verificationCode', (user: Recipient) =>
    sendCode(user, 'verify_email', emailTemplates.verificationCode),
  ),
  passwordResetCode: safely('passwordResetCode', (user: Recipient) =>
    sendCode(user, 'reset_password', emailTemplates.passwordResetCode),
  ),
  signInCode: safely('signInCode', (user: Recipient) =>
    sendCode(user, 'sign_in', emailTemplates.signInCode),
  ),
  welcome: safely('welcome', (user: Recipient) => send(user, emailTemplates.welcome(user.name))),
  accountCreatedByStaff: safely('accountCreatedByStaff', (user: Recipient) =>
    send(user, emailTemplates.accountCreatedByStaff(user.name), { essential: true }),
  ),
  passwordChanged: safely('passwordChanged', (user: Recipient) =>
    send(user, emailTemplates.passwordChanged(user.name), { essential: true }),
  ),
  /** Goes to the old address, because that's who needs to know if this wasn't them. */
  emailChanged: safely('emailChanged', (user: Recipient, oldEmail: string) =>
    send(user, emailTemplates.emailChanged(user.name, user.email), {
      essential: true,
      to: oldEmail,
    }),
  ),
  accountClosed: safely('accountClosed', (user: Recipient) =>
    send(user, emailTemplates.accountClosed(user.name), { essential: true }),
  ),

  walletFunded: toActiveUser(
    'walletFunded',
    (
      { name },
      input: {
        userId: string;
        amount: number;
        balanceAfter: number | null;
        currency: string;
        reference: string;
      },
    ) => emailTemplates.walletFunded({ ...input, name }),
  ),
  investmentStarted: toActiveUser(
    'investmentStarted',
    (
      { name },
      input: {
        userId: string;
        plan: string;
        amount: number;
        expectedReturn: number;
        maturesAt: Date;
        currency: string;
      },
    ) => emailTemplates.investmentStarted({ ...input, name }),
  ),
  investmentPaid: toActiveUser(
    'investmentPaid',
    (
      { name },
      input: {
        userId: string;
        plan: string;
        returnPaid: number;
        principalReturned: number;
        currency: string;
      },
    ) => emailTemplates.investmentPaid({ ...input, name }),
  ),
  investmentWithdrawn: toActiveUser(
    'investmentWithdrawn',
    (
      { name },
      input: {
        userId: string;
        plan: string;
        principalReturned: number;
        penalty: number;
        currency: string;
      },
    ) => emailTemplates.investmentWithdrawn({ ...input, name }),
  ),
  commissionPaid: toActiveUser(
    'commissionPaid',
    ({ name }, input: { userId: string; amount: number; currency: string }) =>
      emailTemplates.commissionPaid({ ...input, name }),
  ),
  ticketCreated: toActiveUser(
    'ticketCreated',
    ({ name }, input: { userId: string; number: string; subject: string }) =>
      emailTemplates.ticketCreated({ ...input, name }),
  ),
  ticketReply: toActiveUser(
    'ticketReply',
    ({ name }, input: { userId: string; number: string; subject: string; body: string }) =>
      emailTemplates.ticketReply({ ...input, name }),
  ),
  kycSubmitted: toActiveUser('kycSubmitted', ({ name }, _input: { userId: string }) =>
    emailTemplates.kycSubmitted(name),
  ),
  // The decision changes what the customer can do, so it goes out whatever their preferences say.
  kycApproved: toActiveUser(
    'kycApproved',
    ({ name }, _input: { userId: string }) => emailTemplates.kycApproved(name),
    { essential: true },
  ),
  kycRejected: toActiveUser(
    'kycRejected',
    ({ name }, input: { userId: string; reason: string }) =>
      emailTemplates.kycRejected({ name, reason: input.reason }),
    { essential: true },
  ),
  ticketResolved: toActiveUser(
    'ticketResolved',
    ({ name }, input: { userId: string; number: string; subject: string }) =>
      emailTemplates.ticketResolved({ ...input, name }),
  ),
};
