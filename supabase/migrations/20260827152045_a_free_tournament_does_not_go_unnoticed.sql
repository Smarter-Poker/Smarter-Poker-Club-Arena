-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827152045; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- A FREE TOURNAMENT DOES NOT GO UNNOTICED
-- ═══════════════════════════════════════════════════════════════════════════
-- Between 2026-08-21 and 2026-08-25, 140 COMPLETED non-satellite MTTs ran with
-- a real buy-in ($2 to $5), real entrants, and buy_in_fee = 0. The house
-- collected nothing on any of them. Roughly 739 chips of entry fee went
-- uncollected, concentrated on 08-23 (484) and 08-22 (220).
--
-- It has already stopped on its own -- 0 zero-fee MTTs created on 08-26 or
-- 08-27 -- so this migration does not chase the cause. What it adds is the
-- thing that was missing: something that would have SAID so at the time.
--
-- WHAT IS NOT WRONG, recorded because measuring it wrongly is easy and I did
-- it twice before getting here:
--
--   * Today's MTT fee looks like 11.11% of buy_in_amount, which is not a
--     finding. 11.11% is 1/9: the fee is 10% of the TOTAL ENTRY, e.g.
--     4.50 + 0.50 = 5.00. Every current pair lands on a clean advertised
--     price (5, 10, 15, 20, 25, 30, 50). Measuring the fee against the
--     prize-pool portion instead of the entry is the wrong denominator.
--
--   * Before 08-21 the fee was 10% of buy_in_amount instead (10.00 + 1.00 =
--     11.00). The 08-26 change to 10%-of-entry is what produces the round
--     prices and looks deliberate.
--
--   * Add-ons take no rake, correctly: there is no addon fee kind in
--     rake_records at all, and atomic_table_addon has no rake path.
--   * Rebuys ARE raked: 1,845 `tournament_rebuy_fee` rows in 30 days, via
--     process_tournament_rebuy.
--   * Zero tournament hands took pot rake.
--
-- Detection, not a hard block. A CHECK constraint refusing a zero fee would
-- also refuse a legitimate promotional freeroll, and a guard that stops a
-- club running a promo is worse than the 739 chips it protects.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_unpriced_tournaments(p_since interval DEFAULT '7 days')
RETURNS TABLE (
  tournament_id uuid,
  name          text,
  tournament_type text,
  buy_in_amount numeric,
  buy_in_fee    numeric,
  entrants      integer,
  uncollected   numeric,
  created_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.name, t.tournament_type, t.buy_in_amount, coalesce(t.buy_in_fee, 0),
         coalesce(t.current_players, 0),
         round((t.buy_in_amount * 0.10 * coalesce(t.current_players, 0))::numeric, 2),
         t.created_at
  FROM public.tournaments t
  WHERE t.buy_in_amount > 0
    AND coalesce(t.buy_in_fee, 0) = 0
    AND t.created_at > now() - p_since
    /* Satellites award a seat rather than a prize pool and legitimately carry
       no fee of their own; the target event charges it. */
    AND t.satellite_target_id IS NULL
    AND coalesce(t.satellite_seats, 0) = 0
    /* Nobody entered means nothing was lost. */
    AND coalesce(t.current_players, 0) > 0
  ORDER BY t.created_at DESC;
$$;

COMMENT ON FUNCTION public.fn_unpriced_tournaments(interval) IS
  'Tournaments that charged a buy-in but no entry fee. Added 2026-08-27 after 140 MTTs ran free between 08-21 and 08-25 with nothing anywhere noticing. Excludes satellites (they legitimately carry no fee) and empty events.';

REVOKE ALL ON FUNCTION public.fn_unpriced_tournaments(interval) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_unpriced_tournaments(interval) TO service_role, authenticated;

-- Fold it into the report that is already the one place to look.
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
  v_free bigint; v_lost numeric;
BEGIN
  SELECT l.severity, l.finding, l.silent_for_days INTO v_sev, v_finding, v_days
    FROM public.fn_ledger_liveness() l;
  check_name := 'ledger_liveness'; severity := v_sev; detail := v_finding;
  RETURN NEXT;

  SELECT count(*) FILTER (WHERE abs(d.drift) > 0.01), COALESCE(max(abs(d.drift)), 0)
    INTO v_drift_rows, v_worst
    FROM public.fn_chip_drift_since_baseline() d;
  check_name := 'drift_since_baseline';
  severity   := CASE WHEN v_drift_rows = 0 THEN 'ok'
                     WHEN v_worst <= 1 THEN 'warn' ELSE 'critical' END;
  detail     := format('%s member(s) drifting, worst %s. Baseline 2026-08-26; '
                       || 'pre-baseline history does not exist and is excluded.',
                       v_drift_rows, round(v_worst, 2));
  RETURN NEXT;

  SELECT count(*) INTO v_fail FROM public.ca_ledger_write_failures;
  check_name := 'ledger_write_failures';
  severity   := CASE WHEN v_fail = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s swallowed ledger write(s). Non-zero means the audit '
                       || 'trail is losing rows right now.', v_fail);
  RETURN NEXT;

  SELECT count(*) INTO v_exits FROM public.fn_unaccounted_seat_exits();
  check_name := 'unaccounted_seat_exits';
  severity   := CASE WHEN v_exits = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s seat exit(s) with a non-zero stack and no wallet credit.', v_exits);
  RETURN NEXT;

  SELECT count(*), COALESCE(sum(u.uncollected), 0) INTO v_free, v_lost
    FROM public.fn_unpriced_tournaments('7 days') u;
  check_name := 'unpriced_tournaments';
  severity   := CASE WHEN v_free = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s tournament(s) in 7 days charged a buy-in and no entry '
                       || 'fee, ~%s uncollected. Satellites and empty events excluded.',
                       v_free, round(v_lost, 2));
  RETURN NEXT;

  SELECT COALESCE(sum(balance), 0), max(updated_at) INTO v_frozen, v_last_write
    FROM public.wallets;
  check_name := 'legacy_wallets_frozen';
  severity   := CASE WHEN v_last_write > now() - interval '2 days' THEN 'critical' ELSE 'ok' END;
  detail     := format('public.wallets holds %s chips, last written %s. Dead pool; '
                       || 'nothing reads it. Only a NEW write here is newsworthy.',
                       round(v_frozen, 2), COALESCE(v_last_write::text, 'never'));
  RETURN NEXT;
END;
$$;

DO $$
DECLARE v_rows int; v_free_sev text;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_chip_integrity_report();
  IF v_rows <> 6 THEN RAISE EXCEPTION 'expected 6 checks, got %', v_rows; END IF;
  SELECT severity INTO v_free_sev FROM public.fn_chip_integrity_report()
   WHERE check_name = 'unpriced_tournaments';
  RAISE NOTICE 'unpriced_tournaments check live, currently %', v_free_sev;
END $$;
