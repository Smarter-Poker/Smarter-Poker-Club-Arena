-- 20261026131306_the_weekly_rakeback_close_is_ready_at_four
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-26 13:13:06 UTC.
--
-- INCIDENT, 2026-10-26. The Monday 4:00 AM Chicago weekly rakeback close for
-- the week ending 2026-10-26 07:00 UTC paid no agent and no player. Read from
-- cron.job_run_details (job 272), union_accounting_runs,
-- weekly_accounting_scheduler_visits, union_pnl_inventory_seal_layers and
-- union_pnl_inventory_checkpoints (all times UTC):
--   07:40  first job 272 tick of the week (minute 40). The week's original
--          inventory seal starts: 28 six-hour layers, about two per tick,
--          nothing from :45 to :00.
--   09:00  the 4:00 AM due tick lands inside the daily engine maintenance
--          freeze (04:00-04:05 Chicago since 2026-10-20). The Midway horse
--          promo owns the tick and is refused (PLATFORM_FROZEN).
--   09:10, 09:15  the promo deadlocks with live play; 09:20 it pays.
--   10:01  last layer staged; 11:43 checkpoint written (one tick ran out of
--          its 4-minute budget on the final step, alert at 11:35).
--   09:40  onward job 272 calls the close only at :40-:44, one scope a tick.
--   12:40  first scope visit of the week (Lightning Internal Pilot, failed on
--          a lock timeout). Midway Union would not be visited before 13:40 and
--          Deep Stack Society not before 14:40.
-- The two weeks before closed late the same way: Midway's week ending 10-19
-- completed on 10-22 (32 attempts), the week ending 10-12 on 10-18.
--
-- ROOT CAUSES AND WHAT CHANGES (CLAUDE.md 10.11/10.12: no repair job, the
-- schedule itself is fixed):
--
-- 1. THE WHOLE WEEK'S SEAL WAS COMPUTED AFTER THE WEEK CLOSED. A layer only
--    depends on the events observed inside its window, on the earlier layers
--    of the same week and on the sealed snapshot of the week's start, so it is
--    the same rows whether it is computed during the week or after it.
--    fn_union_pnl_inventory_layer_precompute stages each layer of the running
--    week as soon as its window has settled, hourly at :22. At the boundary
--    only the last layer, the build pages and the checkpoint remain, and job
--    272 starts on them at 2:00 AM: fn_union_pnl_inventory_seal_in_progress
--    turns true the moment staged layers exist for the closed week, which
--    already makes job 272 call the close on every tick. The seal itself
--    (fn_union_pnl_inventory_seal_advance) is unchanged and skips every layer
--    already staged, exactly as it does for its own earlier ticks.
--
--    A window is SETTLED (fn_union_pnl_inventory_layer_settled) when it ended
--    over five minutes ago and no transaction holding an xid began before its
--    end, and no prepared transaction was prepared before it. An inventory
--    event's observed_at is clock_timestamp() at its transaction's first frame
--    (fn_union_pnl_original_frame), which also assigns the xid, so once no
--    such transaction is running, every event observed before the end has
--    committed or rolled back. The seal reaches the same certainty for a
--    CLOSED week by taking each closed book's advisory lock exclusively; the
--    precompute must never take the running week's book lock, because every
--    live writer holds it shared and would stall behind it.
--
--    Staging holds one week. The precompute only touches it once the running
--    week's start is sealed (its checkpoint exists and is the latest), only
--    under the seal's own serialiser (try-lock, never a wait), and clears a
--    sealed week's leftovers exactly as the seal does when the next week
--    starts. Staging rows are read only by the seal and by
--    fn_union_pnl_inventory_seal_in_progress (measured 2026-10-26: no other
--    function references union_pnl_inventory_seal_layer*).
--
-- 2. AFTER THE 40 MINUTES THAT FOLLOW 4:00 AM, job 272 called the close only
--    at :40-:44. It now also calls it on every tick while a scope active in
--    the last 14 days has had no visit since this week's 4:00 AM and has not
--    completed the week (fn_weekly_close_first_visits_pending), for at most
--    12 hours. A book in progress already continues on every tick through
--    the chunk_committed condition. Nothing about which scope goes first, how
--    much a tick may do, or what is paid changes.
--
-- 3. THE 4:00 AM DUE TICK FALLS IN THE DAILY ENGINE FREEZE. Not moved: Dan's
--    rakeback time is 4:00 AM. With change 2 the 4:05 tick takes the work
--    instead of waiting for the next :40.
--
-- Nothing in this migration moves money or chooses an amount. The precompute
-- job writes only the seal's staging tables.
--
-- periodic-work: union-pnl-inventory-layer-precompute stages the running week's inventory layers as their windows settle, so the Monday seal is ready before the 4:00 AM close instead of four hours after it; it repairs nothing and writes no money.
--
-- Rollback: SELECT cron.unschedule('union-pnl-inventory-layer-precompute');
-- restore job 272's command without " OR public.fn_weekly_close_first_visits_pending()".
--
-- @live-proof: (SELECT count(*)=1 FROM cron.job WHERE jobname='union-pnl-inventory-layer-precompute' AND active AND schedule='22 * * * *' AND position('fn_union_pnl_inventory_layer_precompute()' in command)>0)
-- @live-proof: (SELECT count(*)=1 FROM cron.job WHERE jobname='union-weekly-rakeback-close' AND position(' OR public.fn_weekly_close_first_visits_pending() THEN public.fn_union_settlement_cascade_due() END;' in command)>0)
-- @live-proof: (SELECT count(*)=3 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_union_pnl_inventory_layer_settled','fn_union_pnl_inventory_layer_precompute','fn_weekly_close_first_visits_pending') AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_layer_settled(p_end timestamptz)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT p_end IS NOT NULL AND isfinite(p_end)
  AND p_end <= clock_timestamp() - interval '5 minutes'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a
   WHERE a.pid <> pg_backend_pid() AND a.backend_xid IS NOT NULL AND a.xact_start < p_end)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_prepared_xacts x WHERE x.prepared < p_end);
