-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827011252; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE NIGHTLY CHECK MUST CARRY SIGNAL
-- ═══════════════════════════════════════════════════════════════════════════
-- reconcile_ledger_nightly() reported 575 CRITICAL rows every night for at
-- least ten consecutive nights. Every one compared public.wallets -- frozen
-- since 2026-08-21 00:59:34, zero writes since, 732,591,994.33 chips stranded
-- -- against a ledger that had already stopped on 2026-05-03. Two dead things,
-- disagreeing by exactly 46,316,237.17 on the 25th and again on the 26th.
--
-- That is why nobody noticed the audit trail had flatlined for 115 days. The
-- signal existed; it was buried under 575 nightly copies of a finding about a
-- table nothing reads.
--
-- This does NOT rewrite reconcile_ledger_nightly (6KB of money-adjacent SQL,
-- and rewriting it from a partial read is how this kind of thing goes wrong).
-- It adds the summary the operator should actually be paged on, composed of
-- the checks that are now real:
--
--   * is the ledger recording at all                 fn_ledger_liveness
--   * did anything drift since auditing was restored fn_chip_drift_since_baseline
--   * is the trigger losing rows                     ca_ledger_write_failures
--   * did chips leave the felt unaccounted           fn_unaccounted_seat_exits
--
-- public.wallets is reported as frozen legacy, with its number, and is not
-- allowed to raise a critical: it cannot change, so it cannot be news.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_chip_integrity_report()
RETURNS TABLE (check_name text, severity text, detail text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sev text; v_finding text; v_days integer;
  v_drift_rows bigint; v_worst numeric;
  v_fail bigint; v_exits bigint;
  v_frozen numeric; v_last_write timestamptz;
BEGIN
  -- 1. Is the audit trail recording at all?
  SELECT l.severity, l.finding, l.silent_for_days
    INTO v_sev, v_finding, v_days
    FROM public.fn_ledger_liveness() l;
  check_name := 'ledger_liveness'; severity := v_sev; detail := v_finding;
  RETURN NEXT;

  -- 2. Drift since auditing was restored. This is the one that means chips
  --    moved on our watch without a record.
  SELECT count(*) FILTER (WHERE abs(d.drift) > 0.01),
         COALESCE(max(abs(d.drift)), 0)
    INTO v_drift_rows, v_worst
    FROM public.fn_chip_drift_since_baseline() d;
  check_name := 'drift_since_baseline';
  severity   := CASE WHEN v_drift_rows = 0 THEN 'ok'
                     WHEN v_worst <= 1 THEN 'warn' ELSE 'critical' END;
  detail     := format('%s member(s) drifting, worst %s. Baseline 2026-08-26; '
                       || 'pre-baseline history does not exist and is excluded.',
                       v_drift_rows, round(v_worst, 2));
  RETURN NEXT;

  -- 3. Is the audit trigger itself losing rows? It may never refuse a money
  --    write, so its failures are counted rather than raised.
  SELECT count(*) INTO v_fail FROM public.ca_ledger_write_failures;
  check_name := 'ledger_write_failures';
  severity   := CASE WHEN v_fail = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s swallowed ledger write(s). Non-zero means the audit '
                       || 'trail is losing rows right now.', v_fail);
  RETURN NEXT;

  -- 4. Chips leaving the felt with no matching wallet credit (CLAUDE.md 11.5).
  SELECT count(*) INTO v_exits FROM public.fn_unaccounted_seat_exits();
  check_name := 'unaccounted_seat_exits';
  severity   := CASE WHEN v_exits = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s seat exit(s) with a non-zero stack and no wallet credit.', v_exits);
  RETURN NEXT;

  -- 5. The frozen legacy pool. Reported, never critical: it cannot move.
  SELECT COALESCE(sum(balance), 0), max(updated_at) INTO v_frozen, v_last_write
    FROM public.wallets;
  check_name := 'legacy_wallets_frozen';
  severity   := CASE WHEN v_last_write > now() - interval '2 days'
                     THEN 'critical'   -- something started writing it again: THAT is news
                     ELSE 'ok' END;
  detail     := format('public.wallets holds %s chips, last written %s. Dead pool; '
                       || 'nothing reads it. Only a NEW write here is newsworthy.',
                       round(v_frozen, 2), COALESCE(v_last_write::text, 'never'));
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.fn_chip_integrity_report() IS
  'The five chip-integrity questions worth paging on, added 2026-08-26. Replaces reading 575 nightly criticals about a frozen table, which is what hid a 115-day ledger outage. Page on any critical row.';

REVOKE ALL ON FUNCTION public.fn_chip_integrity_report() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_chip_integrity_report() TO service_role, authenticated;

DO $$
DECLARE v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_chip_integrity_report();
  IF v_rows <> 5 THEN RAISE EXCEPTION 'expected 5 checks, got %', v_rows; END IF;
  RAISE NOTICE 'chip integrity report: 5 checks live.';
END $$;
