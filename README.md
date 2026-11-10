# City Core API

REST API built with Express 5, TypeScript and MongoDB (Mongoose).

## Getting started

Requires Node 20.19+ and MongoDB. To run MongoDB with Docker, as a single-node replica set:

```bash
docker compose up -d
```

Then install and start the API:

```bash
npm install
npm run dev
```

Before starting, create a `.env` file with at least `MONGODB_URI` and `JWT_ACCESS_SECRET` (generate it with `openssl rand -base64 48`). Every setting is defined in `src/config/env.ts`.

The API runs at `http://localhost:4000/api/v1`. The app checks `.env` at startup and exits with a clear message if a value is missing or invalid.

To create the first super admin, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`, then run `npm run seed:admin`. If that email already has an account, the same command promotes it, as long as the password matches.

| Script               | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `npm run dev`        | Start with reload on change                    |
| `npm run build`      | Compile to `dist/`                             |
| `npm start`          | Run the compiled build                         |
| `npm test`           | Run the API tests against an in-memory MongoDB |
| `npm run typecheck`  | Check types                                    |
| `npm run lint`       | Run ESLint                                     |
| `npm run format`     | Run Prettier                                   |
| `npm run seed:admin` | Create or promote the super admin              |

## Project structure

```
src/
  app.ts                 Express app: middleware order and routes
  server.ts              Startup and graceful shutdown
  config/                Validated env, logger, database connection
  constants/             HTTP statuses, roles, allowed file types
  core/                  Reusable building blocks, with no feature logic
    base/                BaseService, createCrudController
    database/            createSchema
    errors/              AppError
    http/                controller() wrapper, response helpers
    validation/          Shared Zod schemas, createListQuerySchema
  middlewares/           auth, rate limiting, uploads, errors, request logging
  modules/               Features, each with its own routes/controller/service/schemas/model
    auth/  user/  role/  kyc/  blog/  media/  upload/  health/  platformConfig/  helpdesk/  investment/  referral/  email/
  routes/                Mounts each module's routes
  scripts/               One-off commands
  types/                 Express type extensions
  utils/                 Passwords, tokens, file helpers
tests/                   API tests
```

## Adding a feature

A new resource needs very little code, because the base classes supply the rest. For example, `src/modules/project/`:

```ts
// project.model.ts
export interface IProject {
  name: string;
}
const projectSchema = createSchema<IProject>({ name: { type: String, required: true } });
export const ProjectModel = model<IProject>('Project', projectSchema);

// project.service.ts: add business rules here by overriding or adding methods
class ProjectService extends BaseService<IProject> {
  constructor() {
    super(ProjectModel, { resourceName: 'Project', searchFields: ['name'] });
  }
}
export const projectService = new ProjectService();

// project.controller.ts: the schemas are ordinary Zod schemas in project.schemas.ts
export const projectController = createCrudController<IProject>(projectService, {
  listQuery: createListQuerySchema({ sortable: ['createdAt', 'name'] }),
  createBody: createProjectBodySchema,
  updateBody: updateProjectBodySchema,
});

// project.routes.ts
const router = Router();
router.use(authenticate);
router.route('/').get(projectController.list).post(projectController.create);
router
  .route('/:id')
  .get(projectController.getById)
  .patch(projectController.update)
  .delete(projectController.remove);
export const projectRoutes = router;
```

Finally, mount it in `src/routes/index.ts`.

For a custom endpoint, use `controller()`. It validates the request first and types `req` from the schemas. Errors can simply be thrown, because the error middleware handles them:

```ts
export const archive = controller({ params: idParamsSchema }, async (req, res) => {
  const project = await projectService.findById(req.params.id);
  if (project.archived) throw AppError.conflict('Project is already archived');
  ok(res, await projectService.updateById(req.params.id, { archived: true }));
});
```

Other reusable pieces:

- **Rate limits:** `createRateLimiter({ max, windowMinutes, message })`
- **Uploads:** `createUploader({ subdirectory, allowedTypes, maxSizeMb })`, or the ready-made `imageUploader` and `documentUploader`. See [file storage](#file-storage)
- **Access control:** `authenticate`, `requirePermission(Permission.WALLET_READ)`, `currentUser(req)`

## API

All paths are under `/api/v1`, except `GET /health`.

| Method             | Path                          | Access | Purpose                            |
| ------------------ | ----------------------------- | ------ | ---------------------------------- |
| POST               | `/auth/register`              | Public | Create an account                  |
| POST               | `/auth/login`                 | Public | Sign in                            |
| POST               | `/auth/google`                | Public | Sign in or sign up with Google     |
| POST               | `/auth/google/link`           | User   | Link Google to your account        |
| POST               | `/auth/set-password`          | User   | Add a password to a Google account |
| POST               | `/auth/verify-email/request`  | Public | Email a verification code          |
| POST               | `/auth/verify-email`          | Public | Verify an email and sign in        |
| POST               | `/auth/forgot-password`       | Public | Email a password reset code        |
| POST               | `/auth/reset-password/verify` | Public | Check a reset code                 |
| POST               | `/auth/reset-password`        | Public | Choose a new password with a code  |
| POST               | `/auth/refresh`               | Cookie | Get new tokens                     |
| POST               | `/auth/logout`                | Cookie | End this session                   |
| POST               | `/auth/logout-everywhere`     | User   | End all sessions                   |
| POST               | `/auth/change-password`       | User   | Change password                    |
| GET, PATCH         | `/users/me`                   | User   | Read or update your profile        |
| PUT, DELETE        | `/users/me/avatar`            | User   | Replace or remove your avatar      |
| GET, POST          | `/users`                      | Staff  | List or create users               |
| GET, PATCH, DELETE | `/users/:id`                  | Staff  | Read, update or delete a user      |
| GET                | `/users/:id/overview`         | Staff  | A user and what's linked           |
| GET, POST          | `/roles`                      | Staff  | List roles or create one           |
| GET, PATCH, DELETE | `/roles/:role`                | Staff  | Read, update or delete a role      |
| POST               | `/uploads/images`             | User   | Upload an image (`file`)           |
| POST               | `/uploads/documents`          | User   | Upload a PDF (`file`)              |

Send the access token as `Authorization: Bearer <token>`. The refresh token is set as an httpOnly cookie, so a browser client must send requests to `/auth` with credentials included.

List endpoints accept `page`, `limit`, `sort` (for example `-createdAt,name`), `search`, and any filters the resource defines.

### Response format

```jsonc
// Success
{ "success": true, "message": "...", "data": {}, "meta": {} }

