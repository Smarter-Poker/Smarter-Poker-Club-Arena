-- A BUST BACKLOG PAGES WITHIN FOUR MINUTES (2026-10-22).
--
-- Coffee Break Freeroll (PLO4) f5a98d7e, 16:17-16:40 UTC: the engine recorded
-- no bust for 23 minutes. 308 busted players stayed `playing` at zero chips,
-- every table break refused (bust_unrecorded) and every re-admission refused
-- (F06_MOVEMENT_ELIMINATION_UNPROVEN). fn_ca_bust_backlog_stalled describes
-- exactly this state, but nothing ever ran it, so the first page was the
-- 20-minute "Tables Have Stopped Dealing" SLO.
--
-- The engine now hands a stalled bust stage to a successor generation after
-- two minutes. This is the independent database witness: any RUNNING event
-- with a bust waiting more than four minutes raises one critical financial
-- alert (deduplicated per event while open) and closes it once the backlog
-- is recorded.

CREATE OR REPLACE FUNCTION public.fn_ca_bust_backlog_page(p_minutes integer DEFAULT 4)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raised integer := 0;
  v_closed integer := 0;
  v_stalled integer := 0;
BEGIN
  DROP TABLE IF EXISTS _ca_bust_backlog;
  CREATE TEMP TABLE _ca_bust_backlog ON COMMIT DROP AS
    SELECT * FROM public.fn_ca_bust_backlog_stalled(GREATEST(p_minutes, 1));
  SELECT count(*) INTO v_stalled FROM _ca_bust_backlog;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  SELECT 'critical',
         'fn_ca_bust_backlog_page',
         b.message || ' The engine hands a stalled bust stage to a fresh generation '
           || 'after two minutes; this page means that did not cure it.',
         jsonb_build_object(
           'checked_at', now(),
           'threshold_minutes', GREATEST(p_minutes, 1),
           'tournament_id', b.tournament_id,
           'tournament_name', b.tournament_name,
           'backlog', b.backlog,
           'oldest_minutes', b.oldest_mins,
           'last_hand_at', b.last_hand_at)
    FROM _ca_bust_backlog b
   WHERE NOT EXISTS (
     SELECT 1 FROM public.financial_alerts fa
      WHERE fa.source = 'fn_ca_bust_backlog_page'
        AND NOT fa.resolved
        AND fa.context->>'tournament_id' = b.tournament_id::text);
  GET DIAGNOSTICS v_raised = ROW_COUNT;

  UPDATE public.financial_alerts fa
     SET resolved = true,
         resolved_at = now(),
         resolution = 'Auto-closed by fn_ca_bust_backlog_page: bust backlog recorded; no bust has waited past the threshold.'
   WHERE fa.source = 'fn_ca_bust_backlog_page'
     AND NOT fa.resolved
     AND NOT EXISTS (
       SELECT 1 FROM _ca_bust_backlog b WHERE b.tournament_id::text = fa.context->>'tournament_id');
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  DROP TABLE IF EXISTS _ca_bust_backlog;
  RETURN jsonb_build_object('stalled', v_stalled, 'raised', v_raised, 'closed', v_closed);
END
$$;

REVOKE ALL ON FUNCTION public.fn_ca_bust_backlog_page(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bust_backlog_page(integer) TO service_role;

-- periodic-work: the only database witness for a tournament whose busts stop being recorded; one indexed read of pending knockout candidates for RUNNING events every two minutes.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ca-bust-backlog-page-2m';
SELECT cron.schedule('ca-bust-backlog-page-2m', '*/2 * * * *', 'select public.fn_ca_bust_backlog_page(4);');