$function$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_layer_settled(timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_layer_precompute()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE;
 v_base timestamptz; v_next timestamptz; g record;
 began timestamptz := clock_timestamp(); t0 timestamptz;
 v_lr bigint; v_li bigint; n_layers int; n_done int; n_new int := 0; v_wait text := NULL;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'inventory_requires_fresh_read_committed_snapshot' USING ERRCODE='25000'; END IF;
 IF public.fn_platform_frozen() THEN
  RETURN jsonb_build_object('status','skipped','reason','maintenance_window'); END IF;
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','skipped','reason','inventory_capture_missing'); END IF;
 v_base := public.fn_union_week_start(clock_timestamp());
 v_next := public.fn_union_week_start(v_base + interval '8 days');
 -- The running week stages on the sealed snapshot of its start. Until that
 -- seal is written the staging tables belong to the seal.
 IF v_base <= origin.captured_at
  OR (SELECT max(c.boundary) FROM public.union_pnl_inventory_checkpoints c) IS DISTINCT FROM v_base THEN
  RETURN jsonb_build_object('status','skipped','reason','week_start_not_sealed','base',v_base);
 END IF;
 -- The seal's own serialiser; never wait on it.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0)) THEN
  RETURN jsonb_build_object('status','skipped','reason','seal_running');
 END IF;
 -- Staging holds one week. A sealed week's leftovers are cleared exactly as
 -- fn_union_pnl_inventory_seal_advance clears them when the next seal starts.
 IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary = v_next)
  OR EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l
   WHERE l.boundary <> v_next OR l.base_boundary IS DISTINCT FROM v_base) THEN
  IF EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary <> v_next
   AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary = l.boundary)) THEN
   RETURN jsonb_build_object('status','skipped','reason','unsealed_week_in_staging');
  END IF;
  TRUNCATE public.union_pnl_inventory_seal_layers, public.union_pnl_inventory_seal_layer_rows, public.union_pnl_inventory_seal_layer_issues;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _inv_layer(o_kind text,o_source_name text,o_row_id uuid,o_event_id bigint,o_first_operation text,o_after_row jsonb) ON COMMIT DROP;
 SELECT count(*) INTO n_layers FROM generate_series(v_base, v_next - interval '1 microsecond', interval '6 hours') s;
 -- The seal's windows, in the seal's order: each layer reads the ones before it.
 FOR g IN SELECT s AS layer_start, LEAST(s + interval '6 hours', v_next) AS layer_end
   FROM generate_series(v_base, v_next - interval '1 microsecond', interval '6 hours') s ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary = v_next AND l.layer_end = g.layer_end);
  IF NOT public.fn_union_pnl_inventory_layer_settled(g.layer_end) THEN v_wait := 'next_window_not_settled'; EXIT; END IF;
  IF n_new > 0 AND clock_timestamp() > began + interval '90 seconds' THEN v_wait := 'call_budget'; EXIT; END IF;
  IF public.fn_platform_frozen() THEN v_wait := 'maintenance_window'; EXIT; END IF;
  t0 := clock_timestamp();
  TRUNCATE pg_temp._inv_layer;
  INSERT INTO pg_temp._inv_layer SELECT * FROM public.fn_union_pnl_inventory_layer_state(v_base, v_next, g.layer_start, g.layer_end);
  INSERT INTO public.union_pnl_inventory_seal_layer_rows(boundary,source_name,row_id,layer_end,latest_event_id,first_operation,after_row)
   SELECT v_next,o_source_name,o_row_id,g.layer_end,o_event_id,o_first_operation,o_after_row FROM pg_temp._inv_layer WHERE o_kind='row';
  GET DIAGNOSTICS v_lr = ROW_COUNT;
  INSERT INTO public.union_pnl_inventory_seal_layer_issues(boundary,source_name,row_id,layer_end,event_id)
   SELECT v_next,o_source_name,o_row_id,g.layer_end,o_event_id FROM pg_temp._inv_layer WHERE o_kind='issue';
  GET DIAGNOSTICS v_li = ROW_COUNT;
  INSERT INTO public.union_pnl_inventory_seal_layers(boundary,layer_end,layer_start,base_boundary,row_count,issue_count,layer_ms)
  VALUES(v_next,g.layer_end,g.layer_start,v_base,v_lr,v_li,(extract(epoch FROM clock_timestamp()-t0)*1000)::bigint);
  n_new := n_new + 1;
 END LOOP;
 SELECT count(*) INTO n_done FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary = v_next;
 RETURN jsonb_build_object('status','staged','boundary',v_next,'base_boundary',v_base,'layers',n_layers,
  'layers_done',n_done,'staged_now',n_new,'waiting',v_wait,'ms',(extract(epoch FROM clock_timestamp()-began)*1000)::bigint);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_layer_precompute() FROM PUBLIC, anon, authenticated;

