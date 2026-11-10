export const Permission = {
  USERS_READ: 'users.read',
  USERS_WRITE: 'users.write',
  USERS_DELETE: 'users.delete',
  USERS_ASSIGN_ROLE: 'users.assign_role',
  ROLES_READ: 'roles.read',
  ROLES_WRITE: 'roles.write',

  WALLET_READ: 'wallet.read',
  WALLET_RECONCILE: 'wallet.reconcile',

  INVESTMENTS_READ: 'investments.read',
  INVESTMENTS_WRITE: 'investments.write',
  INVESTMENTS_DELETE: 'investments.delete',

  REFERRALS_READ: 'referrals.read',
  REFERRALS_WRITE: 'referrals.write',
  REFERRALS_DELETE: 'referrals.delete',
  REFERRALS_PAYOUT: 'referrals.payout',

  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_BALANCES_READ: 'customers.balances.read',
  CUSTOMERS_DOCUMENTS_READ: 'customers.documents.read',
  CUSTOMERS_WRITE: 'customers.write',
  CUSTOMERS_LINK: 'customers.link',
  CORE_BANKING_READ: 'core_banking.read',
  CORE_BANKING_RETRY: 'core_banking.retry',

  CONTENT_READ: 'content.read',
  CONTENT_WRITE: 'content.write',
  CONTENT_PUBLISH: 'content.publish',
  CONTENT_DELETE: 'content.delete',
  MEDIA_READ: 'media.read',
  MEDIA_WRITE: 'media.write',
  MEDIA_DELETE: 'media.delete',

  HELPDESK_READ: 'helpdesk.read',
  HELPDESK_WRITE: 'helpdesk.write',
  HELPDESK_DELETE: 'helpdesk.delete',

  EMAILS_READ: 'emails.read',
  EMAILS_SEND: 'emails.send',

  PLATFORM_CONFIG_READ: 'platform_config.read',
  PLATFORM_CONFIG_WRITE: 'platform_config.write',
  PLATFORM_CONFIG_DELETE: 'platform_config.delete',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const PERMISSIONS = Object.values(Permission);
