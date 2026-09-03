-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831193559; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ZERO-DRIFT PHASE 5 - PROMO QUEUE + MIDWAY BURN-IN GATE (prod ~19:57 UTC;
-- canonical body in prod schema_migrations - export via
-- scripts/dev/export-applied-migrations.sh)
-- ca_pending_promo_accruals + fn_ca_retry_promo_accruals + cron
-- ca-promo-accrual-retry-10m: failed promo_apply_playthrough calls queue and
-- re-drive instead of vanishing (same pattern as pending_fee_distributions).
-- fn_ca_midway_burnin_gate(hours): the doc-05 §3 acceptance gate - eleven
-- named pass/fail checks (criticals, unknowns, suspense, write failures,
-- blocked tournament mints, failed/stuck settlements, checksum chain,
-- structural guards, unregistered RPCs, supply explained); reopening Midway/
-- Shark/JAQK requires pass:true over 24h of horse-only play post epoch-3.

-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PHASE 5 — PROMO-ACCRUAL QUEUE + MIDWAY BURN-IN GATE
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. ca_pending_promo_accruals: when the engine's promo_apply_playthrough
--    RPC call fails (e.g. a PostgREST schema-reload window — the same class
--    that dropped rake-queue writes at 19:23 today), the wagered amount is
--    queued here instead of vanishing. fn_ca_retry_promo_accruals re-drives
--    the queue every 10 minutes through the real (locked-down) RPC, exactly
--    like pending_fee_distributions does for rake. The engine-side patch
--    that enqueues on failure ships as a repo draft.
-- 2. fn_ca_midway_burnin_gate(p_hours): THE acceptance gate from doc 05 §3
--    step 6 — one call answers "may Midway/Shark/JAQK reopen?". Every
--    criterion is checked over the burn-in window and reported pass/fail;
--    overall pass requires ALL of them. Read-only; locks nothing.
CREATE TABLE IF NOT EXISTS public.ca_pending_promo_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  wagered numeric NOT NULL CHECK (wagered > 0),
  hand_id uuid,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ca_promo_accruals_pending
  ON public.ca_pending_promo_accruals (created_at) WHERE resolved_at IS NULL;
REVOKE ALL ON public.ca_pending_promo_accruals FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_retry_promo_accruals(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record; v_res jsonb; v_ok int := 0; v_failed int := 0;
BEGIN
  FOR r IN SELECT * FROM public.ca_pending_promo_accruals
           WHERE resolved_at IS NULL ORDER BY created_at
           LIMIT GREATEST(COALESCE(p_limit,200),1)
  LOOP
    BEGIN
      v_res := public.promo_apply_playthrough(r.club_id, r.user_id, r.wagered);
      UPDATE public.ca_pending_promo_accruals
         SET resolved_at = now(), attempts = attempts + 1, last_attempt_at = now(),
             last_error = NULL
       WHERE id = r.id;
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.ca_pending_promo_accruals
         SET attempts = attempts + 1, last_attempt_at = now(), last_error = left(SQLERRM, 500)
       WHERE id = r.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'redriven', v_ok, 'failed', v_failed);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_retry_promo_accruals(integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-promo-accrual-retry-10m', '4,14,24,34,44,54 * * * *',
  $$SELECT public.fn_ca_retry_promo_accruals(200);$$);

-- ── the burn-in gate ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_midway_burnin_gate(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(p_hours, 1));
  c_open_criticals integer; c_new_criticals integer; c_unresolved_unknown integer;
  c_suspense_rows integer; c_suspense_chips numeric;
  c_write_failures integer; c_mint_incidents integer;
  c_failed_settlements integer; c_stuck_settlements integer;
  v_chain record; c_guards_missing integer; c_rpc_drift integer;
  v_supply record; v_checks jsonb; v_pass boolean;
