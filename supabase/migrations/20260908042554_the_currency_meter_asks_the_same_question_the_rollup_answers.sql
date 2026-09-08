BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 7 OF 8 (UNION ACCOUNTING) - THE CURRENCY METER ASKS THE SAME QUESTION
   THE ROLLUP ANSWERS.
   ---------------------------------------------------------------------------
   fn_ca_currency_meter compares, per (club, agent), the outstanding commission
   it computes itself against agent_commission_unsettled_rollup, and raises a
   CRITICAL ledger_imbalance incident on any disagreement. It computed its own
   side as

       FROM public.agent_commissions WHERE settled_at IS NULL

   which is the question this platform asked BEFORE 20260908025653. Round 2 no
   longer stamps settled_at; it records the period it paid in
   agent_commission_settlements, and a row counts as settled when its own
   settled_at is set OR a settlement row covers its period. The rollup is
   maintained from agent_commissions_unsettled, which asks the new question.
   The meter asked the old one, so the two were guaranteed to diverge by
   exactly the amount round 2 had paid, on the first close after the model
   change. The meter was written at 03:03 UTC, seven minutes after the model
   changed at 02:56; neither side knew about the other.

   MEASURED ON PRODUCTION 2026-09-08, inside a transaction that was rolled
   back. One hour-long round 2 for one union (83 pairs, 12,971 rows, 4,730.87
   paid) left the meter reporting:

     meter (settled_at IS NULL only)   1,012,983.49
     rollup (period aware)             1,008,252.62
     overstatement                         4,730.87   = exactly what was paid
     agents reported as drifted                  83   (worst single 870.11)

   That is a CRITICAL incident on every meter run, carrying the text "the
   rollup is kept by statement triggers and the rows are append-only; seeing it
   means one of those was bypassed" - sending whoever reads it hunting a
   bypassed trigger that does not exist. A full weekly close is far larger than
   one hour. It has not fired yet only because agent_commission_settlements
   still holds 0 rows: round 2 has not run since the model changed. This lands
   before the close that would have produced the false alarm.

   THE FIX is one FROM clause: read agent_commissions_unsettled, the single
   definition of "still owed" that round 2, the claim and the rollup already
   share.

   WHY THIS IS A TRANSFORM AND NOT A PASTED FUNCTION BODY. The meter is ~130
   lines covering four currencies, only one of which is being changed, and
   retyping the other three by hand into a migration risks altering a financial
   alert by accident. So the migration reads the live definition, asserts the
   exact old clause is present exactly once, replaces that one clause, and
   re-executes the result. It is idempotent (a second run finds nothing to
   replace and says so), it aborts rather than guessing if the anchor is
   missing or ambiguous, and it cannot touch the VIP, rakeback or chip
   sections. */

DO $migrate$
DECLARE
  v_def   text;
  v_old   text := 'FROM public.agent_commissions WHERE settled_at IS NULL GROUP BY 1, 2';
  v_new   text := 'FROM public.agent_commissions_unsettled GROUP BY 1, 2';
  v_hits  int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_ca_currency_meter';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_currency_meter does not exist; refusing to invent it';
  END IF;

  IF position(v_new IN v_def) > 0 AND position(v_old IN v_def) = 0 THEN
    RAISE NOTICE 'the meter already reads agent_commissions_unsettled; nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected the pre-phase-7 clause exactly once in fn_ca_currency_meter, found %', v_hits;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$migrate$;

/* Assert the postcondition against the live catalogue, so this aborts rather
   than reporting success if anything moved underneath it. */
DO $assert$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_ca_currency_meter';

  IF src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_currency_meter is missing after the rewrite';
  END IF;
  IF src !~ 'agent_commissions_unsettled' THEN
    RAISE EXCEPTION 'the meter does not read the period-aware unsettled view';
  END IF;
  IF src ~ 'FROM public\.agent_commissions WHERE settled_at IS NULL' THEN
    RAISE EXCEPTION 'the meter still asks the pre-phase-7 question';
  END IF;
  -- the other three currencies must survive untouched
  IF src !~ 'vip_points_ledger' OR src !~ 'rakeback_period_payouts' THEN
    RAISE EXCEPTION 'the rewrite lost a currency section';
  END IF;
END
$assert$;

COMMIT;
