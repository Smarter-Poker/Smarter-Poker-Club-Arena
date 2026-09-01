-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827052741; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- CREATE-FLOW P0 FIXES (2026-08-27). See repo migration
-- supabase/migrations/20260827_create_flow_p0_fixes.sql for the full header.

CREATE OR REPLACE FUNCTION public.cash_tables_needing_engine(p_min integer DEFAULT 2)
 RETURNS TABLE(table_id uuid, player_count bigint, human_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ts.table_id,
         count(*) AS player_count,
         count(*) FILTER (WHERE p.is_horse IS NOT TRUE) AS human_count
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    LEFT JOIN profiles p ON p.id = ts.user_id
   WHERE ts.left_at IS NULL
     AND t.tournament_id IS NULL
     -- 'active' added 2026-08-27: a legal tables.status value that one client
     -- writer used for six months while no engine query matched it.
     AND t.status IN ('waiting', 'running', 'active')
   GROUP BY ts.table_id
  HAVING count(*) >= p_min
      OR count(*) FILTER (WHERE p.is_horse IS NOT TRUE) >= 1;
$function$;

UPDATE public.tables
   SET status = 'waiting'
 WHERE status = 'active'
   AND tournament_id IS NULL;

DO $$
DECLARE
  v_stranded int;
BEGIN
  SELECT count(*) INTO v_stranded
    FROM public.tables
   WHERE status = 'active' AND tournament_id IS NULL;
  IF v_stranded > 0 THEN
    RAISE EXCEPTION 'create_flow_p0: % cash tables still stranded on active', v_stranded;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'cash_tables_needing_engine'
       AND prosrc LIKE '%''active''%'
  ) THEN
    RAISE EXCEPTION 'create_flow_p0: discovery RPC does not tolerate active';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'fn_create_tournament'
       AND prosrc LIKE '%trunc(v_total%'
  ) THEN
    RAISE EXCEPTION 'create_flow_p0: fn_create_tournament lost the trunc-to-cents fee';
  END IF;
END $$;
