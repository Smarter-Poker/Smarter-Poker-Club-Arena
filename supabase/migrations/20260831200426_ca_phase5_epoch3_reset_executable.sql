-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831200426; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_phase5_epoch3_reset_executable (prod 20260831200426). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 5: fn_ca_epoch3_preflight + fn_ca_execute_epoch3_reset (dry-run default; execute needs literal confirm + passing preflight; retires horse mint + frozen wallets pool, opens epoch 3).

-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PHASE 5 — THE MIDWAY EPOCH-3 RESET, EXECUTABLE
-- ═══════════════════════════════════════════════════════════════════════════
-- Doc 05 §3, turned into two functions so nothing about the reset lives in a
-- runbook only a human can follow:
--
-- fn_ca_epoch3_preflight(): the §3 step-2/3 checks as one read-only call —
--   zero open non-info incidents, zero suspense since the phase-2 cutover,
--   zero ledger-write failures (24h), checksum chain clean, all structural
--   guards present, no unregistered money RPCs, and a fresh supply snapshot
--   available. Returns pass/fail per check.
--
-- fn_ca_execute_epoch3_reset(p_confirm, p_dry_run DEFAULT true): the §3
--   step-4/5 ledgered reset. DRY-RUN BY DEFAULT — reports exactly what it
--   would retire, moves nothing. Execute mode requires BOTH the literal
--   confirmation 'MIDWAY-EPOCH-3-RESET' AND a passing preflight, and then in
--   ONE correlated transaction:
--     1. Retires the tournament-cashout horse mint: every wallet credit the
--        blocked bug created (horse cashouts from tournament-attached tables,
--        measured per user from wallet_transactions) is debited back —
--        capped at the current balance so no wallet goes negative — and each
--        debit auto-journals as 'burn' vs chip_retirement.
--     2. Retires the frozen public.wallets pool (stranded 2026-08-21,
--        732.59M): balances zeroed under the audited maintenance escape,
--        one ledgered 'burn' row per non-zero wallet against chip_retirement.
--     3. Closes epoch 2, opens epoch 3 ('epoch-3-midway-reset'), re-baselines
--        treasuries and the frozen pool, and takes a fresh supply snapshot.
--   Nothing is locked, closed, or frozen; play continues throughout. After
--   execution the §3 step-6 gate applies: fn_ca_midway_burnin_gate(24) must
--   pass over horse-only play before Midway/Shark/JAQK reopen normal tables.
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
     AND created_at > '2026-08-31 19:01:00+00';
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

