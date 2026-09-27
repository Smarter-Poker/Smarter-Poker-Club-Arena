-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820130130 "union_law_chip_integrity_invariants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8784d57816b030d373d653a60fc50e24 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — CLUB CHIP INTEGRITY INVARIANTS (2026-08-20, pass 5)
--
-- Exact, cheap corruption checks for club-scoped custody. Each one is a
-- condition that CANNOT legitimately occur, so any non-zero result is a real
-- defect rather than a tolerance to argue about:
--
--   negative_club_balance        a club wallet went below zero — a debit path
--                                skipped its balance guard.
--   orphan_stamped_seat          a seat is stamped to a club the player is not
--                                a member of, so cash-out has nowhere to land.
--   orphan_stamped_entry         same for a tournament entry.
--   seat_stamped_outside_union   a union game seat stamped to a club that is
--                                not in that union — cross-union contamination.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_union_chip_integrity_check()
 RETURNS TABLE(invariant text, offenders bigint, detail text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT 'negative_club_balance', count(*),
         'club_members.chip_balance below zero — a debit path lost its balance guard'
    FROM club_members WHERE chip_balance < 0
  HAVING count(*) > 0

  UNION ALL
  SELECT 'orphan_stamped_seat', count(*),
         'active seat stamped to a club the player does not belong to — cash-out cannot land'
    FROM table_seats ts
   WHERE ts.left_at IS NULL AND ts.club_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM club_members m
                      WHERE m.user_id = ts.user_id AND m.club_id = ts.club_id)
  HAVING count(*) > 0

  UNION ALL
  SELECT 'orphan_stamped_entry', count(*),
         'live tournament entry stamped to a club the player does not belong to'
    FROM tournament_players tp
    JOIN tournaments t ON t.id = tp.tournament_id
   WHERE tp.club_id IS NOT NULL
     AND t.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
     AND NOT EXISTS (SELECT 1 FROM club_members m
                      WHERE m.user_id = tp.user_id AND m.club_id = tp.club_id)
  HAVING count(*) > 0

  UNION ALL
  SELECT 'seat_stamped_outside_union', count(*),
         'union game seat stamped to a club outside that union — cross-union contamination'
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE ts.left_at IS NULL AND ts.club_id IS NOT NULL AND t.union_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM union_clubs uc
                      WHERE uc.club_id = ts.club_id AND uc.union_id = t.union_id)
  HAVING count(*) > 0;
$function$;

-- Fold into the daily law self-test as hard breaches.
CREATE OR REPLACE FUNCTION public.fn_union_law_integrity_breaches()
 RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'check', invariant, 'count', offenders, 'detail', detail)), '[]'::jsonb)
    FROM public.fn_union_chip_integrity_check();
$function$;

