-- 20261018191523_a_union_counts_each_member_once.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-18, with the four carousel cards: Midway Union read 1,480
-- MEMBERS and 665 ACTIVE while its three clubs read 523 / 419 / 538 members
-- and roughly 1,075 active between them, and the two halves of the union card
-- did not agree with each other or with the clubs.
--
-- Measured on production 2026-10-18 19:1x UTC:
--   * 1,480 club_members rows across Club JAQK, Deep Stack Society and Shark
--     Club, but only 954 DISTINCT people. 522 people (518 of them horses) hold
--     a membership in BOTH Club JAQK and Shark Club, because a Midway Union
--     table is bought into from either wallet; 2 more hold Deep Stack + Shark
--     and 1 holds all three.
--   * fn_batch_union_realtime_active_counts already counts DISTINCT people on
--     the union floor (663 at the time), and every one of them is a member of
--     a member club. So the union ACTIVE figure was right, and the club cards
--     cannot be added up: JAQK and Shark each show the same ~520 dual members.
--   * fn_batch_union_realtime_member_counts was `count(cm.user_id)`: one count
--     per membership ROW, so a person in two member clubs was two members.
--     That is the defect. It also fed fn_club_level_for_members via the union
--     level refresh, so the union's level was computed from a doubled count.
--
-- The fix is the counting line itself: count(DISTINCT cm.user_id). Same
-- signature, same callers (HomePage carousel, union level refresh, community
-- search), same membership filter. Horses count exactly as humans do (10.5);
-- nothing is filtered, a person is simply counted once.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_batch_union_realtime_member_counts(p_union_ids uuid[])
 RETURNS TABLE(union_id uuid, member_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  -- One person is one member, however many of the union's clubs they belong
  -- to (2026-10-18). Counting rows counted a JAQK + Shark member twice.
  SELECT requested.union_id, count(DISTINCT cm.user_id)::bigint
    FROM unnest(p_union_ids) requested(union_id)
    LEFT JOIN public.union_clubs uc ON uc.union_id = requested.union_id
    LEFT JOIN public.club_members cm ON cm.club_id = uc.club_id
      AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
   GROUP BY requested.union_id;
$function$;

COMMIT;
