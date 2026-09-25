-- A must_be_zero account is checked by its BALANCE, not by an hour of flow.
--
-- `ca_ledger_accounts` has declared since 20260831143501 that
-- `settlement_suspense` is `must_be_zero` - "must net to zero; never a place to
-- hide drift". Measured 2026-09-25 12:52 UTC, that account stands at
-- +4,170,904.48 (7,743 legs in for 21,730,142.57, 4,676 out for
-- 17,559,238.09), and NOTHING noticed, for two reasons:
--
--   1. `must_be_zero` is read by no function, view, trigger, check or test
--      anywhere in the database. It is a comment with a data type.
--   2. its only detector, `fn_ca_suspense_regression_check` (cron job 177,
--      */15), sums `created_at > now() - interval '60 minutes'`. That measures
--      the last hour of FLOW. The last suspense leg was written 2026-09-14
--      06:27 UTC, so the detector has correctly reported zero every fifteen
--      minutes for eleven days while 4.17M sat in an account declared to hold
--      nothing. A static imbalance is exactly the case a flow window cannot
--      see, and it is the case the invariant is written about.
--
-- This migration keeps the flow check EXACTLY as installed (same floor, same
-- 1.00 tolerance, same finding key, same wording) and adds the balance check it
-- never had, driven by `ca_ledger_accounts.must_be_zero` so the column is now
-- load-bearing: flip another account and it is checked on the next run.
--
-- WHY A RUNNING BALANCE AND NOT A SUM OVER chip_ledger
-- `chip_ledger` is 5,820,918 rows / 5,294 MB and there is no index on
-- `from_type`/`to_type`, so `sum() WHERE to_type='settlement_suspense'` is a
-- full sequential scan. Ninety-six of those a day is not a control, it is a
-- second workload. So the balance is MAINTAINED, in hourly buckets, exactly the
-- shape `ca_ledger_day_manifests` and `member_fee_rollup_state` already use:
--
--   * `ca_must_be_zero_hours` holds one row per (account, UTC hour). Every hour
--     older than the refresh window is sealed history: 58 rows for the whole of
--     settlement_suspense.
--   * each run re-derives only the buckets at or after
--     `date_trunc('hour', now()) - interval '2 hours'`, through
--     `idx_chip_ledger_created_at`. Measured 2026-09-25: 8,319 rows in that
--     window against 3,942 in the hour the installed check already scans. The
--     balance itself is then a sum over a ~58-row table.
--   * the two-hour lip is the late-commit margin. A transaction that opened
--     before the window and commits inside it is still re-counted, because its
--     bucket is recomputed from scratch rather than incremented.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- It does not move one chip and it does not touch the 4,170,904.48. Whatever
-- that number turns out to be, the remedy is the owner's, with a named
-- destination. This makes it VISIBLE (one standing incident, folded by
-- `fn_ca_raise_drift_incident`, never a new row per run) and it makes any
-- FURTHER movement away from the audited baseline a separate, louder finding,
-- so it cannot grow quietly again.
--
-- No new cron job, watcher, reconciler or repair loop: job 177 still calls this
-- one function, and the signal is the existing `fn_ca_raise_drift_incident`
-- -> `ca_drift_incidents` / `financial_alerts` surface.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '600s';

-- The exact installed detector reviewed for this change. If someone has
-- replaced it since, stop rather than silently overwrite their work.
DO $precondition$
DECLARE v_md5 text; v_mbz int;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_suspense_regression_check';
  IF v_md5 IS DISTINCT FROM '0d5579e36566f6f0c4ec1285549e11e6' THEN
    RAISE EXCEPTION 'fn_ca_suspense_regression_check is not the reviewed definition (md5 %); re-review before applying', COALESCE(v_md5, 'absent');
  END IF;

  SELECT count(*) INTO v_mbz FROM public.ca_ledger_accounts WHERE must_be_zero;
  IF v_mbz < 1 THEN
    RAISE EXCEPTION 'no ca_ledger_accounts row declares must_be_zero; this check would have nothing to enforce';
  END IF;
END $precondition$;

-- THE MAINTAINED RUNNING BALANCE.
CREATE TABLE IF NOT EXISTS public.ca_must_be_zero_hours (
  account_type text        NOT NULL,
  hour         timestamptz NOT NULL,
  legs_in      bigint      NOT NULL DEFAULT 0,
  legs_out     bigint      NOT NULL DEFAULT 0,
  chips_in     numeric     NOT NULL DEFAULT 0,
  chips_out    numeric     NOT NULL DEFAULT 0,
  PRIMARY KEY (account_type, hour)
);
COMMENT ON TABLE public.ca_must_be_zero_hours IS
  'Per (must_be_zero account, UTC hour) journal flow. The maintained running balance behind fn_ca_suspense_regression_check''s balance arm; hours older than its refresh window are sealed history. Observation only - no chip moves from here.';

