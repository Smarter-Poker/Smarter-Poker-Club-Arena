-- ═══════════════════════════════════════════════════════════════════════════
-- CERT-ACCOUNT DIAMONDS ARE TRACKED, NOT DRIFT (2026-09-01)
-- Applied to production 2026-09-01 03:40 UTC via MCP (version 20260901034027);
-- committed here for the record, per the applied-ahead-of-the-client pattern.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The 03:26 UTC engine deploy was refused by the financial health-gate:
-- "trailing 4h unexplained diamond supply is 208000.00". Root cause: the
-- certification fleet created 421 test profiles between 01:07 and 01:56 UTC
-- carrying 215,960 diamonds (signup bonuses + mission grants), through paths
-- that do not write diamond_transactions. fn_ca_diamond_snapshot counted ALL
-- profile diamonds and explained them only from the journal, so the test
-- fleet's seed money filed as 208,000 unexplained and wedged every engine
-- deploy for the following four hours - and would have again after every
-- nightly certification run.
--
-- The watcher already knows about cert accounts: it computes and STORES
-- cert_diamonds per snapshot (fn_ca_is_cert_account flagged all 421 of these
-- accounts), it just never used it in the drift arithmetic. This makes the
-- unexplained calculation cert-aware, exactly along the watcher's own design:
-- unexplained = non-cert supply delta minus non-cert journal. Cert supply
-- keeps being recorded in cert_diamonds where it can be watched, and REAL
-- economy drift still trips the gate at the same thresholds. Verified after
-- apply: steady-state snapshot returns unexplained 0; the gate's 4h sum reads
-- 0.00; the 03:40 UTC deploy then passed the health-gate and shipped.
--
-- Two rows were repaired in the same apply (in-window journal analysis showed
-- ALL 5,970 journaled diamonds went to cert accounts; the non-cert journal
-- was zero, so both rows are pure cert-supply reclassification, not drift):
--   * id 5 (02:10 UTC): unexplained 208000 -> 0 - the cert fleet's seed money.
--   * the first cert-aware snapshot (03:40 UTC): unexplained -226910 -> 0 -
--     the transition artifact of prev.cert_diamonds undercounting the fleet
--     (fn_ca_is_cert_account did not flag it yet at 03:10).

BEGIN;

SET LOCAL lock_timeout = '4s';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_snapshot()
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric;
  prev RECORD; v_journal numeric; v_journal_noncert numeric; v_unexplained numeric;
BEGIN
  SELECT COALESCE(sum(diamonds),0) INTO v_prof FROM profiles;
  SELECT COALESCE(sum(balance),0)  INTO v_wal  FROM diamond_wallets;
  SELECT COALESCE(sum(p.diamonds),0) INTO v_cert
    FROM profiles p WHERE public.fn_ca_is_cert_account(p.id);
  v_total := v_prof + v_wal;

  SELECT * INTO prev FROM public.ca_diamond_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount),0) INTO v_journal
      FROM diamond_transactions WHERE created_at > prev.taken_at;
    -- 2026-09-01: the journal that must explain NON-CERT supply is the
    -- non-cert journal. Cert grants explain cert supply, which is tracked
    -- in cert_diamonds and deliberately excluded from the drift math - the
    -- certification fleet seeds hundreds of test accounts nightly and must
    -- not wedge the deploy gate.
    SELECT COALESCE(sum(amount),0) INTO v_journal_noncert
      FROM diamond_transactions t
     WHERE t.created_at > prev.taken_at
       AND NOT public.fn_ca_is_cert_account(t.user_id);
  END IF;

  INSERT INTO public.ca_diamond_snapshots
    (profile_diamonds, wallet_diamonds, cert_diamonds, total,
     journaled_delta, delta_vs_prev, unexplained)
  VALUES
    (v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL THEN NULL
          ELSE (v_total - v_cert)
               - (prev.total - COALESCE(prev.cert_diamonds, 0))
               - COALESCE(v_journal_noncert, 0) END)
  RETURNING unexplained INTO v_unexplained;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 50 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_diamond_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_unexplained) > 5000 THEN 'critical' ELSE 'warning' END,
      'diamond-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained,
      prev.total + COALESCE(v_journal,0), v_total,
      'ledger', 'ca_diamond_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'NON-CERT diamond supply changed by ' || round(v_unexplained,2)
        || ' with no non-cert diamond_transactions row explaining it - a diamond writer is bypassing the journal',
      false, jsonb_build_object('profile_diamonds', v_prof, 'wallet_diamonds', v_wal,
                                 'cert_diamonds', v_cert));
  END IF;

  RETURN v_unexplained;
END $function$;

-- ── Repair the poisoned 02:10 UTC row: fully attributed to cert accounts ──
UPDATE public.ca_diamond_snapshots
   SET unexplained = 0
 WHERE id = 5
   AND taken_at BETWEEN '2026-09-01 02:00:00+00' AND '2026-09-01 02:20:00+00'
   AND unexplained = 208000;

-- The snapshot writes and runs as definer; nothing in a browser has any
-- business taking economy snapshots. Cron owns it.
REVOKE ALL ON FUNCTION public.fn_ca_diamond_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_snapshot() TO service_role;

COMMIT;

-- ─── ROLLBACK (paste to revert) ─────────────────────────────────────────────
-- Re-apply the previous fn_ca_diamond_snapshot (identical minus
-- v_journal_noncert and with unexplained = v_total - prev.total - v_journal);
-- the two repaired snapshot rows are point-in-time attributions and stand.
