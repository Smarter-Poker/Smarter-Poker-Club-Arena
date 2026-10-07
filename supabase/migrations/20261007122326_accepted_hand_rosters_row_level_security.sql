-- 20261007122326_accepted_hand_rosters_row_level_security.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Horse Brain Phase 14.2/14.3. smarter_private.accepted_hand_rosters
-- (migration 20261007024757) was created owner-only with every privilege
-- revoked from PUBLIC, anon, authenticated and service_role, but without row
-- level security. Every other private source the horse readers use
-- (smarter_private.hand_submissions, the three horse_commitment_* tables)
-- carries RLS as a second layer, and the P14.3 migration 20261007075304
-- refuses to install until all of them do
-- (horse_commitment_selection_private_schema_required, read from its apply
-- run at 2026-10-07T12:21:30Z; that transaction rolled back and changed
-- nothing).
--
-- This enables RLS on the table with no policies. Nothing else changes:
--   * its only writer is the settlement door, a SECURITY DEFINER function
--     owned by postgres, the table owner; an owner is not subject to its
--     table's RLS unless FORCE ROW LEVEL SECURITY is set, and it is not set
--     here, so every first-acceptance insert behaves exactly as before;
--   * its readers are the P14.3 SECURITY DEFINER readers, owned by postgres;
--   * no API role has any privilege on it, before or after.
-- The immutability guard trigger, the grants and the rows are untouched.
--
-- One ALTER TABLE in one transaction: one schema-cache reload. lock_timeout
-- keeps the brief ACCESS EXCLUSIVE lock from ever queueing settlement inserts
-- behind it for more than two seconds; a timeout rolls back and is retried
-- once by hand, never in a loop.
--
-- @live-proof: (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('smarter_private.accepted_hand_rosters'))

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $guard$
BEGIN
  IF to_regclass('smarter_private.accepted_hand_rosters') IS NULL THEN
    RAISE EXCEPTION 'smarter_private.accepted_hand_rosters is not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'smarter_private.accepted_hand_rosters'::regclass
       AND relkind = 'r'
       AND pg_get_userbyid(relowner) = 'postgres'
       AND NOT relrowsecurity
       AND NOT relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'smarter_private.accepted_hand_rosters is not the expected owner-only table without RLS';
  END IF;
END
$guard$;

ALTER TABLE smarter_private.accepted_hand_rosters ENABLE ROW LEVEL SECURITY;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'smarter_private.accepted_hand_rosters'::regclass
       AND relrowsecurity AND NOT relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'accepted_hand_rosters RLS postimage not reached';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
     WHERE has_table_privilege(r, 'smarter_private.accepted_hand_rosters',
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
  ) THEN
    RAISE EXCEPTION 'accepted_hand_rosters API-role privilege appeared';
  END IF;
END
$post$;

COMMIT;
