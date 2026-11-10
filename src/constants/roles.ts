import { PERMISSIONS, Permission as P } from './permissions';

export const ROLES = [
  'user',
  'customer_support',
  'accountant',
  'auditor',
  'editor',
  'media_publicity',
  'admin',
  'super_admin',
] as const;
export type Role = (typeof ROLES)[number];

export const Role = {
  USER: 'user',
  CUSTOMER_SUPPORT: 'customer_support',
  ACCOUNTANT: 'accountant',
  AUDITOR: 'auditor',
  EDITOR: 'editor',
  MEDIA_PUBLICITY: 'media_publicity',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
} as const satisfies Record<string, Role>;

export interface RoleDefinition {
  label: string;
  description: string;
  /** Decides who may manage whom: see `canManageRole`. */
  level: number;
  permissions: readonly P[];
}

/** Every custom role sits at this level, so none can outrank or manage an administrator. */
export const STAFF_LEVEL = 10;

/** Only a super admin may manage roles, so these can't be given to any other role. */
const SUPER_ADMIN_ONLY: readonly P[] = [P.ROLES_WRITE];

/** What the role manager may put on a custom role, and everything an admin holds. */
export const GRANTABLE_PERMISSIONS = PERMISSIONS.filter((p) => !SUPER_ADMIN_ONLY.includes(p));

/** The single place to change what a built-in role can do. Custom roles live in the database. */
export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  user: {
    label: 'Customer',
    description: 'A customer. Manages only their own account, wallet and core banking record.',
    level: 0,
    permissions: [],
  },
  customer_support: {
    label: 'Customer Support',
    description:
      'Works helpdesk tickets, and looks up users and customer records to help. Cannot change them.',
    level: STAFF_LEVEL,
    permissions: [
      P.USERS_READ,
      P.REFERRALS_READ,
      P.CUSTOMERS_READ,
      P.CUSTOMERS_DOCUMENTS_READ,
      P.HELPDESK_READ,
      P.HELPDESK_WRITE,
      P.EMAILS_READ,
    ],
  },
  accountant: {
    label: 'Accountant',
    description: 'Reviews and reconciles wallet transactions and customer balances.',
    level: STAFF_LEVEL,
    permissions: [
      P.USERS_READ,
      P.WALLET_READ,
      P.WALLET_RECONCILE,
      P.INVESTMENTS_READ,
      P.REFERRALS_READ,
      P.REFERRALS_PAYOUT,
      P.CUSTOMERS_READ,
      P.CUSTOMERS_BALANCES_READ,
    ],
  },
  auditor: {
    label: 'Auditor',
    description: 'Read-only access across the system, for compliance and review.',
    level: STAFF_LEVEL,
    permissions: [
      P.USERS_READ,
      P.ROLES_READ,
      P.WALLET_READ,
      P.INVESTMENTS_READ,
      P.REFERRALS_READ,
      P.CUSTOMERS_READ,
      P.CUSTOMERS_BALANCES_READ,
      P.CUSTOMERS_DOCUMENTS_READ,
      P.CORE_BANKING_READ,
      P.CONTENT_READ,
      P.MEDIA_READ,
      P.HELPDESK_READ,
      P.EMAILS_READ,
      P.PLATFORM_CONFIG_READ,
    ],
  },
  editor: {
    label: 'Editor',
    description: 'Writes, publishes and removes content, and can add media to it.',
    level: STAFF_LEVEL,
    permissions: [
      P.CONTENT_READ,
      P.CONTENT_WRITE,
      P.CONTENT_PUBLISH,
      P.CONTENT_DELETE,
      P.MEDIA_READ,
      P.MEDIA_WRITE,
    ],
  },
  media_publicity: {
    label: 'Media & Publicity',
    description: 'Manages the media library and drafts content. An editor publishes it.',
    level: STAFF_LEVEL,
    permissions: [P.CONTENT_READ, P.CONTENT_WRITE, P.MEDIA_READ, P.MEDIA_WRITE, P.MEDIA_DELETE],
  },
  admin: {
    label: 'Administrator',
    description: 'Runs the system and manages staff and customers, but not other administrators.',
    level: 50,
    permissions: GRANTABLE_PERMISSIONS,
  },
  super_admin: {
    label: 'Super Administrator',
    description: 'Full access, including creating and managing administrators.',
    level: 100,
    permissions: PERMISSIONS,
  },
};

export const isBuiltInRole = (role: string): role is Role =>
  (ROLES as readonly string[]).includes(role);

const roleLevel = (role: string): number =>
  isBuiltInRole(role) ? ROLE_DEFINITIONS[role].level : STAFF_LEVEL;

/**
 * Whether someone with `actor` may manage an account holding `target`, or grant that role. A role
 * only reaches those below it, so an admin can't create another admin or touch a super admin.
 * Super admins are the exception: nobody else could ever appoint or replace one.
 */
export const canManageRole = (actor: string, target: string): boolean =>
  actor === Role.SUPER_ADMIN || roleLevel(actor) > roleLevel(target);
