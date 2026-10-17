-- Club Data counts what the club played (20261017160125), end to end.
-- The Club JAQK shape: a union, two clubs, every player a member of both and
-- joined to SHARK first; a union cash table and a union tournament.
\set U '''fade0000-0000-0000-0000-000000000001'''
\set J '''a0000000-0000-0000-0000-000000000001'''
\set S '''a4143400-0000-0000-0000-000000000001'''
\set OWN '''00000000-0000-0000-0000-0000000000a1'''
\set AG  '''00000000-0000-0000-0000-0000000000a2'''
\set P   '''00000000-0000-0000-0000-0000000000b1'''
\set Q   '''00000000-0000-0000-0000-0000000000b2'''
\set X   '''00000000-0000-0000-0000-0000000000b3'''
\set T   '''00000000-0000-0000-0000-0000000000c1'''
\set M   '''00000000-0000-0000-0000-0000000000d1'''

INSERT INTO clubs VALUES (:J, 'Club JAQK', :OWN), (:S, 'SHARK CLUB', :OWN), (:U, 'Midway Union', :OWN);
INSERT INTO union_clubs VALUES (:U, :J), (:U, :S);
INSERT INTO profiles (id, username) VALUES (:OWN,'owner'),(:AG,'agent'),(:P,'p'),(:Q,'q'),(:X,'x');
INSERT INTO club_members (club_id, user_id, role, agent_id, joined_at) VALUES
  (:S, :P, 'player', NULL, now() - interval '30 days'),
  (:J, :P, 'player', :AG,  now() - interval '10 days'),   -- P's first union club is SHARK
  (:S, :Q, 'player', NULL, now() - interval '30 days'),
  (:J, :X, 'player', NULL, now() - interval '30 days'),   -- X is in J, not under the agent
  (:J, :AG, 'agent', NULL, now() - interval '40 days'),
  (:J, :OWN, 'owner', NULL, now() - interval '50 days');
INSERT INTO tables (id, club_id, union_id, name, game_variant, big_blind, small_blind, status)
  VALUES (:T, :U, :U, 'Union NLH 1/2', 'nlh', 2, 1, 'running');
INSERT INTO tournaments (id, club_id, union_id, name, tournament_type, status, start_time)
  VALUES (:M, :U, :U, 'Union MTT', 'MTT', 'RUNNING', now());
INSERT INTO tournament_players VALUES (:M, :P, :J), (:M, :Q, :S);

-- Make the live writers live now.
UPDATE ca_club_data_fact_state SET live_from = now() - interval '1 hour';

-- P buys in 100 through JAQK: balance (ledger) first, then the wallet row, one transaction.
BEGIN;
INSERT INTO chip_ledger (club_id, from_type, from_entity_id, to_type, to_entity_id, amount, table_id)
  VALUES (:J, 'player_wallet', :P, 'table_stack', :T, 100, :T);
INSERT INTO table_seats (table_id, user_id, club_id, stack) VALUES (:T, :P, :J, 100);
INSERT INTO wallet_transactions (user_id, amount, type, category, table_id) VALUES (:P, 100, 'debit', 'buyin', :T);
COMMIT;
-- Q buys in 80 through SHARK.
BEGIN;
INSERT INTO chip_ledger (club_id, from_type, from_entity_id, to_type, to_entity_id, amount, table_id)
  VALUES (:S, 'player_wallet', :Q, 'table_stack', :T, 80, :T);
INSERT INTO table_seats (table_id, user_id, club_id, stack) VALUES (:T, :Q, :S, 80);
INSERT INTO wallet_transactions (user_id, amount, type, category, table_id) VALUES (:Q, 80, 'debit', 'buyin', :T);
COMMIT;
-- A hand: 4 rake, P and Q contributed equally.
INSERT INTO rake_records (table_id, is_tournament, rake_amount, player_contributions)
  VALUES (:T, false, 4, jsonb_build_object(:P::text, 20, :Q::text, 20));
