-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831160515; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ca_zero_drift_phase1_watchdogs (prod 20260831160515). Canonical body lives in prod schema_migrations -
-- replace this marker byte-exact via scripts/dev/export-applied-migrations.sh.
-- Phase 1: ca_guard_inventory (63 guards) + integrity check; ca_money_rpc_registry + drift scan; supply thresholds; escrow TTL sweep; idempotency retention 30d.

-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PHASE 1/5: STRUCTURAL WATCHDOGS ("who guards the guards")
-- 1. Guard-integrity watchdog: asserts every trigger, cron, constraint,
--    index, function, and grant-revocation the zero-drift system depends on
--    is still in place. A dropped guard raises a CRITICAL incident daily.
-- 2. Money-RPC registry + new-mutation-path detector: any NEW function that
--    writes balance columns and is not registered raises a warning incident.
-- 3. Supply monitor thresholds: |unexplained| > 100 warning / > 1000 critical.
-- 4. Idempotency retention: money keys keep 30 days (was 48 hours).
-- 5. Escrow TTL sweeper: expired-but-active holds raise incidents.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1a. Guard inventory ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_guard_inventory (
  id        int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind      text NOT NULL CHECK (kind IN ('trigger','cron','constraint','index','function','revoked_dml')),
  object_a  text NOT NULL,   -- trigger/constraint/index/function name, cron jobname, or table for revoked_dml
  object_b  text,            -- table name for triggers/constraints/indexes
  note      text,
  active    boolean NOT NULL DEFAULT true
);
ALTER TABLE public.ca_guard_inventory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_guard_inventory FROM anon, authenticated;

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note) VALUES
 -- append-only journal guards
 ('trigger','trg_ca_append_only','chip_ledger','journal immutability'),
 ('trigger','trg_ca_append_only','wallet_transactions','journal immutability'),
 ('trigger','trg_ca_append_only','chip_transactions','journal immutability'),
 ('trigger','trg_ca_append_only','club_wallet_transactions','journal immutability'),
 ('trigger','trg_ca_append_only','union_wallet_transactions','journal immutability'),
 -- ledger enrichment + coverage
 ('trigger','trg_ca_chip_ledger_enrich','chip_ledger','seq/hash/epoch enrichment'),
 ('trigger','trg_ca_autoledger','clubs','auto-journal'),
 ('trigger','trg_ca_autoledger','club_wallets','auto-journal'),
 ('trigger','trg_ca_autoledger','union_wallets','auto-journal'),
 ('trigger','trg_ca_autoledger','unions','auto-journal'),
 ('trigger','trg_ca_autoledger','agents','auto-journal'),
 ('trigger','trg_ca_autoledger','bbj_pools','auto-journal'),
 ('trigger','trg_ca_autoledger','spin_bonus_pools','auto-journal'),
 ('trigger','trg_ca_autoledger','club_members','auto-journal (promo)'),
 ('trigger','trg_club_members_audit_chip_movement','club_members','chip_balance ledger writer'),
 ('trigger','trg_log_seat_stack_exit','table_seats','felt exit evidence'),
 -- browser blocks
 ('trigger','trg_ca_block_browser','union_wallets','browser write block'),
 ('trigger','trg_ca_block_browser','club_wallets','browser write block'),
 ('trigger','trg_ca_block_browser','bbj_pools','browser write block'),
 ('trigger','trg_ca_block_browser','spin_bonus_pools','browser write block'),
 -- incident wiring
 ('trigger','trg_ca_reconcile_log_incident','ledger_reconcile_log','detector -> incident'),
 ('trigger','trg_ca_financial_alert_incident','financial_alerts','detector -> incident'),
 ('trigger','trg_ca_settlement_guard','ca_settlements','state machine'),
 ('trigger','trg_ca_incident_events_append_only','ca_incident_events','audit trail immutability'),
 -- crons
 ('cron','ca-incident-escalation-tick',NULL,'5/10/15/20 escalation'),
 ('cron','ca-auto-reconcile-tick',NULL,'automated repair'),
 ('cron','ca-quick-reconcile-5m',NULL,'quick reconcile'),
 ('cron','ca-supply-snapshot-hourly',NULL,'supply monitor'),
 ('cron','ca-ledger-chain-verify-daily',NULL,'checksum verify'),
 ('cron','ca-bbj-repair-unbanked-15m',NULL,'BBJ self-heal'),
 -- constraints + indexes
 ('constraint','chip_ledger_exact_scale','chip_ledger','2dp exactness'),
 ('constraint','chip_ledger_category_check','chip_ledger','category vocab'),
 ('constraint','chip_ledger_from_type_check','chip_ledger','account vocab'),
 ('constraint','chip_ledger_to_type_check','chip_ledger','account vocab'),
 ('constraint','chip_ledger_positive_amount','chip_ledger','positive amounts'),
 ('index','ux_chip_ledger_idempotency_key','chip_ledger','exactly-once posting'),
 ('index','ux_ca_drift_incidents_open_dedupe','ca_drift_incidents','incident dedupe'),
 ('index','ca_settlements_settlement_type_external_ref_key','ca_settlements','one settlement per obligation'),
 -- core functions
 ('function','fn_ca_raise_drift_incident',NULL,'incident raise'),
 ('function','fn_ca_incident_escalation_tick',NULL,'escalation'),
 ('function','fn_ca_auto_reconcile_tick',NULL,'auto repair'),
 ('function','fn_ca_quick_reconcile',NULL,'quick reconcile'),
 ('function','fn_ca_autoledger',NULL,'auto-journal writer'),
 ('function','fn_ca_journal_append_only',NULL,'immutability'),
 ('function','fn_ca_chip_ledger_enrich',NULL,'enrichment'),
 ('function','fn_ca_verify_ledger_chain',NULL,'checksum verify'),
 ('function','fn_ca_supply_snapshot',NULL,'supply monitor'),
 ('function','fn_bbj_repair_unbanked',NULL,'BBJ self-heal'),
 -- revoked DML (anon/authenticated must hold NO INSERT/UPDATE/DELETE)
 ('revoked_dml','chip_ledger',NULL,'journal'),
 ('revoked_dml','wallet_transactions',NULL,'journal'),
 ('revoked_dml','chip_transactions',NULL,'journal'),
 ('revoked_dml','club_wallet_transactions',NULL,'journal'),
 ('revoked_dml','union_wallet_transactions',NULL,'journal'),
 ('revoked_dml','wallet_credit_idempotency',NULL,'idempotency claims'),
 ('revoked_dml','transaction_idempotency_keys',NULL,'idempotency claims'),
 ('revoked_dml','ca_seat_stack_exits',NULL,'evidence'),
 ('revoked_dml','ledger_reconcile_log',NULL,'detector log')
