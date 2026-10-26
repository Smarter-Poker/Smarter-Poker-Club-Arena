-- Real installed matcher -> real installed formation -> real begin_dealing.
-- Isolated fixture boundaries: funded anchor seats, legality and P2 keys.
-- These stand-ins do not qualify production permissions or wallet admission.
ALTER TABLE lightning_pool_slot ADD cluster_epoch int DEFAULT 1, ADD last_bb_at timestamptz, ADD last_sb_at timestamptz, ADD last_button_at timestamptz, ADD hands_since_bb int DEFAULT 0, ADD hands_since_sb int DEFAULT 0, ADD updated_at timestamptz;
ALTER TABLE lightning_pool_session ADD state text DEFAULT 'active', ADD starting_stack numeric DEFAULT 100, ADD net_result numeric DEFAULT 0, ADD ending_stack numeric, ADD entered_at timestamptz DEFAULT now();
ALTER TABLE cash_player_session ADD opened_at timestamptz DEFAULT now();
ALTER TABLE lightning_instance ALTER id SET DEFAULT gen_random_uuid(), ADD target_size int, ADD max_size int;
ALTER TABLE lightning_hand ADD cluster_id uuid, ADD cluster_epoch int, ADD lightning_instance_id uuid, ADD formed_at timestamptz, ADD rules_version text, ADD matcher_version text, ADD blind_algorithm_version text, ADD lightning_version text, ADD rake_version text, ADD request_id uuid;
ALTER TABLE lightning_hand_player ADD position text, ADD blind_role text, ADD stack_before numeric, ADD fold_type text, ADD cluster_id uuid, ADD cluster_epoch int;
ALTER TABLE lightning_reservation ADD cluster_id uuid, ADD cluster_epoch int, ADD pool_slot_id uuid, ADD created_at timestamptz, ADD expires_at timestamptz, ADD resolved_at timestamptz;
ALTER TABLE cash_cluster_events ADD request_id uuid;
CREATE TABLE tables(id uuid PRIMARY KEY,game_variant text,pineapple_holdem boolean DEFAULT false);
CREATE TABLE table_seats(id uuid PRIMARY KEY,user_id uuid,stack numeric,left_at timestamptz);
CREATE TABLE lightning_blind_ledger(cluster_id uuid,player_id uuid,bb_count int DEFAULT 0,sb_count int DEFAULT 0,btn_count int DEFAULT 0,utg_count int DEFAULT 0,hj_count int DEFAULT 0,co_count int DEFAULT 0,first_seen_at timestamptz,updated_at timestamptz,PRIMARY KEY(cluster_id,player_id));
CREATE FUNCTION fn_cash_cluster_lightning_thresholds(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"on":18,"off":12}'::jsonb $$;
CREATE FUNCTION fn_cash_cluster_lightning_thresholds_probe(jsonb,int) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"on":18,"off":12}'::jsonb $$;
CREATE FUNCTION fn_lightning_config_number(jsonb,text,numeric,numeric,numeric,boolean) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('value',coalesce(($1->>$2)::numeric,$3)) $$;
CREATE FUNCTION fn_cash_cluster_front_table(uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION fn_lightning_template_allowed(text,jsonb) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION fn_lightning_table_size_allowed(int) RETURNS boolean LANGUAGE sql AS $$ SELECT $1=6 $$;
CREATE FUNCTION fn_lightning_reap_formations(timestamptz,int,uuid) RETURNS int LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION fn_lightning_pool_stack(uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT ts.stack FROM lightning_pool_session ps JOIN table_seats ts ON ts.id=ps.anchor_seat_id WHERE ps.id=$1 $$;
CREATE FUNCTION fn_lightning_player_legality(uuid,timestamptz,uuid[],jsonb) RETURNS TABLE(player_id uuid,legal boolean,reason_code text) LANGUAGE sql AS $$ SELECT sl.player_id,NOT sl.player_id=ANY(coalesce($3,'{}'::uuid[])),CASE WHEN sl.player_id=ANY(coalesce($3,'{}'::uuid[])) THEN 'DISCONNECTED' END FROM lightning_pool_slot sl WHERE sl.cluster_id=$1 AND sl.closed_at IS NULL $$;
CREATE FUNCTION fn_lightning_blind_order(uuid,int,uuid[]) RETURNS TABLE(player_id uuid,pool_slot_id uuid,bb_unresolved boolean,last_bb_at timestamptz,debt_age interval,entered_pool timestamptz,p2_rank bigint) LANGUAGE sql AS $$ SELECT sl.player_id,sl.id,false,sl.last_bb_at,interval '0',ps.entered_at,row_number() OVER(ORDER BY sl.player_id) FROM lightning_pool_slot sl JOIN lightning_pool_session ps ON ps.id=sl.pool_session_id WHERE sl.cluster_id=$1 AND sl.player_id=ANY($3) ORDER BY sl.player_id $$;

-- Exact existing pure P5 assignment helper.
CREATE OR REPLACE FUNCTION public.fn_lightning_diversity_assign(
  p_groups      jsonb,
  p_rest        uuid[],
  p_capacity    integer[],
  p_encounters  jsonb,
  p_recent_sets jsonb,
  p_weight      numeric)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_grp      jsonb := coalesce(p_groups, '[]'::jsonb);
  v_g        integer := jsonb_array_length(coalesce(p_groups, '[]'::jsonb));
  v_cap      integer[] := coalesce(p_capacity, ARRAY[]::integer[]);
  v_enc      jsonb := coalesce(p_encounters, '{}'::jsonb);
  v_sets     jsonb := coalesce(p_recent_sets, '{}'::jsonb);
  v_moved    integer[];
  v_active   boolean;
  v_default  integer;
  v_best     integer;
  v_def_pen  integer;
  v_best_pen integer;
  v_pen      integer;
  v_key      text;
  pen        record;
  p          uuid;
  j          integer;
BEGIN
  v_moved := CASE WHEN v_g > 0 THEN array_fill(0, ARRAY[v_g]) ELSE ARRAY[]::integer[] END;
  v_active := coalesce(p_weight, 0) > 0 AND (v_enc <> '{}'::jsonb OR v_sets <> '{}'::jsonb);
  FOREACH p IN ARRAY coalesce(p_rest, ARRAY[]::uuid[]) LOOP
    v_default := NULL;
    FOR j IN 1 .. v_g LOOP
      IF v_cap[j] > 0 THEN v_default := j; EXIT; END IF;
    END LOOP;
    IF v_default IS NULL THEN
      RAISE EXCEPTION 'fn_lightning_diversity_assign: % players for fewer seats', cardinality(p_rest);
    END IF;
    v_best := v_default;
    IF v_active THEN
      v_def_pen := NULL;
      v_best_pen := NULL;
      FOR pen IN
        SELECT t.j::integer AS j, jsonb_array_length(t.arr) AS size,
               coalesce(sum(coalesce((v_enc ->> (LEAST(p, m.pid::uuid)::text || '/' || GREATEST(p, m.pid::uuid)::text))::integer, 0)), 0)::integer AS n
          FROM jsonb_array_elements(v_grp) WITH ORDINALITY t(arr, j)
          CROSS JOIN LATERAL jsonb_array_elements_text(t.arr) m(pid)
         GROUP BY t.j, t.arr
         ORDER BY t.j
      LOOP
        IF v_cap[pen.j] > 0 THEN
          v_pen := pen.n;
          IF v_cap[pen.j] = 1 AND v_sets <> '{}'::jsonb THEN
            SELECT string_agg(z.x::text, ',' ORDER BY z.x) INTO v_key
              FROM (SELECT m.pid::uuid AS x FROM jsonb_array_elements_text(v_grp -> (pen.j - 1)) m(pid)
                    UNION ALL SELECT p) z;
            IF v_sets ? v_key THEN
              v_pen := v_pen + ((pen.size + 1) * pen.size) / 2;
            END IF;
          END IF;
          IF pen.j = v_default THEN v_def_pen := v_pen; END IF;
          IF v_best_pen IS NULL OR v_pen < v_best_pen THEN
            v_best_pen := v_pen;
            v_best := pen.j;
          END IF;
        END IF;
      END LOOP;
      IF NOT (p_weight * (v_def_pen - v_best_pen) >= 1) THEN
        v_best := v_default;
      END IF;
    END IF;
    v_grp := jsonb_set(v_grp, ARRAY[(v_best - 1)::text], (v_grp -> (v_best - 1)) || to_jsonb(p));
    v_cap[v_best] := v_cap[v_best] - 1;
    IF v_best <> v_default THEN v_moved[v_best] := v_moved[v_best] + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('groups', v_grp, 'moved', to_jsonb(v_moved));
END
$fn$;
CREATE FUNCTION pg_temp.ready_fixture(n int,fifth_age interval) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE g uuid:=gen_random_uuid();p uuid;ss uuid;sl uuid;cs uuid;seat uuid;t timestamptz:=now();
BEGIN
 INSERT INTO cash_games(id,template_name,ruleset_snapshot,variant,sb,bb,name) VALUES(g,'madness','{}','nlh',.25,.5,'Lightning Games');
 INSERT INTO cash_cluster_epoch VALUES(g,1,NULL);
 FOR k IN 1..n LOOP
  p:=md5(g::text||'/'||k::text)::uuid;
  ss:=gen_random_uuid();sl:=gen_random_uuid();cs:=gen_random_uuid();seat:=gen_random_uuid();
  INSERT INTO table_seats VALUES(seat,p,100,NULL);
  INSERT INTO cash_player_session(id,opened_at) VALUES(cs,t-interval '1 hour');
  INSERT INTO lightning_pool_session(id,cluster_id,cluster_epoch,player_id,anchor_seat_id,cash_player_session_id,entered_at) VALUES(ss,g,1,p,seat,cs,t-interval '1 hour');
  INSERT INTO lightning_pool_slot(id,pool_session_id,cluster_id,player_id,idle_since) VALUES(sl,ss,g,p,CASE WHEN k=n THEN t-fifth_age ELSE t-interval '1 minute' END);
 END LOOP;
 RETURN g;
END $$;
DO $flow$
DECLARE g uuid;t timestamptz:=now();plan jsonb;grp jsonb;formed jsonb;begun jsonb;ids uuid[];req uuid;replay jsonb;before_money numeric;n int;
BEGIN
 FOR n IN 4..6 LOOP
  g:=pg_temp.ready_fixture(n,interval '2999 milliseconds');
  plan:=fn_lightning_match_plan(g,t,'{}','m1',32,NULL);
  IF n<6 AND jsonb_array_length(plan->'groups')<>0 THEN RAISE EXCEPTION 'early or under-five matcher: % %',n,plan; END IF;
  IF n=5 THEN
   ids:=ARRAY(SELECT player_id FROM lightning_pool_slot WHERE cluster_id=g ORDER BY player_id);
   formed:=fn_lightning_form_hand(g,ids,5::smallint,6::smallint,ids[1],interval '20 seconds',interval '45 seconds',t,'m1',gen_random_uuid(),NULL);
   IF formed->>'reason'<>'WAITING_FOR_SIXTH_PLAYER' OR formed->>'formed'<>'false' THEN RAISE EXCEPTION 'direct formation released fifth early: %',formed; END IF;
   IF EXISTS(SELECT 1 FROM lightning_hand WHERE cluster_id=g) THEN RAISE EXCEPTION 'early refusal created hand'; END IF;
   -- The same fifth player becomes ready at precisely 3000ms.
   plan:=fn_lightning_match_plan(g,t+interval '1 millisecond','{}','m1',32,NULL);
  END IF;
  IF n>=5 THEN
   IF jsonb_array_length(plan->'groups')<>1 THEN RAISE EXCEPTION 'expected one group for %: %',n,plan; END IF;
   grp:=plan->'groups'->0;
   ids:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(grp->'players') x);
   IF cardinality(ids)<>n THEN RAISE EXCEPTION 'wrong group count'; END IF;
   req:=gen_random_uuid();SELECT sum(stack) INTO before_money FROM table_seats;
   formed:=fn_lightning_form_hand(g,ids,n::smallint,6::smallint,(grp->>'bb')::uuid,interval '20 seconds',interval '45 seconds',t+interval '1 millisecond','m1',req,NULL);
   IF formed->>'formed'<>'true' THEN RAISE EXCEPTION 'real formation refused: %',formed; END IF;
   replay:=fn_lightning_form_hand(g,ids,n::smallint,6::smallint,(grp->>'bb')::uuid,interval '20 seconds',interval '45 seconds',t+interval '1 millisecond','m1',req,NULL);
   IF replay->>'hand_id' IS DISTINCT FROM formed->>'hand_id' OR replay->>'replayed'<>'true' THEN RAISE EXCEPTION 'formation replay disagrees'; END IF;
   begun:=fn_lightning_instance_begin_dealing((formed->>'instance_id')::uuid,interval '10 minutes',t+interval '1 millisecond');
   IF begun->>'dealing'<>'true' THEN RAISE EXCEPTION 'real dealing refused: %',begun; END IF;
   IF (SELECT sum(stack) FROM table_seats)<>before_money THEN RAISE EXCEPTION 'formation moved anchor money'; END IF;
   IF (SELECT count(*) FROM lightning_hand_player WHERE hand_id=(formed->>'hand_id')::uuid)<>n THEN RAISE EXCEPTION 'participants not persisted'; END IF;
  END IF;
 END LOOP;
 -- Eleven ready players: a fresh player belongs to a full six-player group.
 -- That player's timestamp must not hold the independent aged group of five.
 g:=pg_temp.ready_fixture(11,interval '1 minute');
 UPDATE lightning_pool_slot SET idle_since=t WHERE cluster_id=g AND player_id=(SELECT player_id FROM lightning_pool_slot WHERE cluster_id=g ORDER BY player_id LIMIT 1);
 plan:=fn_lightning_match_plan(g,t,'{}','m1',32,NULL);
 IF jsonb_array_length(plan->'groups')<>2
    OR jsonb_array_length(plan->'groups'->0->'players')<>6
    OR jsonb_array_length(plan->'groups'->1->'players')<>5 THEN RAISE EXCEPTION 'unrelated arrival reset selected fifth: %',plan; END IF;
 grp:=plan->'groups'->1;
 ids:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(grp->'players') x);
 formed:=fn_lightning_form_hand(g,ids,5::smallint,6::smallint,(grp->>'bb')::uuid,interval '20 seconds',interval '45 seconds',t,'m1',gen_random_uuid(),NULL);
 IF formed->>'formed'<>'true' THEN RAISE EXCEPTION 'aged selected five failed barrier: %',formed; END IF;
END $flow$;
