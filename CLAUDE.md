# Supabase Infrastructure Context

This document describes the shared Supabase infrastructure used across all Allied/Guardian apps. Any new app or Claude Code session working with this Supabase project should read this first.

---

## Shared Supabase Project

All apps point to a single Supabase project. There is one `auth.users` table shared across all apps. Users are not duplicated — a single account can have access to multiple apps.

---

## Environment Variable Names (per app type)

| Context | URL | Anon Key | Service Role Key |
|---|---|---|---|
| Vite frontend | `VITE_SUPABASE_URL` | `VITE_SUPABASE_ANON_KEY` | — |
| Next.js frontend | `NEXT_PUBLIC_SUPABASE_URL` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | — |
| Netlify functions | `SUPABASE_URL` | — | `SUPABASE_SERVICE_ROLE_KEY` |

**Never expose `SUPABASE_SERVICE_ROLE_KEY` client-side.** All privileged operations go through Netlify functions.

---

## Apps on This Supabase Project

| App | Slug | Stack | User Creation Method |
|---|---|---|---|
| Call Analyzer | `call-analyzer` | Vite + React, Netlify | Admin creates via `admin-create-user.js` |
| Guardian SMS | `guardian-sms` | Next.js, Netlify | Admin approves signup request → invite |
| HubSpot Importer | `albi-hubspot-import` | Vite + React, Netlify | Admin invites via `admin-invite-user.js` |

**None of these apps use `supabase.auth.signUp()` on the client side.** All user creation is server-side and admin-gated.

---

## User Access Control

### `user_app_access` Table

Access to each app is controlled by the `user_app_access` table. This is the gate — it controls whether a user can enter an app at all. It is **NOT** the source of truth for roles or permissions within an app (see Admin Roles section).

```sql
create table user_app_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  app_name text not null,
  role text not null default 'member',
  granted_at timestamptz default now(),
  unique(user_id, app_name)
);
```

**Valid `app_name` values:**
- `call-analyzer`
- `guardian-sms`
- `albi-hubspot-import`

### `role` field — for reference only

The `role` field in this table is informational. Do not use it to drive app behavior. Each app has its own role/permission system (documented below). The `role` field here can mirror that for visibility but should never replace the app's own source of truth.

