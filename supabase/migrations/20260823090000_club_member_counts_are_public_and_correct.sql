-- 20260823090000_club_member_counts_are_public_and_correct.sql
--
-- fn_batch_club_member_counts returned the WRONG NUMBER to almost every user,
-- and was the third most expensive statement on the instance.
--
-- THE BUG
-- The function was SECURITY INVOKER, so RLS on club_members applied to the
-- COUNT. club_members carries eight OR'd policies, and the only one a plain
-- player matches is "Members can read own club memberships"
-- (auth.uid() = user_id) - which is exactly one row. Measured on production as
-- a real player (753e81a9, role 'player' in SHARK CLUB):
--
--   club                shown   actual
--   Club JAQK             1      584
--   SHARK CLUB            1      588
--   Midway Union      (absent)   328
--
-- Every ordinary player browsing clubs saw "1 member" on every club card, and
-- clubs they are not in vanished from the result entirely. ClubsService.ts:518
-- explicitly overrides the stored clubs.member_count with this value
-- ("Override stale member_count with live count"), so the correct number that
-- was already on screen got replaced by 1. Same for ClubDetailPage,
-- ClubCarouselPage and the two UnionService rollups, which sum these per-club
-- counts into a union total.
--
-- THE COST
-- 809 calls at a mean of 188.9 ms in a 30-minute window. The scan itself is
-- 1.3 ms; the other ~187 ms is eight policies, several of them calling
-- functions (is_club_admin, fn_is_agent_of_player, fn_union_oversees_club) or
-- running an EXISTS against clubs, evaluated PER ROW over 1,500 rows.
--
-- WHY SECURITY DEFINER IS SAFE HERE, AND NOT A WIDENING
-- The true counts are ALREADY public. The same player, in the same session,
-- can read clubs.member_count directly and gets 584 / 328 / 588 - verified on
-- production. This function returns the identical fact from the identical rows,
-- so definer rights expose nothing that is not already one SELECT away. What
-- changes is only that the number stops being wrong.
--
-- Execute grants are UNCHANGED (anon, authenticated, service_role, as before).
-- Nothing else about the signature, the status filter, or the shape moves.
--
-- MEASURED AFTER, as the same player: 588 / 584 / 328, and 188.9 ms -> 3.1 ms.

CREATE OR REPLACE FUNCTION public.fn_batch_club_member_counts(p_club_ids uuid[])
RETURNS TABLE(club_id uuid, member_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT cm.club_id, COUNT(*) AS member_count
  FROM club_members cm
  WHERE cm.club_id = ANY(p_club_ids)
    AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
  GROUP BY cm.club_id;
$function$;

-- Restate the grants explicitly so a future CREATE OR REPLACE cannot silently
-- inherit something wider.
REVOKE ALL ON FUNCTION public.fn_batch_club_member_counts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_batch_club_member_counts(uuid[]) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_batch_club_member_counts(uuid[]) IS
  'Live member counts for club cards. SECURITY DEFINER on purpose: under RLS a plain player could only count their own row and saw "1" on every club (2026-08-23). The same counts are already public via clubs.member_count.';

-- Post-apply assertions. The definer path must return the TRUE counts, and it
-- must return them for a club the caller is not a member of, since that is the
-- browsing case that was broken.
DO $assert$
DECLARE
  v_true_shark  bigint;
  v_true_midway bigint;
  v_got_shark   bigint;
  v_got_midway  bigint;
  v_rows        int;
BEGIN
  SELECT count(*) INTO v_true_shark FROM club_members
   WHERE club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
     AND (status IS NULL OR status IN ('active','approved'));
  SELECT count(*) INTO v_true_midway FROM club_members
   WHERE club_id = 'fade0000-0000-0000-0000-000000000001'
     AND (status IS NULL OR status IN ('active','approved'));

  SELECT count(*) INTO v_rows
    FROM public.fn_batch_club_member_counts(
      ARRAY['a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
            'fade0000-0000-0000-0000-000000000001']::uuid[]);
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'expected a row per club, got %', v_rows;
  END IF;

  SELECT member_count INTO v_got_shark
    FROM public.fn_batch_club_member_counts(ARRAY['a41434bb-8d0c-400a-8f0d-e8b3d65afed4']::uuid[]);
  SELECT member_count INTO v_got_midway
    FROM public.fn_batch_club_member_counts(ARRAY['fade0000-0000-0000-0000-000000000001']::uuid[]);

  IF v_got_shark IS DISTINCT FROM v_true_shark THEN
    RAISE EXCEPTION 'shark count wrong: got % expected %', v_got_shark, v_true_shark;
  END IF;
  IF v_got_midway IS DISTINCT FROM v_true_midway THEN
    RAISE EXCEPTION 'midway count wrong: got % expected %', v_got_midway, v_true_midway;
  END IF;

  IF NOT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='fn_batch_club_member_counts') THEN
    RAISE EXCEPTION 'function is not SECURITY DEFINER';
  END IF;
END $assert$;

-- ROLLBACK (restores the bug - do not use)
--   CREATE OR REPLACE FUNCTION public.fn_batch_club_member_counts(p_club_ids uuid[])
--   RETURNS TABLE(club_id uuid, member_count bigint)
--   LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public','extensions'
--   AS $f$ SELECT cm.club_id, COUNT(*) FROM club_members cm
--          WHERE cm.club_id = ANY(p_club_ids)
--            AND (cm.status IS NULL OR cm.status IN ('active','approved'))
--          GROUP BY cm.club_id; $f$;