ON CONFLICT DO NOTHING;

-- ── 1b. Guard integrity check ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_guard_integrity_check()
RETURNS TABLE (kind text, object_a text, object_b text, ok boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g RECORD; v_ok boolean; v_missing int := 0; v_detail jsonb := '[]'::jsonb;
BEGIN
  FOR g IN SELECT * FROM public.ca_guard_inventory WHERE active LOOP
    v_ok := CASE g.kind
      WHEN 'trigger' THEN EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE t.tgname = g.object_a AND c.relname = g.object_b
           AND NOT t.tgisinternal AND t.tgenabled <> 'D')
      WHEN 'cron' THEN EXISTS (
        SELECT 1 FROM cron.job j WHERE j.jobname = g.object_a AND j.active)
      WHEN 'constraint' THEN EXISTS (
        SELECT 1 FROM pg_constraint x JOIN pg_class c ON c.oid = x.conrelid
         WHERE x.conname = g.object_a AND c.relname = g.object_b)
      WHEN 'index' THEN EXISTS (
        SELECT 1 FROM pg_indexes i
         WHERE i.indexname = g.object_a AND i.schemaname = 'public')
        OR EXISTS (SELECT 1 FROM pg_constraint x WHERE x.conname = g.object_a)
      WHEN 'function' THEN EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = g.object_a)
      WHEN 'revoked_dml' THEN NOT EXISTS (
        SELECT 1 FROM information_schema.role_table_grants r
         WHERE r.table_schema = 'public' AND r.table_name = g.object_a
           AND r.grantee IN ('anon','authenticated')
           AND r.privilege_type IN ('INSERT','UPDATE','DELETE'))
      ELSE false END;

    IF NOT v_ok THEN
      v_missing := v_missing + 1;
      v_detail := v_detail || jsonb_build_object('kind', g.kind, 'a', g.object_a, 'b', g.object_b);
    END IF;
    kind := g.kind; object_a := g.object_a; object_b := g.object_b; ok := v_ok;
    RETURN NEXT;
  END LOOP;

  IF v_missing > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_guard_integrity_check', 'unauthorized_adjustment', 'critical',
      'guard-missing:' || CURRENT_DATE::text,
      0, NULL, NULL, 'ledger', 'ca_guard_inventory', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      v_missing || ' zero-drift guard(s) are MISSING or disabled — a protection was dropped',
      false, jsonb_build_object('missing', v_detail));
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_guard_integrity_check() FROM PUBLIC, anon, authenticated;

