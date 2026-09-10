WITH lots(source_id,club_id,union_id,route,generation,bank_at,rake,club_rate,agent_rate,player_rate) AS (
 VALUES('a','club-a','union-a','union_rake_wallet',1,'2026-08-31T06:59:59Z'::timestamptz,.01::numeric,.90::numeric,.70::numeric,.60::numeric),
       ('b','club-a','union-a','union_rake_wallet',1,'2026-08-31T07:00:00Z'::timestamptz,.01::numeric,.90::numeric,.70::numeric,.60::numeric)
), exact AS (
 SELECT *,rake*club_rate club_exact,rake*agent_rate agent_exact,rake*player_rate player_exact,
 (date_trunc('week',bank_at AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles') bank_week,
 date_trunc('week',bank_at AT TIME ZONE 'UTC')::date earning_week FROM lots
), windows AS(
 SELECT bank_week,floor(sum(club_exact)*100)/100 released FROM exact GROUP BY bank_week
), pool AS(
 SELECT club_id,union_id,route,generation,sum(club_exact) club_exact,
 floor(sum(club_exact)*100)/100 released,sum(agent_exact) agent_exact,
 floor(sum(agent_exact)*100)/100 agent_cash,sum(player_exact) player_exact,
 floor(sum(player_exact)*100)/100 player_cash FROM exact GROUP BY club_id,union_id,route,generation
)
SELECT (SELECT sum(released)::text FROM windows) independent_window_cash,
 (SELECT count(*)::int FROM windows) original_bank_windows,
 (SELECT count(DISTINCT earning_week)::int FROM exact) earning_weeks,
 (SELECT jsonb_agg(jsonb_build_object('source',source_id,'bank_at',bank_at,'bank_week',bank_week,'earning_week',earning_week,'club_exact',club_exact,'agent_exact',agent_exact,'player_exact',player_exact) ORDER BY source_id) FROM exact) source_identity,
 to_jsonb(pool) cumulative_pool FROM pool;