// Error
{
  "success": false,
  "message": "Validation failed",
  "code": "VALIDATION_ERROR",
  "requestId": "...",
  "errors": [{ "path": "body.email", "message": "Invalid email address" }]
}
```

## Sign up, email code and KYC

### The flow

1. **Sign up** with `POST /auth/register` (`email`, `password`, optional `referralCode`) or `POST /auth/google` (`idToken`, optional `referralCode`). Both answer with a session. A password signup has `user.emailVerified: false` and a 6 digit code is emailed, so the app shows the code screen. Google accounts arrive verified.
2. **Verify the code** with `POST /auth/verify-email` (`email`, `code`). It answers with a fresh session, like `/auth/login`, so the app goes straight to the dashboard. `POST /auth/verify-email/request` resends the code, at most once every 55 seconds.
3. **Sign in** with `POST /auth/login` (`email`, `password`) or `POST /auth/google`. If `user.emailVerified` is false, send them to the code screen.
4. **The dashboard's Verify button** reads `GET /kyc`. Show it while `nextStep` isn't `complete`, and disable it while `available` is false.
5. **Onboarding** follows `nextStep`: `verify_nin` → `personal_details` → `upload_documents` → `submit` → `await_review` → `complete`.

### Customer routes

| Method | Path                  | Purpose                                                                  |
| ------ | --------------------- | ------------------------------------------------------------------------ |
| GET    | `/kyc`                | Where they are, what's saved and the form's `prefill`                    |
| POST   | `/kyc/nin`            | `{ "nin": "70123456789" }`. Checks it with Dojah and fills the form      |
| PUT    | `/kyc/details`        | Confirm the details. Their legal name comes from the NIN                 |
| PUT    | `/kyc/passport-photo` | Upload or capture (`file`: JPEG, PNG or WebP). Also becomes their avatar |
| PUT    | `/kyc/utility-bill`   | Upload (`file`: JPEG, PNG, WebP or PDF)                                  |
| POST   | `/kyc/submit`         | Send for review. Nothing can change until a reviewer decides             |

Every change needs a verified email (`403 EMAIL_NOT_VERIFIED`).

**The NIN step.** Dojah's record fills `identity` and `prefill`. Fields it supplies are marked in `prefill.locked`, so the form should show them read only. Profile fields that are still empty (phone, date of birth, gender) are filled at once. The NIN is stored encrypted, and customers only ever see its last four digits. Each lookup is billed, so the same NIN again isn't looked up twice, and a customer gets `KYC_MAX_NIN_LOOKUPS` tries (`429 NIN_LOOKUP_LIMIT`, shown as `nin.lookupsRemaining`). Other answers: `400 NIN_NOT_FOUND`, `409 NIN_IN_USE` (another account has it), `502`/`504` if Dojah is unreachable, `503 IDENTITY_VERIFICATION_DISABLED` while it's off.

```jsonc
// PUT /kyc/details. gender and dateOfBirth are only needed if the NIN record lacks them
{
  "phone": "+2348012345678",
  "address": { "line1": "1 Marina", "city": "Lagos Island", "state": "Lagos", "country": "NG" },
  "occupation": "Engineer", // Optional
}
```

Saving the details sets the profile's name to the legal name from the NIN, and its phone, gender, date of birth and address. Customers must be 18 or over (`403 UNDERAGE`). Uploads answer `409 DETAILS_REQUIRED` before this step.

**After submitting**, `status` is `in_review` and changes answer `409 KYC_IN_REVIEW`. If it's `rejected`, `rejectionReason` says why, everything is editable again, and they resubmit. Once `approved`, `user.kycCompleted` is true, which is what `requireKyc` checks.

### Staff routes

| Method | Path                                   | Permission                                   | Purpose                                                          |
| ------ | -------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| GET    | `/kyc/admin/verifications`             | `customers.read`                             | The queue. Filter by `status`, `user`, `search` by name or email |
| GET    | `/kyc/admin/verifications/:id`         | `customers.read`, `customers.documents.read` | One record, with the full NIN and files                          |
| POST   | `/kyc/admin/verifications/:id/approve` | `customers.write`                            | Approve. `note` is optional, staff only                          |
| POST   | `/kyc/admin/verifications/:id/reject`  | `customers.write`                            | Reject with a `reason` the customer sees                         |

**Emails.** The customer is emailed when they submit ("We received your verification"), and when staff approve or reject. The rejection email includes the `reason`, never the staff `note`. Approval and rejection emails go out even if the customer turned off email notifications, because they change what the customer can do.

Only one decision is recorded per submission (`409 KYC_NOT_IN_REVIEW`), and nobody can review their own (`403 SELF_REVIEW`).

## Roles and permissions

Routes check permissions rather than role names. `src/constants/roles.ts` is the single place that says what each built-in role can do, and `GET /roles` returns the same table, plus any custom roles, along with which roles the caller may assign and how many users hold each. Each user in an API response also carries `permissions`, so a frontend can show the right screens.

| Permission                 | Customer Support | Accountant | Auditor | Editor | Media & Publicity | Admin | Super Admin |
| -------------------------- | ---------------- | ---------- | ------- | ------ | ----------------- | ----- | ----------- |
| `users.read`               | Yes              | Yes        | Yes     |        |                   | Yes   | Yes         |
| `users.write`              |                  |            |         |        |                   | Yes   | Yes         |
| `users.delete`             |                  |            |         |        |                   | Yes   | Yes         |
| `users.assign_role`        |                  |            |         |        |                   | Yes   | Yes         |
| `roles.read`               |                  |            | Yes     |        |                   | Yes   | Yes         |
| `roles.write`              |                  |            |         |        |                   |       | Yes         |
| `wallet.read`              |                  | Yes        | Yes     |        |                   | Yes   | Yes         |
| `wallet.reconcile`         |                  | Yes        |         |        |                   | Yes   | Yes         |
| `investments.read`         |                  | Yes        | Yes     |        |                   | Yes   | Yes         |
| `investments.write`        |                  |            |         |        |                   | Yes   | Yes         |
| `investments.delete`       |                  |            |         |        |                   | Yes   | Yes         |
| `referrals.read`           | Yes              | Yes        | Yes     |        |                   | Yes   | Yes         |
| `referrals.write`          |                  |            |         |        |                   | Yes   | Yes         |
| `referrals.delete`         |                  |            |         |        |                   | Yes   | Yes         |
| `referrals.payout`         |                  | Yes        |         |        |                   | Yes   | Yes         |
| `customers.read`           | Yes              | Yes        | Yes     |        |                   | Yes   | Yes         |
| `customers.balances.read`  |                  | Yes        | Yes     |        |                   | Yes   | Yes         |
| `customers.documents.read` | Yes              |            | Yes     |        |                   | Yes   | Yes         |
| `customers.write`          |                  |            |         |        |                   | Yes   | Yes         |
| `customers.link`           |                  |            |         |        |                   | Yes   | Yes         |
| `core_banking.read`        |                  |            | Yes     |        |                   | Yes   | Yes         |
| `core_banking.retry`       |                  |            |         |        |                   | Yes   | Yes         |
| `content.read`             |                  |            | Yes     | Yes    | Yes               | Yes   | Yes         |
| `content.write`            |                  |            |         | Yes    | Yes               | Yes   | Yes         |
| `content.publish`          |                  |            |         | Yes    |                   | Yes   | Yes         |
| `content.delete`           |                  |            |         | Yes    |                   | Yes   | Yes         |
| `media.read`               |                  |            | Yes     | Yes    | Yes               | Yes   | Yes         |
| `media.write`              |                  |            |         | Yes    | Yes               | Yes   | Yes         |
| `media.delete`             |                  |            |         |        | Yes               | Yes   | Yes         |
| `helpdesk.read`            | Yes              |            | Yes     |        |                   | Yes   | Yes         |
| `helpdesk.write`           | Yes              |            |         |        |                   | Yes   | Yes         |
| `helpdesk.delete`          |                  |            |         |        |                   | Yes   | Yes         |
| `emails.read`              | Yes              |            | Yes     |        |                   | Yes   | Yes         |
| `emails.send`              |                  |            |         |        |                   | Yes   | Yes         |
| `platform_config.read`     |                  |            | Yes     |        |                   | Yes   | Yes         |
| `platform_config.write`    |                  |            |         |        |                   | Yes   | Yes         |
| `platform_config.delete`   |                  |            |         |        |                   | Yes   | Yes         |

A super admin passes every permission check, including any added in future.

**Who can manage whom:**

- An admin manages staff and customers, but can't create an admin or change a fellow admin or a super admin.
- A super admin can manage everyone, including other super admins.
- Nobody can change or delete their own account through `/users/:id`, so the last super admin can't remove themselves.
- Role changes apply on the user's next request, because `authenticate` reads the role from the database each time. They're also written to the log with who made them.

### Role manager

A super admin can create roles at runtime and give them any permissions except `roles.write`, so managing roles stays with super admins. Assign a role with `PATCH /users/:id` and `{ "role": "<key>" }`, and find its holders with `GET /users?role=<key>`.

```jsonc
// POST /roles
{
  "key": "blog_writer", // Permanent. Lowercase letters, numbers and underscores
  "label": "Blog Writer",
  "description": "Drafts posts for an editor to publish",
  "permissions": ["content.read", "content.write"], // Must be from grantablePermissions in GET /roles
}
```

- `PATCH /roles/:role` takes `label`, `description` and `permissions`. Changes apply to everyone holding the role on their next request.
- `DELETE /roles/:role` answers `409 ROLE_IN_USE` while anyone holds the role.
- Built-in roles can't be changed or deleted (`403 ROLE_LOCKED`). To adjust one, create a custom role with the permissions you want and move people to it, or edit `src/constants/roles.ts`.
- Custom roles all sit at staff level. Admins and super admins can assign them, and a holder with `users.write` and `users.assign_role` still can't touch anyone at staff level or above.
- If a role somehow goes missing, its holders get no permissions.

## Referrals

Every account has a referral code and link. A customer who signs up with someone's code is linked to them for good, and the customer's first investment earns the referrer a commission, paid into their wallet once a year over the investment's life, as staff approve each payment.

### Signing up

```jsonc
// POST /auth/register. Only email and password are required
{
  "email": "jane.doe@example.com",
  "password": "Passw0rd123",
  "referralCode": "K7PWM2XQ", // Optional. Case doesn't matter, and blank means none
  "name": "Jane Doe", // Optional. Made from the email if omitted, and editable with PATCH /users/me
}

