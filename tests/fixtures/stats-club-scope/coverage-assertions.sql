BEGIN;
INSERT INTO public.hand_history(id,started_at,ended_at,actions,big_blind)
SELECT ('98000000-0000-0000-0000-00000000000'||n)::uuid,
 '2026-10-29 00:00Z'::timestamptz+s*interval '1minute',
 '2026-10-29 00:00Z'::timestamptz+e*interval '1minute',
 '[{"userId":"20000000-0000-0000-0000-000000000001","action":"bet","stage":"flop","amount":2},{"userId":"20000000-0000-0000-0000-000000000001","action":"call","stage":"turn","amount":2}]',1
FROM (VALUES(1,0,10),(2,2,3),(3,9,12),(4,20,21)) x(n,s,e);
CREATE TEMP TABLE requested AS SELECT jsonb_agg(jsonb_build_object('hand_id',id,'bets',NULL,'calls',NULL,'is_cash',right(id::text,1)<>'3')) hands
FROM public.hand_history WHERE id::text LIKE '98000000%';
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_recorded_hand_coverage('20000000-0000-0000-0000-000000000001',(SELECT hands FROM requested));
 IF v#>>'{recorded_coverage,elapsed_seconds}'<>'780.000000' AND (v#>>'{recorded_coverage,elapsed_seconds}')::numeric<>780
 THEN RAISE EXCEPTION 'Nested overlap/disjoint interval union wrong: %',v; END IF;
 IF (v->>'aggression_factor')::numeric<>1 OR (v#>>'{metric_availability,hours_played}')::boolean IS DISTINCT FROM true
 OR (v#>>'{recorded_coverage,cash_elapsed_seconds}')::numeric<>660
 THEN RAISE EXCEPTION 'Historical calls or cash-only union wrong: %',v; END IF;
 v:=public.ca_player_recorded_hand_coverage('20000000-0000-0000-0000-000000000001',(SELECT hands FROM requested),'2026-10-29 00:02Z','2026-10-29 00:20Z');
 IF (v#>>'{recorded_coverage,elapsed_seconds}')::numeric<>600 OR (v#>>'{recorded_coverage,cash_elapsed_seconds}')::numeric<>480
 THEN RAISE EXCEPTION 'Calendar clipping wrong: %',v; END IF;
END $$;
-- The cold durable interval and a complete persisted pair survive history retention.
INSERT INTO public.ca_hand_stat_intervals SELECT id,started_at,ended_at FROM public.hand_history WHERE id::text LIKE '98000000%';
DELETE FROM public.hand_history WHERE id::text LIKE '98000000%';
UPDATE requested SET hands=(SELECT jsonb_agg(x||jsonb_build_object('bets',1,'calls',2)) FROM jsonb_array_elements(hands) x);
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_recorded_hand_coverage('20000000-0000-0000-0000-000000000001',(SELECT hands FROM requested));
 IF (v->>'aggression_factor')::numeric<>0.5 OR (v#>>'{recorded_coverage,elapsed_seconds}')::numeric<>780
 THEN RAISE EXCEPTION 'Durable evidence lost after retention: %',v; END IF;
 v:=public.ca_player_recorded_hand_coverage('20000000-0000-0000-0000-000000000001',(SELECT hands FROM requested)||'[{"hand_id":"98000000-0000-0000-0000-000000000009","is_cash":true}]');
 IF (v#>>'{metric_availability,hours_played}')::boolean OR (v#>>'{metric_availability,cash_hours_played}')::boolean OR (v#>>'{metric_availability,aggression_factor}')::boolean
 THEN RAISE EXCEPTION 'Missing evidence certified: %',v; END IF;
END $$;
-- Partial persisted AF must not mix with a historical denominator.
INSERT INTO public.hand_history(id,started_at,ended_at,actions,big_blind) VALUES
 ('98000000-0000-0000-0000-000000000005',now()-interval '14seconds',now(),
 '[{"userId":"20000000-0000-0000-0000-000000000001","action":"bet","stage":"flop","amount":2},{"userId":"20000000-0000-0000-0000-000000000001","action":"call","stage":"turn","amount":2}]',1);
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_recorded_hand_coverage('20000000-0000-0000-0000-000000000001','[{"hand_id":"98000000-0000-0000-0000-000000000005","bets":9,"calls":null,"is_cash":true}]');
 IF (v->>'aggression_factor')::numeric IS DISTINCT FROM 1 OR abs((v->>'cash_hours_played')::numeric-14::numeric/3600)>0.000000001 THEN RAISE EXCEPTION 'Partial pair/short-hand precision wrong: %',v; END IF;
END $$;
INSERT INTO public.hand_history(id,started_at,ended_at,actions,big_blind) VALUES('98000000-0000-0000-0000-000000000006',now(),now(),'[{"userId":"20000000-0000-0000-0000-000000000001","action":"call","stage":"flop","amount":1}]',1);
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_recorded_hand_coverage('20000000-0000-0000-0000-000000000001','[{"hand_id":"98000000-0000-0000-0000-000000000006","is_cash":true}]');
 IF (v#>>'{metric_availability,hours_played}')::boolean IS DISTINCT FROM false OR (v#>>'{metric_availability,cash_hours_played}')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Zero duration certified elapsed hours: %',v; END IF;
END $$;
INSERT INTO public.ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,big_blind,position,players_dealt,invested,returned,net,net_bb)
VALUES('98000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',now(),'nlh',1,'BTN',2,2,0,-2,-2);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ca_hand_stat_intervals WHERE hand_id='98000000-0000-0000-0000-000000000005' AND ended_at>started_at)
 THEN RAISE EXCEPTION 'Original fact insert did not capture durable interval'; END IF;
 IF has_function_privilege('authenticated','public.ca_player_recorded_hand_coverage(uuid,jsonb,timestamptz,timestamptz)','EXECUTE')
 OR has_function_privilege('anon','public.ca_player_recorded_hand_coverage(uuid,jsonb,timestamptz,timestamptz)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.ca_player_recorded_hand_coverage(uuid,jsonb,timestamptz,timestamptz)','EXECUTE')
 OR has_table_privilege('authenticated','public.ca_hand_stat_intervals','SELECT')
 THEN RAISE EXCEPTION 'Coverage helper/table access leaked'; END IF;
END $$;
ROLLBACK;
-- The real two readers consume the complete authorized population, preserve money,
-- and can qualify historical evidence without updating immutable fact rows.
BEGIN;
INSERT INTO public.hand_history(id,started_at,ended_at,actions,big_blind)
SELECT id,now()-interval '30seconds',now(),
 '[{"userId":"20000000-0000-0000-0000-000000000001","action":"bet","stage":"flop","amount":2},{"userId":"20000000-0000-0000-0000-000000000001","action":"call","stage":"turn","amount":2}]',1
FROM (SELECT hand_id id FROM public.ca_hand_facts UNION SELECT hand_id FROM public.ca_hand_player_stat) all_ids
ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at,ended_at=excluded.ended_at,actions=excluded.actions,big_blind=excluded.big_blind;
SET ROLE authenticated;
DO $$ DECLARE v jsonb; b jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF (v#>>'{quality,metric_availability,aggression_factor}')::boolean IS DISTINCT FROM true OR (v#>>'{overall,aggression_factor}')::numeric<>1
 OR (v#>>'{quality,metric_availability,hours_played}')::boolean IS DISTINCT FROM true OR abs((v#>>'{overall,hours_played}')::numeric-0.008333333)>0.000000001
 THEN RAISE EXCEPTION 'Scoped reader coverage not wired: %',v; END IF;
 b:=(SELECT club FROM public.fixture_coverage_before);
 IF v#>'{overall,total_profit}' IS DISTINCT FROM b#>'{overall,total_profit}' OR v#>'{overall,bb_per_100}' IS DISTINCT FROM b#>'{overall,bb_per_100}'
 THEN RAISE EXCEPTION 'Coverage patch changed scoped money'; END IF;
 v:=public.ca_player_stats_overview_v2('20000000-0000-0000-0000-000000000001',30,'UTC','chips');
 IF (v#>>'{quality,metric_availability,aggression_factor}')::boolean IS DISTINCT FROM true OR (v#>>'{overall,aggression_factor}')::numeric<>1
 OR (v#>>'{quality,metric_availability,cash_hours_played}')::boolean IS DISTINCT FROM true OR abs((v#>>'{overall,hours_played}')::numeric-0.008333333)>0.000000001
 THEN RAISE EXCEPTION 'All Clubs reader coverage not wired: %',v; END IF;
 b:=(SELECT global FROM public.fixture_coverage_before);
 IF v#>'{overall,total_profit}' IS DISTINCT FROM b#>'{overall,total_profit}' OR v#>'{overall,bb_per_100}' IS DISTINCT FROM b#>'{overall,bb_per_100}'
 THEN RAISE EXCEPTION 'Coverage patch changed all-clubs money'; END IF;
END $$;
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_overview_v2('20000000-0000-0000-0000-000000000002',30,'UTC','chips')$q$);
RESET ROLE;
-- A missing older hand beyond the 750-hand analysis cap must still invalidate
-- full-window measurement, even when every newer sampled hand is complete.
INSERT INTO public.hand_history(id,started_at,ended_at,actions,big_blind)
SELECT ('99000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,now()-interval '30seconds',now(),
 '[{"userId":"20000000-0000-0000-0000-000000000001","action":"call","stage":"flop","amount":1}]',1
FROM generate_series(1,751) n;
INSERT INTO public.ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,big_blind,position,players_dealt,invested,returned,net,net_bb)
SELECT ('99000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',now(),'nlh',1,'BTN',2,0,0,0,0
FROM generate_series(1,751) n;
INSERT INTO public.ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,big_blind,position,players_dealt,invested,returned,net,net_bb)
VALUES('99000000-0000-0000-0000-000000000999','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',now()-interval '2days','nlh',1,'BTN',2,0,0,0,0);
SET ROLE authenticated;
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF (v#>>'{quality,metric_availability,hours_played}')::boolean IS DISTINCT FROM false OR (v#>>'{quality,metric_availability,aggression_factor}')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Scoped reader used capped measurement evidence'; END IF;
 v:=public.ca_player_stats_overview_v2('20000000-0000-0000-0000-000000000001',30,'UTC','chips');
 IF (v#>>'{quality,metric_availability,hours_played}')::boolean IS DISTINCT FROM false OR (v#>>'{quality,metric_availability,aggression_factor}')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'All Clubs reader used capped measurement evidence'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
SELECT 'PASS: recorded historical AF, interval union/clipping, durable capture, retention, paired evidence, authorization and reader money' result;
