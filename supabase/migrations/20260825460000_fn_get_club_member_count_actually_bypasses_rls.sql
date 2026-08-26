-- ═══════════════════════════════════════════════════════════════════════════════
--  A FUNCTION WHOSE ENTIRE PURPOSE IS TO BYPASS RLS, WHICH DID NOT BYPASS RLS
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- fn_get_club_member_count was declared STABLE but NOT SECURITY DEFINER, so it
-- ran with the caller's privileges and every club_members SELECT policy applied
-- inside it. Its only caller, ClubsService.getLiveMemberCount, describes it in a
-- comment as:
--
--   "Source A: SECURITY DEFINER RPC (bypasses RLS - authoritative)"
--
-- It was neither. MEASURED against a 588-member club, as a real authenticated
-- user who is not a member, not an admin, not the owner and not a union
-- overseer - which is to say, anybody browsing a club they have not joined:
--
--   direct RLS count ............... 0
--   fn_get_club_member_count ....... 0     <- the "authoritative" source
--   fn_batch_club_member_counts .. 588     <- its SECURITY DEFINER sibling
--   true count ................... 588
--
-- This is the SAME defect the 2026-07-24 note in ClubsService.ts describes -
-- "the featured Shark Club card showed 1 member for a 578-member club" - and the
-- fix written for it never worked. getLiveMemberCount takes a MAX across three
-- sources, so the visible behaviour has been carried entirely by source B, the
-- denormalised clubs.member_count column, which that same note calls "last
-- resort (may be stale)". The accurate source returned 0 from the day it was
-- written and nothing said so, because MAX() hides a zero perfectly.
--
-- Two sibling functions doing one job with one of them silently wrong is the
-- same shape of defect as two copies of a statistic. This makes it match what it
-- claims and what its sibling already does.
--
-- IT IS ALSO ~370x FASTER, which is a side effect rather than the point. The
-- RLS filter on club_members evaluates SECURITY DEFINER policy functions per
-- row, and SECURITY DEFINER functions cannot be inlined by the planner. As the
-- club owner, who can see all 588 rows, averaged over five alternating runs:
--
--   direct count ................. 204.61 ms
--   fn_get_club_member_count ......  0.55 ms
--
-- pg_stat_statements had that direct-count statement shape at a 253 ms mean over
-- 591 calls with a 1,882 ms worst case - 150 seconds of database time - and it
-- returns ONE row per call, because PostgREST also computes an exact count(*)
-- over the same predicate for the pagination header.
--
-- NO NEW EXPOSURE. fn_batch_club_member_counts is already SECURITY DEFINER,
-- already granted to `authenticated`, and already returns this exact number for
-- an arbitrary array of club ids. Active member count is shown publicly on club
-- cards. This closes an inconsistency; it does not open a door.
--
-- search_path stays pinned, which is the property that actually matters once a
-- function is SECURITY DEFINER.

CREATE OR REPLACE FUNCTION public.fn_get_club_member_count(p_club_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT COUNT(*)
  FROM club_members
  WHERE club_id = p_club_id
    AND (status IS NULL OR status IN ('active', 'approved'));
$function$;

REVOKE ALL ON FUNCTION public.fn_get_club_member_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_get_club_member_count(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_get_club_member_count(uuid) TO authenticated, service_role;

DO $$
DECLARE v_secdef boolean;
BEGIN
  SELECT p.prosecdef INTO v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_get_club_member_count';

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'fn_get_club_member_count is still not SECURITY DEFINER; it will keep returning 0 to non-members.';
  END IF;

  -- It must agree with its sibling on EVERY club, or the disagreement has simply
  -- been moved rather than removed.
  IF EXISTS (
    SELECT 1
    FROM (SELECT club_id FROM club_members GROUP BY club_id) c
    WHERE fn_get_club_member_count(c.club_id)
          IS DISTINCT FROM (SELECT b.member_count
                              FROM fn_batch_club_member_counts(ARRAY[c.club_id]) b)
  ) THEN
    RAISE EXCEPTION 'fn_get_club_member_count disagrees with fn_batch_club_member_counts on at least one club.';
  END IF;
END $$;
