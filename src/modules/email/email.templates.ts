import type { EmailCategory } from './email.model';

export interface EmailTemplate {
  template: string;
  category: EmailCategory;
  subject: string;
  html: string;
  text: string;
  sensitive?: boolean;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const firstNameOf = (name: string): string => name.trim().split(/\s+/)[0] || name;

const money = (kobo: number, currency = 'NGN'): string =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(kobo / 100);

const longDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' }).format(date);

const paragraph = (text: string): string =>
  `<p style="margin:0 0 16px;line-height:1.6;color:#374151;font-size:15px">${escapeHtml(text).replaceAll('\n', '<br>')}</p>`;

const codeBlock = (code: string): string =>
  `<p style="margin:0 0 16px;padding:16px;background:#f3f4f6;border-radius:8px;text-align:center;font-size:28px;font-weight:700;letter-spacing:8px;color:#111827">${code}</p>`;

const layout = (heading: string, content: string): string => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td>
<p style="margin:0 0 24px;font-size:18px;font-weight:700;color:#111827">City Core</p>
<h1 style="margin:0 0 16px;font-size:20px;color:#111827">${escapeHtml(heading)}</h1>
${content}
<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">This email was sent by City Core about your account.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

interface SimpleEmail {
  template: string;
  category: EmailCategory;
  subject: string;
  heading?: string;
  paragraphs: string[];
  sensitive?: boolean;
}

/** Most emails are a heading and some paragraphs, and this keeps both versions of them in step. */
const simple = ({ heading, paragraphs, ...email }: SimpleEmail): EmailTemplate => ({
  ...email,
  html: layout(heading ?? email.subject, paragraphs.map(paragraph).join('\n')),
  text: paragraphs.join('\n\n'),
});

const IF_NOT_YOU = "If this wasn't you, contact support straight away.";

const codeEmail = (
  template: string,
  subject: string,
  intro: string,
  code: string,
  ttlMinutes: number,
): EmailTemplate => {
  const expiry = `The code expires in ${ttlMinutes} minutes. If you didn't ask for it, you can ignore this email. Never share it with anyone, including City Core staff.`;
  return {
    template,
    category: 'security',
    subject,
    sensitive: true,
    html: layout(subject, `${paragraph(intro)}${codeBlock(code)}${paragraph(expiry)}`),
    text: `${intro}\n\n${code}\n\n${expiry}`,
  };
};

export const emailTemplates = {
  // The code stays out of the subject, which shows on lock screens and in the activity list.
  verificationCode: (code: string, ttlMinutes: number) =>
    codeEmail(
      'email_verification_code',
      'Verify your email address',
      'Use this code to verify your email address for City Core.',
      code,
      ttlMinutes,
    ),

  passwordResetCode: (code: string, ttlMinutes: number) =>
    codeEmail(
      'password_reset_code',
      'Reset your password',
      'Use this code to reset your City Core password.',
      code,
      ttlMinutes,
    ),

  signInCode: (code: string, ttlMinutes: number) =>
    codeEmail(
      'sign_in_code',
      'Your sign-in code',
      'Use this code to finish signing in to City Core. If this wasn’t you, change your password.',
      code,
      ttlMinutes,
    ),

  welcome: (name: string) =>
    simple({
      template: 'welcome',
      category: 'account',
      subject: 'Welcome to City Core',
      paragraphs: [
        `Hi ${firstNameOf(name)}, welcome to City Core.`,
        'Your account is ready. Complete your profile and verify your identity so you can start investing.',
      ],
    }),

  accountCreatedByStaff: (name: string) =>
    simple({
      template: 'account_created_by_staff',
      category: 'account',
      subject: 'Your City Core account is ready',
      paragraphs: [
        `Hi ${firstNameOf(name)}, a City Core account has been created for you with this email address.`,
        'To sign in, use "Forgot password" on the sign-in page to choose your own password.',
      ],
    }),

  passwordChanged: (name: string) =>
    simple({
      template: 'password_changed',
      category: 'security',
      subject: 'Your password was changed',
      paragraphs: [
        `Hi ${firstNameOf(name)}, the password on your City Core account was just changed, and other devices were signed out.`,
        IF_NOT_YOU,
      ],
    }),

  emailChanged: (name: string, newEmail: string) =>
    simple({
      template: 'email_changed',
      category: 'security',
      subject: 'Your email address was changed',
      sensitive: true,
      paragraphs: [
        `Hi ${firstNameOf(name)}, the email address on your City Core account was changed to ${newEmail}. This address will no longer receive messages about the account.`,
        IF_NOT_YOU,
      ],
    }),

  accountClosed: (name: string) =>
    simple({
      template: 'account_closed',
      category: 'security',
      subject: 'Your account was closed',
      paragraphs: [
        `Hi ${firstNameOf(name)}, your City Core account has been closed and you have been signed out.`,
        IF_NOT_YOU,
      ],
    }),

  walletFunded: (input: {
    name: string;
    amount: number;
    balanceAfter: number | null;
    currency: string;
    reference: string;
  }) =>
    simple({
      template: 'wallet_funded',
      category: 'transaction',
      subject: 'Your wallet was funded',
      sensitive: true,
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, ${money(input.amount, input.currency)} has been added to your City Core wallet.`,
        [
          ...(input.balanceAfter === null
            ? []
            : [`New balance: ${money(input.balanceAfter, input.currency)}`]),
          `Reference: ${input.reference}`,
        ].join('\n'),
      ],
    }),

  investmentStarted: (input: {
    name: string;
    plan: string;
    amount: number;
    expectedReturn: number;
    maturesAt: Date;
    currency: string;
  }) =>
    simple({
      template: 'investment_started',
      category: 'transaction',
      subject: 'Your investment has started',
      sensitive: true,
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, your investment in ${input.plan} has started.`,
        [
          `Amount: ${money(input.amount, input.currency)}`,
          `Expected return: ${money(input.expectedReturn, input.currency)}`,
          `Matures on: ${longDate(input.maturesAt)}`,
        ].join('\n'),
      ],
    }),

