import { Document, model, Schema, type HydratedDocument } from 'mongoose';
import { ROLE_DEFINITIONS, Role, isBuiltInRole } from '@/constants/roles';
import { createSchema } from '@/core/database/createSchema';
import { CustomRoleModel } from '@/modules/role/role.model';
import { hashPassword } from '@/utils/password';
import { generateReferralCode } from '@/utils/referralCode';

export interface IAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  /** ISO 3166-1 alpha-2, such as NG. */
  country: string;
  postalCode?: string | null;
}

export const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed', 'separated'] as const;

export interface INextOfKin {
  name: string;
  relationship: string;
  phone: string;
  email?: string | null;
  address?: string | null;
}

/** Optional here so an update can send only some. The schema always fills in the rest. */
export interface IPreferences {
  language?: string;
  timezone?: string;
  emailNotifications?: boolean;
  smsNotifications?: boolean;
  pushNotifications?: boolean;
}

export interface IUser {
  name: string;
  email: string;
  /** Whether its owner has proved they receive mail there. Nothing is blocked while it's false. */
  emailVerified: boolean;
  /** Absent for an account made with Google, until its owner sets one: see `hasPassword`. */
  password: string;
  hasPassword: boolean;
  /** Google's id for the account, once it's linked. */
  googleId: string | null;
  /** What this person shares to refer others. Older accounts get one when it's first needed. */
  referralCode: string | null;
  /** True after a Google signup with no code, until the customer adds one or skips. */
  referralPromptPending: boolean;
  /** A built-in role or the key of a custom one. Controllers check that it exists. */
  role: string;
  avatar: string | null;
  /** E.164, such as +2348012345678. Not verified, and not unique: people share numbers. */
  phone: string | null;
  alternatePhone: string | null;
  dateOfBirth: Date | null;
  gender: (typeof GENDERS)[number] | null;
  maritalStatus: (typeof MARITAL_STATUSES)[number] | null;
  /** ISO 3166-1 alpha-2, such as NG. */
  nationality: string | null;
  address: IAddress | null;
  occupation: string | null;
  employer: string | null;
  nextOfKin: INextOfKin | null;
  preferences: IPreferences;
  /** For staff, shown on their profile. */
  jobTitle: string | null;
  department: string | null;
  /** Set by whoever manages the account, never by its owner. */
  employeeId: string | null;
  /**
   * Whether Symplus says this customer has passed KYC. Only the Symplus sync sets it, and no request
   * schema accepts it. Being false doesn't stop anyone signing in or using the dashboard.
   */
  kycCompleted: boolean;
  kycCompletedAt: Date | null;
  isActive: boolean;
  /** Incrementing this invalidates every access token already issued to the user. */
  tokenVersion: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const addressSchema = new Schema<IAddress>(
  {
    line1: { type: String, required: true, trim: true },
    line2: { type: String, default: null, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    country: { type: String, required: true, uppercase: true },
    postalCode: { type: String, default: null, trim: true },
  },
  { _id: false },
);

const nextOfKinSchema = new Schema<INextOfKin>(
  {
    name: { type: String, required: true, trim: true },
    relationship: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    email: { type: String, default: null, lowercase: true, trim: true },
    address: { type: String, default: null, trim: true },
  },
  { _id: false },
);

const preferencesSchema = new Schema<IPreferences>(
  {
    language: { type: String, default: 'en' },
    timezone: { type: String, default: 'Africa/Lagos' },
    emailNotifications: { type: Boolean, default: true },
    smsNotifications: { type: Boolean, default: true },
    pushNotifications: { type: Boolean, default: true },
  },
  { _id: false },
);

const userSchema = createSchema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailVerified: { type: Boolean, default: false },
    password: {
      type: String,
      required(this: IUser) {
        return !this.googleId;
      },
      select: false,
    },
    hasPassword: { type: Boolean, default: true },
    googleId: { type: String, default: null },
    referralCode: { type: String, default: null, uppercase: true, trim: true },
    referralPromptPending: { type: Boolean, default: false },
    role: { type: String, default: Role.USER, index: true },
    avatar: { type: String, default: null },
    phone: { type: String, default: null, index: true },
    alternatePhone: { type: String, default: null },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: [...GENDERS, null], default: null },
    maritalStatus: { type: String, enum: [...MARITAL_STATUSES, null], default: null },
    nationality: { type: String, default: null, uppercase: true },
    address: { type: addressSchema, default: null },
    occupation: { type: String, default: null, trim: true },
    employer: { type: String, default: null, trim: true },
    nextOfKin: { type: nextOfKinSchema, default: null },
    preferences: { type: preferencesSchema, default: () => ({}) },
    jobTitle: { type: String, default: null, trim: true },
    department: { type: String, default: null, trim: true, index: true },
    employeeId: { type: String, default: null, trim: true },
    kycCompleted: { type: Boolean, default: false, index: true },
    kycCompletedAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
  },
  { hiddenFields: ['password', 'tokenVersion', 'googleId'] },
);

// Most accounts have no employee id, hence the filter.
userSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'string' } } },
);

// Most accounts have neither until they're needed, hence the filters.
userSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } },
);
userSchema.index(
  { referralCode: 1 },
  { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } },
);

userSchema.virtual('googleLinked').get(function () {
  return !!this.googleId;
});

// Sent with the user so a frontend can show the right screens. The server never relies on it.
userSchema.virtual('permissions').get(function () {
  return isBuiltInRole(this.role)
    ? ROLE_DEFINITIONS[this.role].permissions
    : ((this.$locals.customPermissions as unknown) ?? []);
});

/** A virtual can't query, so a custom role's permissions are loaded along with the user. */
const loadCustomPermissions = async (result: unknown): Promise<void> => {
  const users = [result]
    .flat()
    .filter(
      (doc): doc is HydratedDocument<IUser> =>
        doc instanceof Document && !!doc.get('role') && !isBuiltInRole(doc.get('role') as string),
    );
  if (users.length === 0) return;

  const roles = await CustomRoleModel.find({ key: { $in: users.map((user) => user.role) } })
    .select('key permissions')
    .lean()
    .exec();
  for (const user of users) {
    user.$locals.customPermissions = roles.find((r) => r.key === user.role)?.permissions ?? [];
  }
};

userSchema.post('find', loadCustomPermissions);
userSchema.post('findOne', loadCustomPermissions);
userSchema.post('save', loadCustomPermissions);

userSchema.pre('validate', async function () {
  if (!this.isNew || this.referralCode) return;
  let code = generateReferralCode();
  while (await UserModel.exists({ referralCode: code })) code = generateReferralCode();
  this.referralCode = code;
});

userSchema.pre('save', async function () {
  // A new address hasn't been proved, whatever the old one had.
  if (!this.isNew && this.isModified('email') && !this.isModified('emailVerified')) {
    this.emailVerified = false;
  }
  if (this.isModified('password') && this.password) {
    this.password = await hashPassword(this.password);
    this.hasPassword = true;
  }
});

export const UserModel = model<IUser>('User', userSchema);
