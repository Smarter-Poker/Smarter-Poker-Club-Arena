-- Private PostgreSQL fixture only. No production endpoint is used.
-- Club Data Chicago days (20261022103651 / 20261022103657).
-- Dates are fixed in late October (CDT, UTC-5) so Chicago midnight is 05:00 UTC.
\set J '''a0000000-0000-0000-0000-000000000001'''
\set S '''a4143400-0000-0000-0000-000000000001'''
\set U '''fade0000-0000-0000-0000-000000000001'''
\set P '''00000000-0000-0000-0000-0000000000b1'''
\set Q '''00000000-0000-0000-0000-0000000000b2'''
\set T '''00000000-0000-0000-0000-0000000000c1'''
\set M1 '''99000000-0000-0000-0000-000000000001'''
\set M2 '''99000000-0000-0000-0000-000000000002'''
TRUNCATE ca_club_data_fact, ca_club_data_fact_ct, ca_club_data_game_ct, ca_club_data_hands_ct, ca_club_data_ct_seed_log,
         club_table_daily, ca_club_tournament_daily, ca_club_tournament_player_daily, rake_records, wallet_transactions, chip_ledger;
UPDATE table_seats SET left_at = now();
-- Facts begin 2026-10-20 (the seed log) and the UTC writer is live from 2026-10-01; the Chicago bucket's cutover is 2026-10-21 12:00 UTC.
UPDATE ca_club_data_fact_state SET live_from = '2026-10-01 00:00+00';
UPDATE ca_club_data_ct_state SET live_from = '2026-10-21 12:00+00';
DELETE FROM ca_club_data_fact_seed_log;
INSERT INTO ca_club_data_fact_seed_log(from_at,to_at,rows_put) VALUES ('2026-10-20 00:00+00','2026-10-20 00:00:01+00',0);
INSERT INTO tournaments (id, club_id, union_id, name, tournament_type, status, start_time) VALUES
 (:M1, :U, :U, 'Finished MTT', 'MTT', 'COMPLETED', '2026-10-19 23:00+00'),
 (:M2, :U, :U, 'Running MTT', 'MTT', 'RUNNING', '2026-10-21 23:30+00')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, tournament_type = EXCLUDED.tournament_type;
INSERT INTO tournament_players VALUES (:M1, :P, :J), (:M2, :P, :J), (:M2, :Q, :S) ON CONFLICT DO NOTHING;
INSERT INTO table_seats (table_id, user_id, club_id, stack, joined_at, left_at) VALUES
 (:T, :P, :J, 0, '2026-10-19 00:00+00', NULL), (:T, :Q, :S, 0, '2026-10-19 00:00+00', NULL);

-- UTC day 2026-10-20: two events before Chicago midnight (05:00 UTC), two after.
INSERT INTO rake_records (table_id, is_tournament, rake_amount, player_contributions, created_at) VALUES
 (:T, false, 4, jsonb_build_object(:P::text, 10, :Q::text, 10), '2026-10-20 02:00+00'),
 (:T, false, 6, jsonb_build_object(:P::text, 30), '2026-10-20 15:00+00'),
 (:T, false, 1, '{}'::jsonb, '2026-10-20 04:59:59+00');
INSERT INTO wallet_transactions (user_id, amount, type, category, table_id, created_at) VALUES
 (:P, 100, 'debit', 'buyin', :T, '2026-10-20 01:00+00'),
 (:P, 70, 'credit', 'cashout', :T, '2026-10-20 18:00+00'),
 (:Q, 50, 'debit', 'buyin', :T, '2026-10-20 03:00+00');
INSERT INTO wallet_transactions (user_id, amount, type, category, related_entity_id, created_at) VALUES
 (:P, 20, 'debit', 'tournament_buyin', :M1, '2026-10-20 00:30+00'),
 (:P, 55, 'credit', 'prize', :M1, '2026-10-20 06:00+00');
INSERT INTO rake_records (tournament_id, is_tournament, rake_amount, metadata, created_at) VALUES
 (:M1, true, 2, jsonb_build_object('user_id', :P::text), '2026-10-20 00:30+00');

-- UTC day 2026-10-21 (the cutover day): before Chicago midnight, between it and the cutover, after.
INSERT INTO rake_records (table_id, is_tournament, rake_amount, player_contributions, created_at) VALUES
 (:T, false, 3, jsonb_build_object(:P::text, 5), '2026-10-21 03:00+00'),
 (:T, false, 5, jsonb_build_object(:P::text, 5, :Q::text, 5), '2026-10-21 08:00+00'),
 (:T, false, 7, jsonb_build_object(:Q::text, 9), '2026-10-21 14:00+00');
INSERT INTO wallet_transactions (user_id, amount, type, category, related_entity_id, created_at) VALUES
 (:P, 30, 'debit', 'tournament_buyin', :M2, '2026-10-21 23:40+00'),
 (:Q, 30, 'debit', 'tournament_buyin', :M2, '2026-10-22 04:00+00'),
 (:Q, 10, 'credit', 'bounty', :M2, '2026-10-22 06:00+00');

-- The UTC side, as the live path left it (day rollups as fn_ca_reporting_rollups_from_facts writes them).
SELECT public.fn_ca_reporting_rollups_from_facts(d::date) FROM generate_series(date '2026-10-20', date '2026-10-22', interval '1 day') d;