REVOKE ALL ON FUNCTION public.fn_ca_epoch3_preflight() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_execute_epoch3_reset(
  p_confirm text DEFAULT NULL,
  p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pre jsonb; v_corr uuid := gen_random_uuid();
  v_mint_users integer; v_mint_total numeric;
  v_frozen_rows integer; v_frozen_total numeric;
  r record; v_take numeric; v_retired_mint numeric := 0; v_retired_frozen numeric := 0;
  v_epoch integer;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'epoch-3 reset is operator-only';
  END IF;

  -- measure the horse mint per user (credits from tournament-attached tables)
  CREATE TEMP TABLE IF NOT EXISTS _mint (user_id uuid, minted numeric) ON COMMIT DROP;
  DELETE FROM _mint;
  INSERT INTO _mint
  SELECT wt.user_id, round(sum(wt.amount), 2)
  FROM public.wallet_transactions wt
  JOIN public.profiles p ON p.id = wt.user_id AND p.is_horse
  WHERE wt.amount > 0 AND wt.category IN ('cashout','table_cashout')
    AND wt.table_id IN (SELECT id FROM public.tables WHERE tournament_id IS NOT NULL)
  GROUP BY wt.user_id;
  SELECT count(*), COALESCE(round(sum(minted),2),0) INTO v_mint_users, v_mint_total FROM _mint;

  SELECT count(*), COALESCE(round(sum(balance),2),0) INTO v_frozen_rows, v_frozen_total
    FROM public.wallets WHERE COALESCE(balance,0) <> 0;

  v_pre := public.fn_ca_epoch3_preflight();

  IF p_dry_run THEN
    RETURN jsonb_build_object('dry_run', true, 'would_execute', false,
      'preflight', v_pre,
      'horse_mint_to_retire', jsonb_build_object('users', v_mint_users, 'total', v_mint_total),
      'frozen_pool_to_retire', jsonb_build_object('wallets', v_frozen_rows, 'total', v_frozen_total),
      'correlation_id_preview', v_corr,
      'note', 'run with p_confirm => ''MIDWAY-EPOCH-3-RESET'', p_dry_run => false to execute; preflight must pass');
  END IF;

  IF p_confirm IS DISTINCT FROM 'MIDWAY-EPOCH-3-RESET' THEN
    RAISE EXCEPTION 'epoch-3 reset refused: confirmation literal missing';
  END IF;
  IF NOT COALESCE((v_pre->>'pass')::boolean, false) THEN
    RAISE EXCEPTION 'epoch-3 reset refused: preflight failing — %', v_pre->'checks';
  END IF;

  -- ── 1. retire the horse tournament-cashout mint, ledgered per wallet ──
  PERFORM set_config('app.ledger_category', 'burn', true);
  PERFORM set_config('app.ledger_counterparty', 'chip_retirement', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_correlation', v_corr::text, true);
  FOR r IN SELECT m.user_id, m.minted FROM _mint m WHERE m.minted > 0 LOOP
    -- cap at what the wallet still holds across clubs, largest balances first
    FOR v_take IN
      SELECT LEAST(cm.chip_balance, r.minted) FROM public.club_members cm
       WHERE cm.user_id = r.user_id AND cm.chip_balance > 0
       ORDER BY cm.chip_balance DESC LIMIT 1
    LOOP
      UPDATE public.club_members cm
         SET chip_balance = round(chip_balance - v_take, 2), updated_at = now()
       WHERE cm.user_id = r.user_id
         AND cm.club_id = (SELECT cm2.club_id FROM public.club_members cm2
                            WHERE cm2.user_id = r.user_id AND cm2.chip_balance > 0
                            ORDER BY cm2.chip_balance DESC LIMIT 1);
      v_retired_mint := v_retired_mint + v_take;
    END LOOP;
  END LOOP;

  -- ── 2. retire the frozen public.wallets pool under the audited escape ──
  PERFORM set_config('app.ledger_maintenance',
    'epoch-3 reset ' || v_corr::text || ' — formal retirement of the frozen 2026-08-21 wallets pool (doc 05 §3)', true);
  INSERT INTO public.chip_ledger
    (performed_by, from_type, from_entity_id, to_type, to_entity_id, amount, category,
     correlation_id, description)
  SELECT '2d1cd6c3-5700-4af9-a271-d4863fdab20d', 'player_wallet', w.user_id,
         'chip_retirement', NULL, round(w.balance, 2), 'burn', v_corr,
         'epoch-3: retirement of frozen legacy wallet balance'
  FROM public.wallets w WHERE COALESCE(w.balance, 0) > 0;
  UPDATE public.wallets SET balance = 0, updated_at = now() WHERE COALESCE(balance,0) <> 0;
  v_retired_frozen := v_frozen_total;

  -- ── 3. close epoch 2, open epoch 3, re-baseline, snapshot ──
  UPDATE public.ca_financial_epochs SET is_current = false, ended_at = now() WHERE is_current;
  INSERT INTO public.ca_financial_epochs (name, description, started_at, is_current)
  VALUES ('epoch-3-midway-reset',
          'Midway master reset on the hardened ledger: horse tournament-mint retired ('
            || round(v_retired_mint,2) || '), frozen 2026-08-21 pool retired ('
            || round(v_retired_frozen,2) || '), correlation ' || v_corr,
          now(), true)
  RETURNING id INTO v_epoch;

  DELETE FROM public.ca_treasury_baseline;
  INSERT INTO public.ca_treasury_baseline (club_id, opening_balance, ledger_at_baseline, unledgered_gap, taken_at)
  SELECT c.id, COALESCE(c.chip_treasury,0), COALESCE(c.chip_treasury,0), 0, now() FROM public.clubs c;
  INSERT INTO public.ca_frozen_pool_baseline (pool, frozen_total, frozen_at, note)
  VALUES ('public.wallets', 0, now(), 'epoch-3: pool formally retired, correlation ' || v_corr);
  PERFORM public.fn_ca_supply_snapshot();

  RETURN jsonb_build_object('executed', true, 'epoch', v_epoch, 'correlation_id', v_corr,
    'horse_mint_retired', round(v_retired_mint, 2),
    'frozen_pool_retired', round(v_retired_frozen, 2),
    'next', 'fn_ca_midway_burnin_gate(24) must pass over horse-only play before Midway/Shark/JAQK reopen');
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_execute_epoch3_reset(text, boolean) FROM PUBLIC, anon, authenticated;

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
VALUES ('function', 'fn_ca_epoch3_preflight', NULL, 'phase 5: epoch-3 preflight', true),
       ('function', 'fn_ca_execute_epoch3_reset', NULL, 'phase 5: gated epoch-3 reset', true)
ON CONFLICT DO NOTHING;
INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_ca_epoch3_preflight', 'phase 5: read-only'),
       ('fn_ca_execute_epoch3_reset', 'phase 5: gated + confirmed + dry-run-default reset; ledgered retirements only')
ON CONFLICT DO NOTHING;
