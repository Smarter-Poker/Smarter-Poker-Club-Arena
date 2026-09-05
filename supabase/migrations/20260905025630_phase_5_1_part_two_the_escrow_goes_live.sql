-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 5.1, PART TWO - THE ESCROW GOES LIVE (chip standard, 2026-09-04).
-- Applied inside the :55 platform freeze, when the money tables are quiet:
-- the live events are opened from the shadow and the six triggers are
-- created in the same transaction, so no event is opened stale and no path
-- runs without its trigger. See the part-one header (the_escrow_becomes_a_
-- balance) for what the balance is and how it is kept.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The events open right now are opened from the shadow ──────────────────
DO $$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN SELECT t.id FROM public.tournaments t
            WHERE t.status IN ('REGISTERING', 'RUNNING', 'COMPLETING', 'LATE_REGISTRATION', 'PAUSED', 'SCHEDULED', 'ANNOUNCED')
              AND COALESCE(t.ended_at, t.updated_at, t.created_at) > now() - interval '7 days'
  LOOP
    PERFORM public.fn_ca_escrow_apply(r.id, 'opened at promotion');
    v_n := v_n + 1;
  END LOOP;
  IF v_n < 300 THEN RAISE EXCEPTION 'expected the ~400 open events to be opened, found %', v_n; END IF;
  RAISE NOTICE 'opened % live events from the shadow', v_n;
END $$;

-- ── LAST: the triggers (each takes a brief lock on a busy table) ───────────
DROP TRIGGER IF EXISTS zz_ca_escrow_wallet_tx ON public.wallet_transactions;
CREATE TRIGGER zz_ca_escrow_wallet_tx AFTER INSERT ON public.wallet_transactions
  FOR EACH ROW WHEN (NEW.related_entity_id IS NOT NULL) EXECUTE FUNCTION public.fn_ca_escrow_on_wallet_tx();
DROP TRIGGER IF EXISTS zz_ca_escrow_rake_record ON public.rake_records;
CREATE TRIGGER zz_ca_escrow_rake_record AFTER INSERT ON public.rake_records
  FOR EACH ROW WHEN (NEW.is_tournament IS TRUE AND NEW.tournament_id IS NOT NULL) EXECUTE FUNCTION public.fn_ca_escrow_on_rake_record();
DROP TRIGGER IF EXISTS zz_ca_escrow_overlay_leg ON public.chip_ledger;
CREATE TRIGGER zz_ca_escrow_overlay_leg AFTER INSERT ON public.chip_ledger
  FOR EACH ROW WHEN (NEW.to_type = 'prize_liability' AND (NEW.category = 'overlay' OR (NEW.category = 'correction' AND NEW.from_type IN ('union_bank', 'club_treasury'))))
  EXECUTE FUNCTION public.fn_ca_escrow_on_overlay_leg();
DROP TRIGGER IF EXISTS zz_ca_escrow_seat_payout ON public.tournament_payouts;
CREATE TRIGGER zz_ca_escrow_seat_payout AFTER INSERT ON public.tournament_payouts
  FOR EACH ROW WHEN (NEW.source = 'satellite_seat') EXECUTE FUNCTION public.fn_ca_escrow_on_seat_payout();
DROP TRIGGER IF EXISTS zz_ca_escrow_rake_settlement ON public.tournament_rake_settlements;
CREATE TRIGGER zz_ca_escrow_rake_settlement AFTER INSERT OR UPDATE OF settled_at ON public.tournament_rake_settlements
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_escrow_on_rake_settlement();
DROP TRIGGER IF EXISTS zz_ca_escrow_close ON public.tournaments;
CREATE TRIGGER zz_ca_escrow_close AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED') EXECUTE FUNCTION public.fn_ca_escrow_on_close();

-- The hourly drift check covers the hour it runs for (part one appended it
-- with a three-hour window; one hour is the cadence and a third of the cost).
DO $$
DECLARE v_id bigint; v_cmd text;
BEGIN
  SELECT jobid, command INTO v_id, v_cmd FROM cron.job WHERE jobname = 'ca-escrow-shadow-hourly';
  IF v_cmd LIKE '%fn_ca_escrow_balance_drift(3)%' THEN
    PERFORM cron.alter_job(v_id, command => replace(v_cmd, 'fn_ca_escrow_balance_drift(3)', 'fn_ca_escrow_balance_drift(1)'));
  END IF;
END $$;

-- Every trigger on a money table is declared (another agent's guard, 09-04).
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES
  ('wallet_transactions', 'zz_ca_escrow_wallet_tx', 'chip standard Phase 5.1: maintains tournament_escrow from entries, prizes, bounties, refunds'),
  ('rake_records', 'zz_ca_escrow_rake_record', 'chip standard Phase 5.1: maintains tournament_escrow from the fee per entry and the satellite seat'),
  ('chip_ledger', 'zz_ca_escrow_overlay_leg', 'chip standard Phase 5.1: maintains tournament_escrow from overlay legs'),
  ('tournament_payouts', 'zz_ca_escrow_seat_payout', 'chip standard Phase 5.1: maintains tournament_escrow from satellite seats paid in kind'),
  ('tournament_rake_settlements', 'zz_ca_escrow_rake_settlement', 'chip standard Phase 5.1: maintains tournament_escrow when the fee settles'),
  ('tournaments', 'zz_ca_escrow_close', 'chip standard Phase 5.1: R5 at COMPLETED, reported')
ON CONFLICT (table_name, trigger_name) DO NOTHING;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_trigger WHERE tgname LIKE 'zz_ca_escrow_%';
  IF v_n <> 6 THEN RAISE EXCEPTION 'expected 6 escrow triggers, found %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.fn_undeclared_money_triggers() u WHERE u.trigger_name LIKE 'zz_ca_escrow_%') THEN
    RAISE EXCEPTION 'an escrow trigger is undeclared';
  END IF;
END $$;