// POST /auth/google. Send the ID token from Google Identity Services
{
  "idToken": "eyJhbGciOi...",
  "referralCode": "K7PWM2XQ", // Optional. Pass it on from the link's ?ref= so there's no prompt
}
```

`POST /auth/google` answers with the usual session, plus `isNewUser`, with `201` for a new account and `200` otherwise. It needs `GOOGLE_CLIENT_IDS` in `.env`, and answers `503 GOOGLE_SIGN_IN_DISABLED` without it.

**The Google prompt.** A new Google account with no code has `user.referralPromptPending: true`, on every sign-in until it's answered, so a frontend should show the prompt whenever it sees that:

- `POST /referrals/me/apply` with `{ "code": "K7PWM2XQ" }` adds a code. A wrong one leaves the prompt open.
- `POST /referrals/me/skip` skips it.

Either way it closes for good (`409 REFERRAL_WINDOW_CLOSED`), so nobody can add a referrer after investing. Accounts that signed up with a password never get the prompt. Staff can still assign a referrer to anyone.

**Rules for a code.** An unknown code, or that of a closed account, answers `400 INVALID_REFERRAL_CODE` and creates no account. You can't use your own code (`SELF_REFERRAL`), have two referrers (`ALREADY_REFERRED`), or use the code of someone you referred (`CIRCULAR_REFERRAL`).

**Accounts made with Google** have no password, shown by `user.hasPassword: false`, so `/auth/login` refuses them. Changing an email or closing the account asks for a password (`409 PASSWORD_NOT_SET`), so `POST /auth/set-password` with `{ "newPassword": "..." }` adds one first.

**An email that already has an account** isn't joined to a Google sign-in, which answers `409 GOOGLE_LINK_REQUIRED`. Emails aren't verified here, so whoever registered the address may not own it, and they would keep access through their password. The owner signs in with their password and calls `POST /auth/google/link` with `{ "idToken": "..." }`.

### The customer's referral page

| Method | Path                        | Access | Purpose                                                                 |
| ------ | --------------------------- | ------ | ----------------------------------------------------------------------- |
| GET    | `/referrals/codes/:code`    | Public | Check a code on a signup form. Says nothing about whose it is           |
| GET    | `/referrals/me`             | User   | Everything for the page: code, link, referrer, totals and the programme |
| GET    | `/referrals/me/referrals`   | User   | Who you referred, with `status` as a filter                             |
| GET    | `/referrals/me/commissions` | User   | What you've earned, with `status` as a filter                           |
| POST   | `/referrals/me/apply`       | User   | Answer the prompt with a code                                           |
| POST   | `/referrals/me/skip`        | User   | Skip the prompt                                                         |

```jsonc
// GET /referrals/me. Amounts are in kobo
{
  "code": "K7PWM2XQ",
  "link": "https://app.example.com/signup?ref=K7PWM2XQ",
  "referredBy": { "name": "Ada", "at": "2026-11-06T10:00:00.000Z" }, // Or null
  "promptPending": false,
  "referrals": { "total": 4, "pending": 3, "qualified": 1, "rejected": 0 },
  "earnings": { "pending": 0, "approved": 0, "paid": 500000, "currency": "NGN" },
  "programme": { "commissionBasisPoints": 500, "minInvestmentAmount": 0, "currency": "NGN" },
}
```

Links open `REFERRAL_SIGNUP_URL` (by default `/signup` on the first of `CORS_ORIGINS`) with the code in `?ref=`, so that page should read it and send it as `referralCode`. Referrers see only the first name of whoever they invited, and never an investment's amount or reference.

### Staff routes

| Method | Path                                       | Permission         | Purpose                                                          |
| ------ | ------------------------------------------ | ------------------ | ---------------------------------------------------------------- |
| GET    | `/referrals/admin/stats`                   | `referrals.read`   | Totals, top referrers and the current settings                   |
| GET    | `/referrals/admin/referrals`               | `referrals.read`   | List referrals                                                   |
| POST   | `/referrals/admin/referrals`               | `referrals.write`  | Assign a referrer (`referrer`, `referee`, `note`)                |
| GET    | `/referrals/admin/referrals/:id`           | `referrals.read`   | Read one, with its commissions                                   |
| PATCH  | `/referrals/admin/referrals/:id`           | `referrals.write`  | Change `status` or `note`                                        |
| DELETE | `/referrals/admin/referrals/:id`           | `referrals.delete` | Delete one with no live commissions                              |
| GET    | `/referrals/admin/commissions`             | `referrals.read`   | List commissions                                                 |
| POST   | `/referrals/admin/commissions`             | `referrals.write`  | Record an investment, which creates a commission                 |
| GET    | `/referrals/admin/commissions/:id`         | `referrals.read`   | Read one                                                         |
| PATCH  | `/referrals/admin/commissions/:id`         | `referrals.write`  | Change a pending one's `amount` or `note`                        |
| DELETE | `/referrals/admin/commissions/:id`         | `referrals.delete` | Delete a pending or rejected one                                 |
| POST   | `/referrals/admin/commissions/:id/approve` | `referrals.write`  | Approve a pending one                                            |
| POST   | `/referrals/admin/commissions/:id/reject`  | `referrals.write`  | Reject a scheduled, pending or approved one (`note` is required) |
| POST   | `/referrals/admin/commissions/:id/pay`     | `referrals.payout` | Pay an approved one into the referrer's wallet                   |
| GET    | `/referrals/admin/users/:id`               | `referrals.read`   | One person's code, link, referrer and totals                     |
| PUT    | `/referrals/admin/users/:id/code`          | `referrals.write`  | Set a custom `code`, or generate one. The old link stops working |

Both lists search by the name or email of either person, as well as by the code or investment reference. Referrals filter by `status`, `source`, `referrer` and `referee`. Commissions filter by `status`, `referral`, `referrer` and `referee`.

```jsonc
// POST /referrals/admin/commissions
{
  "referee": "<the customer who invested>",
  "investmentReference": "INV-2026-0001", // Unique, so one investment can't earn twice
  "investmentAmount": 10000000, // In kobo
  "plan": "<investment plan id>", // Optional
  "amount": 500000, // Optional. Replaces the amount worked out from the rate
  "note": "...", // Optional. Staff only
}
```

### How a commission moves

`scheduled` → `pending` → `approved` → `paid`, or `rejected` from any of the first three. A `scheduled` one becomes `cancelled` if the investment is withdrawn before it comes due.

- **Recording:** investing through `POST /investments/subscriptions` records the commission automatically. Staff use the route above for investments made outside the app, which are `pending` at once with no schedule. Both apply the same limits.
- **Yearly payments:** nothing is earned up front. The referrer earns the full rate on the investment at each 12 months of its life, so 5% on a 36 month investment pays 5% three times, 15% in all, and 24 months pays it twice. A plan of 12 months or less pays the rate once, at maturity. A part-year after the first is paid at maturity in proportion, so 18 months pays one and a half times. Investment returns aren't affected.
- **Coming due:** the investment worker moves each `scheduled` payment to `pending` on its `dueAt`, and staff then approve and pay it as usual. Each is its own commission, with `instalment`, `instalments` and `dueAt`, and an `investmentReference` ending in `-Y1`, `-Y2` and so on.
- **Early withdrawal:** payments not yet due become `cancelled`. Anything already due or paid stands.
- **The rate:** each commission keeps the rate it was earned at, so changing the programme doesn't alter it.
- **Paying:** credits the wallet and adds a `referral_commission` entry to its ledger in one transaction, so it needs a replica set, and concurrent requests can't pay twice. A closed account can't be paid (`409 REFERRER_INACTIVE`).
- **Staff's own earnings:** nobody can record, change, approve, reject or pay a commission they earn themselves (`403 SELF_DEALING`).
- **Rejecting a referral** rejects its unpaid commissions. Money already paid stays in the wallet, because taking it back is a decision for a person.
- **Deleting an account** leaves its referrals and commissions in place as records, with that person shown as `null`.

### Settings

These are managed settings in [platform config](#roles-and-permissions), changed with `PATCH /platform-config/admin/:key`. `.env` only gives their first values.

| Key                                       | Default | Purpose                                                                            |
| ----------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `referral.commission.basis_points`        | `0`     | The commission rate for each year of an investment. 100 is 1%, and the most is 20% |
| `referral.commission.min_investment_kobo` | `0`     | The smallest investment that earns a commission                                    |
| `referral.commission.max_investments`     | `1`     | How many of a customer's investments earn a commission. 0 means all                |

The rate starts at `0`, and recording an investment answers `409 COMMISSION_RATE_NOT_SET` until it's set.

## Blog

Posts are written in Markdown. The API stores them as sent, so a frontend must sanitise whatever it renders.

| Method | Path                              | Permission        | Purpose                               |
| ------ | --------------------------------- | ----------------- | ------------------------------------- |
| GET    | `/blog/posts`                     | Public            | List live posts, without their bodies |
| GET    | `/blog/posts/:slug`               | Public            | Read a live post                      |
| GET    | `/blog/categories`                | Public            | Categories in use, with post counts   |
| GET    | `/blog/tags`                      | Public            | Tags in use, with post counts         |
| GET    | `/blog/admin/posts`               | `content.read`    | List posts of any status              |
| GET    | `/blog/admin/posts/:id`           | `content.read`    | Read a post of any status             |
| POST   | `/blog/admin/posts`               | `content.write`   | Create a draft                        |
| PATCH  | `/blog/admin/posts/:id`           | `content.write`   | Update a post                         |
| POST   | `/blog/admin/posts/:id/publish`   | `content.publish` | Publish now, or schedule with a time  |
| POST   | `/blog/admin/posts/:id/unpublish` | `content.publish` | Take a post back to draft             |
| POST   | `/blog/admin/posts/:id/archive`   | `content.publish` | Take a post offline and keep it       |
| DELETE | `/blog/admin/posts/:id`           | `content.delete`  | Delete a post permanently             |

```jsonc
// POST /blog/admin/posts. Only title is required
{
  "title": "City Core launches",
  "slug": "city-core-launches", // Made from the title if omitted, and kept when the title changes
  "excerpt": "...",
  "content": "# Markdown",
  "coverImage": "https://res.cloudinary.com/<cloud>/image/upload/v1/citycore/images/<id>.png", // From POST /uploads/images, or another https URL
  "category": "News",
  "tags": ["launch"],
  "metaTitle": "...",
  "metaDescription": "...",
}

