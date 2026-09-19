-- 20260919153843_a_rake_violation_nobody_can_price_still_gets_logged
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 15:38:43 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- fn_ca_cron_health() reports a job that has run and never once succeeded as
-- `critical`, and Cron Health fails the run on one. Measured 2026-09-19:
--
--   rake-law-wide-daily        1 run,  0 successes   critical
--   rake-law-adherence-hourly  24 runs, 1 success    warn
--
-- Both call fn_rake_law_check, and both died on:
--
--   null value in column "ledger_balance" of relation "ledger_reconcile_log"
--   violates not-null constraint
--
-- fn_rake_law_violations returns eight kinds of finding. Three of them return
-- NULL for the allowed rake ON PURPOSE, because the hand record is incomplete
-- and the number cannot be computed:
--
--   board_not_recorded     a showdown, or four aggressive actions, with no
--                          board recorded
--   players_not_recorded   a flop reached with no dealt count
--   impossible_showdown    a showdown with fewer than three community cards
--
-- fn_rake_law_check wrote that NULL straight into a NOT NULL column, so the
-- INSERT raised, and because the whole check is one statement, EVERY finding
-- in that window went down with it. A warn-level row about a missing board
-- was destroying the over_spec and under_spec violations found beside it. The
-- last rake_law row this estate recorded was 2026-09-17 04:40, and there was
-- exactly one qualifying violation in the two-hour window when this migration
-- ran, which had been discarded on every attempt since.
--
-- WHAT THIS CHANGES, and what it refuses to change
--
-- The obvious fix is COALESCE(v.allowed, 0), and it is wrong. Writing 0 for
-- an amount nobody can compute either invents a drift that did not happen or
-- erases a violation that did. The amount is genuinely absent, so the row
-- records it as absent and says why:
--
--   ledger_balance and stored_balance may be NULL
--   a NULL is allowed only when metadata->'unknowable' names that column and
--   carries a reason, enforced by a CHECK constraint
--
-- so an absent amount can never again become a silent zero, and a writer that
-- simply forgets to explain itself is refused exactly as it was before. No
-- existing row is affected: all 59,173 carried both amounts, so the
-- constraint validated on the spot.
--
-- stored_balance gets the same treatment although no NULL has been observed
-- in it. The failure here was one unfillable column taking down every other
-- finding in the batch, and leaving the second column able to do the same
-- thing next week is not a fix.
--
-- @live-proof: (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid = 'public.ledger_reconcile_log'::regclass AND attname = 'ledger_balance')
-- @live-proof: (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.ledger_reconcile_log'::regclass AND conname = 'ledger_reconcile_log_unknowable_is_explained' AND convalidated)
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The two amounts may be absent, but only when the row says which one and why.
ALTER TABLE public.ledger_reconcile_log ALTER COLUMN ledger_balance DROP NOT NULL;
ALTER TABLE public.ledger_reconcile_log ALTER COLUMN stored_balance DROP NOT NULL;

ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_unknowable_is_explained
  CHECK (
    (ledger_balance IS NOT NULL OR COALESCE(metadata->'unknowable' ? 'ledger_balance', false))
    AND
    (stored_balance IS NOT NULL OR COALESCE(metadata->'unknowable' ? 'stored_balance', false))
  );

COMMENT ON CONSTRAINT ledger_reconcile_log_unknowable_is_explained ON public.ledger_reconcile_log IS
  'A missing amount is allowed only when metadata->>''unknowable'' names the column and says why. fn_rake_law_violations returns NULL for board_not_recorded, players_not_recorded and impossible_showdown on purpose: the hand record is incomplete, so what the spec allows cannot be computed. Writing a number there would either invent a drift or erase a violation.';

CREATE OR REPLACE FUNCTION public.fn_rake_law_check(p_window interval DEFAULT '02:00:00'::interval)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_rake_law_violations(p_window)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'rake_law', v.table_id,
           v.allowed, v.rake,
           CASE WHEN v.kind IN ('board_not_recorded', 'players_not_recorded', 'bbj_club_switch_ignored')
                THEN 'warn' ELSE 'critical' END,
           jsonb_build_object(
             'kind', v.kind,
             'hand_id', v.hand_id,
             'occurred_at', v.occurred_at,
             'stake', v.small_blind::text || '/' || v.big_blind::text,
             'pot', v.pot,
             'spec_checksum', public.fn_rake_spec_checksum())
           -- An amount this hand record cannot produce is recorded as absent
           -- and explained, never as a number. board_not_recorded,
           -- players_not_recorded and impossible_showdown all return NULL for
           -- the allowed rake on purpose, and until 2026-09-19 that NULL hit a
           -- NOT NULL column and took the WHOLE statement down with it: one
           -- warn-level row with no board cost every over_spec and under_spec
           -- violation found in the same window. rake-law-adherence-hourly had
           -- succeeded once in twenty-four runs and rake-law-wide-daily never.
           || CASE WHEN v.allowed IS NULL OR v.rake IS NULL THEN
                jsonb_build_object('unknowable',
                  (CASE WHEN v.allowed IS NULL
                        THEN jsonb_build_object('ledger_balance',
                               v.kind || ': the hand record is incomplete, so the amount the spec allows cannot be computed')
                        ELSE '{}'::jsonb END)
                  ||
                  (CASE WHEN v.rake IS NULL
                        THEN jsonb_build_object('stored_balance',
                               v.kind || ': the hand record does not carry the amount actually taken')
                        ELSE '{}'::jsonb END))
              ELSE '{}'::jsonb END,
           CASE WHEN v.allowed IS NULL
                THEN v.kind || ': took ' || COALESCE(v.rake::text, 'an amount this record does not carry')
                     || ' and the spec amount cannot be computed from this hand record'
                ELSE v.kind || ': took ' || COALESCE(v.rake::text, 'an amount this record does not carry')
                     || ' where the spec says ' || v.allowed::text END
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'rake_law'
          AND l.metadata->>'hand_id' = v.hand_id::text
          AND l.metadata->>'kind' = v.kind)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$function$;

DO $verify$
DECLARE
  v_rows integer;
  v_accepted boolean := false;
BEGIN
  -- An unexplained absence is still refused.
  BEGIN
    INSERT INTO public.ledger_reconcile_log (entity_type, ledger_balance, stored_balance, severity)
    VALUES ('probe_unexplained_null', NULL, 1, 'warn');
    v_accepted := true;
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF v_accepted THEN
    RAISE EXCEPTION 'failed: a null balance with no explanation was accepted';
  END IF;

  -- And the real check runs to completion on the window that has been failing.
  v_rows := public.fn_rake_law_check('2 hours'::interval);
  RAISE NOTICE 'fn_rake_law_check logged % new violation(s) over two hours', v_rows;

  IF EXISTS (SELECT 1 FROM public.ledger_reconcile_log
              WHERE entity_type = 'rake_law' AND ledger_balance IS NULL
                AND NOT (metadata->'unknowable' ? 'ledger_balance')) THEN
    RAISE EXCEPTION 'failed: a rake_law row carries an unexplained absent balance';
  END IF;
END
$verify$;

COMMIT;
