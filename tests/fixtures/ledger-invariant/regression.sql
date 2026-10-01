-- tests/fixtures/ledger-invariant/regression.sql
--
-- Executes the invariant installed by 20261001160611_a_balance_never_moves_
-- without_its_ledger_row. Every "REFUSED" case plants the exact regression
-- (a balance that moves with no leg, a stand-down whose leg is missing, wrong,
-- or names the wrong wallet, a leg with no balance) and proves the named
-- refusal at commit time; every "PASSES" case is a live money-path shape
-- (buy-in, cash-out, raked hand with jackpot drop, pending add-on, treasury
-- stand-down pair, seat move, tournament felt, Diamond felt, journal-only
-- correction) and proves it commits untouched. Runs under psql ON_ERROR_STOP.

\set ON_ERROR_STOP on
\set QUIET on

-- The check is deferred to commit. Inside one transaction, SET CONSTRAINTS ALL
-- IMMEDIATE fires everything queued so far, which is exactly what COMMIT would
-- do; the DO block's own exception then rolls the scenario back.
CREATE OR REPLACE FUNCTION pg_temp.expect_refused(p_case text, p_sql text, p_account text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text; v_detail text; v_state text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'FIXTURE: % committed cleanly and was supposed to be refused', p_case USING ERRCODE = 'P9999';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    IF v_state = 'P9999' THEN RAISE; END IF;
    IF v_state <> '23514' OR v_msg NOT LIKE 'REFUSED: balance_moved_without_its_ledger_row account=' || p_account || ' %' THEN
      RAISE EXCEPTION 'FIXTURE: % was refused for the wrong reason: [%] % / %', p_case, v_state, v_msg, v_detail;
    END IF;
    RAISE NOTICE 'ok  refused   %: %', p_case, v_msg;
  END;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.expect_passes(p_case text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'ok  passes    %', p_case;
END $$;

-- The migration installs 'observe'. The refusal cases run under 'refuse'.
UPDATE public.ca_ledger_invariant_mode SET mode = 'refuse', reason = 'fixture: refusal cases';

-- ===========================================================================
-- REFUSED
-- ===========================================================================

SELECT pg_temp.expect_refused(
  'R1 a cash stack grows with no leg (the chip that appears from nowhere)',
  $q$ UPDATE public.table_seats SET stack = stack + 48 WHERE id = '55555555-0000-0000-0000-000000000001' $q$,
  'table_stack');

SELECT pg_temp.expect_refused(
  'R2 the 2026-08-25 probe: a seat row with a stack is deleted',
  $q$ DELETE FROM public.table_seats WHERE id = '55555555-0000-0000-0000-000000000001' $q$,
  'table_stack');

SELECT pg_temp.expect_refused(
  'R3 a stand-down that writes no leg at all',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 10
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$,
  'player_wallet:aaaaaaaa-0000-0000-0000-000000000001:11111111-1111-1111-1111-111111111111');

SELECT pg_temp.expect_refused(
  'R4 a stand-down whose own leg is the wrong amount (10.00 moved, 9.99 journalled)',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 10
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('club_treasury', '11111111-1111-1111-1111-111111111111', 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000001', 9.99, 'rakeback', '11111111-1111-1111-1111-111111111111');
      SELECT set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs SET chip_treasury = chip_treasury - 9.99 WHERE id = '11111111-1111-1111-1111-111111111111' $q$,
  'player_wallet:aaaaaaaa-0000-0000-0000-000000000001:11111111-1111-1111-1111-111111111111');

SELECT pg_temp.expect_refused(
  'R5 a stand-down whose leg names the wrong wallet (paid user 1, journalled user 2)',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      SELECT set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 10
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
      UPDATE public.clubs SET chip_treasury = chip_treasury - 10 WHERE id = '11111111-1111-1111-1111-111111111111';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('club_treasury', '11111111-1111-1111-1111-111111111111', 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000002', 10, 'commission', '11111111-1111-1111-1111-111111111111') $q$,
  'player_wallet:aaaaaaaa-0000-0000-0000-000000000001:11111111-1111-1111-1111-111111111111');

SELECT pg_temp.expect_refused(
  'R6 a leg with no balance movement behind it',
  $q$ INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('settlement_suspense', NULL, 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000001', 5, 'adjustment', '11111111-1111-1111-1111-111111111111') $q$,
  'player_wallet:aaaaaaaa-0000-0000-0000-000000000001:11111111-1111-1111-1111-111111111111');

SELECT pg_temp.expect_refused(
  'R7 a stand-down on the union rake wallet with no leg',
  $q$ SELECT set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets SET rake_wallet = rake_wallet + 1.50 WHERE union_id = '88888888-0000-0000-0000-000000000001' $q$,
  'union_wallet:88888888-0000-0000-0000-000000000001');

SELECT pg_temp.expect_refused(
  'R8 a stand-down on the jackpot pool with no leg',
  $q$ SELECT set_config('app.ledger_autoskip_bbj_pools', '1', true);
      UPDATE public.bbj_pools SET main_balance = main_balance + 0.25 WHERE id = '44444444-0000-0000-0000-000000000001' $q$,
  'bbj_pool:44444444-0000-0000-0000-000000000001');

SELECT pg_temp.expect_refused(
  'R9 a pending add-on float that appears with no leg',
  $q$ INSERT INTO public.table_pending_addons (table_id, user_id, amount)
      VALUES ('77777777-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 15) $q$,
  'table_stack');

SELECT pg_temp.expect_refused(
  'R10 a cash-out that pays the wallet but leaves the stack on the felt',
  $q$ SELECT set_config('app.ledger_counterparty', 'table_stack', true);
      SELECT set_config('app.ledger_counterparty_entity', '77777777-0000-0000-0000-000000000001', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 50
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$,
  'table_stack');

-- A stand-down that leaked out of its transaction (set_config(..., false) is
-- session scope on a pooled connection) silences the journal for every later
-- transaction on that connection. The next plain write is refused, because
-- the promise the setting makes is now verified instead of trusted.
SELECT set_config('app.ledger_autoskip_club_members', '1', false);
SELECT pg_temp.expect_refused(
  'R11 a session-scoped stand-down leaked onto a later plain wallet write',
  $q$ UPDATE public.club_members SET chip_balance = chip_balance + 1
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002' $q$,
  'player_wallet:aaaaaaaa-0000-0000-0000-000000000002:11111111-1111-1111-1111-111111111111');
SELECT set_config('app.ledger_autoskip_club_members', '', false);

-- ===========================================================================
-- PASSES: every live money-path shape commits untouched
-- ===========================================================================

BEGIN;
SELECT pg_temp.expect_passes(
  'P1 buy-in: wallet -20 (autoledger leg player_wallet -> table_stack), seat +20',
  $q$ SELECT set_config('app.ledger_category', 'buyin', true);
      SELECT set_config('app.ledger_counterparty', 'table_stack', true);
      SELECT set_config('app.ledger_counterparty_entity', '77777777-0000-0000-0000-000000000001', true);
      UPDATE public.club_members SET chip_balance = chip_balance - 20
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
      UPDATE public.table_seats SET stack = stack + 20 WHERE id = '55555555-0000-0000-0000-000000000001' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P2 raked hand with jackpot drop: pot moves between seats, rake to the union, drop to the pool',
  $q$ UPDATE public.table_seats SET stack = stack - 30 WHERE id = '55555555-0000-0000-0000-000000000002';
      UPDATE public.table_seats SET stack = stack + 27 WHERE id = '55555555-0000-0000-0000-000000000003';
      SELECT set_config('app.ledger_category', 'rake', true);
      SELECT set_config('app.ledger_counterparty', 'table_stack', true);
      SELECT set_config('app.ledger_counterparty_entity', '77777777-0000-0000-0000-000000000001', true);
      UPDATE public.union_wallets SET rake_wallet = rake_wallet + 2 WHERE union_id = '88888888-0000-0000-0000-000000000001';
      SELECT set_config('app.ledger_category', 'bbj_contribution', true);
      UPDATE public.bbj_pools SET main_balance = main_balance + 0.50, backup_balance = backup_balance + 0.30, promo_balance = promo_balance + 0.20
       WHERE id = '44444444-0000-0000-0000-000000000001' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P3 cash-out: the seat is vacated with its stack on the row, the wallet is credited',
  $q$ UPDATE public.table_seats SET left_at = now() WHERE id = '55555555-0000-0000-0000-000000000001';
      SELECT set_config('app.ledger_category', 'table_cashout', true);
      SELECT set_config('app.ledger_counterparty', 'table_stack', true);
      SELECT set_config('app.ledger_counterparty_entity', '77777777-0000-0000-0000-000000000001', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 70
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P4a pending add-on requested: wallet -15 with its leg, the float waits on the felt',
  $q$ SELECT set_config('app.ledger_category', 'addon', true);
      SELECT set_config('app.ledger_counterparty', 'table_stack', true);
      SELECT set_config('app.ledger_counterparty_entity', '77777777-0000-0000-0000-000000000001', true);
      UPDATE public.club_members SET chip_balance = chip_balance - 15
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
      INSERT INTO public.table_pending_addons (id, table_id, user_id, amount)
      VALUES ('33333333-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 15) $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P4b pending add-on resolved at hand end: float to seat, no leg (not a movement)',
  $q$ UPDATE public.table_pending_addons SET resolved_at = now(), applied_to_stack = 15 WHERE id = '33333333-0000-0000-0000-000000000001';
      UPDATE public.table_seats SET stack = stack + 15 WHERE id = '55555555-0000-0000-0000-000000000002' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P5 the stand-down pair done right: treasury -100 and wallet +100 under one named leg, leg written first',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      SELECT set_config('app.ledger_autoskip_clubs', '1', true);
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, idempotency_key)
      VALUES ('club_treasury', '11111111-1111-1111-1111-111111111111', 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000003', 100, 'rakeback', '11111111-1111-1111-1111-111111111111', 'rakeback:fixture:1');
      UPDATE public.clubs SET chip_treasury = chip_treasury - 100 WHERE id = '11111111-1111-1111-1111-111111111111';
      UPDATE public.club_members SET chip_balance = chip_balance + 100
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000003' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P6 a rolled-back subtransaction leaves no tally behind',
  $q$ DO $d$ BEGIN
        BEGIN
          PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
          UPDATE public.club_members SET chip_balance = chip_balance + 999
           WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
          RAISE EXCEPTION 'the door changed its mind';
        EXCEPTION WHEN OTHERS THEN
          NULL; -- the write and its tally are gone together
        END;
        PERFORM set_config('app.ledger_autoskip_club_members', '', true);
        PERFORM set_config('app.ledger_category', 'player_funding', true);
        PERFORM set_config('app.ledger_counterparty', 'club_treasury', true);
        PERFORM set_config('app.ledger_counterparty_entity', '11111111-1111-1111-1111-111111111111', true);
        UPDATE public.club_members SET chip_balance = chip_balance + 3
         WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
        PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
        UPDATE public.clubs SET chip_treasury = chip_treasury - 3 WHERE id = '11111111-1111-1111-1111-111111111111';
      END $d$ $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P7 tournament felt and Diamond felt move without legs (not chip money), and a seat moves between two cash tables',
  $q$ UPDATE public.table_seats SET stack = stack - 400 WHERE id = '55555555-0000-0000-0000-00000000000e';
      UPDATE public.table_seats SET stack = stack + 100 WHERE id = '55555555-0000-0000-0000-00000000000d';
      UPDATE public.table_seats SET left_at = now() WHERE id = '55555555-0000-0000-0000-000000000003';
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      SELECT '77777777-0000-0000-0000-000000000002', user_id, 4, stack FROM public.table_seats WHERE id = '55555555-0000-0000-0000-000000000003' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P8 a journal-only correction (fn_ca_post_correction) is outside the tally, as it is outside every meter',
  $q$ INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, metadata)
      VALUES ('settlement_suspense', NULL, 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000001', 12.34, 'correction',
              '11111111-1111-1111-1111-111111111111', '{"posted_via":"fn_ca_post_correction","incident_id":"00000000-0000-0000-0000-000000000000"}'::jsonb) $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P9 a write that moves nothing needs nothing',
  $q$ UPDATE public.club_members SET chip_balance = chip_balance
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
      UPDATE public.table_seats SET seat_number = seat_number WHERE id = '55555555-0000-0000-0000-000000000002' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'P10 a declaring payer names the union by its id, the autoledger by its wallet row: one account',
  $q$ SELECT set_config('app.ledger_autoskip_union_wallets', '1', true);
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, union_id)
      VALUES ('prize_liability', '99999999-0000-0000-0000-000000000001', 'union_wallet', '88888888-0000-0000-0000-000000000001', 4, 'rake', '88888888-0000-0000-0000-000000000001');
      UPDATE public.union_wallets SET rake_wallet = rake_wallet + 4 WHERE union_id = '88888888-0000-0000-0000-000000000001' $q$);
COMMIT;

-- ===========================================================================
-- OBSERVE: the same regression is recorded, warned, and committed
-- ===========================================================================

UPDATE public.ca_ledger_invariant_mode SET mode = 'observe', reason = 'fixture: observe case';
BEGIN;
UPDATE public.table_seats SET stack = stack + 48 WHERE id = '55555555-0000-0000-0000-000000000002';
COMMIT;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.ca_ledger_invariant_findings WHERE account_key = 'table_stack';
  IF r.txid IS NULL OR r.balance_delta <> 48 OR r.ledger_net <> 0 OR r.mode <> 'observe' THEN
    RAISE EXCEPTION 'FIXTURE: observe mode did not record the finding: %', to_jsonb(r);
  END IF;
  RAISE NOTICE 'ok  observed  O1 the felt grew by 48 with no leg; recorded under txid % by % (%)', r.txid, r.db_role, left(r.statement, 60);
END $$;
UPDATE public.ca_ledger_invariant_mode SET mode = 'refuse', reason = 'fixture: back to refuse';

-- ===========================================================================
-- The books after all of it: every balance explained by the journal
-- ===========================================================================

DO $$
DECLARE v_bal numeric; v_led numeric;
BEGIN
  -- player 1: 100 -20 (P1) +70 (P3) +3 (P6) = 153; legs: -20 +70 +3 (and 12.34 journal-only, excluded)
  SELECT chip_balance INTO v_bal FROM public.club_members WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  SELECT COALESCE(sum(CASE WHEN to_type = 'player_wallet' THEN amount ELSE -amount END), 0) INTO v_led
    FROM public.chip_ledger
   WHERE (to_entity_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND to_type = 'player_wallet'
       OR from_entity_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND from_type = 'player_wallet')
     AND NOT (category = 'correction' AND metadata ->> 'posted_via' = 'fn_ca_post_correction');
  IF v_bal <> 153 OR v_led <> 53 THEN
    RAISE EXCEPTION 'FIXTURE: player 1 balance % / journal % (expected 153 / 53)', v_bal, v_led;
  END IF;
  SELECT chip_treasury INTO v_bal FROM public.clubs WHERE id = '11111111-1111-1111-1111-111111111111';
  IF v_bal <> 897 THEN RAISE EXCEPTION 'FIXTURE: treasury % (expected 897)', v_bal; END IF;
  IF (SELECT count(*) FROM public.ca_ledger_invariant_findings) <> 1 THEN
    RAISE EXCEPTION 'FIXTURE: expected exactly one observe finding';
  END IF;
  RAISE NOTICE 'ok  books     player 1 = 153 explained by 53 of legs over 100 opening; treasury 897; one observe finding';
END $$;
