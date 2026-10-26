-- 20261026050506_test_staff_accounts_leave_the_real_clubs.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Dan, 2026-10-26: "REMOVE ANY AND ALL 'STAFF MEMBERS' I HAVEN'T CREATED ANY,
-- ITS ONLY ME FOR KINGS CLUB".
--
-- WHAT WAS WRONG (read from production 2026-10-26)
--
-- Every staff member in KINGS CLUB, Deep Stack Society and Midway Union was a
-- post-deploy verification identity (PostDeployxxxxx,
-- ca-customization-cert-postdeploy-*@example.invalid): 14 admins in KINGS CLUB,
-- 14 in Deep Stack Society, 11 in Midway Union, created 2026-10-23 to
-- 2026-10-25, all zero balance and unseated. No real person held a staff role
-- in any of the three. Post-Deploy E2E makes one zero-balance admin per run
-- and removes it through cleanup_reserved_certification_account; on these 14
-- runs that door refused (CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_
-- CUSTODY, e.g. run 40208304104 at 16:59:54 UTC on 2026-10-25) and nothing
-- removed the membership afterwards.
--
-- 20261026031314 (members with no agent sit under the club owner) then made
-- the door refuse EVERY future run: a fresh test member now joins under the
-- club owner, and the door read any agent_id as authority. That is fixed here
-- at its cause, in two places:
--   1. The door treats an upline that is the club owner as no authority. A
--      real agent or a parent agent is still refused exactly as before.
--   2. scripts/ci/production-e2e-account.mjs clears agent_id when it promotes
--      the test identity to admin: staff sit under no agent (the same reason
--      20261026031314 left staff out of its settlement), which is also what
--      scripts/ci/qualify-agent-boundary.mjs asserts of its starting row.
--
-- THE STAFF ALREADY LEFT BEHIND
--
-- For each live post-deploy identity with a membership in one of the three
-- clubs, in this transaction:
--   - 11 go through cleanup_reserved_certification_account itself, the door
--     the run would have used. Every one of them is an immutable-ledger actor,
--     so the door removes its zero-chip staff memberships and answers
--     auth_soft_delete_required: the sign-in itself is retired through the
--     Auth API by the next stale-account sweep, exactly as for a run that
--     completes (scripts/ci/production-e2e-account.mjs).
--   - 3 the door still refuses for reasons that are not about staff
--     (PostDeploy40f5d and PostDeploy5983a own an unretired Crest Cert
--     Template club; PostDeploy0e54b holds a half-made pending player row in
--     Midway Union). Their memberships in the three clubs are departed through
--     the lifecycle departure write, as an account deletion departs them: the
--     rows stay for the journals and are no longer members of anything.
-- Probed in a rolled-back transaction on 2026-10-26: no refusal, zero staff
-- left in KINGS CLUB. KingFish's owner row is not touched by anything here.
--
-- One function, one transaction: one schema reload. No money moves.
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.cleanup_reserved_certification_account(uuid)'))) = 'b3354b7c9a3854dd8cd743701b3b0696'
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id WHERE m.club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 'fade0000-0000-0000-0000-000000000001'::uuid) AND m.role IN ('admin', 'co_owner') AND m.membership_lifecycle_status = 'active' AND coalesce(m.status, 'approved') IN ('active', 'approved') AND p.email LIKE 'ca-customization-cert-postdeploy-%@example.invalid' AND m.joined_at < '2026-10-26 05:05:06+00')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

DO $test_staff_accounts_leave_the_real_clubs$
DECLARE
  v_fn regprocedure;
  v_new text;
  r record;
  v_result jsonb;
  v_door integer := 0;
  v_departed integer := 0;
  v_rows integer;
  v_left integer;
