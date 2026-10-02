-- tests/fixtures/ledger-invariant/suspense-regression.sql
--
-- Executes *_no_balance_moves_against_settlement_suspense.sql on the fixture
-- after every store proof has run. Every chip store already balances with its
-- own legs; these cases are the ones where the store balances and the chips
-- still come from nowhere, because the other end of the leg is
-- settlement_suspense (no balance column, outside the supply count). Every
-- "REFUSED" case plants that regression and proves the named refusal at
-- commit; every "PASSES" case is a live shape (a declared door, a journal-only
-- correction) and proves it commits. The observe case proves the finding is
-- recorded and the transaction commits while the judgement is measured.

\set ON_ERROR_STOP on
\set QUIET on

CREATE OR REPLACE FUNCTION pg_temp.expect_suspense_refused(p_case text, p_sql text)
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
    IF v_state <> '23514' OR v_msg NOT LIKE 'REFUSED: balance_moved_against_settlement_suspense %' THEN
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

-- The migration installs the judgement in observe. The refusal cases run with
-- it refusing, as production will once the window reads zero.
DO $$
BEGIN
  IF (SELECT mode FROM public.ca_ledger_invariant_store_mode WHERE store = 'settlement_suspense') IS DISTINCT FROM 'observe' THEN
    RAISE EXCEPTION 'FIXTURE: the migration did not install the settlement_suspense judgement in observe';
  END IF;
END $$;
UPDATE public.ca_ledger_invariant_store_mode SET mode = 'refuse', reason = 'fixture: suspense refusal cases'
 WHERE store = 'settlement_suspense';

-- ===========================================================================
-- REFUSED: the store balances, the chips come from suspense
-- ===========================================================================

SELECT pg_temp.expect_suspense_refused(
  'X1 an undeclared member-wallet credit: the journal trigger books it out of suspense',
  $q$ UPDATE public.club_members SET chip_balance = chip_balance + 10
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);

SELECT pg_temp.expect_suspense_refused(
  'X2 an undeclared union rake debit: the journal trigger books it into suspense',
  $q$ UPDATE public.union_wallets SET rake_wallet = rake_wallet - 2
       WHERE union_id = '88888888-0000-0000-0000-000000000001' $q$);

SELECT pg_temp.expect_suspense_refused(
  'X3 a door stands the journal down and writes its own leg out of suspense',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 5
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('settlement_suspense', NULL, 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000002', 5, 'adjustment', '11111111-1111-1111-1111-111111111111') $q$);
SELECT set_config('app.ledger_autoskip_club_members', '', false);

SELECT pg_temp.expect_suspense_refused(
  'X4 a covered balance moves and suspense is reached through a label with no balance',
  $q$ SELECT set_config('app.ledger_category', 'commission', true);
      SELECT set_config('app.ledger_counterparty', 'issuance_reserve', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 10
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000003';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('settlement_suspense', NULL, 'issuance_reserve', NULL, 10, 'adjustment', '11111111-1111-1111-1111-111111111111') $q$);

SELECT pg_temp.expect_suspense_refused(
  'X5 a correction label does not hide a suspense leg beside a balance move',
  $q$ SELECT set_config('app.ledger_category', 'buyin', true);
      SELECT set_config('app.ledger_counterparty', 'table_stack', true);
      SELECT set_config('app.ledger_counterparty_entity', '77777777-0000-0000-0000-000000000001', true);
      UPDATE public.club_members SET chip_balance = chip_balance - 5
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
      UPDATE public.table_seats SET stack = stack + 5 WHERE id = '55555555-0000-0000-0000-000000000002';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, metadata)
      VALUES ('settlement_suspense', NULL, 'issuance_reserve', NULL, 5, 'correction', '11111111-1111-1111-1111-111111111111',
              '{"posted_via":"fn_ca_post_correction","incident_id":"00000000-0000-0000-0000-000000000000"}'::jsonb) $q$);

-- ===========================================================================
-- PASSES: a declared door and a journal-only correction commit untouched
-- ===========================================================================

BEGIN;
SELECT pg_temp.expect_passes(
  'Y1 a declared buy-in (wallet -> felt) names its counterparty and never touches suspense',
  $q$ SELECT set_config('app.ledger_category', 'buyin', true);
      SELECT set_config('app.ledger_counterparty', 'table_stack', true);
      SELECT set_config('app.ledger_counterparty_entity', '77777777-0000-0000-0000-000000000001', true);
      UPDATE public.club_members SET chip_balance = chip_balance - 5
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
      UPDATE public.table_seats SET stack = stack + 5 WHERE id = '55555555-0000-0000-0000-000000000002' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Y2 a journal-only suspense restatement (fn_ca_post_correction) moves no balance and commits',
  $q$ INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, metadata)
      VALUES ('settlement_suspense', NULL, 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000001', 3.21, 'correction',
              '11111111-1111-1111-1111-111111111111', '{"posted_via":"fn_ca_post_correction","incident_id":"00000000-0000-0000-0000-000000000000"}'::jsonb) $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Y3 a journal-only suspense leg to a label with no balance moves nothing and commits',
  $q$ INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('settlement_suspense', NULL, 'chip_retirement', NULL, 4, 'adjustment', '11111111-1111-1111-1111-111111111111') $q$);
COMMIT;

-- ===========================================================================
-- OBSERVE: while the judgement is measured, it records and commits
-- ===========================================================================

UPDATE public.ca_ledger_invariant_store_mode SET mode = 'observe', reason = 'fixture: suspense observe case'
 WHERE store = 'settlement_suspense';

BEGIN;
UPDATE public.club_members SET chip_balance = chip_balance + 9
 WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
COMMIT;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.ca_ledger_invariant_findings WHERE account_key = 'settlement_suspense';
  IF r.txid IS NULL OR r.balance_delta <> 9 OR r.ledger_net <> 9 OR r.mode <> 'observe'
     OR r.statement NOT LIKE '%moved: player_wallet:aaaaaaaa-0000-0000-0000-000000000002:11111111-1111-1111-1111-111111111111 9.00%' THEN
    RAISE EXCEPTION 'FIXTURE: the observed suspense move did not record its finding: %', to_jsonb(r);
  END IF;
  IF (SELECT count(*) FROM public.ca_ledger_invariant_findings WHERE account_key = 'settlement_suspense') <> 1 THEN
    RAISE EXCEPTION 'FIXTURE: expected exactly one settlement_suspense finding (the passes must record none)';
  END IF;
  RAISE NOTICE 'ok  observed  Z1 a member wallet credited 9 out of suspense; recorded, committed, mode observe';
END $$;
