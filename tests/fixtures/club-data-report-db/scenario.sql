-- The Report reads what the club played (20261017204111). Runs after
-- tests/fixtures/club-data-fact-db/scenario.sql against the same database, so
-- the JAQK shape is already there: P joined SHARK first and plays through
-- JAQK (cash at the union table T, and the union tournament M entered via
-- JAQK); Q plays through SHARK; R sits at T via JAQK and at SHARK's own T2.
-- A super agent of JAQK, for the access checks below.
INSERT INTO profiles (id, username) VALUES ('00000000-0000-0000-0000-0000000000a3', 'super');
INSERT INTO club_members (club_id, user_id, role, joined_at)
  VALUES ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3', 'super_agent', now() - interval '60 days');

DO $$
DECLARE v numeric; n int; res jsonb; d date;
  J constant uuid := 'a0000000-0000-0000-0000-000000000001';
  S constant uuid := 'a4143400-0000-0000-0000-000000000001';
  P constant uuid := '00000000-0000-0000-0000-0000000000b1';
  M constant uuid := '00000000-0000-0000-0000-0000000000d1';
  T constant uuid := '00000000-0000-0000-0000-0000000000c1';
BEGIN
  -- LIVE: the tournament prize and entry are JAQK's, ONCE - not SHARK's (the
  -- earliest union club) and not once per club the player belongs to.
  SELECT sum(winnings) INTO v FROM ca_club_tournament_daily WHERE club_id = J AND tournament_id = M;
  IF v IS DISTINCT FROM 19::numeric THEN RAISE EXCEPTION 'JAQK tournament winnings should be -11 + 30 = 19, got %', v; END IF;
  SELECT sum(fee) INTO v FROM ca_club_tournament_daily WHERE club_id = J AND tournament_id = M;
  IF v IS DISTINCT FROM 1::numeric THEN RAISE EXCEPTION 'JAQK tournament fee should be 1, got %', v; END IF;
  SELECT sum(winnings) INTO v FROM ca_club_tournament_daily WHERE club_id = S AND tournament_id = M;
  IF v IS DISTINCT FROM -11::numeric THEN RAISE EXCEPTION 'SHARK tournament winnings should be Q''s -11, got %', v; END IF;
  SELECT count(*) INTO n FROM ca_club_tournament_player_daily WHERE tournament_id = M AND user_id = P;
  IF n <> 1 THEN RAISE EXCEPTION 'P should be one entrant (JAQK), got % rows', n; END IF;
  -- LIVE: P's cash and tournament results are JAQK's.
  SELECT cash_net INTO v FROM ca_club_player_daily WHERE club_id = J AND user_id = P;
  IF v IS DISTINCT FROM 50::numeric THEN RAISE EXCEPTION 'P''s JAQK cash net should be 150 - 100 = 50, got %', v; END IF;
  SELECT count(*) INTO n FROM ca_club_player_daily WHERE club_id = S AND user_id = P;
  IF n <> 0 THEN RAISE EXCEPTION 'P''s play was filed under SHARK'; END IF;
  SELECT buyins INTO v FROM club_table_daily WHERE club_id = J AND table_id = T;
  IF v IS DISTINCT FROM 100::numeric THEN RAISE EXCEPTION 'club_table_daily JAQK buy-ins at T should be P''s 100, got %', v; END IF;
  SELECT buyins INTO v FROM club_table_daily WHERE club_id = S AND table_id = T;
  IF v IS DISTINCT FROM 80::numeric THEN RAISE EXCEPTION 'club_table_daily SHARK buy-ins at T should be Q''s 80, got %', v; END IF;

  -- REBUILD: the five Report tables rebuilt from the facts equal what the live
  -- writers wrote (hands, players, money; not bookkeeping columns).
  SELECT max(stat_date) INTO d FROM club_table_daily;
  CREATE TEMP TABLE before_ctd AS SELECT club_id, table_id, stat_date, rake, hands, players, buyins, cashouts, net FROM club_table_daily WHERE stat_date = d;
  CREATE TEMP TABLE before_cpd AS SELECT club_id, user_id, stat_date, cash_net, tournament_net FROM ca_club_player_daily WHERE stat_date = d;
  CREATE TEMP TABLE before_ctn AS SELECT club_id, tournament_id, stat_date, fee, winnings FROM ca_club_tournament_daily WHERE stat_date = d;
  CREATE TEMP TABLE before_ctp AS SELECT club_id, tournament_id, user_id, stat_date FROM ca_club_tournament_player_daily WHERE stat_date = d;
  CREATE TEMP TABLE before_tpd AS SELECT club_id, table_id, stat_date, user_id FROM ca_club_table_player_daily WHERE stat_date = d;
  res := fn_ca_reporting_rollups_from_facts(d);
  RAISE NOTICE 'rebuilt %: %', d, res;
  SELECT count(*) INTO n FROM ((SELECT * FROM before_ctd EXCEPT SELECT club_id, table_id, stat_date, rake, hands, players, buyins, cashouts, net FROM club_table_daily WHERE stat_date = d)
    UNION ALL (SELECT club_id, table_id, stat_date, rake, hands, players, buyins, cashouts, net FROM club_table_daily WHERE stat_date = d EXCEPT SELECT * FROM before_ctd)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'club_table_daily rebuilt from facts differs from the live writers on % rows: % vs %', n,
    (SELECT jsonb_agg(b) FROM before_ctd b), (SELECT jsonb_agg(c) FROM (SELECT club_id, table_id, rake, hands, players, buyins, cashouts, net FROM club_table_daily WHERE stat_date = d) c); END IF;
  SELECT count(*) INTO n FROM ((SELECT * FROM before_cpd EXCEPT SELECT club_id, user_id, stat_date, cash_net, tournament_net FROM ca_club_player_daily WHERE stat_date = d)
    UNION ALL (SELECT club_id, user_id, stat_date, cash_net, tournament_net FROM ca_club_player_daily WHERE stat_date = d EXCEPT SELECT * FROM before_cpd)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'ca_club_player_daily rebuilt from facts differs on % rows', n; END IF;
  SELECT count(*) INTO n FROM ((SELECT * FROM before_ctn EXCEPT SELECT club_id, tournament_id, stat_date, fee, winnings FROM ca_club_tournament_daily WHERE stat_date = d)
    UNION ALL (SELECT club_id, tournament_id, stat_date, fee, winnings FROM ca_club_tournament_daily WHERE stat_date = d EXCEPT SELECT * FROM before_ctn)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'ca_club_tournament_daily rebuilt from facts differs on % rows', n; END IF;
  SELECT count(*) INTO n FROM ((SELECT * FROM before_ctp EXCEPT SELECT club_id, tournament_id, user_id, stat_date FROM ca_club_tournament_player_daily WHERE stat_date = d)
    UNION ALL (SELECT club_id, tournament_id, user_id, stat_date FROM ca_club_tournament_player_daily WHERE stat_date = d EXCEPT SELECT * FROM before_ctp)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'ca_club_tournament_player_daily rebuilt from facts differs on % rows', n; END IF;
  SELECT count(*) INTO n FROM ((SELECT * FROM before_tpd EXCEPT SELECT club_id, table_id, stat_date, user_id FROM ca_club_table_player_daily WHERE stat_date = d)
    UNION ALL (SELECT club_id, table_id, stat_date, user_id FROM ca_club_table_player_daily WHERE stat_date = d EXCEPT SELECT * FROM before_tpd)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'ca_club_table_player_daily rebuilt from facts differs on % rows', n; END IF;

  -- The range rebuild and the hourly catch-up use the facts for covered days.
  res := ca_refresh_reporting_rollups_base(d, d);
  IF res->>'source' IS DISTINCT FROM 'ca_club_data_fact' THEN RAISE EXCEPTION 'range rebuild did not use the facts: %', res; END IF;
  res := ca_refresh_reporting_cash_rollup(d, d);
  IF res->>'source' IS DISTINCT FROM 'ca_club_data_fact' THEN RAISE EXCEPTION 'cash rebuild did not use the facts: %', res; END IF;
  SELECT sum(winnings) INTO v FROM ca_club_tournament_daily WHERE club_id = J AND tournament_id = M;
  IF v IS DISTINCT FROM 19::numeric THEN RAISE EXCEPTION 'after the range rebuild JAQK tournament winnings should still be 19, got %', v; END IF;
  res := fn_club_table_daily_refresh_day((now() AT TIME ZONE 'UTC')::date);
  IF res->>'skipped' IS DISTINCT FROM 'live_day_is_kept_by_triggers' THEN RAISE EXCEPTION 'refresh of the live day: %', res; END IF;
  res := fn_club_table_daily_refresh_day('2026-01-01');
  IF res->>'skipped' IS DISTINCT FROM 'before_club_data_facts' THEN RAISE EXCEPTION 'refresh before the facts: %', res; END IF;
END $$;

-- The club rake totals (ca_club_rake_daily) follow the seat at the hand.
DO $$
DECLARE r record;
  J constant uuid := 'a0000000-0000-0000-0000-000000000001';
  S constant uuid := 'a4143400-0000-0000-0000-000000000001';
  U constant uuid := 'fade0000-0000-0000-0000-000000000001';
  T constant uuid := '00000000-0000-0000-0000-0000000000c1';
  P constant uuid := '00000000-0000-0000-0000-0000000000b1';
  Q constant uuid := '00000000-0000-0000-0000-0000000000b2';
  hid uuid := gen_random_uuid();
BEGIN
  -- P has left T (the scenario cashed P out); the after-the-hand witness says JAQK.
  INSERT INTO rake_records (id, table_id, club_id, is_tournament, rake_amount, player_contributions, created_at)
    VALUES (hid, T, U, false, 10, jsonb_build_object(P::text, 50, Q::text, 50), now() - interval '2 hours');
  INSERT INTO rake_attributions (rake_record_id, player_id, club_id) VALUES (hid, P, J);
  FOR r IN SELECT * FROM fn_ca_club_rake_daily_compute(now() - interval '3 hours', now() - interval '1 hour', ARRAY[hid]) LOOP
    IF r.club_id = J AND r.rake IS DISTINCT FROM 5::numeric THEN RAISE EXCEPTION 'JAQK rake share should be 5, got %', r.rake; END IF;
    IF r.club_id = S AND r.rake IS DISTINCT FROM 5::numeric THEN RAISE EXCEPTION 'SHARK rake share (Q''s seat) should be 5, got %', r.rake; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM fn_ca_club_rake_daily_compute(now(), now(), ARRAY[hid]) c WHERE c.club_id = J AND c.rake = 5) THEN
    RAISE EXCEPTION 'P''s share did not reach JAQK: %', (SELECT jsonb_agg(c) FROM fn_ca_club_rake_daily_compute(now(), now(), ARRAY[hid]) c);
  END IF;
END $$;

\connect "host=127.0.0.1 port=@PORT@ dbname=live user=authenticator"
SET ROLE authenticated;
DO $$
DECLARE res jsonb;
  J constant uuid := 'a0000000-0000-0000-0000-000000000001';
BEGIN
  -- A super agent may NOT open the whole-club Report; an agent may not; the owner may.
  PERFORM set_config('test.role', 'authenticated', true);
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000a3', true);
  IF ca_can_view_whole_club_report(J) THEN RAISE EXCEPTION 'a super agent can open the whole-club Report'; END IF;
  BEGIN
    res := ca_club_data_snapshot(J, NULL, NULL, 'ALL', 'ALL', NULL, 50);
    RAISE EXCEPTION 'a super agent read the whole-club snapshot';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    res := ca_rake_snapshot('club', J, NULL, NULL, NULL, NULL, 10, 0, NULL, NULL);
    RAISE EXCEPTION 'a super agent read the whole-club rake panel';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (ca_club_data_export_page(J, 0, 1)->>'authorized')::boolean THEN RAISE EXCEPTION 'a super agent can export the club''s games'; END IF;
  -- ...and still reads their own and their downline's figures on Club Data.
  res := ca_club_data_screen(J);
  IF res->>'scope' <> 'downline' THEN RAISE EXCEPTION 'a super agent should read their downline on Club Data: %', res->>'scope'; END IF;

  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
  IF NOT ca_can_view_whole_club_report(J) THEN RAISE EXCEPTION 'the owner cannot open the Report'; END IF;
  res := ca_club_data_snapshot(J, NULL, NULL, 'ALL', 'ALL', NULL, 50);
  -- The player list is the club's members: P, whose earliest union club is
  -- SHARK, is JAQK's member and is listed.
  res := ca_club_player_breakdown(J, NULL, NULL, 50);
  IF NOT res ? '00000000-0000-0000-0000-0000000000b1' THEN RAISE EXCEPTION 'JAQK''s player list leaves out P: %', res; END IF;
  res := ca_club_player_page_core_20261006(J, NULL, NULL, NULL, NULL, NULL, 50);
  IF NOT res ? '00000000-0000-0000-0000-0000000000b1' THEN RAISE EXCEPTION 'JAQK''s player page leaves out P: %', res; END IF;
  RAISE NOTICE 'REPORT SCENARIO PASSED';
END $$;