BEGIN
  -- 1. The cleanup door: an upline that is the club owner is not authority.
  v_fn := to_regprocedure('public.cleanup_reserved_certification_account(uuid)');
  IF v_fn IS NULL OR md5(pg_get_functiondef(v_fn)) <> '793d42fa3e4ac6f53f45fa9afd4d455e' THEN
    RAISE EXCEPTION 'TEST_STAFF_PREIMAGE_CHANGED: %', 'public.cleanup_reserved_certification_account(uuid)' USING ERRCODE = '55000';
  END IF;
  v_new := replace(replace(pg_get_functiondef(v_fn),
$cleanup_old0$                        OR agent_id IS NOT NULL OR parent_agent_id IS NOT NULL
                        OR NOT (
$cleanup_old0$,
$cleanup_new0$                        OR (agent_id IS NOT NULL AND agent_id IS DISTINCT FROM
                            (SELECT c.owner_id FROM public.clubs c WHERE c.id = club_members.club_id))
                        OR parent_agent_id IS NOT NULL
                        OR NOT (
$cleanup_new0$),
$cleanup_old1$                      OR agent_id IS NOT NULL OR parent_agent_id IS NOT NULL)) THEN
$cleanup_old1$,
$cleanup_new1$                      OR (agent_id IS NOT NULL AND agent_id IS DISTINCT FROM
                          (SELECT c.owner_id FROM public.clubs c WHERE c.id = club_members.club_id))
                      OR parent_agent_id IS NOT NULL)) THEN
$cleanup_new1$);
  IF md5(v_new) <> 'b3354b7c9a3854dd8cd743701b3b0696' THEN
    RAISE EXCEPTION 'TEST_STAFF_PATCH_MISMATCH: %', 'public.cleanup_reserved_certification_account(uuid)' USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> 'b3354b7c9a3854dd8cd743701b3b0696' THEN
    RAISE EXCEPTION 'TEST_STAFF_INSTALL_MISMATCH: %', 'public.cleanup_reserved_certification_account(uuid)' USING ERRCODE = '55000';
  END IF;

  -- 2. The test identities already left in the three clubs.
  FOR r IN
    SELECT p.id, p.username
      FROM public.profiles p
      JOIN auth.users u ON u.id = p.id
     WHERE p.email LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
       AND u.deleted_at IS NULL AND p.status IS DISTINCT FROM 'deleted'
       AND NOT coalesce(p.is_horse, false) AND NOT coalesce(p.is_admin, false)
       AND p.created_at < '2026-10-26 05:05:06+00'
       AND EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.user_id = p.id AND m.membership_lifecycle_status = 'active'
                      AND m.club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 'fade0000-0000-0000-0000-000000000001'::uuid))
     ORDER BY p.created_at, p.id
  LOOP
    IF r.username IN ('PostDeploy40f5d', 'PostDeploy5983a', 'PostDeploy0e54b') THEN
      PERFORM set_config('app.club_membership_lifecycle_write', 'depart', true);
      UPDATE public.club_members m
         SET status = 'suspended', is_active = false,
             membership_lifecycle_status = 'departed',
             departed_at = clock_timestamp(),
             departure_reason = 'Test Account Retired',
             updated_at = clock_timestamp()
       WHERE m.user_id = r.id AND m.membership_lifecycle_status = 'active'
         AND m.club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 'fade0000-0000-0000-0000-000000000001'::uuid)
         AND coalesce(m.chip_balance, 0) = 0 AND coalesce(m.promo_balance, 0) = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      PERFORM set_config('app.club_membership_lifecycle_write', '', true);
      v_departed := v_departed + v_rows;
    ELSE
      v_result := public.cleanup_reserved_certification_account(r.id);
      IF coalesce(v_result ->> 'success', '') <> 'true'
         AND coalesce(v_result ->> 'reason', '') <> 'auth_soft_delete_required' THEN
        RAISE EXCEPTION 'TEST_STAFF_CLEANUP_REFUSED: % %', r.username, v_result USING ERRCODE = '55000';
      END IF;
      v_door := v_door + 1;
    END IF;
  END LOOP;

  IF v_door < 11 OR v_departed < 7 THEN
    RAISE EXCEPTION 'TEST_STAFF_UNEXPECTED: door % departed %', v_door, v_departed USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_left
    FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
   WHERE m.club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 'fade0000-0000-0000-0000-000000000001'::uuid)
     AND m.role IN ('admin', 'co_owner')
     AND m.membership_lifecycle_status = 'active'
     AND coalesce(m.status, 'approved') IN ('active', 'approved')
     AND p.email LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
     AND p.created_at < '2026-10-26 05:05:06+00';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'TEST_STAFF_LEFT: %', v_left USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'test_staff_accounts_leave_the_real_clubs: % through the door, % memberships departed', v_door, v_departed;
END
$test_staff_accounts_leave_the_real_clubs$;

COMMIT;
