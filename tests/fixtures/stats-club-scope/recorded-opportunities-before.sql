ALTER TABLE public.ca_hand_facts ADD COLUMN three_bet_opportunity boolean;
ALTER TABLE public.ca_hand_facts ADD COLUMN cbet_flop_opportunity boolean;
-- Local fixtures only. Missing historical denominators remain NULL.
UPDATE public.ca_hand_facts SET three_bet=true,three_bet_opportunity=true,
 cbet_flop=true,cbet_flop_opportunity=true,went_to_showdown=true,won_at_showdown=true
 WHERE hand_id='30000000-0000-0000-0000-000000000001';
UPDATE public.ca_hand_facts SET three_bet=false,three_bet_opportunity=true,
 cbet_flop=false,cbet_flop_opportunity=true
 WHERE hand_id='30000000-0000-0000-0000-000000000002';
UPDATE public.tournament_players SET bounties_collected=3 WHERE id='41000000-0000-0000-0000-000000000001';
CREATE TABLE public.fixture_expected_fact_rates AS
 SELECT round(count(*) FILTER(WHERE went_to_showdown)::numeric/nullif(count(*) FILTER(WHERE saw_flop),0),4) wtsd,
 count(*) FILTER(WHERE went_to_showdown)::int showdowns
 FROM public.ca_hand_facts WHERE user_id='20000000-0000-0000-0000-000000000001';
GRANT SELECT ON public.fixture_expected_fact_rates TO authenticated;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF (v#>>'{overall,three_bet_percent}')::numeric<>0 THEN RAISE EXCEPTION 'Pre-fix reproduction changed'; END IF;
END $$;
RESET ROLE;
