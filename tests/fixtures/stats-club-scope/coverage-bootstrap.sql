ALTER TABLE public.hand_history ADD COLUMN started_at timestamptz;
ALTER TABLE public.hand_history ADD COLUMN ended_at timestamptz;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
CREATE TABLE public.fixture_coverage_before AS SELECT
 public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001') club,
 public.ca_player_stats_overview_v2('20000000-0000-0000-0000-000000000001',30,'UTC','chips') global;
GRANT SELECT ON public.fixture_coverage_before TO authenticated;
