-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE-FLOW P0 FIXES (2026-08-27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- From the full create-table / create-game audit. TableConfigPage's Start
-- button inserted cash tables with status 'active'. cash_tables_needing_engine
-- only matched ('waiting','running'), so those tables were never adopted by an
-- engine: they sat in the lobby, took seats, and never dealt a hand — every
-- socket to them closed 4404. The client is fixed in the same PR to write
-- 'waiting' (the status every working writer uses); this migration
--
--   (a) repairs the stranded row(s), and
--   (b) makes the discovery RPC tolerant of 'active', so a stale client
--       bundle cannot reproduce the failure while the deploy propagates.
--
-- Applied to production via Supabase MCP as `create_flow_p0_fixes` on
-- 2026-08-27.
--
-- ROLLBACK: restore the RPC body from
-- 20260822b_cash_tables_needing_engine.sql (drops 'active' from the status
-- list); the UPDATE is data repair and needs no rollback — 'waiting' is the
-- correct state for a cash table with no engine.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Discovery RPC tolerates the legal-but-forgotten 'active' status ─────
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

-- ── 2. Repair tables stranded on 'active' ──────────────────────────────────
UPDATE public.tables
   SET status = 'waiting'
 WHERE status = 'active'
   AND tournament_id IS NULL;

-- ── Post-apply assertions ──────────────────────────────────────────────────
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
END $$;