  investmentPaid: (input: {
    name: string;
    plan: string;
    returnPaid: number;
    principalReturned: number;
    currency: string;
  }) =>
    simple({
      template: input.principalReturned > 0 ? 'investment_matured' : 'investment_payout',
      category: 'transaction',
      subject:
        input.principalReturned > 0 ? 'Your investment has matured' : 'You received a payout',
      sensitive: true,
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, here is what was paid to your wallet from ${input.plan}.`,
        [
          ...(input.returnPaid > 0 ? [`Return: ${money(input.returnPaid, input.currency)}`] : []),
          ...(input.principalReturned > 0
            ? [`Principal: ${money(input.principalReturned, input.currency)}`]
            : []),
        ].join('\n'),
      ],
    }),

  investmentWithdrawn: (input: {
    name: string;
    plan: string;
    principalReturned: number;
    penalty: number;
    currency: string;
  }) =>
    simple({
      template: 'investment_withdrawn',
      category: 'transaction',
      subject: 'Your investment was withdrawn',
      sensitive: true,
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, your investment in ${input.plan} was withdrawn early.`,
        [
          `Returned to your wallet: ${money(input.principalReturned, input.currency)}`,
          `Early withdrawal penalty: ${money(input.penalty, input.currency)}`,
        ].join('\n'),
      ],
    }),

  commissionPaid: (input: { name: string; amount: number; currency: string }) =>
    simple({
      template: 'referral_commission_paid',
      category: 'transaction',
      subject: 'You earned a referral commission',
      sensitive: true,
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, ${money(input.amount, input.currency)} in referral commission has been paid to your wallet. Thank you for spreading the word.`,
      ],
    }),

  ticketCreated: (input: { name: string; number: string; subject: string }) =>
    simple({
      template: 'ticket_created',
      category: 'support',
      subject: `We received your request (${input.number})`,
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, we have received your support request and will get back to you soon.`,
        `Ticket: ${input.number}\nSubject: ${input.subject}`,
      ],
    }),

  ticketReply: (input: { name: string; number: string; subject: string; body: string }) =>
    simple({
      template: 'ticket_reply',
      category: 'support',
      subject: `New reply on your request (${input.number})`,
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, our support team replied about "${input.subject}":`,
        input.body,
        'To respond, open this ticket in the app.',
      ],
    }),

  ticketResolved: (input: { name: string; number: string; subject: string }) =>
    simple({
      template: 'ticket_resolved',
      category: 'support',
      subject: `Your request was resolved (${input.number})`,
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, we have marked "${input.subject}" as resolved.`,
        'If you still need help, you can reopen the ticket in the app.',
      ],
    }),

  kycSubmitted: (name: string) =>
    simple({
      template: 'kyc_submitted',
      category: 'account',
      subject: 'We received your verification',
      paragraphs: [
        `Hi ${firstNameOf(name)}, thanks for submitting your identity verification.`,
        'Our team is reviewing your NIN, passport photograph and utility bill. We will email you as soon as a decision is made.',
      ],
    }),

  kycApproved: (name: string) =>
    simple({
      template: 'kyc_approved',
      category: 'account',
      subject: 'Your identity is verified',
      paragraphs: [
        `Hi ${firstNameOf(name)}, good news: your identity has been verified.`,
        'Your account is fully set up, so you can now fund your wallet and start investing.',
      ],
    }),

  kycRejected: (input: { name: string; reason: string }) =>
    simple({
      template: 'kyc_rejected',
      category: 'account',
      subject: 'We could not verify your identity',
      paragraphs: [
        `Hi ${firstNameOf(input.name)}, we were not able to approve your identity verification.`,
        `Reason: ${input.reason}`,
        'Open the app to fix this and submit again.',
      ],
    }),

  test: (name: string) =>
    simple({
      template: 'test',
      category: 'system',
      subject: 'City Core test email',
      paragraphs: [`Hi ${firstNameOf(name)}, email sending is working.`],
    }),

  /** Staff write the wording, and only `{{firstName}}` and `{{name}}` are filled in. */
  birthday: (input: { name: string; subject: string; message: string }): EmailTemplate => {
    const fill = (text: string) =>
      text.replaceAll('{{firstName}}', firstNameOf(input.name)).replaceAll('{{name}}', input.name);
    const subject = fill(input.subject);
    const message = fill(input.message);
    return {
      template: 'birthday',
      category: 'birthday',
      subject,
      html: layout(subject, paragraph(message)),
      text: message,
    };
  },
};