| Value | Meaning |
|---|---|
| `member` | Standard access |
| `admin` | App-level admin (mirrors app's own admin concept) |
| `super_admin` | In `super_admins` table (Apps 1 and 3 only) |
| `master_admin` | App 1 only — partner management tier |

### RLS Policies

```sql
-- Users can read their own access rows
create policy "users read own access"
  on user_app_access for select
  using (auth.uid() = user_id);

-- Only service role can insert/update/delete
create policy "service role manages access"
  on user_app_access for all
  using (auth.role() = 'service_role');
```

### Checking Access in a New App

Always check access at the route protection choke point — not scattered across individual routes.

```js
// After confirming session exists
const { data: access } = await supabase
  .from('user_app_access')
  .select('role')
  .eq('app_name', 'your-app-slug')
  .single();

if (!access) {
  // Redirect to /no-access — do not flash a redirect during loading
  // Keep the spinner visible until this check resolves
}
```

### Granting Access (Server-Side Only)

Use the `grant-app-access` Netlify function (present in all 3 existing apps):

```js
await fetch('/.netlify/functions/grant-app-access', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, appName: 'your-app-slug' })
});
```

Or directly via service role in a Netlify function:

```js
await supabase
  .from('user_app_access')
  .upsert(
    { user_id: userId, app_name: 'your-app-slug', role: 'member' },
    { onConflict: 'user_id,app_name' }
  );
```

---

## User Creation Patterns

### Tagging Users at Creation

Every user creation/invite call must pass `signup_app` in user metadata so the DB trigger auto-grants access:

```js
// admin.createUser
supabase.auth.admin.createUser({
  email,
  user_metadata: { signup_app: 'your-app-slug' }
});

// inviteUserByEmail
supabase.auth.admin.inviteUserByEmail(email, {
  data: { signup_app: 'your-app-slug' }
});
```

### DB Trigger (already live in Supabase)

A trigger on `auth.users` insert automatically creates a `user_app_access` row when `signup_app` is present in `raw_user_meta_data`. Do not replicate this logic in app code — rely on the trigger.

```
-- Trigger: on_auth_user_created_app_access
-- Fires: AFTER INSERT on auth.users
-- Behavior: inserts into user_app_access if signup_app metadata is present
```

---

## Admin Role Architecture

**Critical rule:** Each app manages its own role/permission logic using its own tables. Do NOT consolidate these into `user_app_access` or create a second source of truth. The access table is the door. The app's own tables are the keys inside.

### App 1 — Call Analyzer (`call-analyzer`)

Four-tier role hierarchy stored across three tables:

| Tier | Source | Scope | UI Badge |
|---|---|---|---|
| Member | `company_members.role = 'member'` | Own company | none |
| Admin | `company_members.role = 'admin'` | Own company | amber |
| Master Admin | `user_settings.is_master_admin = true` | Multi-partner via `user_partners` | indigo |
| Super Admin | row exists in `super_admins` table | All companies, all users | purple |

Master Admin and Super Admin are completely separate concepts:
- **Super Admin** — manages all companies and users across the platform
- **Master Admin** — no company assignment; manages multiple partner companies with shared CallRail/OpenAI keys

Frontend checks (`Dashboard.jsx`):

```js
const isSuperAdmin  = !!saData                    // row in super_admins
const isMasterAdmin = us?.is_master_admin          // boolean in user_settings
const isAdmin       = membership?.role === 'admin' || isSuperAdmin
```

Backend check pattern (all `admin-*.js` functions):

```js
const [saResult, memberResult] = await Promise.all([
  supabase.from('super_admins').select('user_id').eq('user_id', user.id).single(),
  supabase.from('company_members').select('company_id, role').eq('user_id', user.id).single(),
])
const isSuperAdmin = !!saResult.data
// Super Admin → full access
// Company Admin → company-scoped access
// else → 403
```

**Gate location:** `ProtectedRoute` in `App.jsx` is session-only. All role logic lives inside `Dashboard.jsx`. Do not add role checks to `ProtectedRoute` — it is intentionally kept clean.

---

### App 2 — Guardian SMS (`guardian-sms`)

Single-tier admin model — no super admin concept.

| Tier | Source |
|---|---|
| Member | `users.role = 'member'` in `public.users` table |
| Admin | `users.role = 'admin'` in `public.users` table |

The first user created via `/api/onboarding` is automatically assigned `role: 'admin'`. All subsequent users default to `'member'` unless explicitly set in the approval flow.

Backend check pattern (each route independently — no shared utility):

```js
const { data: userRow } = await supabase
  .from('users')
  .select('role')
  .eq('id', user.id)
  .single()

if (userRow?.role !== 'admin') return // redirect or 403
```

Admin-only routes: `/admin/signups`, `/api/admin/approve-signup`, `/api/admin/reject-signup`, `/api/admin/set-password`.

**Gate location:** `proxy.ts` middleware handles all route protection. Add `checkAppAccess()` here — do not scatter it across individual routes.

---

### App 3 — HubSpot Importer (`albi-hubspot-import`)

Two-tier admin model using the same table pattern as App 1, but without Master Admin.

| Tier | Source | Scope |
|---|---|---|
| Member | `company_members.role = 'member'` | Own company |
| Admin | `company_members.role = 'admin'` | Own company |
| Super Admin | row exists in `super_admins` table | All companies |

Frontend check (`App.jsx`):

```js
setIsAdmin(!!superRes.data || member?.role === 'admin')
// isSuperAdmin — top tier
// isAdmin — either tier
```

Backend check pattern (all 3 admin functions):

```js
const [{ data: superAdmin }, { data: callerMember }] = await Promise.all([
  supabase.from('super_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
  supabase.from('company_members').select('company_id, role').eq('user_id', user.id).maybeSingle(),
])
if (!superAdmin && callerMember?.role !== 'admin') return jsonResponse(403, ...)
```

**Gate location:** `ProtectedRoute` (all auth'd routes) and `AdminRoute` (`/admin` only) in `App.jsx`. `checkAppAccess()` lives in `ProtectedRoute` — `AdminRoute` stays role-focused.

---

## Cross-App `super_admins` Table Note

Apps 1 and 3 both query the same `super_admins` table (same Supabase project). A super admin in one app is a super admin in both. This is intentional — do not create separate super admin tables per app. If you need app-scoped super admins in the future, add an `app_name` column to `super_admins`.

---

## What NOT to Do

- Do not create a new Supabase project for a new app — add a new slug to `user_app_access`
- Do not use `supabase.auth.signUp()` client-side — all user creation is server-side
- Do not expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code or client-side Supabase instances
- Do not scatter access checks across individual routes — use a single choke point per app
- Do not replace app-specific role tables with `user_app_access.role` — they serve different purposes
- Do not add a new `grant-app-access` function if one already exists in the project
- Do not conflate Master Admin (App 1 partner tier) with Super Admin — they are unrelated concepts

---

## Adding a New App to This Infrastructure

1. Choose a unique slug (kebab-case, descriptive)
2. Add the slug to the `validApps` array in each existing app's `grant-app-access.js` function
3. Set up `user_app_access` check at the route protection choke point
4. Pass `signup_app: 'your-slug'` in all user creation/invite calls
5. Decide on your admin model — use `company_members` + `super_admins` pattern (like Apps 1 and 3) or a simpler `users.role` column (like App 2). Document it in this file.
6. Update the Apps table and Admin Role Architecture section above