-- A scope active in the last 14 days has not had its first visit since this
-- week's 4:00 AM and has not completed the week. Job 272's tick gate.
CREATE OR REPLACE FUNCTION public.fn_weekly_close_first_visits_pending()
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path TO 'public'
AS $function$
 WITH d AS (SELECT public.fn_union_week_start(clock_timestamp()) AS wk,
   public.fn_union_accounting_run_at(public.fn_union_week_start(clock_timestamp())) AS due)
 SELECT EXISTS(SELECT 1 FROM d, public.weekly_accounting_scheduler_visits v
  WHERE clock_timestamp() >= d.due AND clock_timestamp() < d.due + interval '12 hours'
   AND v.last_visit_at > clock_timestamp() - interval '14 days'
   AND v.last_visit_at < d.due
   AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.scope_kind = v.scope_kind
     AND q.scope_id = v.scope_id AND q.period_end = d.wk AND q.status = 'complete'));
$function$;

REVOKE ALL ON FUNCTION public.fn_weekly_close_first_visits_pending() FROM PUBLIC, anon, authenticated;

-- Job 272: also call the close on every tick while a scope waits for its first
-- visit of the week. Anchored on the command as measured 2026-10-26 13:12 UTC.
DO $do$
DECLARE c text; v_anchor constant text := ' THEN public.fn_union_settlement_cascade_due() END;';
BEGIN
 SELECT command INTO c FROM cron.job WHERE jobname = 'union-weekly-rakeback-close';
 IF c IS NULL THEN RAISE EXCEPTION 'job union-weekly-rakeback-close missing'; END IF;
 IF position('fn_weekly_close_first_visits_pending' IN c) = 0 THEN
  IF md5(c) <> 'c74214f0f7e65064769601dbe867ec28' THEN
   RAISE EXCEPTION 'job union-weekly-rakeback-close changed since this migration was written (md5 %)', md5(c); END IF;
  PERFORM cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'union-weekly-rakeback-close'),
   command := replace(c, v_anchor, ' OR public.fn_weekly_close_first_visits_pending()' || v_anchor));
 END IF;
END
$do$;

-- Stage the running week's layers hourly at :22, clear of the :40 close slot.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'union-pnl-inventory-layer-precompute';
SELECT cron.schedule('union-pnl-inventory-layer-precompute', '22 * * * *',
 $job$SET statement_timeout = '180s'; SELECT public.fn_union_pnl_inventory_layer_precompute();$job$);

COMMIT;