// POST /blog/admin/posts/:id/publish. The body is optional
{ "publishAt": "2026-12-01T09:00:00Z" }
```

- **Filters:** public lists take `category`, `tag` and `search`. The admin list also takes `status` (`draft`, `published`, `archived`) and `author`.
- **Scheduling:** a post published with a future `publishAt` goes live at that time with no background job. Until then it has status `published` and a future `publishedAt`, and readers can't see it. Publishing it again with no time brings it forward.
- **Review:** someone with `content.write` alone, such as Media & Publicity, can edit drafts and archived posts, but editing a published or scheduled post needs `content.publish` too (`403 POST_EDIT_FORBIDDEN`).
- **Publishing rules:** a post with no content can't be published (`409 POST_INCOMPLETE`), and a post that's already live answers `409 POST_ALREADY_PUBLISHED`.
- **Authors:** readers see only the author's name and avatar. If the author's account is deleted, the post stays up with `author: null`.
- **Images:** deleting a post or changing its cover leaves the image file in place, because other posts may use it.

## Profiles

Every account, customer or staff, manages its own profile through the same routes. `PATCH /users/me` takes any of the fields below, plus `name`, `jobTitle` and `department`. Send `null` to clear one, except `name` and `preferences`.

```jsonc
// PATCH /users/me
{
  "phone": "+2348012345678", // With the country code
  "alternatePhone": "+2348087654321",
  "dateOfBirth": "1990-04-12",
  "gender": "female", // male, female, other or prefer_not_to_say
  "maritalStatus": "single", // single, married, divorced, widowed or separated
  "nationality": "NG", // Two-letter code
  "occupation": "Engineer",
  "employer": "Acme Ltd",
  "address": {
    "line1": "12 Marina Road",
    "line2": null, // Optional, as is postalCode
    "city": "Lagos",
    "state": "Lagos",
    "country": "NG", // Two-letter code
    "postalCode": "101001",
  },
  "nextOfKin": {
    "name": "Ada Obi",
    "relationship": "Sister",
    "phone": "+2348011111111",
    "email": null, // Optional, as is address
    "address": null,
  },
  // Merged, so send only what changes. Defaults: en, Africa/Lagos, all notifications on
  "preferences": {
    "language": "en",
    "timezone": "Africa/Lagos",
    "emailNotifications": true,
    "smsNotifications": false,
    "pushNotifications": true,
  },
}
```

**Your own account:**

| Method      | Path                      | Purpose                                                      |
| ----------- | ------------------------- | ------------------------------------------------------------ |
| GET, PATCH  | `/users/me`               | Read or update your profile                                  |
| PUT, DELETE | `/users/me/avatar`        | Replace your avatar (`avatar` file field) or remove it       |
| POST        | `/auth/change-email`      | Change your email (`email`, `currentPassword`)               |
| POST        | `/auth/change-password`   | Change your password, which signs out your other devices     |
| GET         | `/auth/sessions`          | Devices you're signed in on, with `current` marking this one |
| DELETE      | `/auth/sessions/:id`      | Sign out one device                                          |
| POST        | `/auth/logout-everywhere` | Sign out every device                                        |
| POST        | `/auth/close-account`     | Close your account (`currentPassword`)                       |

**Someone else's account:**

| Method      | Path                             | Permission    | Purpose                                     |
| ----------- | -------------------------------- | ------------- | ------------------------------------------- |
| GET         | `/users/:id`                     | `users.read`  | Read a full profile                         |
| PATCH       | `/users/:id`                     | `users.write` | Update a profile, as well as email and role |
| PUT, DELETE | `/users/:id/avatar`              | `users.write` | Replace or remove their avatar              |
| POST        | `/users/:id/sign-out`            | `users.write` | Sign them out of every device               |
| GET         | `/users/:id/overview`            | `users.read`  | Profile plus what's linked to the account   |
| GET         | `/users/:id/sessions`            | `users.read`  | Devices they're signed in on                |
| DELETE      | `/users/:id/sessions/:sessionId` | `users.write` | Sign out one of their devices               |

`POST /users` takes every profile field too, as well as `employeeId`, so an account can be created complete. `employeeId` is unique and can only be set through `POST /users` and `PATCH /users/:id`, not by the account's owner.

The overview always has `user` and `activeSessions`. `wallet` needs `wallet.read`, `coreBanking` needs `customers.read`, and `tickets` needs `helpdesk.read`; each is left out otherwise.

Staff can search `/users` by phone number or employee ID, and filter it with `?department=`.

**Rules:**

- **Who can manage whom:** the rules under [Roles and permissions](#roles-and-permissions) apply to all of these, and nobody can use these routes on their own account.
- **Identity numbers and bank details:** BVN, NIN, identity documents and bank accounts aren't part of the profile. They stay in Symplus, through `/onboarding` and `/symplus/me`.
- **Deactivating someone:** `PATCH /users/:id` with `isActive: false` also signs them out everywhere, so they have to sign in again once restored.
- **Notification preferences:** these are only stored for now. Nothing sends notifications yet, so whatever does must read them.
- **Work details:** `jobTitle` and `department` can be set by the staff member or an admin. They're ignored for customers editing their own profile.
- **Changing an email:** yours needs your password, and emails aren't verified. Nobody can change one while a core banking profile is queued, pending or active, staff included (`409 EMAIL_LOCKED`), because Symplus finds customers by email. There's no route yet to change one once it's locked.
- **Closing your account:** deactivates it rather than deleting it, so staff can restore it with `isActive: true` and its email stays taken. The wallet must be empty (`409 WALLET_NOT_EMPTY`), and the last super admin can't leave (`409 LAST_SUPER_ADMIN`).
- **Signing out one device:** takes effect when that device next refreshes, so it keeps working until its access token expires, up to `JWT_ACCESS_EXPIRES_IN`. Signing out everywhere takes effect at once.

## Email (Resend)

All email goes out through [Resend](https://resend.com). Set these in `.env`:

| Setting           | Purpose                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `RESEND_ENABLED`  | While false, emails are recorded as `skipped` and nothing is sent                             |
| `RESEND_API_KEY`  | A sending key is enough. Also needs `DATA_ENCRYPTION_KEY`                                     |
| `RESEND_FROM`     | The sender, such as `City Core <hello@yourdomain.com>`. Its domain must be verified in Resend |
| `RESEND_REPLY_TO` | Optional address that replies go to                                                           |

The default sender, `onboarding@resend.dev`, can only deliver to the Resend account's own address, so verify a domain before going live. `POST /emails/admin/test` sends a test to your own address, and the activity list shows Resend's reason if it's refused.

### How sending works

A request never talks to Resend. It records the email in the `emaillogs` collection, and a worker sends what's waiting every `EMAIL_QUEUE_POLL_SECONDS`. So a slow or broken provider can't hold up a request or undo a payment, and an email survives a restart.

- **Temporary failures** retry with growing gaps, up to `EMAIL_QUEUE_MAX_ATTEMPTS`. A rate limit pauses the whole queue and uses up no attempts.
- **Refusals**, such as an unverified domain, fail straight away. Staff can retry them.
- **Duplicates:** each email carries an idempotency key, so a retry after a crash can't send it twice, and several servers can run the worker together.
- **Sensitive emails**, those with a code or financial details, are encrypted while they wait and aren't readable by staff. Their content is removed once sent.

### What gets sent

| Email                                           | When                               | Follows the customer's opt out |
| ----------------------------------------------- | ---------------------------------- | ------------------------------ |
| Verification code                               | Signup, new address, or on request | No                             |
| Password reset code                             | `POST /auth/forgot-password`       | No                             |
| Password changed, email changed, account closed | When it happens                    | No                             |
| Account created for you                         | Staff create an account            | No                             |
| Welcome                                         | Email verified, or Google signup   | Yes                            |
| Wallet funded                                   | Money is credited                  | Yes                            |
| Investment started, payout, matured, withdrawn  | When it happens                    | Yes                            |
| Referral commission paid                        | Staff pay it                       | Yes                            |
| Ticket received, staff reply, ticket resolved   | When it happens                    | Yes                            |
| Birthday                                        | See below                          | Yes                            |

The opt out is `preferences.emailNotifications`. An email it stops is recorded as `skipped`, with the reason.

### Verification and password reset

Codes are 6 digits and last `EMAIL_CODE_TTL_MINUTES`. Each allows 5 wrong guesses, can be requested once every 55 seconds, and stops working if the account's address changes. The request routes answer the same whether or not the account exists.

```
POST /auth/forgot-password        { email }
POST /auth/reset-password/verify  { email, code }                 optional check before the next screen
POST /auth/reset-password         { email, code, newPassword }    signs out every device

