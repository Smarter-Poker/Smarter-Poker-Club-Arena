-- ═══════════════════════════════════════════════════════════════════════════════
--  FIX — fn_get_active_player_count must count only LIVE tables
-- ═══════════════════════════════════════════════════════════════════════════════
--  Applied to production (kuklfnapbkmacvwxktbh) 2026-07-24.
--
--  BUG: the club "active players" number was massively inflated. The function
--  counted DISTINCT table_seats.user_id with left_at IS NULL across ALL of a
--  club's tables regardless of table status. Seats orphaned on closed/finished
--  tables (129 such seats existed) were counted as "active", so e.g. Club JAQK
--  showed 117 active vs 56 real, and unions summed these inflated per-club counts.
--
--  FIX: exclude non-live table statuses (closed/completed/cancelled/finished) and
--  players who are sitting away. Self-correcting even if a seat is ever left
--  dangling again. Also see migration 20260724g which released the orphaned seats.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_get_active_player_count(p_club_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COUNT(DISTINCT ts.user_id)
  FROM table_seats ts
  INNER JOIN tables t ON ts.table_id = t.id
  WHERE t.club_id = p_club_id
    AND ts.left_at IS NULL
    AND COALESCE(ts.is_away, false) = false
    AND lower(COALESCE(t.status,'')) NOT IN ('closed','completed','cancelled','finished');
$function$;
