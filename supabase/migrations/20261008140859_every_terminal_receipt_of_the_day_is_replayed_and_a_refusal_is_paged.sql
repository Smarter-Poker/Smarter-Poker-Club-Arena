-- 20261008140859_every_terminal_receipt_of_the_day_is_replayed_and_a_refusal_is_paged.sql
--
-- Version is the one production recorded when the Supabase MCP applied it
-- (14:08:59 UTC); a migration file matches what production ran.
--
-- ============================================================================
-- EVERY TERMINAL RECEIPT OF THE DAY IS REPLAYED, AND A REFUSAL IS PAGED
-- ============================================================================
--
-- A terminal receipt (fn_ca_tournament_terminal_receipt,
-- fn_ca_satellite_settlement_receipt, fn_ca_satellite_cohort_receipt) is the
-- proof every finish rests on, and it is replayed after the fact by the
-- manager's own completion read, by recovery, and by the player's result
-- screen. Twice in five days a receipt stopped proving without anybody
-- noticing until it froze a live event: 20261003023500 (a pre-start refund),
-- 20261008113442 (the same refund in the cohort receipt, 17 hours), and on
-- 2026-10-08 a hand replay of the last seven days found 328 of 562 satellite
-- receipts refusing on a redeemed entry ticket (20261008140724).
--
-- fn_ca_replay_terminal_receipts(p_hours, p_limit) replays every COMPLETED
-- MTT, Spin, Sit & Go and satellite of the last p_hours (satellites and MTTs
-- first, newest first, up to p_limit) and raises one CRITICAL financial
-- alert per distinct refusal text, which closes itself when the refusal no
-- longer reproduces. A lock timeout or statement cancel on one event is
-- skipped and counted, never read as a refusal. Read on production at
-- 14:09Z: 1,500 receipts of the last 6 h replayed, 0 refused, 0 skipped.
--
-- periodic-work: this schedule is the audit itself, not compensation. A
-- receipt is the proof every finish rests on; replaying the day's receipts
-- is how a receipt that has silently stopped proving (328 of 562 satellites
-- on 2026-10-08, found by hand) is found the day it happens, before it
-- freezes a live event. It repairs nothing and moves no money.
--
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-terminal-receipt-replay-daily' AND active))

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_ca_replay_terminal_receipts(p_hours integer DEFAULT 24, p_limit integer DEFAULT 4000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '600s'
SET lock_timeout TO '2s'
AS $function$
DECLARE
  t record; v jsonb;
  v_ok int := 0; v_refused int := 0; v_locked int := 0; v_raised int := 0; v_resolved int := 0;
  v_fail jsonb := '[]'::jsonb;
BEGIN
  FOR t IN
    SELECT tr.id, upper(coalesce(tr.tournament_type,'')) ttype, lower(coalesce(tr.variant,'')) variant,
           (SELECT tp.user_id FROM public.tournament_players tp WHERE tp.tournament_id=tr.id AND tp.status::text='winner' ORDER BY tp.position LIMIT 1) winner,
           (SELECT s.qualifier_ids FROM public.tournament_satellite_settlements s WHERE s.tournament_id=tr.id) qids,
           EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s WHERE s.tournament_id=tr.id) sat_hdr
      FROM public.tournaments tr
     WHERE tr.status='COMPLETED'
       AND tr.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours,24),1))
       AND upper(coalesce(tr.tournament_type,'')) IN ('MTT','SPIN','SNG','SATELLITE')
     ORDER BY CASE WHEN upper(coalesce(tr.tournament_type,''))='SATELLITE' OR lower(coalesce(tr.variant,''))='satellite' THEN 0
                   WHEN upper(coalesce(tr.tournament_type,''))='MTT' THEN 1 ELSE 2 END,
              tr.ended_at DESC
     LIMIT GREATEST(COALESCE(p_limit,4000),1)
  LOOP
    BEGIN
      IF t.sat_hdr THEN
        IF t.qids IS NOT NULL AND cardinality(t.qids) > 0 THEN
          v := public.fn_ca_satellite_cohort_receipt(t.id, t.qids);
        ELSE
          v := public.fn_ca_satellite_settlement_receipt(t.id, t.winner);
        END IF;
      ELSIF t.ttype='SATELLITE' OR t.variant='satellite' THEN
        RAISE EXCEPTION 'satellite % completed without a settlement header', t.id USING ERRCODE='P0404';
      ELSE
        v := public.fn_ca_tournament_terminal_receipt(t.id, t.winner);
      END IF;
      v_ok := v_ok + 1;
    EXCEPTION
      WHEN lock_not_available OR query_canceled THEN
        v_locked := v_locked + 1;
      WHEN OTHERS THEN
        v_refused := v_refused + 1;
        IF jsonb_array_length(v_fail) < 50 THEN
          v_fail := v_fail || jsonb_build_object('tournament_id', t.id, 'type', t.ttype, 'code', SQLSTATE, 'error', left(SQLERRM, 240));
        END IF;
    END;
  END LOOP;

  -- One open alert per distinct refusal text; the incident bridge keys on it.
  INSERT INTO public.financial_alerts (severity, source, message, context)
  SELECT 'critical', 'fn_ca_replay_terminal_receipts',
         format('A terminal receipt no longer proves on replay: %s tournament(s) completed in the last %s h refuse with "%s" (sample %s). A receipt that stops proving will freeze the next event that reaches the same state, so this is fixed in the receipt before it does.',
                g.n, GREATEST(COALESCE(p_hours,24),1), g.err, g.sample),
         jsonb_build_object('checked_at', now(), 'hours', GREATEST(COALESCE(p_hours,24),1), 'refusal', g.err, 'count', g.n, 'sample_tournament_id', g.sample, 'samples', g.ids)
    FROM (SELECT regexp_replace(f->>'error', '[0-9a-f-]{36}', '<id>', 'g') err, count(*) n, min(f->>'tournament_id') sample,
                 jsonb_agg(f->>'tournament_id') ids
            FROM jsonb_array_elements(v_fail) f GROUP BY 1) g
   WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                      WHERE fa.source='fn_ca_replay_terminal_receipts' AND NOT fa.resolved
                        AND fa.context->>'refusal' = g.err);
  GET DIAGNOSTICS v_raised = ROW_COUNT;

  -- A refusal that no longer reproduces closes itself.
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now(),
         resolution = format('Re-measured by fn_ca_replay_terminal_receipts at %s: %s receipt(s) of the last %s h replayed, none refuses with this text any more.', now(), v_ok, GREATEST(COALESCE(p_hours,24),1))
   WHERE fa.source='fn_ca_replay_terminal_receipts' AND NOT fa.resolved
     AND v_refused = 0 AND v_ok > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_fail) f
                      WHERE regexp_replace(f->>'error', '[0-9a-f-]{36}', '<id>', 'g') = fa.context->>'refusal');
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'checked_at', now(), 'hours', GREATEST(COALESCE(p_hours,24),1),
    'replayed', v_ok, 'refused', v_refused, 'skipped_locked', v_locked, 'raised', v_raised, 'resolved', v_resolved, 'failures', v_fail);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_replay_terminal_receipts(integer, integer) FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-terminal-receipt-replay-daily') THEN
    PERFORM cron.unschedule('ca-terminal-receipt-replay-daily');
  END IF;
  PERFORM cron.schedule(
    'ca-terminal-receipt-replay-daily',
    '37 4 * * *',
    $$select public.fn_ca_replay_terminal_receipts(26, 4000);$$);
END
$cron$;

COMMIT;
