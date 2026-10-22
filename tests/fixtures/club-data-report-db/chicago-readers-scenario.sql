-- Private PostgreSQL fixture only. No production endpoint is used.
-- Club Data readers on Chicago days, finished vs running MTTs (20261022120121).
-- Runs after chicago-days-scenario.sql and the three history load migrations.
SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000a1',false);
DO $test$
DECLARE
  U constant uuid := 'fade0000-0000-0000-0000-000000000001';
  J constant uuid := 'a0000000-0000-0000-0000-000000000001';
  s jsonb; r jsonb; pg jsonb; d date; k text; v_clubs uuid[];
  e_fee numeric; e_win numeric; e_cash numeric; e_tour numeric;
BEGIN
  v_clubs := public.fn_ca_club_data_clubs(U);
  -- "Today" and the default window are the Chicago calendar day.
  s := public.ca_club_data_screen(U, NULL, NULL);
  IF (s->'range'->>'end')::date IS DISTINCT FROM (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'screen today is not the Chicago day: %', s->'range'; END IF;
  IF s->>'accounting_basis' <> 'chicago_net_money_flow' OR s->>'day_basis' <> 'America/Chicago' THEN
    RAISE EXCEPTION 'basis label wrong: %', s->>'accounting_basis'; END IF;
  -- Every Chicago day reconciles to the Chicago facts, for the union and a member club.
  FOR d IN SELECT g::date FROM generate_series(date '2026-10-19', date '2026-10-22', interval '1 day') g LOOP
    SELECT COALESCE(sum(fee),0), COALESCE(sum(winnings),0),
           COALESCE(sum(winnings) FILTER (WHERE kind='CASH'),0), COALESCE(sum(winnings) FILTER (WHERE kind<>'CASH'),0)
      INTO e_fee, e_win, e_cash, e_tour
      FROM ca_club_data_fact_ct WHERE club_id = ANY (v_clubs) AND stat_date = d;
    s := public.ca_club_data_screen(U, d, d)->'summary';
    IF (s->>'fee')::numeric <> round(e_fee,2) OR (s->>'total_winnings')::numeric <> round(e_win,2)
       OR (s->>'cash_winnings')::numeric <> round(e_cash,2) OR (s->>'tournament_winnings')::numeric <> round(e_tour,2) THEN
      RAISE EXCEPTION 'union screen % disagrees with Chicago facts: % vs fee % win %', d, s, e_fee, e_win; END IF;
    -- total = cash + every tournament flow; tournament = finished MTT + running MTT + other formats.
    IF (s->>'total_winnings')::numeric <> (s->>'cash_winnings')::numeric + (s->>'tournament_winnings')::numeric THEN
      RAISE EXCEPTION 'total does not reconcile on %: %', d, s; END IF;
    r := public.ca_rake_snapshot_v2('union', NULL, U, d, d, NULL, 200);
    FOREACH k IN ARRAY ARRAY['fee','cash_fee','mtt_fee','tournament_fee','total_winnings','cash_winnings','mtt_winnings','tournament_winnings','running_mtt_entries','running_mtt_fee'] LOOP
      IF (r->'summary'->>k)::numeric IS DISTINCT FROM (s->>k)::numeric THEN
        RAISE EXCEPTION 'Union Data and Club Data disagree on % for %: % vs %', k, d, r->'summary', s; END IF;
    END LOOP;
    IF r->>'accounting_basis' <> 'chicago_net_money_flow' THEN RAISE EXCEPTION 'rake snapshot basis'; END IF;
    pg := public.ca_club_game_page_core_20261006(U, d, d, 'ALL', 'ALL', NULL, 'recent', NULL, 200);
    IF (SELECT COALESCE(sum((x->>'fee_exact')::numeric),0) FROM jsonb_array_elements(pg->'rows') x) <> e_fee THEN
      RAISE EXCEPTION 'game page fees on % do not reconcile: %', d, pg; END IF;
    IF (SELECT COALESCE(sum(winnings),0) FROM public.fn_ca_club_games(U, d, d, 'ALL', 'ALL', NULL)) <> round(e_win,2) THEN
      RAISE EXCEPTION 'export winnings on % do not reconcile', d; END IF;
  END LOOP;
  -- Chicago 10-19 holds the evening before UTC midnight: under UTC days it was empty.
  s := public.ca_club_data_screen(U, date '2026-10-19', date '2026-10-19')->'summary';
  IF (s->>'cash_fee')::numeric <> 5 OR (s->>'cash_winnings')::numeric <> -150 THEN RAISE EXCEPTION 'Chicago 10-19 cash wrong: %', s; END IF;
  IF (s->>'mtt_winnings')::numeric <> -20 OR (s->>'mtt_fee')::numeric <> 2 OR (s->>'running_mtt_entries')::numeric <> 0 THEN
    RAISE EXCEPTION 'finished MTT entry not on its Chicago day: %', s; END IF;
  s := public.ca_club_data_screen(U, date '2026-10-20', date '2026-10-20')->'summary';
  IF (s->>'mtt_winnings')::numeric <> 55 THEN RAISE EXCEPTION 'finished MTT prize misplaced: %', s; END IF;
  -- Chicago 10-21: the running MTT's two entries (one at 23:00 Chicago = 04:00 UTC next day) are Running MTT Entries, not MTT Winnings.
  s := public.ca_club_data_screen(U, date '2026-10-21', date '2026-10-21')->'summary';
  IF (s->>'running_mtt_entries')::numeric <> -60 OR (s->>'mtt_winnings')::numeric <> 0 OR (s->>'tournament_winnings')::numeric <> -60 THEN
    RAISE EXCEPTION 'running MTT not separated: %', s; END IF;
  IF (s->>'cash_fee')::numeric <> 12 THEN RAISE EXCEPTION 'Chicago 10-21 cash fee wrong: %', s; END IF;
  -- The filtered screen separates them the same way.
  s := public.ca_club_data_screen(U, date '2026-10-19', date '2026-10-22', 'MTT', 'ALL', NULL, 200)->'summary';
  IF (s->>'mtt_winnings')::numeric <> 35 OR (s->>'running_mtt_entries')::numeric <> -50
     OR (s->>'total_winnings')::numeric <> (s->>'mtt_winnings')::numeric + (s->>'running_mtt_entries')::numeric THEN
    RAISE EXCEPTION 'filtered MTT split wrong: %', s; END IF;
  -- The finished MTT row is not live; the running one is.
  pg := public.ca_club_game_page_core_20261006(U, date '2026-10-19', date '2026-10-22', 'MTT', 'ALL', NULL, 'recent', NULL, 200);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg->'rows') x WHERE x->>'id'='99000000-0000-0000-0000-000000000002' AND (x->>'live')::boolean AND (x->>'winnings')::numeric=-50) THEN
    RAISE EXCEPTION 'running MTT row wrong: %', pg; END IF;
  -- Hands on Chicago days: union counts raked hands between Chicago midnights.
  IF public.fn_ca_club_data_hand_count(U, date '2026-10-20', date '2026-10-20', 'ALL', 'ALL', NULL) <> 2 THEN
    RAISE EXCEPTION 'union Chicago hands wrong: %', public.fn_ca_club_data_hand_count(U, date '2026-10-20', date '2026-10-20', 'ALL', 'ALL', NULL); END IF;
  IF public.fn_ca_club_data_hand_count(J, date '2026-10-21', date '2026-10-21', 'ALL', 'ALL', NULL) <> 1 THEN
    RAISE EXCEPTION 'club Chicago hands wrong'; END IF;
  -- Union = sum of member clubs and the union's own account, every figure.
  r := public.ca_rake_snapshot_v2('union', NULL, U, date '2026-10-19', date '2026-10-21', NULL, 200);
  IF (SELECT sum((x->>'fee')::numeric) FROM jsonb_array_elements(r->'breakdown') x) <> (r->'summary'->>'fee_exact')::numeric THEN
    RAISE EXCEPTION 'union fee is not the sum of its clubs: %', r; END IF;
  IF (SELECT sum((x->>'winnings')::numeric) FROM jsonb_array_elements(r->'breakdown') x) <> (r->'summary'->>'total_winnings')::numeric THEN
    RAISE EXCEPTION 'union winnings are not the sum of its clubs: %', r; END IF;
  IF (SELECT sum((x->>'winnings')::numeric) FROM jsonb_array_elements(r->'series') x) <> (r->'summary'->>'total_winnings')::numeric THEN
    RAISE EXCEPTION 'series does not reconcile'; END IF;
  IF (SELECT array_agg(x->>'bucket' ORDER BY x->>'bucket') FROM jsonb_array_elements(r->'series') x) <> ARRAY['2026-10-19','2026-10-20','2026-10-21'] THEN
    RAISE EXCEPTION 'series buckets are not Chicago days: %', r->'series'; END IF;
  IF r->'previous_range'->>'end' <> '2026-10-18' THEN RAISE EXCEPTION 'previous period wrong'; END IF;
  -- The legacy open-client contract still maps MTT to every tournament.
  r := public.ca_club_data_snapshot(U, date '2026-10-21', date '2026-10-21', 'ALL', 'ALL', NULL, 200);
  IF (r->'summary'->>'mtt_winnings')::numeric <> (r->'summary'->>'tournament_winnings')::numeric THEN RAISE EXCEPTION 'legacy contract changed'; END IF;
  r := public.ca_club_data_snapshot_v2(U, date '2026-10-21', date '2026-10-21', 'ALL', 'ALL', NULL, 200);
  IF r->>'accounting_basis' <> 'chicago_net_money_flow' OR (r->'summary'->>'running_mtt_entries')::numeric <> -60 THEN RAISE EXCEPTION 'report snapshot: %', r; END IF;
END $test$;
SELECT 'CHICAGO READERS SCENARIO PASSED';