-- A hand with no usable contribution: the table's club's.
INSERT INTO rake_records (table_id, is_tournament, rake_amount, player_contributions) VALUES (:T, false, 1, '{}'::jsonb);
-- P cashes out 150 through JAQK and leaves.
BEGIN;
INSERT INTO chip_ledger (club_id, from_type, from_entity_id, to_type, to_entity_id, amount, table_id)
  VALUES (:J, 'table_stack', :T, 'player_wallet', :P, 150, :T);
UPDATE table_seats SET left_at = now(), stack = 0 WHERE table_id = :T AND user_id = :P;
INSERT INTO wallet_transactions (user_id, amount, type, category, table_id) VALUES (:P, 150, 'credit', 'cashout', :T);
COMMIT;
-- Tournament: P enters (11), pays a 1 fee, wins 30. Q enters through SHARK.
BEGIN;
INSERT INTO chip_ledger (club_id, from_type, from_entity_id, to_type, amount) VALUES (:J, 'player_wallet', :P, 'prize_liability', 11);
INSERT INTO wallet_transactions (user_id, amount, type, category, related_entity_id) VALUES (:P, 11, 'debit', 'tournament_buyin', :M);
COMMIT;
INSERT INTO rake_records (tournament_id, is_tournament, rake_amount, metadata) VALUES (:M, true, 1, jsonb_build_object('user_id', :P::text));
INSERT INTO wallet_transactions (user_id, amount, type, category, related_entity_id) VALUES (:Q, 11, 'debit', 'tournament_buyin', :M);
INSERT INTO wallet_transactions (user_id, amount, type, category, related_entity_id) VALUES (:P, 30, 'credit', 'prize', :M);
-- Noise that must be ignored.
INSERT INTO wallet_transactions (user_id, amount, type, category) VALUES (:P, 5, 'credit', 'promo');

DO $$
DECLARE r record; j jsonb;
BEGIN
  -- The facts: JAQK owns P's money, SHARK owns Q's, the old guess is gone.
  SELECT sum(fee) fee, sum(buyins) b, sum(cashouts) c, sum(winnings) w INTO r FROM ca_club_data_fact
   WHERE club_id = 'a0000000-0000-0000-0000-000000000001' AND kind = 'CASH';
  IF (r.fee, r.b, r.c, r.w) IS DISTINCT FROM (2::numeric, 100::numeric, 150::numeric, 50::numeric) THEN
    RAISE EXCEPTION 'JAQK cash facts wrong: %', r; END IF;
  SELECT sum(fee) fee, sum(winnings) w INTO r FROM ca_club_data_fact
   WHERE club_id = 'a0000000-0000-0000-0000-000000000001' AND kind = 'TOURNAMENT';
  IF (r.fee, r.w) IS DISTINCT FROM (1::numeric, 19::numeric) THEN RAISE EXCEPTION 'JAQK tournament facts wrong: %', r; END IF;
  SELECT sum(fee) fee, sum(winnings) w INTO r FROM ca_club_data_fact WHERE club_id = 'a4143400-0000-0000-0000-000000000001';
  IF (r.fee, r.w) IS DISTINCT FROM (2::numeric, -91::numeric) THEN RAISE EXCEPTION 'SHARK facts wrong: %', r; END IF;
  SELECT sum(fee) INTO r FROM ca_club_data_fact WHERE club_id = 'fade0000-0000-0000-0000-000000000001';
  IF r.sum IS DISTINCT FROM 1::numeric THEN RAISE EXCEPTION 'unnamed rake should be the table club''s 1, got %', r; END IF;
