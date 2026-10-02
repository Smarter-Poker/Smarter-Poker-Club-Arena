-- tests/fixtures/ledger-invariant/stores-regression.sql
--
-- Executes 20261002030942_every_chip_store_balances_with_its_ledger_row on the
-- remaining chip stores. Every "REFUSED" case plants the regression (a promo,
-- agent, club wallet, insurance, Spin reserve, escrow, ticket or clearing
-- balance that moves with no leg, the wrong leg, or a leg with no balance)
-- and proves the named refusal at commit; every "PASSES" case is a live
-- money-path shape and proves it commits. The mixed case proves the point of
-- per-store mode: a store being observed records a finding while a proven
-- store in the same transaction still refuses.

\set ON_ERROR_STOP on
\set QUIET on

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

-- The migration installs the nine new stores in observe; the six proven
-- stores carry refuse. The refusal cases run with every store refusing.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.ca_ledger_invariant_store_mode WHERE mode = 'observe') <> 9
     OR (SELECT count(*) FROM public.ca_ledger_invariant_store_mode WHERE mode = 'refuse') <> 6 THEN
    RAISE EXCEPTION 'FIXTURE: the migration did not install six refusing and nine observed stores';
  END IF;
END $$;
UPDATE public.ca_ledger_invariant_store_mode SET mode = 'refuse', reason = 'fixture: refusal cases';

-- ===========================================================================
-- REFUSED
-- ===========================================================================

SELECT pg_temp.expect_refused(
  'S1 a member promo wallet grows with no leg',
  $q$ UPDATE public.club_members SET promo_balance = promo_balance + 10
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$,
  'promo_wallet:aaaaaaaa-0000-0000-0000-000000000001');

SELECT pg_temp.expect_refused(
  'S2 an agent wallet moves through its mirror column (business_balance) with no leg',
  $q$ UPDATE public.agents SET business_balance = business_balance - 25 WHERE id = 'a6e00000-0000-0000-0000-000000000001' $q$,
  'agent_wallet:aaaaaaaa-0000-0000-0000-000000000003');

SELECT pg_temp.expect_refused(
  'S3 a club wallet leg of the wrong amount (rake 7.00 credited, 6.99 journalled)',
  $q$ UPDATE public.club_wallets SET chip_balance = chip_balance + 7 WHERE id = 'c1c1c1c1-0000-0000-0000-000000000001';
      SELECT set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets SET rake_wallet = rake_wallet - 6.99 WHERE union_id = '88888888-0000-0000-0000-000000000001';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('union_wallet', '88888888-0000-0000-0000-000000000001', 'club_wallet', 'c1c1c1c1-0000-0000-0000-000000000001', 6.99, 'rake', '11111111-1111-1111-1111-111111111111') $q$,
  'club_wallet:11111111-1111-1111-1111-111111111111');

SELECT pg_temp.expect_refused(
  'S4 a club insurance bank moves with no leg',
  $q$ UPDATE public.clubs SET insurance_balance = insurance_balance + 5 WHERE id = '11111111-1111-1111-1111-111111111111' $q$,
  'insurance_bank:11111111-1111-1111-1111-111111111111');

SELECT pg_temp.expect_refused(
  'S5 a Spin reserve is drawn with no leg',
  $q$ UPDATE public.spin_bonus_pools SET balance = balance - 40 WHERE id = '5b5b5b5b-0000-0000-0000-000000000001' $q$,
  'spin_reserve:5b5b5b5b-0000-0000-0000-000000000001');

SELECT pg_temp.expect_refused(
  'S6 an event escrow grows with no leg (the prize pool from nowhere)',
  $q$ UPDATE public.tournament_escrow SET prize_balance = prize_balance + 64000 WHERE tournament_id = '99999999-0000-0000-0000-000000000001' $q$,
  'tournament_liability:99999999-0000-0000-0000-000000000001');

SELECT pg_temp.expect_refused(
  'S7 a prize leg with no escrow movement behind it (paid twice from one pool)',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 18
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('prize_liability', '99999999-0000-0000-0000-000000000001', 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000002', 18, 'tournament_prize', '11111111-1111-1111-1111-111111111111') $q$,
  'tournament_liability:99999999-0000-0000-0000-000000000001');

SELECT pg_temp.expect_refused(
  'S8 a ticket is issued with no leg (a seat from nowhere)',
  $q$ INSERT INTO public.tournament_tickets (club_id, holder_id, value, status)
      VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 50, 'issued') $q$,
  'ticket_escrow');

