-- 20260910191452_the_open_day_writer_restates_the_door_it_was_already_behind.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE OPEN-DAY WRITER RESTATES THE DOOR IT WAS ALREADY BEHIND.
--
-- fn_ca_daily_bonus_open_day is SECURITY DEFINER, it INSERTs the player's day
-- row, and it derives nothing from auth.uid(): its actor is the p_user_id it
-- is handed. That is correct for what it is - an internal helper that
-- fn_ca_daily_bonus_status and fn_ca_daily_bonus_claim call after THEY have
-- established who is asking - and it is exactly the shape
-- check-definer-authorization refuses when a browser role can reach it,
-- because a caller-supplied id is a caller-supplied answer.
--
-- A browser has never been able to reach it. The phase 1 ledger
-- (20260907234436_the_daily_club_arena_bonus_has_a_ledger) revoked it from
-- PUBLIC, anon and authenticated and granted it to service_role alone, and
-- CREATE OR REPLACE FUNCTION does not reset privileges, so the phase 3
-- rewrite (20260910181625) inherited that ACL untouched. Verified on
-- production after that migration applied: {postgres=X/postgres,
-- service_role=X/postgres} - no anon, no authenticated, no PUBLIC.
--
-- So this changes no privilege. What it changes is where the closure is
-- WRITTEN DOWN. The rule the gate enforces reads the newest declaration of a
-- function, and the newest declaration lives in 20260910181625, which restates
-- the body without restating the door. That is a real gap in the record even
-- though it is not a gap in the database: the next agent to CREATE OR REPLACE
-- this function reads that file, sees a definer writer with no ACL statement
-- beside it, and has nothing telling them the function is closed. Two lines of
-- SQL that are a no-op today are cheaper than that.
--
-- GRANT and REVOKE do not fire pgrst_ddl_watch, so this reloads no schema
-- cache (production DDL policy, rule 5).

BEGIN;

REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date) TO service_role;

COMMENT ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date) IS
  'Internal. Opens (or returns) one player''s day row for the Daily Club Arena Bonus: streak, cycle day, tile snapshot, and the shield spend when exactly one day was missed. SECURITY DEFINER and trusts p_user_id, so it is service_role only - callers (fn_ca_daily_bonus_status, fn_ca_daily_bonus_claim) establish the actor from auth.uid() before calling it. Never grant this to anon or authenticated.';

COMMIT;
