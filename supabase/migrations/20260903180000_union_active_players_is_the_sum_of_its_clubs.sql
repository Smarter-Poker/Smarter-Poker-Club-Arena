-- 20260903180000_union_active_players_is_the_sum_of_its_clubs.sql
-- Dan 2026-09-03: "if shark club has 530 active and club jaqk has 526 active,
-- why is midway union showing 530 active? midway union 'active players' is a
-- combination of all active players inside all of the clubs."
--
-- The union count was count(DISTINCT user_id) across the whole union, so a
-- player who is a member of both Shark and JAQK counted once. Because the two
-- rosters overlap almost entirely, the union number collapsed to the larger
-- club's number (measured: Shark 500, JAQK 497, union 500).
--
-- The union card's MEMBERS figure is already the plain sum of its member
-- clubs' member counts (fn_batch_union_realtime_member_counts, over
-- union_clubs, no de-dup: 593 + 584 = 1177). ACTIVE now uses the same basis:
-- the sum of each member club's own active count, computed by the very same
-- function the club cards use, so the union card always equals the sum of the
-- club cards beneath it.
--
-- TIER 2 (replaces STABLE read-only functions; no schema change).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_batch_union_realtime_active_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  WITH member_clubs AS (
    SELECT uc.union_id, uc.club_id
      FROM public.union_clubs uc
     WHERE uc.union_id = ANY(p_union_ids)
  ),
  per_club AS (
    SELECT a.club_id, a.active_count
      FROM public.fn_batch_club_realtime_active_counts(
             (SELECT coalesce(array_agg(DISTINCT mc.club_id), '{}'::uuid[]) FROM member_clubs mc)
           ) a
  )
  SELECT requested.union_id,
         coalesce(sum(pc.active_count), 0)::bigint AS active_count
    FROM unnest(p_union_ids) requested(union_id)
    LEFT JOIN member_clubs mc ON mc.union_id = requested.union_id
    LEFT JOIN per_club pc ON pc.club_id = mc.club_id
   GROUP BY requested.union_id;
$function$;

-- Same definition for the reference function so "one definition" stays true.
CREATE OR REPLACE FUNCTION public.fn_union_active_player_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT * FROM public.fn_batch_union_realtime_active_counts(p_union_ids);
$function$;

REVOKE ALL ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[])
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) IS
  'Sum of each member club''s active-player count (fn_batch_club_realtime_active_counts) over union_clubs. Matches the union member count basis: a player in two clubs is two active players. Returns a row per requested union, zero included.';

-- Post-apply assertion: the union equals the sum of its member clubs' cards.
DO $assert$
DECLARE
  v_union uuid;
  v_union_active bigint;
  v_club_sum bigint;
BEGIN
  SELECT u.id INTO v_union
    FROM public.unions u
    ORDER BY coalesce(u.member_count, 0) DESC
    LIMIT 1;
  IF v_union IS NULL THEN RETURN; END IF;

  SELECT active_count INTO v_union_active
    FROM public.fn_batch_union_realtime_active_counts(ARRAY[v_union]);

  SELECT coalesce(sum(a.active_count), 0) INTO v_club_sum
    FROM public.fn_batch_club_realtime_active_counts(
           (SELECT coalesce(array_agg(uc.club_id), '{}'::uuid[])
              FROM public.union_clubs uc WHERE uc.union_id = v_union)
         ) a;

  RAISE NOTICE 'union % active=% sum_of_clubs=%', v_union, v_union_active, v_club_sum;

  IF coalesce(v_union_active, -1) <> v_club_sum THEN
    RAISE EXCEPTION 'union active (%) is not the sum of its clubs (%)', v_union_active, v_club_sum;
  END IF;
END;
$assert$;

COMMIT;