SELECT pg_temp.expect_refused(
  'S9 a ticket is marked redeemed with no leg (its value vanishes)',
  $q$ UPDATE public.tournament_tickets SET status = 'redeemed' WHERE id = '77777777-7777-0000-0000-000000000001' $q$,
  'ticket_escrow');

SELECT pg_temp.expect_refused(
  'S10 a clearing store keeps what passed through it (treasury -> opening_setup with no onward leg)',
  $q$ SELECT set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs SET chip_treasury = chip_treasury - 100 WHERE id = '11111111-1111-1111-1111-111111111111';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('club_treasury', '11111111-1111-1111-1111-111111111111', 'opening_setup', '11111111-1111-1111-1111-111111111111', 100, 'club_opening_allocation', '11111111-1111-1111-1111-111111111111') $q$,
  'opening_setup:11111111-1111-1111-1111-111111111111');

SELECT pg_temp.expect_refused(
  'S11 the legacy union promo fund moves with no leg',
  $q$ UPDATE public.unions SET promo_fund_balance = promo_fund_balance + 9 WHERE id = '88888888-0000-0000-0000-000000000001' $q$,
  'promo_wallet:88888888-0000-0000-0000-000000000001');

-- ===========================================================================
-- PASSES: the live shapes
-- ===========================================================================