-- ── 2. Money-RPC registry + new-mutation-path detector ─────────────────────
CREATE TABLE IF NOT EXISTS public.ca_money_rpc_registry (
  proname   text PRIMARY KEY,
  status    text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','legacy','retired','system')),
  notes     text,
  added_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_money_rpc_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_money_rpc_registry FROM anon, authenticated;

-- seed: every function CURRENTLY writing balance columns is grandfathered as
-- audited (the 2026-08-31 audit covered them); NEW arrivals need registration.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT DISTINCT p.proname, 'approved', 'grandfathered at phase-1 baseline (2026-08-31 audit)'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
  AND p.prosrc ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\b'
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_drift()
RETURNS TABLE (proname text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT p.proname AS pn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND p.prosrc ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\b'
      AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = p.proname)
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_money_rpc_drift', 'unauthorized_adjustment', 'warning',
      'rpc-drift:' || r.pn,
      0, NULL, NULL, 'ledger', 'pg_proc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'NEW unregistered function writes balance columns: ' || r.pn
        || ' — audit it, then register it in ca_money_rpc_registry',
      NULL, jsonb_build_object('proname', r.pn));
    proname := r.pn; RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_drift() FROM PUBLIC, anon, authenticated;

-- ── 3. Supply monitor thresholds ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric; v_total numeric;
BEGIN
  SELECT
    (SELECT COALESCE(sum(chip_balance),0) FROM club_members)            AS member_wallets,
    (SELECT COALESCE(sum(promo_balance),0) FROM club_members)           AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND t.tournament_id IS NOT NULL))            AS felt,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs)                  AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs)                      AS chip_pools,
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets)            AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
             +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0)
       FROM union_wallets)                                              AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
             +COALESCE(promo_wallet_balance,0)),0) FROM agents)         AS agent_wallets,
    (SELECT COALESCE(sum(main_balance+backup_balance+promo_balance),0)
       FROM bbj_pools)                                                  AS bbj,
    (SELECT COALESCE(sum(balance),0) FROM spin_bonus_pools)             AS spin,
    (SELECT COALESCE(sum(COALESCE(prize_pool,0) + COALESCE(bounty_pool,0)
                         - COALESCE(bounty_pool_paid,0) + COALESCE(total_rake,0)),0)
       FROM tournaments
      WHERE status NOT IN ('COMPLETED','CANCELLED'))                    AS tourn_liab
  INTO s;

  v_total := s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
           + s.union_wallets + s.agent_wallets + s.bbj + s.spin + s.tourn_liab;

  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;

  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount) FILTER (WHERE from_type IN ('system_mint','issuance_reserve')),0),
           COALESCE(sum(amount) FILTER (WHERE to_type   IN ('system_burn','chip_retirement')),0)
      INTO v_mint, v_burn
      FROM public.chip_ledger
     WHERE created_at > prev.taken_at;
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab, v_total,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END)
  RETURNING unexplained INTO v_unexplained;

  -- thresholds: only when comparable (same column basis on both snapshots)
  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 100 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_supply_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_unexplained) > 1000 THEN 'critical' ELSE 'warning' END,
      'supply-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained, prev.total + COALESCE(v_mint,0) - COALESCE(v_burn,0), v_total,
      'ledger', 'ca_supply_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'total chip supply changed by ' || round(v_unexplained,2)
        || ' beyond ledgered issuance/retirement in the last snapshot interval',
      false, '{}'::jsonb);
  END IF;

  RETURN v_unexplained;
