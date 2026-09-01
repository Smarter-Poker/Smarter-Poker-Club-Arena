-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831004654; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- BBJ CONSERVATION DRIFT 71,749.31 — ROOT CAUSE FOUND, GUARDED (2026-08-31)
--
-- Forensic result (full decomposition in docs/changelog): sixteen historical
-- bbj_payouts rows for the union pool f9806a7f — hits paid to real players
-- July 2026 → 2026-08-21 — were DELETED from the ledger between the baseline
-- measurement (2026-08-25 22:23Z) and 2026-08-30, by an un-migrated write.
-- Proof: bbj_pools.total_paid_out (172,740.21) minus surviving payout rows
-- (100,990.90) = 71,749.31, exactly the drift; last_hit_at 2026-08-21 06:04 /
-- last_hit_amount 7,883.95 is only ever stamped in the same transaction as a
-- payout insert, yet the newest surviving union payout row is 2026-08-18;
-- union hit_count 45 = 5 surviving + 24 merged + 16 missing. No player was
-- shorted — the winners were paid when the hits happened; only the RECORDS
-- vanished. bbj_payout_recipients went with them via ON DELETE CASCADE.
--
-- Repair chosen: re-baseline, not reinsertion. bbj_payouts requires
-- winner/loser user ids we cannot recover; fabricating a 71k payout against a
-- real player's name would poison player-facing history. total_paid_out
-- still asserts the truth. The baseline table exists for exactly this:
-- accepted, explained historical residue, tolerance 1.00 so any NEW movement
-- goes red at once.
--
-- Guard added: deleting from bbj_payouts / bbj_winners / bbj_payout_recipients
-- is now LOUD — every deleted row is copied to bbj_ledger_deletions with the
-- role and application that did it, and a critical alert is filed. The
-- trigger never blocks (a guard that can abort a legitimate cleanup can
-- strand a payout path); it makes the failure visible, which is what was
-- missing.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bbj_ledger_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table text NOT NULL,
  row_data jsonb NOT NULL,
  deleted_by_role text NOT NULL DEFAULT current_user,
  application_name text NOT NULL DEFAULT current_setting('application_name', true),
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bbj_ledger_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bbj_ledger_deletions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bbj_ledger_deletions TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_ledger_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.bbj_ledger_deletions (source_table, row_data)
  VALUES (TG_TABLE_NAME, to_jsonb(OLD));
  -- One alert per statement would flood on a cascade; dedupe to one per table per hour.
  IF NOT EXISTS (
    SELECT 1 FROM public.financial_alerts
     WHERE source = 'bbj_ledger_delete_guard'
       AND context->>'table' = TG_TABLE_NAME
       AND created_at > now() - interval '1 hour') THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('critical', 'bbj_ledger_delete_guard',
      'A BBJ ledger row was deleted. The 2026-08 drift incident was exactly this. Review bbj_ledger_deletions.',
      jsonb_build_object('table', TG_TABLE_NAME, 'role', current_user,
                         'app', current_setting('application_name', true)));
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.fn_bbj_ledger_delete_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bbj_payouts_delete_guard ON public.bbj_payouts;
CREATE TRIGGER trg_bbj_payouts_delete_guard BEFORE DELETE ON public.bbj_payouts
  FOR EACH ROW EXECUTE FUNCTION public.fn_bbj_ledger_delete_guard();
DROP TRIGGER IF EXISTS trg_bbj_winners_delete_guard ON public.bbj_winners;
CREATE TRIGGER trg_bbj_winners_delete_guard BEFORE DELETE ON public.bbj_winners
  FOR EACH ROW EXECUTE FUNCTION public.fn_bbj_ledger_delete_guard();
DROP TRIGGER IF EXISTS trg_bbj_recipients_delete_guard ON public.bbj_payout_recipients;
CREATE TRIGGER trg_bbj_recipients_delete_guard BEFORE DELETE ON public.bbj_payout_recipients
  FOR EACH ROW EXECUTE FUNCTION public.fn_bbj_ledger_delete_guard();

-- Re-baseline to the measured, explained gap.
UPDATE public.bbj_conservation_baseline
   SET baseline_gap = 74321.90,
       tolerance = 1.00,
       measured_at = now(),
       note = 'Re-measured 2026-08-31. Composition: 2,572.59 accepted 2026-08-25 residue (see prior note) + 71,749.31 from sixteen union-pool bbj_payouts rows (hits paid Jul->Aug 21) DELETED from the ledger between 2026-08-25 22:23Z and 2026-08-30 by an un-migrated write. Winners were genuinely paid at hit time; only records were destroyed (recipients cascaded). Fingerprint: total_paid_out 172,740.21 - surviving rows 100,990.90 = 71,749.31 exactly. Deletions are now logged by fn_bbj_ledger_delete_guard. Tolerance stays 1.00.'
 WHERE id = 1;

-- Stale/disposed alerts:
-- (a) fn_rake_bbj_audit outage-day alerts: every sampled hand rechecked; the
--     live audit now returns 0 violations (unbanked fees were requeued and
--     banked by earlier repairs).
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_rake_bbj_audit' AND resolved IS NOT TRUE
   AND (SELECT (fn_rake_bbj_audit()->>'violations')::int) = 0;
-- (b) FeeReconciler.exhausted: its pending row 85215f50 is resolved (banked).
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'FeeReconciler.exhausted' AND resolved IS NOT TRUE
   AND EXISTS (SELECT 1 FROM public.pending_fee_distributions
                WHERE id = '85215f50-5396-4631-82d4-5f65f5e2c3f0' AND resolved_at IS NOT NULL);
-- (c) bbj checkpoint drift alert (2026-08-21): fn_bbj_contributions_total_verify now reports drift 0.
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_bbj_contributions_total_verify' AND resolved IS NOT TRUE
   AND (SELECT (fn_bbj_contributions_total_verify()->>'drift')::numeric) = 0;
-- (d) fn_apply_prize_guarantee negative-treasury (2026-08-29): treasury recovered to 0.00;
--     the alert's own escalation rule was 'escalate if it survives a weekly close'.
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_apply_prize_guarantee' AND resolved IS NOT TRUE
   AND (SELECT chip_treasury >= 0 FROM public.clubs WHERE id = 'fade0000-0000-0000-0000-000000000001');
-- (e) fn_tournament_payout_reconcile: a 0.01 rounding overpay, reported-only by design.
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_tournament_payout_reconcile' AND resolved IS NOT TRUE
   AND (context->'issues'->0->>'excess')::numeric <= 0.01;
-- (f) the old bbj_pool_conservation_drift alert: superseded by the re-baseline above.
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_union_treasury_selftest' AND resolved IS NOT TRUE
   AND context->>'check' = 'bbj_pool_conservation_drift';
-- KEPT OPEN on purpose: lapsed_week_unclosed + rakeback_settler_lagging (phase 3 work)
-- and mystery_bounty_double_pay_backlog (Dan's decision, not an agent's).

-- ASSERTIONS
DO $$
DECLARE v jsonb; n int;
BEGIN
  v := fn_bbj_conservation_check();
  IF (v->>'healthy')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'conservation still unhealthy after re-baseline: %', v;
  END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgname LIKE 'trg_bbj_%_delete_guard';
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 delete guards, found %', n; END IF;
  SELECT count(*) INTO n FROM financial_alerts WHERE resolved IS NOT TRUE AND severity='critical';
  RAISE NOTICE 'unresolved criticals remaining: %', n;
END $$;

