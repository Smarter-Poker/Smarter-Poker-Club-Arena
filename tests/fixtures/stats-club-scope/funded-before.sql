RESET ROLE;
-- Stable keyset ordering: the original scope fixture intentionally gives751
-- rows the same timestamp, which is unsuitable for comparing limited pages.
WITH ordered AS (SELECT hand_id,user_id,row_number() OVER(ORDER BY hand_id,user_id) n FROM public.ca_hand_facts)
UPDATE public.ca_hand_facts f SET played_at=f.played_at-o.n*interval '1 millisecond'
FROM ordered o WHERE o.hand_id=f.hand_id AND o.user_id=f.user_id;
UPDATE public.ca_hand_facts SET table_id='50000000-0000-0000-0000-000000000001'
 WHERE hand_id='30000000-0000-0000-0000-000000000001';
CREATE FUNCTION public.fixture_all_scoped_stats() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'ev',public.ca_player_ev_curve_by_club('20000000-0000-0000-0000-000000000001',30,5000,'chips','10000000-0000-0000-0000-000000000001')-'generated_at',
  'grid',public.ca_player_hand_grid_by_club('20000000-0000-0000-0000-000000000001',NULL,NULL,30,'chips','10000000-0000-0000-0000-000000000001')-'generated_at',
  'class',public.ca_player_class_hands_by_club('20000000-0000-0000-0000-000000000001','AA',NULL,NULL,30,100,'chips','10000000-0000-0000-0000-000000000001')-'generated_at',
  'rake',public.ca_player_rake_stats_by_club('20000000-0000-0000-0000-000000000001',30,'chips','10000000-0000-0000-0000-000000000001')-'generated_at',
  'pulse',public.ca_player_stats_pulse_by_club('20000000-0000-0000-0000-000000000001','chips','10000000-0000-0000-0000-000000000001')-'generated_at',
  'nemesis',public.ca_player_nemesis_by_club('20000000-0000-0000-0000-000000000001',30,1,10,'chips','10000000-0000-0000-0000-000000000001')-'generated_at',
  'hands',public.ca_player_hands_v2_by_club('20000000-0000-0000-0000-000000000001','all',100,'chips','10000000-0000-0000-0000-000000000001')-'generated_at',
  'evidence',public.ca_player_stats_hand_evidence('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001')-'generated_at');
$$;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
CREATE TABLE public.fixture_funded_baseline AS
SELECT public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001')->'overall' overall,
 public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001')->'tournaments' tournaments,
 public.ca_player_stats_club_comparison('20000000-0000-0000-0000-000000000001',30,'chips')->'rows' comparison;
GRANT SELECT ON public.fixture_funded_baseline TO authenticated;
ALTER TABLE public.fixture_funded_baseline ADD COLUMN readers jsonb;
UPDATE public.fixture_funded_baseline SET readers=public.fixture_all_scoped_stats();
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000002',false);
ALTER TABLE public.fixture_funded_baseline ADD COLUMN shared jsonb;
UPDATE public.fixture_funded_baseline SET shared=public.ca_player_stats_shared_overview_v1('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',30,'UTC','chips')->'overview';
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
UPDATE public.ca_hand_facts SET club_id='10000000-0000-0000-0000-000000000002'
 WHERE hand_id='30000000-0000-0000-0000-000000000001';
INSERT INTO public.cash_participant_funding_receipts VALUES
 ('60000000-0000-0000-0000-000000000001','buyin','50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',now()-interval '1 day',now()),
 ('60000000-0000-0000-0000-000000000002','buyin','50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',now()+interval '1 day',now());
UPDATE public.tournament_players SET club_id='10000000-0000-0000-0000-000000000001';
UPDATE public.tournaments SET club_id='10000000-0000-0000-0000-000000000002';
UPDATE public.ca_hand_facts SET club_id='10000000-0000-0000-0000-000000000002'
 WHERE tournament_id IS NOT NULL;
DO $$ DECLARE old jsonb; BEGIN
 old:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF old->'overall'=(SELECT overall FROM public.fixture_funded_baseline)
 THEN RAISE EXCEPTION 'Expected old physical-club reader to lose funded hands'; END IF;
 IF (old#>>'{tournaments,entries}')::int<>0 THEN RAISE EXCEPTION 'Expected old union-host tournament count to be wrong'; END IF;
END $$;
SELECT 'PASS: old Stats readers lose funded cash hands and union tournament results' result;
