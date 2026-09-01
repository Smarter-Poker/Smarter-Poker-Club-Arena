-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- ═══════════════════════════════════════════════════════════════════════════
-- HARDENING ROUND 2, PHASE 2: the watchers widen.
--   A. Mint-velocity circuit watch: minting is rare by design. An accidental
--      mint loop should page in minutes, not at the next hourly snapshot.
--      Detects only - nothing is ever blocked.
--   B. Guard-definition drift watch: the alarm functions themselves are now
--      checksummed. Any session that rewrites one (the way the scope filter
--      was added to the raise path unannounced) surfaces on the dashboard
--      within the hour, once per change, with the old and new hash.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A. mint velocity ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_mint_velocity_watch()
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_mint numeric; v_burn numeric;
BEGIN
  SELECT COALESCE(sum(amount) FILTER (WHERE from_type IN ('system_mint','issuance_reserve')), 0),
         COALESCE(sum(amount) FILTER (WHERE to_type   IN ('system_burn','chip_retirement')), 0)
    INTO v_mint, v_burn
    FROM public.chip_ledger
   WHERE created_at > now() - interval '10 minutes';

  IF v_mint > 250000 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_mint_velocity_watch', 'ledger_imbalance',
      CASE WHEN v_mint > 1000000 THEN 'critical' ELSE 'warning' END,
      'mint-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_mint, 250000, v_mint, 'ledger', 'chip_ledger',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      round(v_mint, 2) || ' chips minted in 10 minutes - far above the expected trickle; if this is not a deliberate batch (mass club creation, epoch reset), a mint loop is running',
      true, jsonb_build_object('mint_10m', round(v_mint,2), 'burn_10m', round(v_burn,2)));
  END IF;

  IF v_burn > 1000000 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_mint_velocity_watch', 'ledger_imbalance', 'warning',
      'burn-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_burn, 1000000, v_burn, 'ledger', 'chip_ledger',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      round(v_burn, 2) || ' chips burned in 10 minutes - expected only during an epoch reset or a mass cleanup; verify the operation is deliberate',
      true, jsonb_build_object('mint_10m', round(v_mint,2), 'burn_10m', round(v_burn,2)));
  END IF;

  RETURN v_mint;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_velocity_watch() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-mint-velocity-5m', '*/5 * * * *',
  $$SELECT public.fn_ca_mint_velocity_watch()$$);

-- ── B. guard-definition drift ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_guard_defs (
  proname   text PRIMARY KEY,
  def_hash  text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ca_guard_defs IS
  'Hardening round 2: checksums of the alarm stack''s own function bodies. fn_ca_guard_defs_watch notices any change once, files a dashboard incident, and re-baselines.';
ALTER TABLE public.ca_guard_defs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_guard_defs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure'
    ]) x)
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_guard_watchlist() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_defs_watch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name text; v_hash text; v_stored text; v_changes int := 0;
BEGIN
  FOREACH v_name IN ARRAY public.fn_ca_guard_watchlist()
  LOOP
    SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
      INTO v_hash
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_hash IS NULL THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_guard_defs_watch', 'unknown', 'warning',
        'guard-def-missing:' || v_name,
        0, NULL, NULL, 'reporting', 'pg_proc',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'guard function ' || v_name || ' no longer exists - an alarm was deleted',
        true, jsonb_build_object('guard', v_name));
      v_changes := v_changes + 1;
      CONTINUE;
    END IF;

    SELECT def_hash INTO v_stored FROM public.ca_guard_defs WHERE proname = v_name;
    IF v_stored IS NULL THEN
      INSERT INTO public.ca_guard_defs (proname, def_hash) VALUES (v_name, v_hash)
      ON CONFLICT (proname) DO NOTHING;
    ELSIF v_stored <> v_hash THEN
      v_changes := v_changes + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_guard_defs_watch', 'unknown', 'info',
        'guard-def-drift:' || v_name || ':' || left(v_hash, 12),
        0, NULL, NULL, 'reporting', 'pg_proc',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'guard function ' || v_name || ' was redefined since its last baseline - review the change, then this notice self-clears (noticed once per change)',
        true, jsonb_build_object('guard', v_name, 'old_hash', v_stored, 'new_hash', v_hash));
      UPDATE public.ca_guard_defs
         SET def_hash = v_hash, updated_at = now() WHERE proname = v_name;
    END IF;
  END LOOP;
  RETURN v_changes;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_guard_defs_watch() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-guard-defs-hourly', '25 * * * *',
  $$SELECT public.fn_ca_guard_defs_watch()$$);

-- baseline now, silently
SELECT public.fn_ca_guard_defs_watch();

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT v.k, v.a, NULL, v.note, true FROM (VALUES
 ('cron', 'ca-mint-velocity-5m', 'mint/burn velocity circuit watch, detect-only'),
 ('cron', 'ca-guard-defs-hourly', 'checksums the alarm stack''s own function bodies, notices changes once')
) AS v(k, a, note)
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory g WHERE g.object_a = v.a);;
