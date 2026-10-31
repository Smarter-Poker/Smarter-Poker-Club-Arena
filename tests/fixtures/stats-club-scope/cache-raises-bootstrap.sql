
CREATE FUNCTION public.ca_hand_player_facts_one(p_hand_id uuid,p_user uuid DEFAULT NULL)
RETURNS TABLE(pfr boolean,aggro_cnt integer,call_cnt integer,amount_sum numeric)
LANGUAGE plpgsql STABLE AS $function$
BEGIN RETURN QUERY WITH my_hands AS MATERIALIZED (
 SELECT h.id,h.actions,h.big_blind FROM public.hand_history h WHERE h.id=p_hand_id
),
acts AS MATERIALIZED (
 SELECT mh.id hand_id,x.ord,x.act->>'userId' auid,x.act->>'stage' stage,
 lower(x.act->>'action') action,coalesce((x.act->>'amount')::numeric,0) amount,
 coalesce((x.act->>'dead')::boolean,false) dead_flag
 FROM my_hands mh CROSS JOIN LATERAL jsonb_array_elements(mh.actions) WITH ORDINALITY x(act,ord)
),
players_all AS (SELECT 1 marker), per_player_base AS (
 SELECT coalesce(bool_or(a.stage = 'preflop' AND a.action IN ('raise','all_in','allin')), false) AS pfr,
 count(*) FILTER (WHERE a.action IN ('bet','raise','all_in','allin'))::int AS aggro_cnt,
 count(*) FILTER (WHERE a.action = 'call')::int AS call_cnt,sum(a.amount) amount_sum
 FROM acts a WHERE a.auid=p_user::text
) SELECT b.* FROM per_player_base b;
END $function$;
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('public.ca_hand_player_facts_one(uuid,uuid)'::regprocedure);
 d:=replace(d,'ca_hand_player_facts_one(p_hand_id uuid, p_user uuid DEFAULT NULL::uuid)',
  'ca_hand_player_facts_range(p_hand_id uuid, p_user uuid DEFAULT NULL::uuid)');
 EXECUTE d;
END $$;
INSERT INTO public.hand_history(id,club_id,actions,big_blind) VALUES(
 '92000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
 '[{"userId":"20000000-0000-0000-0000-000000000002","action":"bb","amount":10,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000002","action":"all_in","amount":30,"stage":"preflop"},
 {"userId":"20000000-0000-0000-0000-000000000001","action":"all_in","amount":20,"stage":"preflop"}]',10);
DO $$ DECLARE r record; BEGIN
 SELECT * INTO r FROM public.ca_hand_player_facts_one('92000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
 IF NOT r.pfr OR r.aggro_cnt<>1 OR r.call_cnt<>0 THEN RAISE EXCEPTION 'Old all-in call reproduction changed'; END IF;
END $$;
