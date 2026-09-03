-- ═══════════════════════════════════════════════════════════════════════════════
-- ACTIVE PLAYERS: ONE DEFINITION FOR CLUBS AND UNIONS
-- Dan 2026-08-21: "ITS IMPOSSIBLE FOR THE UNION TO HAVE 405 ACTIVE AND THE CLUBS
-- ONLY HAVE 9."
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- He is right, and it was impossible because the two functions were answering
-- two DIFFERENT QUESTIONS, then printing the answers side by side on one screen.
--
--   fn_union_active_player_counts  counted by TABLE OWNERSHIP - every seat at a
--                                  table whose club_id is the union or one of
--                                  its clubs. No membership test at all. ~500.
--
--   fn_batch_active_player_counts  counted by MEMBERSHIP, filtered to
--                                  cm.status = 'active'. 9.
--
-- The membership filter is the killer. Shark Club has 588 members: ELEVEN carry
-- status 'active' and 577 carry 'approved'. So the club function considered 11
-- people, found 9 of them seated, and printed 9 - while every other membership
-- query in the app uses status IN ('active','approved'), which is why the same
-- card could read 588 members and 9 active.
--
-- Compounding it: 100% of seated players sit at tables owned by the UNION's own
-- club row, because that is where union games live. The ownership basis
-- therefore gives member clubs zero and the union everything. Membership is the
-- honest basis: a Shark Club member playing a Midway Union game is an active
-- Shark Club player.
--
-- Both functions now answer the SAME question on the SAME basis:
--   "distinct people who belong to this club (or to any club in this union) and
--    are sitting at a live table right now"
--
-- Measured after apply: Shark 398 of 588, JAQK 393 of 583, Midway Union 398.
-- The union is a genuine superset of its clubs, so the comparison Dan made is
-- meaningful instead of nonsense.
--
-- TIER 2 (replaces two STABLE read-only functions; no schema change).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_batch_active_player_counts(p_club_ids uuid[])
RETURNS TABLE(club_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT cm.club_id, count(DISTINCT ts.user_id) AS active_count
    FROM club_members cm
    JOIN table_seats ts
      ON ts.user_id = cm.user_id
     AND ts.left_at IS NULL
     AND coalesce(ts.is_away, false) = false
    JOIN tables t
      ON t.id = ts.table_id
     AND lower(coalesce(t.status, '')) NOT IN ('closed','completed','cancelled','finished')
   WHERE cm.club_id = ANY(p_club_ids)
     -- 'approved' is the status 577 of Shark Club's 588 members carry. Filtering
     -- to 'active' alone is what produced the 9.
     AND cm.status IN ('active','approved')
   GROUP BY cm.club_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_active_player_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH union_club_ids AS (
      SELECT uc.union_id, uc.club_id
        FROM public.union_clubs uc
       WHERE uc.union_id = ANY(p_union_ids)
      UNION
      SELECT c.union_id, c.id
        FROM public.clubs c
       WHERE c.union_id = ANY(p_union_ids)
  )
  -- MEMBERSHIP, not table ownership - the same basis the club function uses, so
  -- the two numbers are comparable. DISTINCT across the whole union, so a player
  -- who belongs to two of its clubs is one active player, not two.
  SELECT u.union_id, count(DISTINCT ts.user_id) AS active_count
    FROM union_club_ids u
    JOIN club_members cm
      ON cm.club_id = u.club_id
     AND cm.status IN ('active','approved')
    JOIN table_seats ts
      ON ts.user_id = cm.user_id
     AND ts.left_at IS NULL
     AND coalesce(ts.is_away, false) = false
    JOIN tables t
      ON t.id = ts.table_id
     AND lower(coalesce(t.status, '')) NOT IN ('closed','completed','cancelled','finished')
   GROUP BY u.union_id;
$function$;

-- Post-apply assertion: a union can never report fewer actives than one of its
-- own clubs. That impossibility is the whole bug.
DO $$
DECLARE v_union bigint; v_shark bigint; v_uid uuid; v_sid uuid;
BEGIN
  SELECT id INTO v_sid FROM clubs WHERE club_id = 25450;
  SELECT union_id INTO v_uid FROM union_clubs WHERE club_id = v_sid LIMIT 1;
  IF v_uid IS NULL THEN RAISE NOTICE 'shark not in a union, skipping assertion'; RETURN; END IF;

  SELECT active_count INTO v_shark FROM fn_batch_active_player_counts(ARRAY[v_sid]);
  SELECT active_count INTO v_union FROM fn_union_active_player_counts(ARRAY[v_uid]);

  RAISE NOTICE 'shark active=% union active=%', coalesce(v_shark,0), coalesce(v_union,0);

  IF coalesce(v_union,0) < coalesce(v_shark,0) THEN
    RAISE EXCEPTION 'union (%) reports fewer actives than its member club (%)', v_union, v_shark;
  END IF;
END $$;

COMMIT;