POST /auth/verify-email/request   { email }
POST /auth/verify-email           { email, code }
```

An account's `emailVerified` shows the result. Nothing is blocked while it's false.

### Staff routes

Under `/emails/admin`.

| Method     | Path                  | Permission    | Purpose                                                   |
| ---------- | --------------------- | ------------- | --------------------------------------------------------- |
| GET        | `/activity`           | `emails.read` | The activity list                                         |
| GET        | `/activity/:id`       | `emails.read` | One email, with its content unless it's sensitive         |
| POST       | `/activity/:id/retry` | `emails.send` | Send a failed email again                                 |
| GET        | `/stats`              | `emails.read` | Totals by status and category, and sent or failed in 24h  |
| POST       | `/test`               | `emails.send` | Send a test to your own address                           |
| GET, PATCH | `/birthdays/settings` | Read / send   | The automatic send and its wording                        |
| GET        | `/birthdays/upcoming` | `emails.read` | Upcoming birthdays. `days` is 1 to 365, and defaults to 7 |
| POST       | `/birthdays/preview`  | `emails.read` | Show the email without sending it                         |
| POST       | `/birthdays/send`     | `emails.send` | Send now                                                  |

`GET /activity` accepts `status` (`queued`, `sending`, `sent`, `failed`, `skipped`), `category` (`security`, `account`, `transaction`, `support`, `birthday`, `system`), `template`, `user`, `triggeredBy`, `dateFrom`, `dateTo`, `search` (address or subject) and `sort`. Each row has `to`, `subject`, `template`, `category`, `status`, `attempts`, `lastError`, `providerId`, `createdAt`, `sentAt`, `failedAt`, and `user` and `triggeredBy`. An empty `triggeredBy` means the system sent it.

"Sent" means Resend accepted it. Whether it later bounced shows in the Resend dashboard.

### Birthdays

The automatic send starts **off**. Check the wording, then turn it on:

```jsonc
// PATCH /emails/admin/birthdays/settings
{
  "autoSendEnabled": true,
  "subject": "Happy birthday, {{firstName}}!",
  "message": "Everyone at City Core wishes you a happy birthday, {{firstName}}.",
  "sendHour": 9,
  "timezone": "Africa/Lagos",
}
```

Once on, it checks every `EMAIL_BIRTHDAY_CHECK_MINUTES` from `sendHour` onward, so a server that was down at that hour still catches up. "Today" means today in `timezone`. Those born on 29 February get theirs on the 28th in other years. The wording can use `{{firstName}}` and `{{name}}`.

`POST /birthdays/send` sends now, to everyone whose birthday is today, or to `userIds` (up to 500) whatever the date. `subject` and `message` optionally replace the saved wording, and it answers with how many were `queued`, `alreadySent`, `optedOut`, `noDateOfBirth` and `notFound`.

Each person gets one birthday email a year, however it was sent and however many servers are running.

## Helpdesk

Any signed-in user can raise support tickets and talk to staff on them. Staff work from a shared queue, and can leave internal notes that customers never see.

**Customer routes.** These only ever reach the caller's own tickets. Someone else's ticket returns 404.

| Method             | Path                                        | Purpose                                     |
| ------------------ | ------------------------------------------- | ------------------------------------------- |
| GET, POST          | `/helpdesk/tickets`                         | List your tickets or raise one              |
| GET, PATCH         | `/helpdesk/tickets/:id`                     | Read a ticket, or edit it until staff reply |
| POST               | `/helpdesk/tickets/:id/close`               | Close a ticket                              |
| POST               | `/helpdesk/tickets/:id/reopen`              | Reopen a resolved or closed ticket          |
| GET, POST          | `/helpdesk/tickets/:id/messages`            | Read the conversation or reply              |
| GET, PATCH, DELETE | `/helpdesk/tickets/:id/messages/:messageId` | Read a message, or change your own          |

**Staff routes.**

| Method | Path                                              | Permission        | Purpose                                                |
| ------ | ------------------------------------------------- | ----------------- | ------------------------------------------------------ |
| GET    | `/helpdesk/admin/stats`                           | `helpdesk.read`   | Counts by status and priority, and unassigned tickets  |
| GET    | `/helpdesk/admin/tickets`                         | `helpdesk.read`   | The queue                                              |
| GET    | `/helpdesk/admin/tickets/:id`                     | `helpdesk.read`   | Read any ticket                                        |
| POST   | `/helpdesk/admin/tickets`                         | `helpdesk.write`  | Raise a ticket for a customer (`requester`)            |
| PATCH  | `/helpdesk/admin/tickets/:id`                     | `helpdesk.write`  | Change anything, including `status` and `assignee`     |
| DELETE | `/helpdesk/admin/tickets/:id`                     | `helpdesk.delete` | Delete a ticket and its conversation                   |
| GET    | `/helpdesk/admin/tickets/:id/messages`            | `helpdesk.read`   | Read the conversation, with internal notes             |
| POST   | `/helpdesk/admin/tickets/:id/messages`            | `helpdesk.write`  | Reply, or add a note with `"internal": true`           |
| GET    | `/helpdesk/admin/tickets/:id/messages/:messageId` | `helpdesk.read`   | Read a message                                         |
| PATCH  | `/helpdesk/admin/tickets/:id/messages/:messageId` | `helpdesk.write`  | Edit your own message                                  |
| DELETE | `/helpdesk/admin/tickets/:id/messages/:messageId` | `helpdesk.write`  | Delete your own message, or any with `helpdesk.delete` |

```jsonc
// POST /helpdesk/tickets. Only subject and description are required
{
  "subject": "Card payment not showing",
  "description": "I paid 5,000 on Monday and my wallet has not changed.",
  "category": "wallet", // account, wallet, banking, technical or other (the default)
  "attachments": ["https://res.cloudinary.com/<cloud>/image/upload/v1/citycore/images/<id>.png"], // Up to 5 URLs from POST /uploads
}
```

Ticket lists filter by `status` (`status=open,in_progress` matches either), `category` and `priority`. The staff queue also filters by `requester`, `assignee` and `unassigned=true`. Use `sort=-priorityRank,createdAt` for the most urgent and then the oldest first. `search` matches the ticket number and subject.

**How a ticket moves.** Status is `open`, `in_progress`, `waiting_customer`, `resolved` or `closed`. Staff can set any of these, and these happen on their own:

- Assigning an open ticket moves it to `in_progress`.
- A public staff reply moves an open or in-progress ticket to `waiting_customer`.
- A customer reply moves a waiting or resolved ticket back to `in_progress`, or to `open` if nobody is assigned.

**Rules:**

- **Closed tickets:** nobody can reply or edit until the ticket is reopened (`409 TICKET_CLOSED`). Staff can still add internal notes.
- **Customer edits:** a ticket can be edited only while it's open and has no staff reply (`409 TICKET_LOCKED`).
- **Deleting tickets:** only staff can, so customers close tickets instead and the record stays.
- **Messages:** authors can change their own for 15 minutes (`409 MESSAGE_LOCKED`), and edits set `editedAt`. Someone with `helpdesk.delete` can remove any message at any time.
- **Assignees:** must be active staff with `helpdesk.write` (`400 INVALID_ASSIGNEE`).
- **Deleted users:** tickets outlive the account, and then show `requester` or `author` as `null`.
- **Priority:** only staff can set it, so customers can't all mark themselves urgent.

## File storage

Cloudinary is the storage platform for uploaded files: `/uploads`, `/media` and avatars. Copy the API environment variable from Dashboard > Settings > API Keys into `.env`:

| Setting                 | Meaning                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `CLOUDINARY_URL`        | `cloudinary://<api_key>:<api_secret>@<cloud_name>`. Required in production |
| `CLOUDINARY_FOLDER`     | Folder for this environment's files. Defaults to `citycore`                |
| `CLOUDINARY_TIMEOUT_MS` | How long to wait for an upload. Defaults to 60000                          |

- **Without it:** outside production the server still starts, and uploads answer `503 STORAGE_NOT_CONFIGURED`.
- **The flow:** a file is held in memory, its contents are checked, and only then is it sent to Cloudinary. A request that later fails has its file deleted again.
- **URLs:** uploads answer with a full `https://res.cloudinary.com/...` URL. Images are stored as `image` assets and PDFs as `raw` ones.
- **Errors:** `502 STORAGE_UPLOAD_FAILED` when Cloudinary can't be reached, and `400 INVALID_FILE_CONTENT` when it refuses a file.
- **KYC documents:** those sent through Symplus never go to Cloudinary. They stay in memory until forwarded.

## Media library

`src/modules/media/` is the staff library of images and PDFs, with details about each file and who uploaded it. It sits alongside `/uploads`, which any signed-in user can post to and which keeps no records.

- **In blog posts:** use a file's `url` as a post's `coverImage`, or in its Markdown.
- **Deleting:** a file a blog post is using can't be deleted (`409 MEDIA_IN_USE`). Posts of any status count, as the cover or in the text.
- **Files are public:** anyone with a file's URL can open it, so keep private documents out of the library.

| Method | Path               | Permission     | Purpose                        |
| ------ | ------------------ | -------------- | ------------------------------ |
| GET    | `/media`           | `media.read`   | List files (`kind`, `search`)  |
| GET    | `/media/:id`       | `media.read`   | One file's details             |
| POST   | `/media/images`    | `media.write`  | Upload an image (`file`)       |
| POST   | `/media/documents` | `media.write`  | Upload a PDF (`file`)          |
| PATCH  | `/media/:id`       | `media.write`  | Update `title` or `altText`    |
| DELETE | `/media/:id`       | `media.delete` | Delete the record and the file |

