# A browser cannot delete or forge its own profile, and dblink leaves the Data API

2026-10-05. Launch audit blockers 2 and 4. Database only; no client or engine change.

## What was wrong (read on production, 2026-10-05)

- `public.profiles` ACL was `authenticated=adxtm`: table-level INSERT and DELETE.
  `profiles_delete` and `profiles_insert_self` check only `auth.uid() = id`, and
  `trg_guard_profile_privileged_columns` is BEFORE UPDATE only. A signed-in
  account could delete its own row and insert it again with `role = 'god'`,
  `is_admin`, `is_vip` and a diamond balance. `fn_is_platform_admin()` reads
  `profiles.role`. The 2026-08-27 fix (`20260827214020`) was a column-level
  `REVOKE INSERT`, a no-op under the table-level grant.
- `authenticated` held column UPDATE on `kyc_status`, the other `kyc_*` columns,
  `age_verified`, `age_verified_at`, `mfa_required` and `is_farming_flagged`.
- `dblink` was installed in `public` with EXECUTE for PUBLIC, `anon` and
  `authenticated` on all 41 of its functions, so `/rest/v1/rpc/dblink_connect`
  answered a visitor with no account.

The exploit was not run against production. The grants, policies and triggers
were read from the catalogue.

## What changed

`20261005220434_a_browser_cannot_delete_or_forge_its_own_profile.sql`

- `REVOKE DELETE ON public.profiles FROM authenticated, anon`. Neither client
  deletes a profile and no database function does.
- `trg_guard_profile_privileged_columns_on_insert` (BEFORE INSERT): in a browser
  context a new profile may not carry `role`, `is_admin`, `is_vip`, `vip_tier`,
  `vip_expires_at`, `diamonds`, `diamond_balance`, `diamond_multiplier`,
  `kyc_status`, `age_verified`, `mfa_required`, `email_verified` or
  `phone_verified` off their defaults. Service contexts pass untouched: the four
  functions that insert profiles (`handle_new_user`, `heal_auth_integrity`,
  `initialize_player_profile`, `create_bot_player`) are not executable by a
  browser role. The signup upsert in `src/pages/AuthPage.tsx` sends
  `diamonds: 0` and no privileged value.
- Column UPDATE on the KYC, age, MFA and farming flags is revoked from the
  browser roles. No browser code in Club Arena or the World Hub writes them.

`20261005221203_dblink_leaves_the_schema_the_data_api_serves.sql`

- `ALTER EXTENSION dblink SET SCHEMA extensions`. The grants belong to
  `supabase_admin`, so they cannot be revoked by a migration; the extension is
  relocatable, and the Data API does not serve `extensions`.
- `fn_ca_ledger_refusal_record`, the one caller, is re-pointed at
  `extensions.dblink*` in the same transaction from its installed definition.

Both migrations assert their own result and abort if a step did nothing.

## Proof before install

Run against a scratch PostgreSQL 16 with the production grants, policies and
`fn_is_service_context` reproduced. Before: a player deleted its row and
re-inserted it as `god` with 1,000,000 diamonds, and set its own `kyc_status`.
After: the delete is `permission denied for table profiles`, a forged insert is
refused by name (`profiles.role is server-managed ...`), the signup-shaped
insert and an ordinary profile edit still succeed, server and service-role
inserts with VIP still succeed, and the refusal recorder still reaches dblink.
Re-applying the profile migration is harmless; re-applying the dblink migration
refuses itself.

## Not done here

The production `postgres` password is in this public repository's history
(commit `4edf94705`). Only a reset in the Supabase dashboard closes that, and
every secret that carries the connection string (`DATABASE_URL` in Actions, the
engine's environment) has to be updated with it.

Law: `tests/a-browser-cannot-forge-its-own-profile.law.test.ts`.
