-- Dan 2026-08-21, bug list item 7.
--
-- Verbatim: "If all the games are ran from the Midway Union, and both Shark
-- Club and Club JAQK are inside of it, why does Shark Club have 513 active,
-- Club JAQK have 508 active but Midway Union only shows 513? Horses can only
-- play inside ONE club at a time. They can't play both clubs at once. They
-- need to choose one or the other or rotate play between them."
--
-- Two halves, both applied to production via Supabase MCP on 2026-08-21.
--
-- ── HALF 1: the count ────────────────────────────────────────────────────────
-- fn_batch_active_player_counts v2 counted a club's MEMBERS who were seated
-- anywhere. Every horse in this union belongs to both clubs (583 of them), so
-- one horse at one table was counted ACTIVE by Shark, by JAQK and by the union
-- simultaneously — which is why each club was nearly as large as the union that
-- contains it. v3 attributes a seated player to exactly ONE club: the club
-- stamped on their seat (table_seats.club_id — who they represent at that
-- table), falling back to the club that owns the table.
--
--   before: Shark 585, JAQK 580, Union 585   (the same horses, three times)
--   after:  Shark 202, JAQK 209, Union 410
--
-- A union counts every player seated at its own tables or at any member club's
-- tables, distinctly — so the union is always >= the largest club and <= the
-- sum, which is the relationship Dan expected.
--
-- ── HALF 2: the seating ──────────────────────────────────────────────────────
-- The count above is only honest if nobody holds two seats stamped with two
-- different clubs, and eleven horses did. fn_seat_club_for_user picked a horse's
-- home club as hash(user_id) % <number of clubs it belongs to> — stable only
-- while that count is stable. Adding a horse to a second club flips it from 1 to
-- 2 and reassigns the club underneath any seat the horse is already sitting in.
-- Horses were being added to both clubs through the day, so every horse that was
-- mid-session when its second membership landed ended up in two clubs.
--
-- The fix: identity while playing comes from what the player is already doing.
-- If they hold a live seat in this union that is already stamped with a club, a
-- new seat joins that same club — ahead of the preferred club, the hash and
-- membership order. Rotation still works as Dan described: leave every table and
-- the next sit-down re-runs the ordinary selection.
--
-- The eleven existing violations were normalised to the club of each horse's
-- OLDEST live seat; re-verified afterwards at zero.
--
-- ROLLBACK:
--   fn_batch_active_player_counts: restore the v2 body from
--     20260821_fn_batch_active_member_counts.sql
--   fn_seat_club_for_user: drop the "ONE CLUB AT A TIME" block below.

create or replace function public.fn_batch_active_player_counts(p_club_ids uuid[])
returns table(club_id uuid, active_count bigint)
language sql
stable
set search_path to 'public'
as $$
  with live as (
    select
      ts.user_id,
      -- ONE club per seated player. This is the whole fix.
      coalesce(ts.club_id, t.club_id) as at_club,
      t.union_id                      as at_union
    from table_seats ts
    join tables t
      on t.id = ts.table_id
     and lower(coalesce(t.status, '')) not in ('closed', 'completed', 'cancelled', 'finished')
    where ts.left_at is null
      and coalesce(ts.is_away, false) = false
  )
  select
    c.id as club_id,
    count(distinct l.user_id) as active_count
  from clubs c
  join live l
    on case
         when coalesce(c.is_union, false)
           then l.at_union = c.id
                or l.at_club = c.id
                or l.at_club in (select mc.id from clubs mc where mc.union_id = c.id)
           else l.at_club = c.id
       end
  where c.id = any(p_club_ids)
  group by c.id;
$$;

revoke all on function public.fn_batch_active_player_counts(uuid[]) from public;
grant execute on function public.fn_batch_active_player_counts(uuid[]) to anon, authenticated;

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
