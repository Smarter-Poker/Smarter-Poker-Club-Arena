-- ═══════════════════════════════════════════════════════════════════════════
--  THE RESTRICTION HELPERS STOP ANSWERING A CALLER WITH NO ACCOUNT
--  Found by the phase 7 gate of the Club Operations upgrade, 2026-09-05.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `scripts/ci/audit-live-definer-exposure.mjs` asks production which
-- SECURITY DEFINER functions `anon` can execute. It is red, with three
-- findings, and one of them hands a moderation record to the open internet.
--
-- PROVED AGAINST PRODUCTION with nothing but the publishable key - no session,
-- no user:
--
--     POST /rest/v1/rpc/fn_ca_player_restricted       200  false
--     POST /rest/v1/rpc/fn_ca_player_restriction_for  200  {"id":null,"user_id":null,
--          "scope":null,"reason_code":null,"reason_note":null,"status":null,
--          "applied_by":null,"applied_at":...}
--     GET  /rest/v1/ca_player_restrictions            200  []
--
-- The TABLE is safe: RLS is on and it carries no policy, so a direct read
-- returns nothing to anybody. The definer helpers are the way around it, and
-- `fn_ca_player_restriction_for` RETURNS THE WHOLE ROW - `reason_code`,
-- `reason_note`, `applied_by`, `applied_at`, `expires_at` - for any user id
-- the caller cares to type.
--
-- Nothing leaks TODAY only because `ca_player_restrictions` has zero rows. The
-- first time an operator restricts a player, anyone on the internet can read
-- who did it, why, and until when, by guessing nothing more than a uuid that
-- appears in public leaderboards.
--
-- NOTHING LEGITIMATE LOSES ACCESS. The only caller of either helper anywhere -
-- repo, client, engine - is `fn_ca_refuse_restricted_entry`, the trigger
-- function behind `zz_restriction_seat_guard`, `zz_restriction_seat_revive_guard`
-- and `zz_restriction_tourney_guard`. That function is itself SECURITY DEFINER
-- and owned by `postgres`, so its nested calls run as the owner and the
-- CALLER's grant is never consulted. No client file references either name;
-- neither appears in any RLS policy expression (checked against `pg_policy`,
-- which is the trap the audit's own guidance warns about).
--
-- AND A THIRD, WHICH IS A DIFFERENT MISTAKE WORTH NAMING.
-- `fn_club_member_count(uuid)` is also anon-executable, and its own migration
-- (`20260902203325_the_club_home_count_was_costing_a_quarter_of_the_database`)
-- says plainly that it should not be:
--
--     REVOKE ALL ON FUNCTION public.fn_club_member_count(uuid) FROM PUBLIC;
--     GRANT EXECUTE ON FUNCTION public.fn_club_member_count(uuid)
--       TO authenticated, service_role;
--
-- That REVOKE names PUBLIC and only PUBLIC, and **revoking PUBLIC does not
-- remove a direct grant to `anon`**. An earlier definition had granted anon
-- outright, so the intended fix read as done and changed nothing. It is the
-- mirror of the trap the audit prints in its own guidance ("revoking anon
-- alone reads as a fix and does nothing" - the same sentence, the other way
-- round). This migration carries out that migration's stated intent. The
-- client calls `fn_club_member_countS` (plural, a different function); the
-- singular has no caller in this repo or the World Hub.
--
-- A grant change fires no `pgrst_ddl_watch` reload (CLAUDE.md section 2,
-- rule 5), so this costs the platform nothing.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';

-- PUBLIC is named alongside anon in every one of these, because anon inherits
-- whatever PUBLIC holds and revoking one without the other is the failure that
-- put `fn_club_member_count` on this list in the first place.

-- Reached only by a SECURITY DEFINER trigger owned by postgres.
REVOKE ALL ON FUNCTION public.fn_ca_player_restricted(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_player_restricted(uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_player_restriction_for(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_player_restriction_for(uuid, text)
  TO service_role;

-- Carrying out 20260902203325's stated intent, not changing it.
REVOKE ALL ON FUNCTION public.fn_club_member_count(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_member_count(uuid)
  TO authenticated, service_role;

DO $$
DECLARE
  r        record;
  v_closed int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_ca_player_restricted',
                         'fn_ca_player_restriction_for',
                         'fn_club_member_count')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% still answers a caller with no account', r.proname;
    END IF;
    v_closed := v_closed + 1;
  END LOOP;

  IF v_closed <> 3 THEN
    RAISE EXCEPTION 'expected to close three doors, found % of them', v_closed;
  END IF;

  -- The guard that DOES need to keep working: its trigger function is the
  -- only caller, and it must still be able to reach both helpers. It is
  -- SECURITY DEFINER owned by postgres, so this is what that means in
  -- practice - assert it rather than trusting the sentence.
  IF NOT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'fn_ca_refuse_restricted_entry')
  THEN
    RAISE EXCEPTION 'the restriction guard is not SECURITY DEFINER, so revoking the helpers just broke seating';
  END IF;

  IF NOT has_function_privilege('postgres', 'public.fn_ca_player_restriction_for(uuid, text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'the owner cannot reach the helper its own trigger calls';
  END IF;
END $$;

COMMIT;