`POST` also accepts `title` and `altText` as form fields.

## Platform configuration

`src/modules/platformConfig/` stores settings that staff can change at runtime, without a deploy. Each one has a permanent `key` and a `value` checked against its `type`.

| Method | Path                          | Permission               | Purpose                                                  |
| ------ | ----------------------------- | ------------------------ | -------------------------------------------------------- |
| GET    | `/platform-config`            | Public                   | Public settings, as `{ key: value }`                     |
| GET    | `/platform-config/admin`      | `platform_config.read`   | List settings (`category`, `type`, `isPublic`, `search`) |
| POST   | `/platform-config/admin`      | `platform_config.write`  | Create a setting                                         |
| GET    | `/platform-config/admin/:key` | `platform_config.read`   | Read a setting                                           |
| PATCH  | `/platform-config/admin/:key` | `platform_config.write`  | Update a setting                                         |
| DELETE | `/platform-config/admin/:key` | `platform_config.delete` | Delete a setting                                         |

```jsonc
// POST /platform-config/admin
{
  "key": "support.email", // Permanent. Lowercase letters, numbers, underscores and dots
  "label": "Support email",
  "description": "Shown in the app footer", // Optional
  "category": "support", // Optional. Defaults to general
  "type": "string", // string, number, boolean or json (an object or array)
  "value": "help@example.com",
  "isPublic": true, // Optional. Defaults to false
}
```

- **Updates:** `PATCH` takes any field except `key`. A JSON value is replaced whole, not merged. Changing `type` needs a `value` that fits it, unless the stored one already does.
- **Public settings:** anyone can read a setting with `isPublic: true`, without signing in. Settings are private unless you say otherwise.
- **Secrets:** values aren't encrypted, and they're written to the log when changed. Keep credentials in `.env`.
- **History:** each setting records `createdBy` and `updatedBy`, and every change is logged with who made it.
- **Other `.env` settings:** the integrations' credentials, URLs and timeouts still come from `.env`. Adding a setting here doesn't change how they behave.

### Wallet limits and fees

These settings are managed, and the responses mark them `managed: true`. The server creates any that are missing each time it starts, taking the first value from `.env`. **After that, the stored value is the one used, and changing `.env` has no effect.**

| Key                                           | First value from                      | Allowed values           |
| --------------------------------------------- | ------------------------------------- | ------------------------ |
| `wallet.funding.min_kobo`                     | `WALLET_MIN_FUNDING_KOBO`             | 1 to 10,000,000,000 kobo |
| `wallet.funding.max_kobo`                     | `WALLET_MAX_FUNDING_KOBO`             | 1 to 10,000,000,000 kobo |
| `wallet.fees.checkout.basis_points`           | `PAYSTACK_FEE_BASIS_POINTS`           | 0 to 1,000 (10%)         |
| `wallet.fees.checkout.flat_kobo`              | `PAYSTACK_FEE_FLAT_KOBO`              | 0 to 10,000,000 kobo     |
| `wallet.fees.checkout.flat_waived_below_kobo` | `PAYSTACK_FEE_FLAT_WAIVED_BELOW_KOBO` | 0 to 10,000,000 kobo     |
| `wallet.fees.checkout.cap_kobo`               | `PAYSTACK_FEE_CAP_KOBO`               | 0 to 10,000,000 kobo     |
| `wallet.fees.transfer.basis_points`           | `PAYSTACK_DVA_FEE_BASIS_POINTS`       | 0 to 1,000 (10%)         |
| `wallet.fees.transfer.cap_kobo`               | `PAYSTACK_DVA_FEE_CAP_KOBO`           | 0 to 10,000,000 kobo     |

- **Changing one:** `PATCH /platform-config/admin/:key` with `{ "value": 20000 }`. Anything else answers `403 CONFIG_LOCKED`, and so do deleting one and creating one with a managed key.
- **Pairs:** the minimum can't pass the maximum, and the flat fee can't pass the cap (`422`). To move both, change them in the order that keeps them valid.
- **When it applies:** straight away on every server. A payment already started keeps the fee it was quoted, because it's checked against the total stored when it began.
- **Paystack's real rates:** these settings only decide what customers are charged. If they stop matching what Paystack charges, City Core gains or absorbs the difference, and each transaction's `fees` shows Paystack's figure next to `customerFee`.
- **Bad data:** if a stored value breaks its rule, perhaps from a direct database edit, the `.env` value is used and an error is logged.

## Investments

Staff manage a catalogue of investment plans, and signed-in customers browse the ones available now and invest in them from their wallet.

| Method | Path                             | Permission           | Purpose                                              |
| ------ | -------------------------------- | -------------------- | ---------------------------------------------------- |
| GET    | `/investments/plans`             | User                 | List available plans                                 |
| GET    | `/investments/plans/:slug`       | User                 | Read an available plan                               |
| GET    | `/investments/plans/:slug/quote` | User                 | Project the return on `?units=` or `?amount=` (kobo) |
| GET    | `/investments/categories`        | User                 | Categories in use, with plan counts                  |
| GET    | `/investments/admin/plans`       | `investments.read`   | List plans of any status                             |
| GET    | `/investments/admin/plans/:id`   | `investments.read`   | Read a plan of any status                            |
| POST   | `/investments/admin/plans`       | `investments.write`  | Create a plan                                        |
| PATCH  | `/investments/admin/plans/:id`   | `investments.write`  | Update a plan, including its status                  |
| DELETE | `/investments/admin/plans/:id`   | `investments.delete` | Delete a plan permanently                            |

```jsonc
// POST /investments/admin/plans
{
  "name": "Fixed Income Note", // Required
  "slug": "fixed-income-note", // Made from the name if omitted, and kept when the name changes
  "summary": "Short text for a listing",
  "description": "Full details", // Required
  "category": "Fixed income",
  "coverImage": "https://res.cloudinary.com/<cloud>/image/upload/v1/citycore/images/<id>.png", // From POST /uploads/images, or another https URL
  "thumbnail": "https://res.cloudinary.com/<cloud>/image/upload/v1/citycore/images/<id>.png", // The same. A plan can't open without one
  "assetType": "Residential",
  "assetSubtype": "Development",
  "location": { "area": "Lekki", "state": "Lagos", "country": "Nigeria" },
  "unitPrice": 15000000, // In kobo, with totalUnits, for a plan sold in units
  "totalUnits": 1000,
  "riskLevel": "low", // Required: low, medium or high
  "roiBasisPoints": 1800, // Required: 1800 is 18%
  "roiGuaranteed": false, // The default. False means the rate is only a target
  "roiType": "per_annum", // Required: per_annum (prorated over the duration) or flat (total for the duration)
  "payoutFrequency": "at_maturity", // Required: monthly, quarterly or at_maturity
  "durationValue": 6, // Required, up to 50 years in all
  "durationUnit": "months", // Required: days, months or years
  "minAmount": 10000000, // In kobo. Required, unless the plan is sold in units, when it defaults to one unit
  "maxAmount": 500000000, // In kobo. Null or omitted means no upper limit
  "earlyWithdrawalAllowed": true,
  "earlyWithdrawalPenaltyBasisPoints": 250,
  "features": ["Capital paid at maturity"],
  "terms": "Terms and conditions",
  "status": "draft", // draft (default), open, closed or archived
  "opensAt": "2026-12-01T09:00:00Z", // Optional availability window
  "closesAt": "2027-03-01T09:00:00Z",
}
```

- **Offering:** a plan sold in units also returns `unitsSold`, `unitsAvailable` and `totalOffering` (in kobo), which the API works out. A `per_annum` rate is simple interest. A plan with no units takes any amount within its limits.
- **Display:** the API returns the values and leaves wording to the frontend: "Residential • Development" from `assetType` and `assetSubtype`, and "16% simple • not guaranteed" from `roiBasisPoints`, `roiType` and `roiGuaranteed`.
- **Availability:** customers see a plan only when its status is `open` and the time is inside `opensAt` and `closesAt`. Any other plan answers 404, as if it didn't exist.
- **Filters:** lists take `category`, `assetType`, `riskLevel`, `roiType`, `payoutFrequency` and `search`, which also matches the asset type and location, and sort by `name`, `roiBasisPoints`, `durationDays`, `minAmount` or `createdAt`. The admin list also takes `status`.
- **Duration:** the API sets `durationDays` for sorting, counting a month as 30 days and a year as 365. Returns are worked out from `durationValue` and `durationUnit`, so 12 months earns exactly one year's rate.
- **Quotes:** `projectedReturn` is rounded down to the kobo. It's a projection from the plan's rate, and it ignores fees, tax and any payout schedule. The amount must be within the plan's limits (`422`).

### Investing

