-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820122926 "union_law_backfill_entries_and_guard_all_money_paths"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b143f8b1b7f1d2a905aad62ec92ef90c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Backfill provenance for live tournament entries -------------------------
UPDATE public.tournament_players tp
   SET club_id = public.fn_tournament_club_for_user(tp.user_id, tp.tournament_id, NULL)
  FROM public.tournaments t
 WHERE t.id = tp.tournament_id
   AND tp.club_id IS NULL
   AND tp.user_id IS NOT NULL
   AND t.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING');

-- Heal both seat and entry provenance on the 5-minute job -----------------
CREATE OR REPLACE FUNCTION public.fn_heal_seat_provenance()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_seats integer; v_entries integer;
BEGIN
  UPDATE table_seats ts
     SET club_id = public.fn_seat_club_for_user(ts.user_id, ts.table_id, NULL)
   WHERE ts.left_at IS NULL
     AND ts.club_id IS NULL
     AND ts.user_id IS NOT NULL
     AND public.fn_seat_club_for_user(ts.user_id, ts.table_id, NULL) IS NOT NULL;
  GET DIAGNOSTICS v_seats = ROW_COUNT;

  UPDATE tournament_players tp
     SET club_id = public.fn_tournament_club_for_user(tp.user_id, tp.tournament_id, NULL)
    FROM tournaments t
   WHERE t.id = tp.tournament_id
     AND tp.club_id IS NULL
     AND tp.user_id IS NOT NULL
     AND t.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
     AND public.fn_tournament_club_for_user(tp.user_id, tp.tournament_id, NULL) IS NOT NULL;
  GET DIAGNOSTICS v_entries = ROW_COUNT;

  RETURN v_seats + v_entries;
END $function$;

-- Guard EVERY money path, so a future rewrite that drops club routing alarms
CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT x.fn,
         'money path no longer routes through club_members — club wallets would be commingled'
    FROM (VALUES
            ('atomic_table_buyin'),
            ('atomic_table_cashout'),
            ('atomic_table_rebuy'),
            ('atomic_table_addon'),
            ('atomic_tournament_register'),
            ('atomic_tournament_unregister'),
            ('process_tournament_rebuy')
         ) AS x(fn)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = x.fn
        AND p.prosrc LIKE '%club_members%');
$function$;