BEGIN;
SELECT pg_temp.expect_passes(
  'Q1 tournament buy-in: wallet -20, escrow prize +18 fee +2, one leg player_wallet -> prize_liability',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      UPDATE public.club_members SET chip_balance = chip_balance - 20
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('player_wallet', 'aaaaaaaa-0000-0000-0000-000000000002', 'prize_liability', '99999999-0000-0000-0000-000000000001', 20, 'tournament_buyin', '11111111-1111-1111-1111-111111111111');
      UPDATE public.tournament_escrow SET prize_balance = prize_balance + 18, fee_balance = fee_balance + 2
       WHERE tournament_id = '99999999-0000-0000-0000-000000000001' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q2 an event first seen: its escrow row is opened in the transaction that writes its first leg',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      UPDATE public.club_members SET chip_balance = chip_balance - 10
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000003';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('player_wallet', 'aaaaaaaa-0000-0000-0000-000000000003', 'prize_liability', '99999999-0000-0000-0000-000000000002', 10, 'tournament_buyin', '11111111-1111-1111-1111-111111111111');
      INSERT INTO public.tournament_escrow (tournament_id, prize_balance, fee_balance) VALUES ('99999999-0000-0000-0000-000000000002', 9, 1) $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q3 a prize and the event rake: escrow -18 to the winner, fee -2 to the union, two legs',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      SELECT set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.club_members SET chip_balance = chip_balance + 18
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
      UPDATE public.union_wallets SET rake_wallet = rake_wallet + 2 WHERE union_id = '88888888-0000-0000-0000-000000000001';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('prize_liability', '99999999-0000-0000-0000-000000000001', 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000002', 18, 'tournament_prize', '11111111-1111-1111-1111-111111111111'),
             ('prize_liability', '99999999-0000-0000-0000-000000000001', 'union_wallet', '88888888-0000-0000-0000-000000000001', 2, 'rake', NULL);
      UPDATE public.tournament_escrow SET prize_balance = prize_balance - 18, fee_balance = fee_balance - 2
       WHERE tournament_id = '99999999-0000-0000-0000-000000000001' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q4 a Spin: entry to the reserve and the drawn prize back, legs spin_entry and spin_prize',
  $q$ INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category)
      VALUES ('prize_liability', '99999999-0000-0000-0000-000000000002', 'spin_reserve', '5b5b5b5b-0000-0000-0000-000000000001', 9, 'spin_entry'),
             ('spin_reserve', '5b5b5b5b-0000-0000-0000-000000000001', 'prize_liability', '99999999-0000-0000-0000-000000000002', 45, 'spin_prize');
      UPDATE public.spin_bonus_pools SET balance = balance + 9 - 45 WHERE id = '5b5b5b5b-0000-0000-0000-000000000001';
      UPDATE public.tournament_escrow SET prize_balance = prize_balance - 9 + 45 WHERE tournament_id = '99999999-0000-0000-0000-000000000002' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q5 a satellite ticket: issued out of the event escrow, then redeemed into another event',
  $q$ INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category)
      VALUES ('prize_liability', '99999999-0000-0000-0000-000000000002', 'escrow', '77777777-7777-0000-0000-000000000002', 20, 'ticket_issue');
      UPDATE public.tournament_escrow SET prize_balance = prize_balance - 20 WHERE tournament_id = '99999999-0000-0000-0000-000000000002';
      INSERT INTO public.tournament_tickets (id, club_id, holder_id, value, status)
      VALUES ('77777777-7777-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 20, 'issued');
      UPDATE public.tournament_tickets SET status = 'redeemed' WHERE id = '77777777-7777-0000-0000-000000000001';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category)
      VALUES ('escrow', '77777777-7777-0000-0000-000000000001', 'prize_liability', '99999999-0000-0000-0000-000000000001', 30, 'ticket_redeem');
      UPDATE public.tournament_escrow SET prize_balance = prize_balance + 30 WHERE tournament_id = '99999999-0000-0000-0000-000000000001' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q6 the opening allocation clears through opening_setup in one transaction',
  $q$ SELECT set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs SET chip_treasury = chip_treasury - 100 WHERE id = '11111111-1111-1111-1111-111111111111';
      UPDATE public.spin_bonus_pools SET balance = balance + 100 WHERE id = '5b5b5b5b-0000-0000-0000-000000000001';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('club_treasury', '11111111-1111-1111-1111-111111111111', 'opening_setup', '11111111-1111-1111-1111-111111111111', 100, 'club_opening_allocation', '11111111-1111-1111-1111-111111111111'),
             ('opening_setup', '11111111-1111-1111-1111-111111111111', 'spin_reserve', '5b5b5b5b-0000-0000-0000-000000000001', 100, 'club_opening_allocation', '11111111-1111-1111-1111-111111111111') $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q7 a leaderboard round: the club promo pays out through leaderboard_round to two players',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      UPDATE public.clubs SET promo_balance = promo_balance - 50 WHERE id = '11111111-1111-1111-1111-111111111111';
      UPDATE public.club_members SET chip_balance = chip_balance + 30
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
      UPDATE public.club_members SET chip_balance = chip_balance + 20
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000002';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('promo_wallet', '11111111-1111-1111-1111-111111111111', 'leaderboard_round', '11111111-1111-1111-1111-111111111111', 50, 'leaderboard_payout', '11111111-1111-1111-1111-111111111111'),
             ('leaderboard_round', '11111111-1111-1111-1111-111111111111', 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000001', 30, 'leaderboard_payout', '11111111-1111-1111-1111-111111111111'),
             ('leaderboard_round', '11111111-1111-1111-1111-111111111111', 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000002', 20, 'leaderboard_payout', '11111111-1111-1111-1111-111111111111') $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q8 an agent sends from the agent wallet (written through business_balance) to a player',
  $q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
      UPDATE public.agents SET business_balance = business_balance - 25 WHERE id = 'a6e00000-0000-0000-0000-000000000001';
      UPDATE public.club_members SET chip_balance = chip_balance + 25
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('agent_wallet', 'aaaaaaaa-0000-0000-0000-000000000003', 'player_wallet', 'aaaaaaaa-0000-0000-0000-000000000001', 25, 'agent_transfer', '11111111-1111-1111-1111-111111111111') $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q9 a club wallet and its insurance bank, named by the club_wallets row or by the club: one account each',
  $q$ SELECT set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.club_wallets SET chip_balance = chip_balance + 7, insurance_balance = insurance_balance - 3
       WHERE id = 'c1c1c1c1-0000-0000-0000-000000000001';
      UPDATE public.union_wallets SET rake_wallet = rake_wallet - 4 WHERE union_id = '88888888-0000-0000-0000-000000000001';
      INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id)
      VALUES ('union_wallet', '88888888-0000-0000-0000-000000000001', 'club_wallet', 'c1c1c1c1-0000-0000-0000-000000000001', 7, 'rake', '11111111-1111-1111-1111-111111111111'),
             ('insurance_bank', '11111111-1111-1111-1111-111111111111', 'union_wallet', '88888888-0000-0000-0000-000000000001', 3, 'insurance', '11111111-1111-1111-1111-111111111111') $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q10 a Diamond event''s escrow shadow moves with no chip leg: Diamonds in custody, not chips',
  $q$ UPDATE public.tournament_escrow SET prize_balance = prize_balance - 100 WHERE tournament_id = '99999999-0000-0000-0000-00000000000d' $q$);