DO $test$
DECLARE r record; v jsonb;
BEGIN
  -- Only the post-cutover events reached the Chicago bucket live.
  IF (SELECT count(*) FROM ca_club_data_fact_ct WHERE last_at < '2026-10-21 12:00+00') <> 0 THEN
    RAISE EXCEPTION 'live writer wrote before its cutover'; END IF;
  IF (SELECT sum(fee) FROM ca_club_data_fact_ct WHERE kind='CASH') <> 7 THEN RAISE EXCEPTION 'live cash fee after cutover wrong'; END IF;
  IF (SELECT sum(hands) FROM ca_club_data_hands_ct WHERE table_id='00000000-0000-0000-0000-0000000000c1' AND stat_date='2026-10-21') <> 1 THEN
    RAISE EXCEPTION 'live hand after cutover not counted'; END IF;
  -- The seed refuses a day after the cutover day, and runs once per day.
  BEGIN PERFORM public.fn_ca_club_data_ct_seed('2026-10-22'); RAISE EXCEPTION 'seed accepted a live day';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%after the cutover day%' THEN RAISE; END IF; END;
END $test$;
-- @@ AFTER THE HISTORY LOAD @@ (the native test runs the three load migrations here)
DO $test$
DECLARE r record; n int;
BEGIN
  BEGIN PERFORM public.fn_ca_club_data_ct_seed('2026-10-20'); RAISE EXCEPTION 'seed replayed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%already loaded%' THEN RAISE; END IF; END;
  -- Totals are preserved per club, game and player: only the day moves.
  SELECT count(*) INTO n FROM (
    SELECT club_id, game_id, user_id, sum(fee) fee, sum(buyins) b, sum(cashouts) c, sum(winnings) w FROM ca_club_data_fact GROUP BY 1,2,3
  ) u FULL JOIN (
    SELECT club_id, game_id, user_id, sum(fee) fee, sum(buyins) b, sum(cashouts) c, sum(winnings) w FROM ca_club_data_fact_ct GROUP BY 1,2,3
  ) c USING (club_id, game_id, user_id)
  WHERE (u.fee, u.b, u.c, u.w) IS DISTINCT FROM (c.fee, c.b, c.c, c.w);
  IF n <> 0 THEN RAISE EXCEPTION 'Chicago facts do not preserve UTC totals (% keys)', n; END IF;
  -- And the per-game table is exactly the player table summed.
  SELECT count(*) INTO n FROM (SELECT club_id, stat_date, game_id, sum(fee) f, sum(winnings) w FROM ca_club_data_fact_ct GROUP BY 1,2,3) a
    FULL JOIN (SELECT club_id, stat_date, game_id, sum(fee) fee, sum(winnings) winnings FROM ca_club_data_game_ct GROUP BY 1,2,3) g
      USING (club_id, stat_date, game_id) WHERE (a.f, a.w) IS DISTINCT FROM (g.fee, g.winnings);
  IF n <> 0 THEN RAISE EXCEPTION 'game table disagrees with player facts'; END IF;
  -- Each event sits on its Chicago day. Chicago 2026-10-19: P 2 (rake 02:00) + 1 MTT fee; Q 2; unnamed 1.
  IF (SELECT sum(fee) FROM ca_club_data_fact_ct WHERE stat_date='2026-10-19' AND kind='CASH') <> 5 THEN
    RAISE EXCEPTION 'Chicago 10-19 cash fee wrong: %', (SELECT sum(fee) FROM ca_club_data_fact_ct WHERE stat_date='2026-10-19' AND kind='CASH'); END IF;
  IF (SELECT sum(winnings) FROM ca_club_data_fact_ct WHERE stat_date='2026-10-19' AND kind='CASH') <> -150 THEN
    RAISE EXCEPTION 'Chicago 10-19 cash winnings wrong'; END IF;
  IF (SELECT sum(winnings) FROM ca_club_data_fact_ct WHERE stat_date='2026-10-20' AND game_id='99000000-0000-0000-0000-000000000001') <> 55 THEN
    RAISE EXCEPTION 'Chicago 10-20 prize misplaced'; END IF;
  -- 10-20 Chicago: 6 (15:00) + 3 (10-21 03:00) cash fee; 10-21 Chicago: 5 (08:00) + 7 (14:00 live).
  IF (SELECT sum(fee) FROM ca_club_data_fact_ct WHERE stat_date='2026-10-20' AND kind='CASH') <> 9 THEN RAISE EXCEPTION 'Chicago 10-20 cash fee wrong'; END IF;
  IF (SELECT sum(fee) FROM ca_club_data_fact_ct WHERE stat_date='2026-10-21' AND kind='CASH') <> 12 THEN RAISE EXCEPTION 'Chicago 10-21 cash fee wrong'; END IF;
  -- Hands: 10-19 two hands (both clubs share the 02:00 hand: J and S one each, plus the unnamed hand to the table club).
  IF (SELECT sum(hands) FROM ca_club_data_hands_ct WHERE stat_date='2026-10-20') <> 2 THEN RAISE EXCEPTION 'Chicago 10-20 hands wrong: %', (SELECT json_agg(h) FROM ca_club_data_hands_ct h); END IF;
  IF (SELECT sum(hands) FROM ca_club_data_hands_ct WHERE stat_date='2026-10-21') <> 3 THEN RAISE EXCEPTION 'Chicago 10-21 hands wrong: %', (SELECT json_agg(h) FROM ca_club_data_hands_ct h); END IF;
  -- Nothing on a Chicago day has a negative remainder.
  IF EXISTS (SELECT 1 FROM ca_club_data_fact_ct WHERE fee < -0.0000001 OR buyins < 0 OR cashouts < 0) THEN RAISE EXCEPTION 'negative split'; END IF;
END $test$;
SELECT 'CHICAGO SEED SCENARIO PASSED';
