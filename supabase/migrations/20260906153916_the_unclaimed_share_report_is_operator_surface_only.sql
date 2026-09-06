-- 20260906153916_the_unclaimed_share_report_is_operator_surface_only.sql
--
-- THE FILE FOR A MIGRATION THE DATABASE ALREADY HAS.
--
-- This is the exact SQL applied to production as version 20260906153916 on
-- 2026-09-06, written down after the fact because it had no file and
-- check-applied-migrations-are-recorded.mjs would have reported it as a gap
-- for ever. Its own header says why that matters: a Midway Union master reset
-- rebuilds from these files, and an applied migration with no file is a
-- hardening production has that the rebuild does not.
--
-- The same REVOKE/GRANT also lives inside
-- 20260906152640_an_unpayable_jackpot_share_is_parked_not_lost, folded in so a
-- rebuild never creates the function open even for an instant. So on a rebuild
-- this file is a no-op that re-asserts the state, which is the correct shape
-- for a record of what was actually run. A third, independent revoke of the
-- same function landed later as 20260906154044 (PR #3348) from a different
-- session that found the live grant before this one was written down; it is
-- idempotent with this and neither undoes the other.
--
-- THE ORIGINAL HEADER, VERBATIM, FOLLOWS.
--
-- THE UNCLAIMED-SHARE REPORT IS OPERATOR SURFACE, NOT PUBLIC
-- BBJ phase 2.3 follow-up, 2026-09-06.
--
-- fn_bbj_unclaimed_shares (added minutes ago in
-- 20260906152329_an_unpayable_jackpot_share_is_parked_not_lost) is SECURITY
-- DEFINER and so runs past RLS. Left with its default grants it would hand
-- every unclaimed jackpot share - user ids and amounts, across every club - to
-- any caller, including an unauthenticated one. It never asks who is calling.
--
-- scripts/ci/definer-authorization.mjs refused the push that first proposed it
-- and was right to: read-only is not the same as harmless.
--
-- A PLAYER does not need this function. The bbj_unclaimed_self_select policy on
-- the table already lets them read their OWN row. This is the operator view.
--
-- Verified before revoking: no RLS policy calls it, so nothing loses its SELECT.
-- PUBLIC is named as well as the roles because anon and authenticated inherit
-- whatever PUBLIC holds - revoking the roles alone reads as a fix and does
-- nothing. GRANT/REVOKE does not fire the schema-cache reload (CLAUDE.md 2.5).

BEGIN;

REVOKE ALL ON FUNCTION public.fn_bbj_unclaimed_shares() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_unclaimed_shares() TO service_role;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(grantee, ',') INTO v_bad
    FROM information_schema.role_routine_grants
   WHERE routine_name = 'fn_bbj_unclaimed_shares'
     AND grantee IN ('PUBLIC', 'anon', 'authenticated');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'fn_bbj_unclaimed_shares is still reachable by %', v_bad;
  END IF;
END $$;

COMMIT;
