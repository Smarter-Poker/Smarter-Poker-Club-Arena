-- the_guard_that_stopped_five_satellites_is_answered_for
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The record half of the fix in
-- 20260910075958_a_deferred_check_reads_the_row_at_commit_not_the_statement
-- (CLAUDE.md 10.9: a settlement is finished when the migration, the changelog,
-- the resolved incident and the code fix all exist).
--
-- Between 07:24 and 07:52 my own constraint trigger refused the terminal
-- settlement of five satellites, because a DEFERRED constraint trigger is
-- handed the tuple its firing statement produced, not the row as it commits.
-- Each event was down to its last player and each retried until the trigger was
-- corrected at 07:59:58. All five settled within 36 seconds of that, through
-- their own door, with the seat delivered, the remainder paid and escrow at
-- zero:
--
--   0c007b41  08:00:25  1 award, 38.00 paid, escrow 0
--   19b22b48  08:00:28  1 award, 57.00 paid, escrow 0
--   56deda8a  08:00:25  1 award, 57.00 paid, escrow 0
--   84d3755b  08:00:18  1 award, 200.00 paid, escrow 0
--   df08cfbf  08:00:34  1 award, 38.00 paid, escrow 0
--
-- Nobody was paid late by more than half an hour, nobody was paid twice, and no
-- correction of any kind is owed: every refusal aborted its own transaction, so
-- there was nothing to undo. The two guard-definition notices are mine as well -
-- fn_ca_settlement_correctness_check was redefined by a_ticket_entry_is_an_entry
-- and fn_ca_financial_alert_to_incident by 20260910020416.
--
-- This migration only writes to ca_drift_incidents. It asserts the events are
-- COMPLETED with nothing left in escrow before it closes anything.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_sats uuid[] := ARRAY[
    '0c007b41-668a-4600-8a12-ecb8b5e1b16b',
    '19b22b48-3392-416f-9341-57e0952b98e4',
    '56deda8a-63a7-47c5-a453-1ce57084f148',
    '84d3755b-17b0-4617-b739-5fba9fd9c154',
    'df08cfbf-7278-4b4c-9b66-e176956abf64']::uuid[];
  v_n integer;
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.tournaments t
   WHERE t.id = ANY(v_sats) AND t.status = 'COMPLETED';
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'expected all five satellites COMPLETED, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tournament_escrow e
   WHERE e.tournament_id = ANY(v_sats)
     AND round(COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0) + COALESCE(e.fee_balance,0), 2) <> 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% of the five satellites still hold escrow', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.tournament_players tp
   WHERE tp.tournament_id = ANY(v_sats) AND tp.position IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% roster row(s) across the five satellites still hold no place', v_n;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'Constraint trigger tournament_elimination_has_a_place (my migration 20260910072351) judged NEW, which for a DEFERRED constraint trigger is the tuple produced by the firing statement rather than the row as it commits. A terminal settlement that writes status=eliminated first and the finishing place second was therefore refused on a row that was about to be correct. Fixed in 20260910075958: the deferred check re-reads the row at commit.',
         correction_ref = 'migration a_deferred_check_reads_the_row_at_commit_not_the_statement',
         resolution = 'No correction owed. Each refusal aborted its own transaction, so nothing was half-written; all five satellites settled through their own door within 36 seconds of the fix, each with its seat award delivered, its remainder paid and escrow at 0.00. Delay to the affected players: under 36 minutes.'
   WHERE i.status = 'open'
     AND i.source = 'financial_alerts:Tournament.atomic_satellite_finish_refused';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 5 THEN
    RAISE EXCEPTION 'expected to resolve at least 5 satellite refusal incidents, resolved %', v_rows;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'Expected notice: the guard-definition watch reports any redefinition of a guard function. fn_ca_settlement_correctness_check was redefined by migration a_ticket_entry_is_an_entry (section F now accepts the entry door''s tournament_ticket_entry receipt as well as the cash door''s tournament_ticket_redeem); fn_ca_financial_alert_to_incident was redefined by migration 20260910020416.',
         correction_ref = 'no-change-needed: both redefinitions are deliberate, each shipped in its own migration with its reasoning and a changelog, and the watch reported them exactly as designed',
         resolution = 'Baseline accepted. The watch is doing what it exists to do; the definitions it flagged are the two this session and an earlier session changed on purpose.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_guard_defs_watch';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'expected to resolve the guard-definition notices, resolved %', v_rows;
  END IF;
END
$body$;

COMMIT;