| Method | Path                                            | Permission         | Purpose                                             |
| ------ | ----------------------------------------------- | ------------------ | --------------------------------------------------- |
| POST   | `/investments/subscriptions`                    | User, with KYC     | Invest from the wallet                              |
| GET    | `/investments/subscriptions`                    | User               | Your investments. Filter by `status`                |
| GET    | `/investments/subscriptions/:id`                | User               | One of your investments, with its schedule          |
| GET    | `/investments/subscriptions/:id/withdraw/quote` | User               | What withdrawing now would pay and cost             |
| POST   | `/investments/subscriptions/:id/withdraw`       | User               | Withdraw early. Body: `{ "confirm": true }`         |
| GET    | `/investments/admin/subscriptions`              | `investments.read` | All investments. Filter by `status`, `plan`, `user` |
| GET    | `/investments/admin/subscriptions/summary`      | `investments.read` | Totals by status, and what's still owed             |
| GET    | `/investments/admin/subscriptions/:id`          | `investments.read` | Any investment, with its owner                      |

```jsonc
// POST /investments/subscriptions
{
  "planId": "<plan id>",
  "units": 2, // On a plan sold in units. Or send "amount" in kobo, which must buy whole units
  "idempotencyKey": "<a new UUID for each attempt>", // Retrying with the same key can't invest twice
  "acceptTerms": true,
}
```

- **Taking the money:** the wallet is debited in the same transaction that creates the investment. A low balance answers `409 INSUFFICIENT_BALANCE`, and a repeated key returns the first investment with `200` (`409 IDEMPOTENCY_KEY_REUSED` if the plan or amount differ).
- **Units:** a plan can't oversell, however many people buy at once (`409 INSUFFICIENT_UNITS`). Once units have sold, the unit price is fixed and `totalUnits` can't go below `unitsSold`. An early withdrawal doesn't put units back on sale. The term starts at allocation, which is the moment of investing.
- **Locked terms:** each investment keeps a copy of the plan's rate, duration, payout frequency, withdrawal terms, legal terms and offering details in `planSnapshot`, so editing a plan never changes existing investments. A plan with investments can't be deleted (`409 PLAN_IN_USE`): close or archive it instead.
- **Payouts:** `payouts` lists each return payment and its date. A worker pays what's due every `INVESTMENT_PAYOUT_MINUTES`, and catches up after any downtime. The last payout comes at maturity with the principal, and the investment becomes `matured`. Each payment has a unique ledger reference, so it can't be paid twice.
- **Early withdrawal:** only if the plan allows it (`409 EARLY_WITHDRAWAL_NOT_ALLOWED`). The customer gets the principal less the penalty, plus anything already due. Returns already paid are kept, and future ones are given up (`returnForfeited`). The penalty is a percentage of the principal.
- **Ledger:** wallet history shows `investment` as a debit, and `investment_return`, `investment_principal` and `investment_withdrawal` as credits. Filter by `type`.
- **Referrals:** a new investment schedules a commission for the customer's referrer, under the programme's rules, and closes the signup referral prompt. An investment that earns nothing is simply not recorded. If recording fails unexpectedly, the investment still stands and the error is logged, so staff can record it by hand with the `CCI-I-<id>` reference, though that has no yearly schedule. Commission is paid yearly, and withdrawing early cancels what hasn't come due: see [Referrals](#referrals).
- **Accounts:** a user with active investments can't be deleted (`409 INVESTMENTS_ACTIVE`).

## Wallet funding (Paystack)

`src/modules/wallet/` holds each user's wallet and a ledger of every transaction. Customers can fund by card, by bank transfer at checkout, or by transfer to their own dedicated virtual account. All amounts are whole kobo (`100000` is 1,000 naira).

### Setup

1. **Use a replica set.** Crediting uses MongoDB transactions, and the server won't start with Paystack on without them. Atlas qualifies, and so does `docker compose up -d`, which runs a single-node set.
2. **Set these in `.env`:**

| Variable                  | Value                                              |
| ------------------------- | -------------------------------------------------- |
| `PAYSTACK_ENABLED`        | `true`                                             |
| `PAYSTACK_SECRET_KEY`     | Dashboard > Settings > API Keys & Webhooks         |
| `PAYSTACK_WEBHOOK_SECRET` | `whsec_...` from Developers > API configuration    |
| `PAYSTACK_CALLBACK_URL`   | The frontend page customers return to              |
| `PAYSTACK_DVA_PROVIDER`   | `test-bank` in test mode. A provider slug for live |

3. **Add the webhook URL** on the Paystack dashboard: `https://your-domain/webhooks/paystack`. It must be publicly reachable, so local testing needs a tunnel such as ngrok.

### Card or transfer at checkout

1. `POST /api/v1/wallet/fund` with `{ "amount": 500000 }` returns an `authorizationUrl`.
2. Send the customer there. Paystack returns them to `PAYSTACK_CALLBACK_URL` with `?reference=...`.
3. Call `POST /api/v1/wallet/fund/:reference/verify` to show them the result.

The wallet is credited whichever arrives first: the webhook, the verify call, or the reconciliation job. It can't be credited twice.

### Fees

The customer pays Paystack's fee. Staff set the rates and funding limits at runtime: see [Wallet limits and fees](#wallet-limits-and-fees).

- **Card or transfer at checkout:** the wallet gets exactly the amount requested, and the fee is added on top. `GET /api/v1/wallet/fund/quote?amount=500000` returns `{ amount, fee, total }` for showing before payment, and `POST /fund` returns the same. For example, 5,000 naira costs the customer 5,177.67 naira.
- **Virtual account transfer:** the sender has already chosen the amount, so the fee is deducted from it. A transfer of 2,750 naira credits 2,750 naira less the fee.
- **Foreign cards:** these cost 3.9% + 100 naira, with no cap, but the card isn't known when the total is set. The customer pays the local rate, and City Core absorbs the difference. Each transaction's `fees` holds what Paystack actually charged, next to `customerFee`.

### Virtual account

`POST /api/v1/wallet/virtual-account` with `firstName`, `lastName`, `phone` and `consent: true`. Financial services businesses must also send `bvn`, `accountNumber` and `bankCode`, which Paystack uses to validate the customer and which aren't stored here. It returns `202`, and `GET /api/v1/wallet` shows the account once Paystack's webhook confirms it. Paystack only offers this to registered businesses that have gone live, though `test-bank` works in test mode.

### How money is protected

- **Only Paystack's word counts:** every credit comes from calling Paystack's verify API. A client's claim or a webhook's contents never credit anything.
- **No double credit:** the balance and ledger entry change together in one database transaction, and concurrent attempts conflict and retry.
- **Wrong amount or currency:** the payment is `flagged` for a person to review, and isn't credited. So is a transfer that matches no wallet.
- **Missed webhooks:** a job re-checks unfinished payments every `PAYSTACK_RECONCILE_MINUTES`.
- **Webhook handling:** the event is processed before responding, because an incoming transfer has no other record. If processing fails, Paystack sends it again.

### Routes

All are under `/api/v1/wallet` and need a signed-in user.

| Method | Path                                     | Purpose                      |
| ------ | ---------------------------------------- | ---------------------------- |
| GET    | `/`                                      | Balance and virtual account  |
| GET    | `/transactions`                          | Your ledger                  |
| GET    | `/transactions/:reference`               | One transaction              |
| POST   | `/fund`                                  | Start a payment              |
| POST   | `/fund/:reference/verify`                | Check a payment now          |
| POST   | `/virtual-account`                       | Request a virtual account    |
| POST   | `/virtual-account/requery`               | Look for a missing transfer  |
| GET    | `/admin/status`                          | Mode and transaction counts  |
| GET    | `/admin/transactions`                    | All transactions, filterable |
| POST   | `/admin/transactions/:reference/recheck` | Re-check with Paystack       |

## KYC onboarding

Every new user starts with `kycCompleted: false`, which comes back on register, login and `GET /users/me`. They can still sign in and use the dashboard. Your "Complete Account" button starts this flow, which is a layer over Symplus: Symplus holds the customer's record and decides when KYC is complete.

| Method | Path                    | Purpose                                  |
| ------ | ----------------------- | ---------------------------------------- |
| GET    | `/onboarding`           | Where the user is, and what to show next |
| POST   | `/onboarding/details`   | Step 1: send their details to Symplus    |
| POST   | `/onboarding/documents` | Step 2: upload one document at a time    |
| POST   | `/onboarding/refresh`   | Ask Symplus for the latest result        |

All are under `/api/v1` and need a signed-in user. Each one returns the same state, so the frontend can just follow `nextStep`:

```jsonc
{
  "available": true, // false while Symplus is off, so hide or disable the button
  "kycCompleted": false,
  "status": "pending", // not_started, queued, pending, active, rejected or failed
  "nextStep": "upload_documents",
  "documents": [{ "type": "PIX", "label": "Passport photograph", "submitted": true }],
  "customerId": null,
  "sourceReference": "REF123",
  "upstreamStatus": null,
  "lastError": null,
}
```

| `nextStep`         | What to show                                                  |
| ------------------ | ------------------------------------------------------------- |
| `submit_details`   | The details form, with `lastError` if an attempt failed       |
| `processing`       | "We're sending your details". Symplus is down, and it retries |
| `upload_documents` | Upload the `documents` not yet `submitted`                    |
| `await_review`     | "Under review". Nothing more for the user to do               |
| `complete`         | KYC is done, so hide the button                               |

