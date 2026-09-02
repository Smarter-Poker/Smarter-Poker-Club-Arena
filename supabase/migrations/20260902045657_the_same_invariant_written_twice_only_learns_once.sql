-- fn_chip_integrity_report carries its own copy of two invariants that
-- fn_ca_quick_reconcile already had to be taught the truth about, and it was
-- never taught. Two detectors, one lesson, one of them still wrong:
--
--   legacy_wallets_frozen  hardcodes the constant 732591994.33 and compares
--     the raw sum. public.wallets cascades from profiles and auth.users, so a
--     torn-down certification account silently removes its share of the
--     stranded pool (see the_dead_pool_leaks_through_a_cascade_not_a_write).
--     It now reads the baseline from ca_frozen_pool_baseline and adds back
--     balances recorded as having LEFT, exactly as quick_reconcile does.
--
--   ledger_write_failures  counts every row in ca_ledger_write_failures
--     including the one benign shape quick_reconcile explicitly excludes: a
--     23505 on ux_chip_ledger_idempotency_key where the club-opening grant of
--     100000 is present and posted. That is idempotency REFUSING A DUPLICATE,
--     which is the guard working. The money is journalled exactly once; the
--     row records a refused second attempt.
--
-- Both now read the same sources of truth rather than a private constant, so
-- the next correction lands in one place instead of needing to be remembered
-- in two.

CREATE OR REPLACE FUNCTION public.fn_chip_integrity_report()
RETURNS TABLE(check_name text, severity text, detail text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sev text; v_finding text; v_days integer;
  v_drift_rows bigint; v_worst numeric;
  v_fail bigint; v_exits bigint;
  v_frozen numeric; v_last_write timestamptz;
  v_free bigint; v_lost numeric;
  v_flag bigint; v_flag_chips numeric;
  v_base numeric; v_left numeric;
BEGIN
  SELECT l.severity, l.finding, l.silent_for_days INTO v_sev, v_finding, v_days
    FROM public.fn_ledger_liveness() l;
  check_name := 'ledger_liveness'; severity := v_sev; detail := v_finding;
  RETURN NEXT;

  SELECT count(*) FILTER (WHERE abs(d.drift) > 0.01), COALESCE(max(abs(d.drift)), 0)
    INTO v_drift_rows, v_worst FROM public.fn_chip_drift_since_baseline() d;
  check_name := 'drift_since_baseline';
  severity   := CASE WHEN v_drift_rows = 0 THEN 'ok' WHEN v_worst <= 1 THEN 'warn' ELSE 'critical' END;
  detail     := format('%s member(s) drifting, worst %s. Baseline 2026-08-26.', v_drift_rows, round(v_worst,2));
  RETURN NEXT;

  -- Excludes the idempotency refusal, matching fn_ca_quick_reconcile 3f.
  SELECT count(*) INTO v_fail
    FROM public.ca_ledger_write_failures f
   WHERE NOT (
     f.sqlstate = '23505'
     AND f.message LIKE '%ux_chip_ledger_idempotency_key%'
     AND EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.club_id = f.club_id
          AND l.idempotency_key = 'club-opening-grant:' || f.club_id::text
          AND l.category = 'mint' AND l.from_type = 'system_mint'
          AND l.to_type = 'club_treasury' AND l.to_entity_id = f.club_id
          AND l.amount = 100000 AND l.status = 'posted'));
  check_name := 'ledger_write_failures';
  severity   := CASE WHEN v_fail = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s swallowed ledger write(s) (idempotency refusals of an already-posted grant excluded).', v_fail);
  RETURN NEXT;

  SELECT count(*) INTO v_exits FROM public.fn_unaccounted_seat_exits();
  check_name := 'unaccounted_seat_exits';
  severity   := CASE WHEN v_exits = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s seat exit(s) with a non-zero stack and no wallet credit.', v_exits);
  RETURN NEXT;

  SELECT count(*), COALESCE(sum(u.uncollected),0) INTO v_free, v_lost
    FROM public.fn_unpriced_tournaments('7 days') u;
  check_name := 'unpriced_tournaments';
  severity   := CASE WHEN v_free = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s COMPLETED tournament(s) in 7 days took a buy-in and earned no rake, ~%s uncollected.',
                       v_free, round(v_lost,2));
  RETURN NEXT;

  SELECT b.memberships, b.chips_held INTO v_flag, v_flag_chips
    FROM public.fn_bot_flag_disagreement() b;
  check_name := 'bot_flag_disagreement';
  severity   := CASE WHEN v_flag = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s membership(s) holding %s chips have club_members.is_bot disagreeing '
                       || 'with profiles.is_horse. Every is_bot-keyed report is wrong by this much.',
                       v_flag, round(v_flag_chips,2));
  RETURN NEXT;

  SELECT COALESCE(sum(balance),0), max(updated_at) FILTER (WHERE balance <> 0)
    INTO v_frozen, v_last_write FROM public.wallets;
  SELECT COALESCE(frozen_total, 732591994.33) INTO v_base
    FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  SELECT COALESCE(sum(deleted_balance),0) INTO v_left
    FROM public.ca_frozen_pool_deletions WHERE pool = 'public.wallets';
  check_name := 'legacy_wallets_frozen';
  severity   := CASE WHEN round(v_frozen + COALESCE(v_left,0), 2) <> round(COALESCE(v_base,0),2) THEN 'critical'
                     WHEN v_last_write > now() - interval '2 days' THEN 'critical'
                     ELSE 'ok' END;
  detail     := format('public.wallets holds %s chips plus %s recorded as having left, against a frozen baseline of %s. Last MONEY write %s. A zero-balance row created at signup is not a movement; a changed total is, and so is a row that cascaded away.',
                       round(v_frozen,2), round(COALESCE(v_left,0),2), round(COALESCE(v_base,0),2),
                       COALESCE(v_last_write::text,'never'));
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_chip_integrity_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_chip_integrity_report() TO service_role;