CREATE TABLE IF NOT EXISTS public.ca_must_be_zero_state (
  account_type      text PRIMARY KEY,
  baseline_balance  numeric     NOT NULL,
  baseline_at       timestamptz NOT NULL,
  baseline_note     text,
  last_balance      numeric,
  last_checked_at   timestamptz,
  buckets_from      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ca_must_be_zero_state IS
  'One row per must_be_zero account: the audited balance at the moment this control was installed, and the last balance it read. baseline_balance is what "already known, already the owner''s decision" means; movement away from it is a NEW finding. An owner who resolves a standing imbalance re-baselines here.';
COMMENT ON COLUMN public.ca_must_be_zero_state.baseline_balance IS
  'The balance measured when the control was installed. NOT a tolerance and NOT permission: the balance arm still reports the full balance against zero every run.';

ALTER TABLE public.ca_must_be_zero_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_must_be_zero_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_must_be_zero_hours FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ca_must_be_zero_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_must_be_zero_hours TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_must_be_zero_state TO service_role;

-- SEED. One pass over the journal, once, in this transaction - the only
-- unbounded read this change ever performs. Everything after it is bounded.
INSERT INTO public.ca_must_be_zero_hours (account_type, hour, legs_in, legs_out, chips_in, chips_out)
SELECT a.account_type,
       date_trunc('hour', l.created_at),
       count(*) FILTER (WHERE l.to_type   = a.account_type),
       count(*) FILTER (WHERE l.from_type = a.account_type),
       COALESCE(sum(l.amount) FILTER (WHERE l.to_type   = a.account_type), 0),
       COALESCE(sum(l.amount) FILTER (WHERE l.from_type = a.account_type), 0)
  FROM public.chip_ledger l
  JOIN public.ca_ledger_accounts a
    ON a.must_be_zero AND (l.from_type = a.account_type OR l.to_type = a.account_type)
 GROUP BY 1, 2
ON CONFLICT (account_type, hour) DO UPDATE
  SET legs_in = EXCLUDED.legs_in, legs_out = EXCLUDED.legs_out,
      chips_in = EXCLUDED.chips_in, chips_out = EXCLUDED.chips_out;

INSERT INTO public.ca_must_be_zero_state
  (account_type, baseline_balance, baseline_at, baseline_note, last_balance, last_checked_at, buckets_from)
SELECT a.account_type,
       COALESCE((SELECT round(sum(h.chips_in - h.chips_out), 2)
                   FROM public.ca_must_be_zero_hours h
                  WHERE h.account_type = a.account_type), 0),
       now(),
       'measured at install of the balance arm (migration 20260925131500). Not audited, not authorised, not a tolerance: the standing imbalance this control was built to make visible.',
       COALESCE((SELECT round(sum(h.chips_in - h.chips_out), 2)
                   FROM public.ca_must_be_zero_hours h
                  WHERE h.account_type = a.account_type), 0),
       now(),
       (SELECT min(h.hour) FROM public.ca_must_be_zero_hours h WHERE h.account_type = a.account_type)
  FROM public.ca_ledger_accounts a
 WHERE a.must_be_zero
ON CONFLICT (account_type) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_suspense_regression_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  DECLARE
    v_in numeric; v_out numeric; v_net numeric;
    v_rows_in int; v_rows_out int;
    v_since constant timestamptz := '2026-09-01 00:17:00+00';
    /* THE BALANCE ARM (2026-09-25). Bounded: only buckets at or after this
       instant are re-derived from chip_ledger; older hours are sealed. Two
       hours is the late-commit margin, and it fully contains the flow window
       below, whose semantics are unchanged. */
    v_window constant timestamptz := date_trunc('hour', now()) - interval '2 hours';
    v_tolerance constant numeric := 1.00;
    v_findings int := 0;
    v_acct record;
    v_balance numeric; v_legs_in bigint; v_legs_out bigint;
    v_chips_in numeric; v_chips_out numeric;
    v_baseline numeric; v_moved numeric;
    v_own_balance_arm boolean;
  BEGIN
    /* ---- 1. THE MAINTAINED RUNNING BALANCE, REFRESHED OVER A BOUNDED TAIL --- */
    /* One writer at a time. Job 177 fires every fifteen minutes and this runs in
       milliseconds, so an overlap means a previous run is still going: let it
       finish and own the buckets rather than racing its DELETE against this
       one's ON CONFLICT. The flow arm below is read-only and still runs. */
    v_own_balance_arm := pg_try_advisory_xact_lock(hashtextextended('ca-must-be-zero-balance-arm', 0));

    IF v_own_balance_arm THEN
    DELETE FROM public.ca_must_be_zero_hours WHERE hour >= v_window;

    INSERT INTO public.ca_must_be_zero_hours
      (account_type, hour, legs_in, legs_out, chips_in, chips_out)
    SELECT a.account_type,
           date_trunc('hour', l.created_at),
           count(*) FILTER (WHERE l.to_type   = a.account_type),
           count(*) FILTER (WHERE l.from_type = a.account_type),
           COALESCE(sum(l.amount) FILTER (WHERE l.to_type   = a.account_type), 0),
           COALESCE(sum(l.amount) FILTER (WHERE l.from_type = a.account_type), 0)
      FROM public.chip_ledger l
      JOIN public.ca_ledger_accounts a
        ON a.must_be_zero AND (l.from_type = a.account_type OR l.to_type = a.account_type)
     WHERE l.created_at >= v_window
     GROUP BY 1, 2
    ON CONFLICT (account_type, hour) DO UPDATE
      SET legs_in = EXCLUDED.legs_in, legs_out = EXCLUDED.legs_out,
          chips_in = EXCLUDED.chips_in, chips_out = EXCLUDED.chips_out;

    /* An account newly declared must_be_zero has no buckets before the window,
       so give it a state row rather than reporting a balance that only counts
       the last two hours. Its first full balance needs a seed the owner asks
       for; until then it is honestly absent, not zero. */
    INSERT INTO public.ca_must_be_zero_state
      (account_type, baseline_balance, baseline_at, baseline_note, buckets_from)
    SELECT a.account_type, 0, now(),
           'declared must_be_zero after the balance arm was installed; buckets cover only from buckets_from, so the balance below is partial until the account is seeded from the journal',
           v_window
      FROM public.ca_ledger_accounts a
     WHERE a.must_be_zero
       AND NOT EXISTS (SELECT 1 FROM public.ca_must_be_zero_state s
                        WHERE s.account_type = a.account_type);
    END IF;

    /* ---- 2. THE FLOW CHECK, UNCHANGED ------------------------------------- */
    SELECT count(*) FILTER (WHERE to_type = 'settlement_suspense'),
           COALESCE(sum(amount) FILTER (WHERE to_type = 'settlement_suspense'), 0),
           count(*) FILTER (WHERE from_type = 'settlement_suspense'),
           COALESCE(sum(amount) FILTER (WHERE from_type = 'settlement_suspense'), 0)
      INTO v_rows_in, v_in, v_rows_out, v_out
      FROM public.chip_ledger
     WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
       AND created_at > now() - interval '60 minutes'
       AND created_at > v_since;

    v_net := round(COALESCE(v_in, 0) - COALESCE(v_out, 0), 2);

    IF abs(v_net) > 1.00 THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_suspense_regression_check', 'unauthorized_adjustment', 'warning',
        'suspense-regression',
        v_net, NULL, NULL, 'ledger', 'settlement_suspense',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        format('suspense kept %s chips in the last hour: %s leg(s) in for %s, %s leg(s) out for %s. A money path lost, or never had, its category declaration and nothing came back for it. Gross flow through suspense is not a finding - what it keeps is.',
               v_net, v_rows_in, round(COALESCE(v_in,0), 2), v_rows_out, round(COALESCE(v_out,0), 2)),
        false,
        jsonb_build_object('net_last_hour', v_net,
                           'legs_in', v_rows_in, 'chips_in', round(COALESCE(v_in,0), 2),
                           'legs_out', v_rows_out, 'chips_out', round(COALESCE(v_out,0), 2)));
      v_findings := v_findings + 1;
    END IF;

    /* ---- 3. THE BALANCE CHECK THE DECLARATION ACTUALLY ASKS FOR ----------- */
    /* Driven by the column, not by a hard-coded account name: this is the only
       reader `ca_ledger_accounts.must_be_zero` has, and it is what makes the
       declaration enforceable. */
    FOR v_acct IN SELECT a.account_type FROM public.ca_ledger_accounts a
                   WHERE a.must_be_zero AND v_own_balance_arm ORDER BY a.account_type
    LOOP
      SELECT COALESCE(round(sum(h.chips_in - h.chips_out), 2), 0),
             COALESCE(sum(h.legs_in), 0), COALESCE(sum(h.legs_out), 0),
             COALESCE(round(sum(h.chips_in), 2), 0), COALESCE(round(sum(h.chips_out), 2), 0)
        INTO v_balance, v_legs_in, v_legs_out, v_chips_in, v_chips_out
        FROM public.ca_must_be_zero_hours h
       WHERE h.account_type = v_acct.account_type;

      SELECT s.baseline_balance INTO v_baseline
        FROM public.ca_must_be_zero_state s WHERE s.account_type = v_acct.account_type;
      v_baseline := COALESCE(v_baseline, 0);
      v_moved := round(v_balance - v_baseline, 2);

      UPDATE public.ca_must_be_zero_state
         SET last_balance = v_balance, last_checked_at = now(), updated_at = now()
       WHERE account_type = v_acct.account_type;

      IF abs(v_balance) > v_tolerance THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_suspense_regression_check', 'ledger_imbalance', 'critical',
          'must-be-zero-balance:' || v_acct.account_type,
          v_balance, 0, v_balance, 'ledger', v_acct.account_type,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          format('ca_ledger_accounts declares %s must_be_zero, and its BALANCE is %s chips: %s leg(s) in for %s, %s leg(s) out for %s. This is the account''s standing position, not an hour of flow - it does not clear by itself and it is invisible to any check that only reads recent movement. No chip may be moved to make this number smaller: the destination is the owner''s decision.',
                 v_acct.account_type, v_balance, v_legs_in, v_chips_in, v_legs_out, v_chips_out),
          false,
          jsonb_build_object('account_type', v_acct.account_type,
                             'balance', v_balance,
                             'legs_in', v_legs_in, 'chips_in', v_chips_in,
                             'legs_out', v_legs_out, 'chips_out', v_chips_out,
                             'baseline_balance', v_baseline,
                             'moved_since_baseline', v_moved,
                             'basis', 'ca_must_be_zero_hours'));
        v_findings := v_findings + 1;
      ELSE
        /* A condition that stopped being true closes itself. Otherwise a
           balance brought back to zero leaves a critical open for ever, which
           is how a critical list reaches 233 rows (2026-09-07). */
        UPDATE public.ca_drift_incidents
           SET status = 'resolved', resolved_at = now(),
               resolution = format('balance arm: %s is back within %s of zero (read %s)',
                                   v_acct.account_type, v_tolerance, v_balance),
               closure_basis = 'condition_no_longer_holds'
         WHERE source = 'fn_ca_suspense_regression_check'
           AND dedupe_key IN ('must-be-zero-balance:' || v_acct.account_type,
                              'must-be-zero-growth:'  || v_acct.account_type)
           AND status <> 'resolved';
      END IF;

      /* GROWTH IS ITS OWN FINDING. The standing imbalance is already the
         owner's to decide; a balance that moves AWAY from the audited baseline
         is a live writer putting chips somewhere declared to hold none, and
         that is the thing this control has to stop. */
      IF abs(v_moved) > v_tolerance THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_suspense_regression_check', 'ledger_imbalance', 'critical',
          'must-be-zero-growth:' || v_acct.account_type,
          v_moved, v_baseline, v_balance, 'ledger', v_acct.account_type,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          format('%s is declared must_be_zero and its balance has MOVED %s chips since the audited baseline of %s: it now stands at %s. A writer is still putting chips into, or taking them out of, an account that is supposed to hold none. Find the writer before deciding anything about the standing balance.',
                 v_acct.account_type, v_moved, v_baseline, v_balance),
          false,
          jsonb_build_object('account_type', v_acct.account_type,
                             'balance', v_balance,
                             'baseline_balance', v_baseline,
                             'moved_since_baseline', v_moved,
                             'basis', 'ca_must_be_zero_hours'));
        v_findings := v_findings + 1;
      END IF;
    END LOOP;

    RETURN v_findings;
  END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_suspense_regression_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_suspense_regression_check() TO service_role;

-- A DECLARED GUARD CHANGE IS RECORDED, NOT RAISED (2026-09-10). This detector is
-- on fn_ca_guard_watchlist(), so the redefinition above names itself here, in the
-- same transaction, and fn_ca_guard_defs_watch has nothing for a human to close.
SELECT public.fn_ca_declare_guard_redefinition(
  'fn_ca_suspense_regression_check',
  'migration 20260925131500_a_must_be_zero_account_is_checked_by_its_balance');

-- auto_resolve_hours is deliberately left as installed. A balance arm finding is
-- re-raised on every run while the balance stands, so last_seen_at is never 24h
-- stale and the unseen-clearance can never apply to it; changing the column
-- would change how the flow arm's transient findings age, which is not this
-- change's business.
UPDATE public.ca_detector_registry
   SET note = 'two arms: the flow arm (net through suspense in the last hour, floored 2026-09-01 00:17) and the balance arm (the standing balance of every ca_ledger_accounts.must_be_zero account, read off the maintained ca_must_be_zero_hours buckets). The balance arm is the only reader must_be_zero has. Its findings are standing conditions and clear when the balance returns to zero, not when they go unseen.',
       updated_at = now()
 WHERE source = 'fn_ca_suspense_regression_check';

COMMIT;