- **Details:** the fields are the ones `DoCRCSNewIndividualCustomer` takes, such as `first_name`, `last_name`, `mobile_phone_no`, `gender_cd`, `address_street`, `address_city` and `address_country_cd`. Their email comes from their account. Dropdown values come from `GET /symplus/reference/:list`.
- **Documents:** multipart, with the file in `file` and `document_type` as `PIX`, `IDN`, `SIG` or `UBL`. Each can be up to 1MB, as a BMP, PNG, JPG or PDF. `SYMPLUS_REQUIRED_DOCUMENTS` sets which ones are asked for.
- **Who sets `kycCompleted`:** only the Symplus sync, from `kyc_completed` on `GetCRCSCustomerDetails`. No request can set it, and uploading every document doesn't set it. It turns off again if Symplus withdraws KYC or blacklists the customer.
- **Staying current:** a background job checks every `SYMPLUS_SYNC_INTERVAL_MINUTES`, so the result arrives even if the user never presses refresh.
- **Rejected or failed:** the user goes back to `submit_details`, and it starts as a new registration.

### What needs KYC

Funding a wallet (`POST /wallet/fund`), requesting a virtual account (`POST /wallet/virtual-account`) and investing (`POST /investments/subscriptions`) return `403` with the code `KYC_REQUIRED` until KYC is complete, so a frontend can send the user to onboarding. The check runs on every request, so it applies as soon as Symplus changes.

Everything else stays open without KYC, including the dashboard, the wallet balance and history, fee quotes, and browsing investment plans. Money already sent is always credited, even if KYC has since been withdrawn: a payment in progress still settles, and a transfer to an existing virtual account still arrives.

Withdrawing early and collecting payouts don't need KYC, because that only returns money the customer already invested.

## Symplus core banking

`src/integrations/symplus/` talks to the Symplus Customer Management API (v5). All 58 endpoints are covered. `src/modules/symplus/` adds customer linking, balance sync, the retry queue and the routes below.

### Setup

Symplus is off by default, and its routes return `503` until it's turned on. To turn it on, set these in `.env`:

| Variable                | Value                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `SYMPLUS_ENABLED`       | `true`                                                                              |
| `SYMPLUS_CLIENT_KEY`    | Client key from Symplus                                                             |
| `SYMPLUS_CLIENT_SECRET` | Client secret from Symplus                                                          |
| `SYMPLUS_BASE_URL`      | Sandbox: `https://o501.neuappx.com/sandbox/avazp/v5/cor/scs/`. Replace it for live. |
| `SYMPLUS_TOKEN_URL`     | Sandbox: `https://o501.neuappx.com/sandbox/avazp/oauth/token`. Replace it for live. |
| `DATA_ENCRYPTION_KEY`   | `openssl rand -base64 32`. Don't change it while jobs wait                          |

The server won't start if any of these is missing while Symplus is enabled. `GET /api/v1/symplus/admin/status` then shows whether the credentials work.

### How it works

- **Onboarding:** `POST /onboarding/details` creates the customer. Their email and CRM ID come from their account, so they can't be spoofed. The link starts as `pending`, and becomes `active` once Symplus approves it.
- **Linking safety:** a user is only auto-linked to a Symplus record whose `external_crm_id` is their own user ID. A record with the same email but a different owner is refused, and an admin can link it through `POST /symplus/admin/links`.
- **Balances:** a background worker copies balances from Symplus every `SYMPLUS_SYNC_INTERVAL_MINUTES`. `GET /symplus/me/balances` serves that copy with its `balancesSyncedAt` time, and `POST /symplus/me/balances/sync` fetches fresh figures.
- **Retry queue:** when Symplus is down, onboarding and customer updates are queued and the API responds `202`. Jobs retry with increasing delays up to `SYMPLUS_QUEUE_MAX_ATTEMPTS`, then stop as `dead`, ready for an admin to review and retry. Payloads are encrypted, and a successful job's payload is deleted.
- **Reads** are retried straight away. **Writes** only go through the queue, because a write that timed out may have been applied.

### Routes

All are under `/api/v1/symplus` and need a signed-in user.

| Method | Path                  | Purpose                               |
| ------ | --------------------- | ------------------------------------- |
| GET    | `/me`                 | Read the link                         |
| GET    | `/me/details`         | Full customer record                  |
| GET    | `/me/balances`        | Stored balances                       |
| POST   | `/me/balances/sync`   | Fetch balances now                    |
| GET    | `/me/documents`       | Document status                       |
| GET    | `/me/documents/:type` | Download `PIX`, `IDN`, `SIG` or `UBL` |
| PATCH  | `/me/:section`        | Update a section (see below)          |
| DELETE | `/me/employment`      | Remove employment details             |
| GET    | `/reference/:list`    | Dropdown data, such as `banks`        |

Sections are `details`, `next-of-kin`, `nin`, `tin`, `bank`, `address`, `email`, `employment` and `identification`.

Admin routes, under `/admin`:

| Method | Path                                     | Purpose                           |
| ------ | ---------------------------------------- | --------------------------------- |
| GET    | `/status`                                | Connection and queue health       |
| GET    | `/jobs`                                  | Retry queue                       |
| POST   | `/jobs/:id/retry`                        | Retry a dead job                  |
| POST   | `/links`                                 | Link a user to a customer         |
| GET    | `/links/:id`                             | A user's link, by user ID         |
| GET    | `/customers`                             | List customers (`offset`, `rows`) |
| POST   | `/customers/search`                      | Search by ID, BVN, NIN and others |
| GET    | `/customers/by-serial`                   | List by serial range              |
| GET    | `/customers/by-plan/:product`            | List by account plan              |
| GET    | `/customers/:customerId`                 | Customer record                   |
| GET    | `/customers/:customerId/balances`        | Live balances                     |
| GET    | `/customers/:customerId/minors`          | Minors for a parent               |
| GET    | `/customers/:customerId/documents`       | Document status                   |
| GET    | `/customers/:customerId/documents/:type` | Download a document               |
| PATCH  | `/customers/:customerId/:section`        | Update a section                  |
| DELETE | `/customers/:customerId/employment`      | Remove employment details         |
| POST   | `/registrations/:kind`                   | Create a customer of any kind     |
| GET    | `/registrations/:kind/:reference`        | Registration status               |
| POST   | `/registrations/:kind/documents`         | Upload a document (`file`)        |
| GET    | `/minors`                                | List minors                       |
| POST   | `/minors/upgrade`                        | Upgrade a minor to a customer     |

`:kind` is `individual`, `corporate`, `joint` or `minor`.

### To confirm against the sandbox

The automated tests use a local stand-in built from the OpenAPI spec, because no credentials were available. Check these first once you have some:

- **KYC values:** `kyc_completed` is only documented as a string. `YES`, `Y`, `TRUE` and `1` count as complete, and anything else doesn't. The raw value is kept as `upstreamKyc` on the link.
- **Status values:** Symplus doesn't document the registration status text. `classifyRegistrationStatus` matches words like "approved" and "rejected", and anything else stays `pending`.
- **`external_crm_id`:** linking relies on `GetCRCSCustomerDetails` returning it. If it doesn't, every existing-email case needs an admin link.
- **Result codes:** only `code: "A"` is documented. A failure is detected from the HTTP status, or a `status` other than `success`.
- **Duplicates:** a pending customer may not appear in the email lookup, so a retry after a timeout could create a second pending record.
- **Token lifetime:** the code uses `expires_in`, and assumes 5 minutes if it's absent.

## Before going to production

- **Several server instances:** rate limit counters and uploaded files are stored per process and on local disk. Multiple instances need a shared rate limit store, such as Redis, and shared file storage, such as S3.
- **Uploaded files are public:** anyone with a file's URL can open it. The URLs are unguessable, but private documents would need a route that checks access. This includes helpdesk attachments, which customers may use for bank statements or ID.
- **Helpdesk notifications:** nothing tells a customer or agent about a reply yet, because the app has no email or push provider. They have to check the API.
- **Reverse proxy:** set `TRUST_PROXY` to the number of proxies in front of the app, or rate limiting will see the proxy's IP rather than the client's.
- **Paystack refunds and disputes:** these are only noted for review when a re-check sees a reversal. Nothing takes money back out of a wallet yet, so `charge.dispute.*` and `refund.*` need handling once the business rules are set.
- **Referral costs:** the commission rate repeats each year, so at the 20% limit a 36 month investment would cost 60% of its value in commission. Set the rate with that in mind.
- **Investments:** returns and principal are paid from the wallet ledger, with nothing tying them to money the business actually holds, so watch `outstanding` in the admin summary. Have the ROI wording, the early withdrawal rules and any licensing requirement checked before taking real money.
- **Symplus:** new users' emails aren't verified yet. Add email verification before going live, so the email sent to Symplus is known to be the user's own.
- **Cookies:** the refresh cookie is `Secure` in production and `SameSite=Strict`. This works for a frontend on the same site, such as `app.example.com` and `api.example.com`. A frontend on a different domain needs `SameSite=None`, plus CSRF protection.
