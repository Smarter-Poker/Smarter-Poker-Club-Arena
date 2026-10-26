-- 20261024220826_an_infinite_ban_breaks_list_users.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- One auth.users row holds banned_until = 'infinity', and GoTrue cannot read
-- it. Postgres returns a non-finite timestamptz as the string "infinity", and
-- GoTrue scans banned_until into a Go time.Time, so every GET /admin/users
-- page fails with HTTP 500 for every caller in the project:
--
--   unable to fetch records: sql: Scan error on column index 1, name
--   "banned_until": unsupported Scan, storing driver.Value type string into
--   type *time.Time
--
-- The row is 0021dadd-59e8-41b7-9b11-a5a6e9975b76, a post-deploy customization
-- certification fixture (ca-customization-cert-postdeploy-...@example.invalid)
-- created 2026-10-23 18:14Z. The value was written between 18:22:35Z (its last
-- sign-in, and its updated_at) and 18:38:29Z (the first 500), by a direct SQL
-- write: GoTrue's own ban_duration only ever writes a finite time, and no
-- function, trigger or tracked script writes banned_until. It is the only
-- non-finite timestamp among 3,662 users (read-only, 2026-10-24 22:08Z).
--
-- Effect: Club Create Certification failed 59 runs in a row from 18:38Z
-- ("Legacy Certificate Inventory Failed: Database error finding users"), and
-- every other listUsers caller in the estate failed with it.
--
-- The ban is kept, in the finite form GoTrue itself writes for a permanent
-- ban (876000 hours, as operations/release/fixture/auth-fixture.mjs uses), so
-- the fixture still cannot sign in. Same shape as
-- 20260901013451_20260831_the_system_row_breaks_list_users. Nothing else is
-- touched. The cause is pinned by
-- tests/no-auth-user-timestamp-is-infinite.law.test.ts, which refuses any
-- tracked SQL that writes a non-finite time into an auth.users column.
--
-- Data only: no DDL, so no schema-cache reload and no break-window refusal.
--
-- @live-proof: NOT EXISTS (SELECT 1 FROM auth.users WHERE (banned_until IS NOT NULL AND NOT isfinite(banned_until)) OR (created_at IS NOT NULL AND NOT isfinite(created_at)) OR (updated_at IS NOT NULL AND NOT isfinite(updated_at)) OR (last_sign_in_at IS NOT NULL AND NOT isfinite(last_sign_in_at)))

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $finite_ban$
DECLARE
  v_fixed integer;
BEGIN
  UPDATE auth.users
     SET banned_until = now() + interval '876000 hours'
   WHERE banned_until IS NOT NULL
     AND NOT isfinite(banned_until);
  GET DIAGNOSTICS v_fixed = ROW_COUNT;

  -- Measured: exactly one row. More would mean another writer has been at
  -- work since this was read, and that is a reason to stop and look.
  IF v_fixed > 1 THEN
    RAISE EXCEPTION 'expected at most one non-finite banned_until, found %', v_fixed;
  END IF;

  IF EXISTS (
    SELECT 1 FROM auth.users
     WHERE (banned_until IS NOT NULL AND NOT isfinite(banned_until))
        OR (created_at IS NOT NULL AND NOT isfinite(created_at))
        OR (updated_at IS NOT NULL AND NOT isfinite(updated_at))
        OR (last_sign_in_at IS NOT NULL AND NOT isfinite(last_sign_in_at))
  ) THEN
    RAISE EXCEPTION 'POST-APPLY: auth.users still holds a non-finite timestamp GoTrue cannot scan';
  END IF;
END
$finite_ban$;

COMMIT;
