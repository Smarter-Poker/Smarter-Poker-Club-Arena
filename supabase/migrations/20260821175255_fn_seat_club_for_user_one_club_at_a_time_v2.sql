-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821175255 "fn_seat_club_for_user_one_club_at_a_time_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1ccab81185b02f6bc0145999dfa613d8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Dan 2026-08-21, bug list item 7 (second half):
--   "Horses can only play inside ONE club at a time. They can't play both
--    clubs at once. They need to choose one or the other or rotate play
--    between them."
--
-- The counting side is fixed by fn_batch_active_player_counts v3, which
-- attributes each seated player to the club stamped on their seat. That is only
-- honest if a player never holds two seats stamped with two different clubs —
-- and eleven horses did exactly that at the time of writing, each sitting at one
-- Shark table and one JAQK table simultaneously.
--
-- WHY IT HAPPENED. The horse branch picks a "home" club deterministically from
-- the horse's own id, offset into its membership list:
--     v_idx := hash(user_id) % v_n
-- which is stable only while v_n is stable. Every horse added to a second club
-- flips v_n from 1 to 2, and the club it is assigned changes underneath any seat
-- it is already sitting in. Horses were being added to both clubs through the
-- day, so each one that was mid-session when its second membership landed ended
-- up with two seats in two clubs.
--
-- THE FIX. Identity while playing comes from what the player is ALREADY doing,
-- not from a hash. If they hold any live seat in this union that is already
-- stamped with a club, the new seat joins that same club. Nothing else can make
-- "one club at a time" true, because nothing else survives a membership change
-- mid-session.
--
-- Rotation still works exactly as Dan described: the moment a horse leaves all
-- its tables it has no live seat to inherit from, and the next sit-down re-runs
-- the ordinary selection below.
--
-- Signature and SECURITY DEFINER are preserved verbatim — the trigger
-- fn_stamp_seat_club calls this on every table_seats insert.
--
-- Applied to production via Supabase MCP apply_migration on 2026-08-21.
-- ROLLBACK: drop the "ONE CLUB AT A TIME" block from the function body.

CREATE OR REPLACE FUNCTION public.fn_seat_club_for_user(
  p_user_id uuid,
  p_table_id uuid,
  p_preferred_club uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_table_club uuid; v_club uuid;
  v_is_horse boolean := false; v_n int; v_idx int;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_table_club
    FROM tables t WHERE t.id = p_table_id;

  IF v_union IS NULL THEN
    RETURN v_table_club;                       -- standalone club game
  END IF;

  -- ONE CLUB AT A TIME (Dan 2026-08-21). If this player is already sitting
  -- somewhere in this union, the club they are already representing wins —
  -- over the preferred club, over the hash, over membership order. Everything
  -- below only decides where a player who is NOT currently seated starts.
  SELECT ts.club_id INTO v_club
    FROM table_seats ts
    JOIN tables t2 ON t2.id = ts.table_id
   WHERE ts.user_id = p_user_id
     AND ts.left_at IS NULL
     AND ts.club_id IS NOT NULL
     AND t2.union_id = v_union
     AND lower(coalesce(t2.status, '')) NOT IN ('closed','completed','cancelled','finished')
   ORDER BY ts.joined_at ASC NULLS LAST
   LIMIT 1;
  IF v_club IS NOT NULL THEN
    RETURN v_club;
  END IF;

  -- Honour the club the player entered through, when they really are a member.
  IF p_preferred_club IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                  JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club
                   AND m.status IN ('active','approved'))
  THEN
    RETURN p_preferred_club;
  END IF;

  SELECT COALESCE(p.is_horse, false) INTO v_is_horse FROM profiles p WHERE p.id = p_user_id;

  IF v_is_horse THEN
    -- Stable home club for a simulated player that is not currently seated:
    -- deterministic from its own id, so horses spread across the union's clubs
    -- instead of all piling into the oldest one.
    SELECT count(*) INTO v_n
      FROM club_members m
      JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
     WHERE m.user_id = p_user_id AND m.status IN ('active','approved');

    IF v_n > 1 THEN
      v_idx := (abs(hashtextextended(p_user_id::text, 0)) % v_n)::int;
      SELECT m.club_id INTO v_club
        FROM club_members m
        JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
       WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
       ORDER BY m.club_id
       OFFSET v_idx LIMIT 1;
      IF v_club IS NOT NULL THEN RETURN v_club; END IF;
    END IF;
  END IF;

  -- Real players: oldest membership.
  SELECT m.club_id INTO v_club
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$;
