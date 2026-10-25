-- Daily digest: count original alerts and compare rake against current sources.
-- Six refusals plus six resolution updates are six incidents, not twelve.
-- The Oct 24 snapshot kept rollup zero after the rollup caught up to343158.54.
-- Re-read the rollup at the original request and compare with the recorded UTC-day ledger;
-- annotate resolved historical rake items without rewriting snapshots or alerts.
-- Functions only. No money, source events, schedules, ownership or grants change.
-- Exact preimages/postimages refuse concurrent source drift and replay.
-- Rollback: restore these three pinned preimages through a reviewed migration.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
DO $digest_original_alerts$
DECLARE
 sig text; before_hash text; after_hash text; expected integer;
 original text; amended text; anchor text; replacement text;
 owner_before oid; acl_before aclitem[]; config_before text[]; sec_before boolean;
BEGIN
 FOR sig,before_hash,after_hash IN VALUES
    ('public.fn_sp_daily_metrics_compute(date)', '8cc2a4cfaab3573ffef2551948f534f9', 'b3e73a2b6a93d2bde0d18b4aea540a7e'),
    ('public.fn_sp_digest_attention(date,jsonb)', 'd68ca98e26d783ded93a94bc777ae4ac', 'e9858fa93a233234cfedff0b3a726413'),
    ('public.fn_sp_daily_digest(date,boolean)', 'b55af303d33bd7faaf018112475beef8', 'd41812a96c7b68a01b666e4d4f222173')
 LOOP
    SELECT pg_get_functiondef(oid),proowner,proacl,proconfig,prosecdef
      INTO original,owner_before,acl_before,config_before,sec_before
      FROM pg_proc WHERE oid=sig::regprocedure;
    IF md5(original) IS DISTINCT FROM before_hash THEN
      RAISE EXCEPTION 'DIGEST_ALERT_PREIMAGE_DRIFT: % is %',sig,md5(original);
    END IF;
    amended:=original;
    IF sig = 'public.fn_sp_daily_metrics_compute(date)' THEN
      FOR anchor, replacement, expected IN VALUES
      ($old$investigation_status IS DISTINCT FROM 'informational'$old$, $new$investigation_status IS DISTINCT FROM 'informational' AND payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'$new$, 3)
      LOOP
        IF (length(amended)-length(replace(amended,anchor,'')))/length(anchor) <> expected THEN
          RAISE EXCEPTION 'DIGEST_ALERT_ANCHOR_COUNT: %', sig;
        END IF;
        amended := replace(amended,anchor,replacement);
      END LOOP;
    END IF;
    IF sig = 'public.fn_sp_digest_attention(date,jsonb)' THEN
      FOR anchor, replacement, expected IN VALUES
      ($old$investigation_status IS DISTINCT FROM 'informational'$old$, $new$investigation_status IS DISTINCT FROM 'informational' AND payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'$new$, 1),
      ($old$AND o.received_at >= s - interval '7 days' AND o.received_at < s$old$, $new$AND o.payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'
                            AND o.received_at >= s - interval '7 days' AND o.received_at < s$new$, 1)
      LOOP
        IF (length(amended)-length(replace(amended,anchor,'')))/length(anchor) <> expected THEN
          RAISE EXCEPTION 'DIGEST_ALERT_ANCHOR_COUNT: %', sig;
        END IF;
        amended := replace(amended,anchor,replacement);
      END LOOP;
    END IF;
    IF sig = 'public.fn_sp_daily_digest(date,boolean)' THEN
      FOR anchor, replacement, expected IN VALUES
      ($old$  v_days_in_month int; v_days_so_far int;$old$, $new$  v_days_in_month int; v_days_so_far int;
  v_rake_ledger numeric; v_rake_rollup numeric;$new$, 1),
      ($old$  v_live := public.fn_sp_digest_attention(v_day, v_row.metrics);$old$, $new$  -- Refresh only the rollup in memory; the ledger baseline and snapshots remain intact.
  SELECT (v_row.metrics#>>'{money,ledger_rake_utc_day}')::numeric,
         (SELECT round(COALESCE(sum(rake_amount),0),2) FROM public.club_rake_daily_user WHERE day = v_day)
    INTO v_rake_ledger, v_rake_rollup;
  v_row.metrics := jsonb_set(v_row.metrics, '{money}', COALESCE(v_row.metrics->'money','{}'::jsonb) || jsonb_build_object(
    'ledger_rake_utc_day', v_rake_ledger, 'rollup_rake_utc_day', v_rake_rollup, 'rollup_rechecked_at', clock_timestamp()));
  v_live := public.fn_sp_digest_attention(v_day, v_row.metrics);$new$, 1),
      ($old$    SELECT * INTO v_row FROM public.sp_daily_metrics WHERE day = v_day;
  ELSE$old$, $new$    SELECT attention INTO v_row.attention FROM public.sp_daily_metrics WHERE day = v_day;
  ELSE$new$, 1),
      ($old$'status', CASE WHEN NOT (it ? 'alert_event_id') THEN 'tracked'$old$, $new$'status', CASE WHEN it->>'rule' = 'rake_rollup_mismatch'
                            AND abs(v_rake_ledger - v_rake_rollup) <= 1 THEN 'fixed'
                       WHEN it->>'rule' = 'rake_rollup_mismatch' AND abs(v_rake_ledger - v_rake_rollup) > 1
                       THEN CASE WHEN NOT (it ? 'alert_event_id') THEN 'tracked'
                                 WHEN o.investigation_status = 'investigating' THEN 'in_progress'
                                 ELSE 'not_picked_up' END
                       WHEN NOT (it ? 'alert_event_id') THEN 'tracked'$new$, 1),
      ($old$'resolution', o.investigation->>'resolution') x$old$, $new$'resolution', CASE WHEN it->>'rule' = 'rake_rollup_mismatch'
                            AND abs(v_rake_ledger - v_rake_rollup) <= 1
                       THEN format('Current rollup matches recorded UTC-day ledger %s; original snapshot retained.', v_rake_ledger)
                       WHEN it->>'rule' = 'rake_rollup_mismatch' AND abs(v_rake_ledger - v_rake_rollup) > 1
                       THEN format('Current rollup %s differs from recorded UTC-day ledger %s; original snapshot retained.', v_rake_rollup, v_rake_ledger)
                       ELSE o.investigation->>'resolution' END) x$new$, 1)
      LOOP
        IF (length(amended)-length(replace(amended,anchor,'')))/length(anchor) <> expected THEN
          RAISE EXCEPTION 'DIGEST_ALERT_ANCHOR_COUNT: %', sig;
        END IF;
        amended := replace(amended,anchor,replacement);
      END LOOP;
    END IF;
    IF md5(amended) IS DISTINCT FROM after_hash THEN
      RAISE EXCEPTION 'DIGEST_ALERT_POSTIMAGE_MISMATCH: % is %', sig, md5(amended);
    END IF;
    EXECUTE amended;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = sig::regprocedure
      AND md5(pg_get_functiondef(oid)) = after_hash
      AND proowner = owner_before AND proacl IS NOT DISTINCT FROM acl_before
      AND proconfig IS NOT DISTINCT FROM config_before AND prosecdef = sec_before) THEN
      RAISE EXCEPTION 'DIGEST_ALERT_READBACK_OR_ACCESS_CHANGED: %', sig;
    END IF;
 END LOOP;
END $digest_original_alerts$;
COMMIT;
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)) = 'b3e73a2b6a93d2bde0d18b4aea540a7e')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_sp_digest_attention(date,jsonb)'::regprocedure)) = 'e9858fa93a233234cfedff0b3a726413')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_sp_daily_digest(date,boolean)'::regprocedure)) = 'd41812a96c7b68a01b666e4d4f222173')