END $$;
\connect "host=127.0.0.1 port=@PORT@ dbname=live user=authenticator"
-- As PostgREST runs a signed-in request: session user authenticator, role authenticated.
SET ROLE authenticated;
DO $$
DECLARE r record; j jsonb;
BEGIN
  -- The owner sees the whole club.
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
  PERFORM set_config('test.role', 'authenticated', true);
  j := ca_club_data_screen('a0000000-0000-0000-0000-000000000001');
  IF j->>'scope' <> 'club' OR j->>'club_name' <> 'Club JAQK' THEN RAISE EXCEPTION 'owner scope wrong: %', j; END IF;
  IF (j->'summary'->>'games')::int <> 2 OR (j->'summary'->>'fee')::numeric <> 3
     OR (j->'summary'->>'total_winnings')::numeric <> 69 OR (j->'summary'->>'mtt_winnings')::numeric <> 19 THEN
    RAISE EXCEPTION 'owner summary wrong: %', j->'summary'; END IF;
  RAISE NOTICE 'owner: %', j->'summary';

  -- SHARK's owner view includes Q's seated 80 as felt, not a loss.
  j := ca_club_data_screen('a4143400-0000-0000-0000-000000000001');
  IF (j->'summary'->>'total_winnings')::numeric <> -11 OR (j->'summary'->>'on_felt')::numeric <> 80 THEN
    RAISE EXCEPTION 'SHARK felt wrong: %', j->'summary'; END IF;
  IF (j->'rows'->0->>'live')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'seated table should read live: %', j->'rows'; END IF;

  -- The agent sees himself and P, with the same numbers (all of JAQK's play is P's).
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000a2', true);
  j := ca_club_data_screen('a0000000-0000-0000-0000-000000000001');
  IF j->>'scope' <> 'downline' OR j->>'viewer_role' <> 'agent' THEN RAISE EXCEPTION 'agent scope wrong: %', j; END IF;
  IF (j->'summary'->>'fee')::numeric <> 3 OR (j->'summary'->>'total_winnings')::numeric <> 69 THEN
    RAISE EXCEPTION 'agent summary wrong (unnamed rake is nobody''s downline): %', j->'summary'; END IF;

  -- A player is refused.
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000b3', true);
  BEGIN
    j := ca_club_data_screen('a0000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'a player was allowed to read Club Data: %', j;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Nobody signed in is refused.
  PERFORM set_config('test.uid', '', true);
  PERFORM set_config('test.role', 'anon', true);
  BEGIN
    j := ca_club_data_screen('a0000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'an anonymous caller was allowed: %', j;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Filters: Hold'em only shows the cash table; MTT only the tournament.
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
  PERFORM set_config('test.role', 'authenticated', true);
  j := ca_club_data_screen('a0000000-0000-0000-0000-000000000001', NULL, NULL, 'HOLDEM');
  IF (j->'summary'->>'games')::int <> 1 OR (j->'summary'->>'mtt_winnings')::numeric <> 0 THEN RAISE EXCEPTION 'holdem filter: %', j->'summary'; END IF;
  j := ca_club_data_screen('a0000000-0000-0000-0000-000000000001', NULL, NULL, 'MTT');
  IF (j->'summary'->>'games')::int <> 1 OR (j->'summary'->>'fee')::numeric <> 1 THEN RAISE EXCEPTION 'mtt filter: %', j->'summary'; END IF;
  j := ca_club_data_screen('a0000000-0000-0000-0000-000000000001', NULL, NULL, 'ALL', 'ALL', 'Union NLH');
  IF (j->'summary'->>'games')::int <> 1 THEN RAISE EXCEPTION 'search: %', j->'summary'; END IF;
END $$;

\connect "host=127.0.0.1 port=@PORT@ dbname=live user=postgres"
-- ===== A player at more than one table, and tables outside the union. =====
-- R joined SHARK first, then JAQK. R sits at the union table T through JAQK,
-- then at SHARK's own (non-union) table T2, then at JAQK's own table T3.
-- Each hand belongs to the club of R's seat AT THAT TABLE - never the earliest
-- union club (the original guess), never the latest seat anywhere (#7262).
\set R  '''00000000-0000-0000-0000-0000000000b4'''
\set T2 '''00000000-0000-0000-0000-0000000000c2'''
\set T3 '''00000000-0000-0000-0000-0000000000c3'''
INSERT INTO profiles (id, username) VALUES (:R, 'r');
INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES
  (:S, :R, 'player', now() - interval '30 days'), (:J, :R, 'player', now() - interval '10 days');
INSERT INTO tables (id, club_id, union_id, name, game_variant, big_blind, small_blind, status) VALUES
  (:T2, :S, NULL, 'Shark Home 1/2', 'nlh', 2, 1, 'running'),
  (:T3, :J, NULL, 'Jaqk Home 1/2', 'nlh', 2, 1, 'running');
INSERT INTO table_seats (table_id, user_id, club_id, stack, joined_at) VALUES (:T, :R, :J, 60, now() - interval '3 minutes');
INSERT INTO table_seats (table_id, user_id, club_id, stack, joined_at) VALUES (:T2, :R, :S, 40, now() - interval '2 minutes');
-- R's latest seat is SHARK's: a hand at the union table is still JAQK's.
INSERT INTO rake_records (table_id, is_tournament, rake_amount, player_contributions)
  VALUES (:T, false, 3, jsonb_build_object(:R::text, 30));
INSERT INTO rake_records (table_id, is_tournament, rake_amount, player_contributions)
  VALUES (:T2, false, 2, jsonb_build_object(:R::text, 20));
INSERT INTO table_seats (table_id, user_id, club_id, stack, joined_at) VALUES (:T3, :R, :J, 50, now() - interval '1 minute');
-- R's latest seat is now JAQK's: a hand at SHARK's own table is still SHARK's.
INSERT INTO rake_records (table_id, is_tournament, rake_amount, player_contributions)
  VALUES (:T2, false, 6, jsonb_build_object(:R::text, 60));
DO $$
DECLARE v numeric; n int;
BEGIN
  SELECT sum(fee) INTO v FROM ca_club_data_fact WHERE user_id = '00000000-0000-0000-0000-0000000000b4'
     AND club_id = 'a0000000-0000-0000-0000-000000000001' AND game_id = '00000000-0000-0000-0000-0000000000c1';
  IF v IS DISTINCT FROM 3::numeric THEN RAISE EXCEPTION 'R''s union-table hand should be JAQK''s 3, got %', v; END IF;
  SELECT sum(fee) INTO v FROM ca_club_data_fact WHERE user_id = '00000000-0000-0000-0000-0000000000b4'
     AND club_id = 'a4143400-0000-0000-0000-000000000001' AND game_id = '00000000-0000-0000-0000-0000000000c2';
  IF v IS DISTINCT FROM 8::numeric THEN RAISE EXCEPTION 'R''s SHARK-table hands should be SHARK''s 8, got %', v; END IF;
  SELECT count(*) INTO n FROM ca_club_data_fact WHERE user_id = '00000000-0000-0000-0000-0000000000b4'
     AND club_id = 'a0000000-0000-0000-0000-000000000001' AND game_id = '00000000-0000-0000-0000-0000000000c2';
  IF n <> 0 THEN RAISE EXCEPTION 'a SHARK-table hand was filed under JAQK'; END IF;

  -- The advanced report's facts follow the same seat (fn_ca_club_table_daily_add_rake).
  SELECT rake INTO v FROM club_table_daily WHERE club_id = 'a0000000-0000-0000-0000-000000000001'
     AND table_id = '00000000-0000-0000-0000-0000000000c1';
  IF v IS DISTINCT FROM 5::numeric THEN RAISE EXCEPTION 'club_table_daily JAQK at T should be 2 + 3, got %', v; END IF;
  SELECT rake INTO v FROM club_table_daily WHERE club_id = 'a4143400-0000-0000-0000-000000000001'
     AND table_id = '00000000-0000-0000-0000-0000000000c1';
  IF v IS DISTINCT FROM 2::numeric THEN RAISE EXCEPTION 'club_table_daily SHARK at T should be Q''s 2, got %', v; END IF;
  SELECT rake INTO v FROM club_table_daily WHERE club_id = 'a4143400-0000-0000-0000-000000000001'
     AND table_id = '00000000-0000-0000-0000-0000000000c2';
  IF v IS DISTINCT FROM 8::numeric THEN RAISE EXCEPTION 'club_table_daily SHARK at T2 should be 8, got %', v; END IF;
  SELECT count(*) INTO n FROM club_table_daily WHERE club_id = 'a0000000-0000-0000-0000-000000000001'
     AND table_id = '00000000-0000-0000-0000-0000000000c2';
  IF n <> 0 THEN RAISE EXCEPTION 'club_table_daily filed a SHARK-table hand under JAQK'; END IF;

  -- The felt follows each seat's own club.
  SELECT count(*) INTO n FROM fn_ca_club_cash_felt('a0000000-0000-0000-0000-000000000001', current_date - 1, current_date) f
   WHERE f.table_id IN ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3');
  IF n <> 2 THEN RAISE EXCEPTION 'JAQK felt should be T and T3, got % of them', n; END IF;
  SELECT count(*) INTO n FROM fn_ca_club_cash_felt('a0000000-0000-0000-0000-000000000001', current_date - 1, current_date) f
   WHERE f.table_id = '00000000-0000-0000-0000-0000000000c2';
  IF n <> 0 THEN RAISE EXCEPTION 'JAQK felt counted R''s SHARK seat'; END IF;
  -- The union-scoped last resort never leaves its union.
  IF fn_ca_cash_reporting_club(NULL, 'a4143400-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b4')
     IS DISTINCT FROM 'a4143400-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'a non-union table''s last resort must be the table''s own club'; END IF;
END $$;

-- ===== The seed reproduces exactly what the triggers wrote. =====
-- Copy the facts aside, wipe them, move live_from past every row, seed, compare.
CREATE TEMP TABLE live_facts AS SELECT * FROM ca_club_data_fact;
-- The seed must refuse to run before live_from has settled.
DO $$ BEGIN
  UPDATE ca_club_data_fact_state SET live_from = now() + interval '1 minute';
  BEGIN PERFORM fn_ca_club_data_fact_seed(now() - interval '1 hour', now());
    RAISE EXCEPTION 'seed ran before live_from';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'seed waits%' THEN RAISE; END IF;
  END;
END $$;
DELETE FROM ca_club_data_fact;
-- live_from is in the future relative to the rows, but the seed checks now() >= live_from + 1 min;
-- simulate time passing by moving every row back two hours instead.
UPDATE rake_records SET created_at = created_at - interval '2 hours';
UPDATE wallet_transactions SET created_at = created_at - interval '2 hours';
UPDATE chip_ledger SET created_at = created_at - interval '2 hours';
UPDATE table_seats SET joined_at = joined_at - interval '2 hours';
UPDATE ca_club_data_fact_state SET live_from = now() - interval '2 minutes';
UPDATE live_facts SET stat_date = (now() - interval '2 hours')::date;
SELECT fn_ca_club_data_fact_seed(now() - interval '1 day', now() - interval '2 minutes') AS seeded;
DO $$
DECLARE d int;
BEGIN
  SELECT count(*) INTO d FROM (
    (SELECT club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings FROM live_facts
     EXCEPT SELECT club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings FROM ca_club_data_fact)
    UNION ALL
    (SELECT club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings FROM ca_club_data_fact
     EXCEPT SELECT club_id, stat_date, kind, game_id, user_id, fee, buyins, cashouts, winnings FROM live_facts)) x;
  IF d <> 0 THEN RAISE EXCEPTION 'seed and triggers disagree on % rows', d; END IF;
  -- A second seed of the same window is refused.
  BEGIN PERFORM fn_ca_club_data_fact_seed(now() - interval '1 day', now() - interval '2 minutes');
    RAISE EXCEPTION 'overlapping seed ran';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%overlaps%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'SCENARIO PASSED';
END $$;
