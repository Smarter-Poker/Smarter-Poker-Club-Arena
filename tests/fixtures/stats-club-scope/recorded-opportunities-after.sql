SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF (v#>>'{overall,three_bet_percent}')::numeric<>0.5
  OR (v#>>'{quality,metric_availability,three_bet_opportunities}')::int<>2
  OR NOT (v#>>'{quality,metric_availability,three_bet_percent}')::boolean
  OR (v#>>'{overall,cbet_flop}')::numeric<>0.5 THEN
  RAISE EXCEPTION 'Recorded opportunities or funded scope mismatch: %',v; END IF;
END $$;
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2('20000000-0000-0000-0000-000000000001',30,'UTC','chips');
 IF (v#>>'{overall,three_bet_percent}')::numeric<>0.5
 OR (v#>>'{overall,cbet_flop}')::numeric<>0.5
 OR (v#>>'{quality,metric_availability,three_bet_opportunities}')::int<>2
 OR (v#>>'{overall,wtsd}')::numeric<>(SELECT wtsd FROM public.fixture_expected_fact_rates)
 OR (v#>>'{overall,showdowns_total}')::int<>(SELECT showdowns FROM public.fixture_expected_fact_rates)
 OR (v#>>'{overall,tournaments_with_hands}')::int<>1
 OR (v#>>'{tournaments,total_bounties}')::int<>3
 OR (v#>>'{recent_tournaments,0,finish_rank}')::int<>2
 THEN RAISE EXCEPTION 'All Clubs inherited capped legacy advanced rates: %',v; END IF;
END $$;
RESET ROLE;
-- Do not include unmeasured historic numerators in the measured sample.
UPDATE public.ca_hand_facts SET three_bet=true,cbet_flop=true
 WHERE three_bet_opportunity IS NULL;
SET ROLE authenticated;
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF (v#>>'{overall,three_bet_percent}')::numeric<>0.5 OR (v#>>'{overall,cbet_flop}')::numeric<>0.5
 THEN RAISE EXCEPTION 'Unavailable history leaked into measured numerator'; END IF;
END $$;
RESET ROLE;
UPDATE public.ca_hand_facts SET three_bet_opportunity=NULL,cbet_flop_opportunity=NULL;
SET ROLE authenticated;
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF (v#>>'{quality,metric_availability,three_bet_percent}')::boolean
 OR (v#>>'{quality,metric_availability,cbet_flop}')::boolean
 THEN RAISE EXCEPTION 'Missing opportunity data reported measured'; END IF;
END $$;
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000002',30,'UTC','chips','10000000-0000-0000-0000-000000000001')$q$);
RESET ROLE;
SELECT 'PASS: recorded opportunities, funded scope, nullable history, self-only authorization' result;
