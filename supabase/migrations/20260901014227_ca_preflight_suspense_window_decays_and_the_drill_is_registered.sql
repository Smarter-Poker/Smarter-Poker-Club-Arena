-- Three preflight blockers found while closing out hardening round 2:
--
-- 1. fn_ca_epoch3_preflight counted suspense rows after a FIXED floor
--    (2026-08-31 19:01), so the 108 pre-fix rows kept the check red FOREVER.
--    Doc 07 and the burn-in plan both say the window "decays to green about
--    24h after the last suspense row". Make it true: count rows after
--    GREATEST(the last-writer-fix floor already used by the rollup and the
--    regression checks, now() - 24 hours). Once the trailing window slides
--    past the floor, only NEW suspense can hold the gate.
-- 2. fn_ca_alarm_drill (hardening round 2 phase 3) touches money tables in
--    its deliberately-unwound subtransactions, so fn_ca_money_rpc_drift
--    rightly flagged it as an unregistered money RPC. Register it: every
--    write it makes is rolled back by design and its results table holds no
--    chips.
-- 3. The warning incident that scan raised is resolved with that narrative.

CREATE OR REPLACE FUNCTION public.fn_ca_epoch3_preflight()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_open integer; c_susp integer; c_wf integer; v_chain record;
  c_drift integer; v_snap record; v_checks jsonb; v_pass boolean; v_guard_inc integer;
BEGIN
  SELECT count(*) INTO c_open FROM public.ca_drift_incidents
   WHERE status <> 'resolved' AND severity <> 'info';
  SELECT count(*) INTO c_susp FROM public.chip_ledger
   WHERE (from_type='settlement_suspense' OR to_type='settlement_suspense')
     AND created_at > GREATEST('2026-09-01 00:17:00+00'::timestamptz,
                               now() - interval '24 hours');
  SELECT count(*) INTO c_wf FROM public.ca_ledger_write_failures
   WHERE occurred_at > now() - interval '24 hours';
  SELECT * INTO v_chain FROM public.fn_ca_verify_ledger_chain(50000);
  SELECT count(*) INTO v_guard_inc FROM (
    SELECT 1 FROM public.ca_drift_incidents
     WHERE dedupe_key LIKE 'guard-missing:%' AND status <> 'resolved') g;
  SELECT count(*) INTO c_drift FROM public.fn_ca_money_rpc_drift();
  SELECT s.unexplained, s.taken_at INTO v_snap
    FROM public.ca_supply_snapshots s ORDER BY s.taken_at DESC LIMIT 1;

  v_checks := jsonb_build_object(
    'no_open_incidents',        jsonb_build_object('pass', c_open = 0, 'open', c_open),
    'zero_suspense_flow',       jsonb_build_object('pass', c_susp = 0, 'rows', c_susp),
    'zero_write_failures_24h',  jsonb_build_object('pass', c_wf = 0, 'value', c_wf),
    'ledger_chain_clean',       jsonb_build_object('pass', COALESCE(v_chain.breaks,0) = 0,
                                                   'checked', COALESCE(v_chain.checked,0)),
    'guards_all_present',       jsonb_build_object('pass', v_guard_inc = 0, 'open_guard_incidents', v_guard_inc),
    'no_unregistered_rpcs',     jsonb_build_object('pass', c_drift = 0, 'value', c_drift),
    'fresh_supply_snapshot',    jsonb_build_object('pass', v_snap.taken_at > now() - interval '2 hours',
                                                   'taken_at', v_snap.taken_at,
                                                   'unexplained', round(COALESCE(v_snap.unexplained,0),2))
  );
  SELECT bool_and((v->'pass')::boolean) INTO v_pass FROM jsonb_each(v_checks) e(k, v);
  RETURN jsonb_build_object('pass', v_pass, 'checked_at', now(), 'checks', v_checks);
END $function$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_ca_alarm_drill', 'approved',
        'Weekly alarm drill (hardening round 2 phase 3). Fires every alarm class inside subtransactions that are ALWAYS unwound via RAISE; no chip movement ever persists. Registered so the drift scan does not page on the fire alarm test itself.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

UPDATE public.ca_drift_incidents
   SET status = 'resolved',
       resolved_at = now(),
       root_cause = 'fn_ca_money_rpc_drift correctly flagged fn_ca_alarm_drill (hardening round 2 phase 3) as an unregistered money-touching RPC. The drill only writes inside deliberately-unwound subtransactions, so it is registered as approved rather than changed.',
       resolution = 'Registered fn_ca_alarm_drill in ca_money_rpc_registry (approved). No chip movement was at risk; every drill write rolls back by design.'
 WHERE id = '705e71f0-57a2-4d6e-ac92-57c5c5ad2277' AND status <> 'resolved';

-- Self-contained ACL (repo mirror requirement): CREATE OR REPLACE preserves
-- the live grants (service_role only), but the migration must say so itself.
REVOKE ALL ON FUNCTION public.fn_ca_epoch3_preflight() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_epoch3_preflight() TO service_role;