COMMIT;

BEGIN;
SELECT pg_temp.expect_passes(
  'Q11 a rolled-back subtransaction takes its promo tally with it',
  $q$ DO $d$ BEGIN
        BEGIN
          UPDATE public.club_members SET promo_balance = promo_balance + 99
           WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
          RAISE EXCEPTION 'abandon';
        EXCEPTION WHEN raise_exception THEN NULL;
        END;
      END $d$ $q$);
COMMIT;

-- ===========================================================================
-- PER-STORE MODE: an observed store records; a proven store still refuses
-- ===========================================================================

UPDATE public.ca_ledger_invariant_store_mode SET mode = 'observe', reason = 'fixture: observe case'
 WHERE store = 'promo_wallet';

SELECT pg_temp.expect_refused(
  'M1 one transaction, an observed promo drift and a felt drift: the felt still refuses',
  $q$ UPDATE public.club_members SET promo_balance = promo_balance + 7
       WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
      UPDATE public.table_seats SET stack = stack + 7 WHERE id = '55555555-0000-0000-0000-000000000002' $q$,
  'table_stack');

BEGIN;
UPDATE public.club_members SET promo_balance = promo_balance + 7
 WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
COMMIT;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.ca_ledger_invariant_findings
   WHERE account_key = 'promo_wallet:aaaaaaaa-0000-0000-0000-000000000001';
  IF r.txid IS NULL OR r.balance_delta <> 7 OR r.ledger_net <> 0 OR r.mode <> 'observe' THEN
    RAISE EXCEPTION 'FIXTURE: an observed store did not record its finding: %', to_jsonb(r);
  END IF;
  RAISE NOTICE 'ok  observed  M2 the promo wallet grew by 7 with no leg; recorded, committed, mode observe';
END $$;

-- ===========================================================================
-- The books: every new store explained by the journal
-- ===========================================================================

DO $$
DECLARE v numeric;
BEGIN
  -- event 1: 200 opening; +20 (Q1) -20 (Q3) +30 (Q5) = 230
  SELECT prize_balance + bounty_balance + fee_balance INTO v FROM public.tournament_escrow
   WHERE tournament_id = '99999999-0000-0000-0000-000000000001';
  IF v <> 230 THEN RAISE EXCEPTION 'FIXTURE: event 1 escrow % (expected 230)', v; END IF;
  -- event 2: +10 (Q2) -9 +45 (Q4) -20 (Q5) = 26
  SELECT prize_balance + bounty_balance + fee_balance INTO v FROM public.tournament_escrow
   WHERE tournament_id = '99999999-0000-0000-0000-000000000002';
  IF v <> 26 THEN RAISE EXCEPTION 'FIXTURE: event 2 escrow % (expected 26)', v; END IF;
  -- Spin pool: 300 +9 -45 (Q4) +100 (Q6) = 364
  SELECT balance INTO v FROM public.spin_bonus_pools WHERE id = '5b5b5b5b-0000-0000-0000-000000000001';
  IF v <> 364 THEN RAISE EXCEPTION 'FIXTURE: spin pool % (expected 364)', v; END IF;
  -- ticket float: 30 redeemed, 20 issued
  SELECT COALESCE(sum(value), 0) INTO v FROM public.tournament_tickets WHERE status = 'issued';
  IF v <> 20 THEN RAISE EXCEPTION 'FIXTURE: ticket float % (expected 20)', v; END IF;
  -- agent: 500 - 25 (Q8), mirror equal
  SELECT agent_wallet_balance INTO v FROM public.agents WHERE id = 'a6e00000-0000-0000-0000-000000000001';
  IF v <> 475 THEN RAISE EXCEPTION 'FIXTURE: agent wallet % (expected 475)', v; END IF;
  IF (SELECT count(*) FROM public.ca_ledger_invariant_findings WHERE account_key LIKE 'promo_wallet:%') <> 1 THEN
    RAISE EXCEPTION 'FIXTURE: expected exactly one observed store finding';
  END IF;
  RAISE NOTICE 'ok  books     event escrows 230 / 26, Spin pool 364, ticket float 20, agent wallet 475; one observed finding';
END $$;