END $$;

-- ── 4. Idempotency retention: 48h -> 30 days ───────────────────────────────
SELECT cron.schedule('prune_idempotency_keys', '0 * * * *',
  $cron$DELETE FROM public.transaction_idempotency_keys WHERE created_at < now() - interval '30 days';$cron$);

-- ── 5. Escrow TTL sweeper (into quick reconcile via standalone fn + cron) ──
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_ttl_sweep()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; n int := 0;
BEGIN
  FOR r IN
    SELECT * FROM chip_escrow_holds
     WHERE status = 'active' AND expires_at IS NOT NULL
       AND expires_at < now() - interval '10 minutes'
     LIMIT 25
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_escrow_ttl_sweep', 'settlement_error', 'warning',
      'escrow-expired:' || r.id::text,
      r.amount, r.amount, 0, 'settlement', 'chip_escrow_holds', r.user_id,
      r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'escrow hold (' || r.hold_type || ') expired ' ||
        floor(extract(epoch FROM now() - r.expires_at)/60) || ' min ago but was never released',
      NULL, jsonb_build_object('hold_id', r.id, 'hold_type', r.hold_type,
                               'related_id', r.related_id, 'expires_at', r.expires_at));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_ttl_sweep() FROM PUBLIC, anon, authenticated;

-- ── 6. Crons ────────────────────────────────────────────────────────────────
SELECT cron.schedule('ca-guard-integrity-daily', '15 5 * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-guard-integrity'))
    THEN (SELECT count(*)::int FROM public.fn_ca_guard_integrity_check() WHERE NOT ok) ELSE -1 END; $cron$);
SELECT cron.schedule('ca-money-rpc-drift-daily', '25 5 * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-money-rpc-drift'))
    THEN (SELECT count(*)::int FROM public.fn_ca_money_rpc_drift()) ELSE -1 END; $cron$);
SELECT cron.schedule('ca-escrow-ttl-sweep-10m', '*/10 * * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-escrow-ttl'))
    THEN (SELECT public.fn_ca_escrow_ttl_sweep()) ELSE -1 END; $cron$);

-- register the new guards in their own inventory
INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note) VALUES
 ('cron','ca-guard-integrity-daily',NULL,'guard watchdog'),
 ('cron','ca-money-rpc-drift-daily',NULL,'RPC drift watchdog'),
 ('cron','ca-escrow-ttl-sweep-10m',NULL,'escrow TTL'),
 ('function','fn_ca_guard_integrity_check',NULL,'guard watchdog'),
 ('function','fn_ca_money_rpc_drift',NULL,'RPC drift watchdog'),
 ('function','fn_ca_escrow_ttl_sweep',NULL,'escrow TTL')
ON CONFLICT DO NOTHING;