BEGIN
  SELECT count(*) FILTER (WHERE status <> 'resolved' AND severity = 'critical'),
         count(*) FILTER (WHERE severity = 'critical' AND detected_at > v_since),
         count(*) FILTER (WHERE status <> 'resolved' AND classification = 'unknown' AND severity <> 'info')
    INTO c_open_criticals, c_new_criticals, c_unresolved_unknown
    FROM public.ca_drift_incidents;

  SELECT count(*), COALESCE(sum(amount),0) INTO c_suspense_rows, c_suspense_chips
    FROM public.chip_ledger
   WHERE (from_type='settlement_suspense' OR to_type='settlement_suspense')
     AND created_at > GREATEST(v_since, '2026-08-31 19:01:00+00'::timestamptz);

  SELECT count(*) INTO c_write_failures FROM public.ca_ledger_write_failures WHERE occurred_at > v_since;

  SELECT count(*) INTO c_mint_incidents FROM public.ca_drift_incidents
   WHERE dedupe_key LIKE 'tourney-cashout-blocked:%' AND detected_at > v_since AND status <> 'resolved';

  SELECT count(*) FILTER (WHERE state = 'failed'),
         count(*) FILTER (WHERE state NOT IN ('final','failed') AND updated_at < now() - interval '10 minutes')
    INTO c_failed_settlements, c_stuck_settlements
    FROM public.ca_settlements WHERE updated_at > v_since;

  SELECT * INTO v_chain FROM public.fn_ca_verify_ledger_chain(50000);

  SELECT count(*) INTO c_guards_missing FROM (
    SELECT g.id FROM public.ca_guard_inventory g WHERE g.active
    EXCEPT SELECT g2.id FROM public.ca_guard_inventory g2 WHERE g2.active AND (
      (g2.kind='trigger'     AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname=g2.object_a AND NOT t.tgisinternal)) OR
      (g2.kind='cron'        AND EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname=g2.object_a AND j.active)) OR
      (g2.kind='function'    AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=g2.object_a)) OR
      (g2.kind NOT IN ('trigger','cron','function'))
    )) miss;

  SELECT count(*) INTO c_rpc_drift FROM public.fn_ca_money_rpc_drift();

  SELECT s.unexplained, s.taken_at INTO v_supply
    FROM public.ca_supply_snapshots s ORDER BY s.taken_at DESC LIMIT 1;

  v_checks := jsonb_build_object(
    'no_open_critical_incidents',        jsonb_build_object('pass', c_open_criticals = 0, 'value', c_open_criticals),
    'no_new_criticals_in_window',        jsonb_build_object('pass', c_new_criticals = 0, 'value', c_new_criticals),
    'no_unresolved_unknowns',            jsonb_build_object('pass', c_unresolved_unknown = 0, 'value', c_unresolved_unknown),
    'zero_suspense_flow',                jsonb_build_object('pass', c_suspense_rows = 0, 'rows', c_suspense_rows, 'chips', round(c_suspense_chips,2)),
    'zero_ledger_write_failures',        jsonb_build_object('pass', c_write_failures = 0, 'value', c_write_failures),
    'zero_blocked_tournament_mints',     jsonb_build_object('pass', c_mint_incidents = 0, 'value', c_mint_incidents),
    'no_failed_or_stuck_settlements',    jsonb_build_object('pass', c_failed_settlements = 0 AND c_stuck_settlements = 0, 'failed', c_failed_settlements, 'stuck', c_stuck_settlements),
    'ledger_chain_clean',                jsonb_build_object('pass', COALESCE(v_chain.breaks,0) = 0, 'checked', COALESCE(v_chain.checked,0), 'breaks', COALESCE(v_chain.breaks,0)),
    'all_structural_guards_present',     jsonb_build_object('pass', c_guards_missing = 0, 'missing', c_guards_missing),
    'no_unregistered_money_rpcs',        jsonb_build_object('pass', c_rpc_drift = 0, 'value', c_rpc_drift),
    'last_supply_snapshot_explained',    jsonb_build_object('pass', abs(COALESCE(v_supply.unexplained, 0)) <= 100, 'unexplained', round(COALESCE(v_supply.unexplained,0),2), 'taken_at', v_supply.taken_at)
  );

  SELECT bool_and((v->'pass')::boolean) INTO v_pass FROM jsonb_each(v_checks) AS e(k, v);

  RETURN jsonb_build_object(
    'gate', CASE WHEN v_pass THEN 'PASS — hardened accounting proven for this window' ELSE 'FAIL — do not restart Midway/Shark/JAQK yet' END,
    'pass', v_pass, 'window_hours', p_hours, 'since', v_since, 'checked_at', now(),
    'checks', v_checks);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_midway_burnin_gate(integer) FROM PUBLIC, anon, authenticated;

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
VALUES
  ('function', 'fn_ca_retry_promo_accruals', NULL, 'phase 5: promo accrual retry queue', true),
  ('function', 'fn_ca_midway_burnin_gate', NULL, 'phase 5: Midway epoch-3 acceptance gate', true),
  ('cron', 'ca-promo-accrual-retry-10m', NULL, 'phase 5: promo accrual redrive every 10 min', true)
ON CONFLICT DO NOTHING;
INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_ca_retry_promo_accruals', 'phase 5: redrives promo_apply_playthrough from queue'),
       ('fn_ca_midway_burnin_gate', 'phase 5: read-only acceptance gate')
ON CONFLICT DO NOTHING;
