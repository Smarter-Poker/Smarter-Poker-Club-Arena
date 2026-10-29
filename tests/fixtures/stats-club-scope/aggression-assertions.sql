BEGIN;
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_fact_aggression_counts('[
 {"userId":"20000000-0000-0000-0000-000000000001","action":"raise","amount":6,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000002","action":"fold","amount":0,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"return","amount":4,"stage":"preflop"}
 ]'::jsonb,'20000000-0000-0000-0000-000000000001',2);
 IF v IS DISTINCT FROM jsonb_build_object('bets_raises',1,'calls',0)
 THEN RAISE EXCEPTION 'Uncalled return discarded measured aggression: %',v; END IF;
 v:=public.ca_fact_aggression_counts('[
 {"userId":"20000000-0000-0000-0000-000000000002","action":"raise","amount":2,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"fold","amount":0,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000002","action":"return","amount":1,"stage":"preflop"}
 ]'::jsonb,'20000000-0000-0000-0000-000000000001',1);
 IF v IS DISTINCT FROM jsonb_build_object('bets_raises',0,'calls',0)
 THEN RAISE EXCEPTION 'Opponent return made a folded hand unmeasured: %',v; END IF;
END $$;
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_fact_aggression_counts('[
 {"userId":"20000000-0000-0000-0000-000000000002","action":"bb","origin":"forced","amount":2,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000002","action":"raise","amount":10,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"all_in","amount":6,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"check","amount":0,"stage":"flop"},
 {"userId":"20000000-0000-0000-0000-000000000002","action":"bet","amount":5,"stage":"flop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"call","amount":5,"stage":"flop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"bet","amount":20,"stage":"turn"},
 {"userId":"20000000-0000-0000-0000-000000000002","action":"bet","amount":30,"stage":"river"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"raise","amount":60,"stage":"river"}
 ]'::jsonb,'20000000-0000-0000-0000-000000000001');
 IF v<>jsonb_build_object('bets_raises',2,'calls',2) THEN RAISE EXCEPTION 'Calls/checks/all-in classification wrong: %',v; END IF;
 IF public.ca_fact_aggression_counts(NULL,'20000000-0000-0000-0000-000000000001') IS NOT NULL
 OR public.ca_fact_aggression_counts('{}','20000000-0000-0000-0000-000000000001') IS NOT NULL
 OR public.ca_fact_aggression_counts('[]','20000000-0000-0000-0000-000000000001') IS NOT NULL
 OR public.ca_fact_aggression_counts('[{"userId":"20000000-0000-0000-0000-000000000001","action":"all_in","stage":"flop"}]','20000000-0000-0000-0000-000000000001') IS NOT NULL
 THEN RAISE EXCEPTION 'Incomplete action history manufactured measured zeros'; END IF;
END $$;
INSERT INTO public.hand_history(id,club_id,actions) VALUES(
 '91000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
 '[{"userId":"20000000-0000-0000-0000-000000000001","action":"check","amount":0,"stage":"flop"},
 {"userId":"20000000-0000-0000-0000-000000000002","action":"bet","amount":10,"stage":"flop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"call","amount":10,"stage":"flop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"bet","amount":10,"stage":"turn"}]');
INSERT INTO public.ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,big_blind,position,players_dealt,
 invested,returned,net,net_bb)
VALUES('91000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000001',now(),'nlh',1,'BTN',2,20,0,-20,-20);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.ca_hand_facts WHERE hand_id='91000000-0000-0000-0000-000000000001'
 AND af_bet_raise_actions=1 AND af_call_actions=1)
 THEN RAISE EXCEPTION 'Original fact INSERT did not persist call-only aggression'; END IF;
END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF (v#>>'{quality,metric_availability,aggression_factor}')::boolean
 THEN RAISE EXCEPTION 'Incomplete historical coverage certified AF'; END IF;
END $$;
RESET ROLE;
-- Synthetic complete historical coverage; production old histories remain NULL.
UPDATE public.ca_hand_facts SET af_bet_raise_actions=0,af_call_actions=0 WHERE af_call_actions IS NULL;
SET ROLE authenticated;
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF NOT (v#>>'{quality,metric_availability,aggression_factor}')::boolean
 OR (v#>>'{overall,aggression_factor}')::numeric<>1
 OR (v#>>'{quality,metric_availability,aggression_factor_denominator}')::int<>1
 THEN RAISE EXCEPTION 'Call-only AF aggregate/denominator wrong: %',v; END IF;
END $$;
RESET ROLE;
DELETE FROM public.ca_hand_player_stat s WHERE s.user_id='20000000-0000-0000-0000-000000000001'
 AND NOT EXISTS(SELECT 1 FROM public.ca_hand_facts f WHERE f.hand_id=s.hand_id AND f.user_id=s.user_id);
SET ROLE authenticated;
DO $$ DECLARE v jsonb; BEGIN
 v:=public.ca_player_stats_overview_v2('20000000-0000-0000-0000-000000000001',30,'UTC','chips');
 IF NOT (v#>>'{quality,metric_availability,aggression_factor}')::boolean
 OR (v#>>'{overall,aggression_factor}')::numeric<>1
 OR (v#>>'{quality,metric_availability,aggression_factor_denominator}')::int<>1
 THEN RAISE EXCEPTION 'All Clubs call-only AF wrong: %',v; END IF;
END $$;
RESET ROLE;
ROLLBACK;
SELECT 'PASS: insert-time call counts, checks, all-in calls, unknown history and complete-window availability' result;

DO $$ BEGIN
 IF public.ca_fact_aggression_counts('[{"action":"mystery","userId":"20000000-0000-0000-0000-000000000001","stage":"flop"}]'::jsonb,'20000000-0000-0000-0000-000000000001') IS NOT NULL
 OR public.ca_fact_aggression_counts('[{"action":"call","amount":2}]'::jsonb,'20000000-0000-0000-0000-000000000001') IS NOT NULL
 THEN RAISE EXCEPTION 'Unknown or incomplete actions falsely reported measured'; END IF;
END $$;
