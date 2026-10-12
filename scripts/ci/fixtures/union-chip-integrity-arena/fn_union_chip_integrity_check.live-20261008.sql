CREATE OR REPLACE FUNCTION public.fn_union_chip_integrity_check()
 RETURNS TABLE(invariant text, offenders bigint, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT 'negative_club_balance', count(*),
         'club_members.chip_balance below zero - a debit path lost its balance guard'
    FROM club_members WHERE chip_balance < 0
  HAVING count(*) > 0

  UNION ALL
  SELECT 'orphan_stamped_seat', count(*),
         'active seat stamped to a club the player does not belong to - cash-out cannot land'
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
         'union game seat stamped to a club outside that union - cross-union contamination'
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE ts.left_at IS NULL AND ts.club_id IS NOT NULL AND t.union_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM union_clubs uc
                      WHERE uc.club_id = ts.club_id AND uc.union_id = t.union_id)
  HAVING count(*) > 0;
$function$
