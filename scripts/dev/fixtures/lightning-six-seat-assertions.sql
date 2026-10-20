-- Owner ruling 2026-10-19: every Lightning game is six-seat Action or Madness.
-- Run after 20261020005222 on the native installed image built by
-- scripts/dev/test-lightning-six-seat-boundary.sh.
SET ROLE authenticated;
DO $test$
DECLARE
 g record; req uuid; r jsonb; c text; action text; codes text[];
 v_six constant uuid[] := ARRAY['00000000-0000-4000-a000-000000000002','00000000-0000-4000-a000-000000000003']::uuid[];
 v_other constant uuid[] := ARRAY['00000000-0000-4000-a000-000000000019','00000000-0000-4000-a000-000000000029',
                                  '00000000-0000-4000-a000-000000000028','00000000-0000-4000-a000-000000000012']::uuid[];
BEGIN
 -- SIX-SEAT ACTION AND MADNESS KEEP LIGHTNING.
 FOR g IN SELECT * FROM cash_games WHERE id = ANY(v_six) ORDER BY id LOOP
  IF g.handedness <> 6 OR g.template_name NOT IN ('action','madness') THEN RAISE EXCEPTION 'FAIL fixture six-seat row %',g.id; END IF;
  r:=fn_lightning_rollout_readiness(g.id);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'reasons') x WHERE x->>'code' IN ('LIGHTNING_TABLE_SIZE_NOT_ALLOWED','LIGHTNING_TEMPLATE_NOT_ALLOWED')) THEN
   RAISE EXCEPTION 'FAIL six-seat readiness blocked %',r;
  END IF;
  UPDATE cash_games SET lightning_enabled=true,cluster_mode='pending_on' WHERE id=g.id;
  UPDATE cash_games SET cluster_mode='lightning' WHERE id=g.id;
  INSERT INTO lightning_hand(cluster_id) VALUES(g.id);
  -- An active six-seat Lightning game cannot be resized away from six.
  BEGIN
   UPDATE cash_games SET handedness=9 WHERE id=g.id;
   RAISE EXCEPTION 'FAIL active Lightning resize admitted';
  EXCEPTION WHEN check_violation THEN
   GET STACKED DIAGNOSTICS c=CONSTRAINT_NAME;
   IF c IS DISTINCT FROM 'cash_games_lightning_six_seat_only' THEN RAISE; END IF;
  END;
  UPDATE cash_games SET lightning_enabled=false,cluster_mode='must_move' WHERE id=g.id;
 END LOOP;
 IF (SELECT count(*) FROM lightning_hand WHERE cluster_id = ANY(v_six))<>2 THEN RAISE EXCEPTION 'FAIL six-seat formation census'; END IF;

 -- EVERY OTHER SIZE OF ACTION AND MADNESS IS REFUSED, BY NAME, AT EVERY DOOR.
 FOR g IN SELECT * FROM cash_games WHERE id = ANY(v_other) ORDER BY id LOOP
  IF g.handedness = 6 OR NOT fn_lightning_template_allowed(g.template_name,g.ruleset_snapshot) THEN RAISE EXCEPTION 'FAIL fixture other-size row %',g.id; END IF;
  FOREACH action IN ARRAY ARRAY['lightning_enabled','pending_on','lightning'] LOOP
   BEGIN
    IF action='lightning_enabled' THEN UPDATE cash_games SET lightning_enabled=true WHERE id=g.id;
    ELSE UPDATE cash_games SET cluster_mode=action WHERE id=g.id; END IF;
    RAISE EXCEPTION 'FAIL % admitted at % seats',action,g.handedness;
   EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS c=CONSTRAINT_NAME;
    IF c IS DISTINCT FROM 'cash_games_lightning_six_seat_only' THEN RAISE; END IF;
   END;
  END LOOP;
  BEGIN
   INSERT INTO lightning_hand(cluster_id) VALUES(g.id);
   RAISE EXCEPTION 'FAIL direct formation admitted at % seats',g.handedness;
  EXCEPTION WHEN check_violation THEN
   GET STACKED DIAGNOSTICS c=CONSTRAINT_NAME;
   IF c IS DISTINCT FROM 'lightning_hand_table_size_allowed' THEN RAISE; END IF;
  END;
  req:=gen_random_uuid();
  r:=fn_lightning_operator_control(g.id,'enable_lightning','native qualification',jsonb_build_object('request_id',req));
  IF r->>'code' IS DISTINCT FROM 'LIGHTNING_TABLE_SIZE_NOT_ALLOWED' OR r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'FAIL operator refusal %',r; END IF;
  IF NOT EXISTS(SELECT 1 FROM lightning_operator_request WHERE request_id=req AND answer=r) THEN RAISE EXCEPTION 'FAIL refusal not durable'; END IF;
  IF (fn_lightning_operator_control(g.id,'enable_lightning','native qualification',jsonb_build_object('request_id',req))->>'replayed') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FAIL replay'; END IF;
  FOREACH action IN ARRAY ARRAY['resume','enable_joins','set_flag'] LOOP
   r:=fn_lightning_operator_control(g.id,action,'native qualification',jsonb_build_object('request_id',gen_random_uuid(),'flag','lightning_v1','value',true));
   IF r->>'code' IS DISTINCT FROM 'LIGHTNING_TABLE_SIZE_NOT_ALLOWED' THEN RAISE EXCEPTION 'FAIL alternate operator enable % %',action,r; END IF;
  END LOOP;
  r:=fn_lightning_rollout_readiness(g.id);
  SELECT array_agg(x->>'code') INTO codes FROM jsonb_array_elements(r->'reasons') x WHERE x->>'code' LIKE 'LIGHTNING_%_NOT_ALLOWED' AND x->>'severity'='blocking';
  IF r->>'verdict' IS DISTINCT FROM 'no_go' OR codes IS DISTINCT FROM ARRAY['LIGHTNING_TABLE_SIZE_NOT_ALLOWED'] THEN RAISE EXCEPTION 'FAIL other-size readiness %',r; END IF;
  -- Ordinary game entry and every ordinary state stay legal.
  FOREACH action IN ARRAY ARRAY['pending_off','draining','paused','frozen','dead','must_move'] LOOP
   UPDATE cash_games SET cluster_mode=action WHERE id=g.id;
  END LOOP;
  UPDATE cash_games SET enabled=false WHERE id=g.id;
  UPDATE cash_games SET enabled=true,handedness=6 WHERE id=g.id;
  UPDATE cash_games SET handedness=g.handedness WHERE id=g.id;
  IF (SELECT lightning_enabled OR cluster_mode<>'must_move' OR handedness<>g.handedness FROM cash_games WHERE id=g.id) THEN RAISE EXCEPTION 'FAIL ordinary state not restored'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM lightning_hand WHERE cluster_id = ANY(v_other)) THEN RAISE EXCEPTION 'FAIL other-size formation census'; END IF;

 -- CLASSIC STAYS REFUSED FOR ITS TEMPLATE FIRST, AT EVERY SIZE.
 r:=fn_lightning_operator_control('00000000-0000-4000-a000-000000000039','enable_lightning','native qualification',jsonb_build_object('request_id',gen_random_uuid()));
 IF r->>'code' IS DISTINCT FROM 'LIGHTNING_TEMPLATE_NOT_ALLOWED' THEN RAISE EXCEPTION 'FAIL classic nine operator %',r; END IF;
 SELECT array_agg(x->>'code' ORDER BY x->>'code') INTO codes FROM jsonb_array_elements(fn_lightning_rollout_readiness('00000000-0000-4000-a000-000000000039')->'reasons') x WHERE x->>'code' LIKE 'LIGHTNING_%_NOT_ALLOWED';
 IF codes IS DISTINCT FROM ARRAY['LIGHTNING_TABLE_SIZE_NOT_ALLOWED','LIGHTNING_TEMPLATE_NOT_ALLOWED'] THEN RAISE EXCEPTION 'FAIL classic nine readiness %',codes; END IF;
 BEGIN
  INSERT INTO lightning_hand(cluster_id) VALUES('00000000-0000-4000-a000-000000000039');
  RAISE EXCEPTION 'FAIL classic nine formation admitted';
 EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS c=CONSTRAINT_NAME;
  IF c IS DISTINCT FROM 'lightning_hand_template_allowed' THEN RAISE; END IF;
 END;
 r:=fn_lightning_operator_control('00000000-0000-4000-a000-000000000001','enable_lightning','native qualification',jsonb_build_object('request_id',gen_random_uuid()));
 IF r->>'code' IS DISTINCT FROM 'LIGHTNING_TEMPLATE_NOT_ALLOWED' THEN RAISE EXCEPTION 'FAIL classic six operator %',r; END IF;

 -- HORSES AND HUMANS: the size rule names no player kind anywhere.
 IF position('horse' in pg_get_functiondef('public.fn_lightning_table_size_allowed(integer)'::regprocedure))>0
    OR position('horse' in pg_get_functiondef('public.fn_lightning_hand_template_guard()'::regprocedure))>0
    OR position('horse' in pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds(uuid)'::regprocedure))>0 THEN
  RAISE EXCEPTION 'FAIL the six-seat rule distinguishes a kind of player';
 END IF;
END $test$;
RESET ROLE;

-- THRESHOLDS: a six-seat game keeps its 18/12; any other size is not Lightning.
SET ROLE service_role;
DO $test$ DECLARE r jsonb; BEGIN
 r:=fn_cash_cluster_lightning_thresholds('00000000-0000-4000-a000-000000000002');
 IF r->>'lightning_allowed' IS DISTINCT FROM 'true' OR r ? 'reason' OR (r->>'on')::int<>18 OR (r->>'off')::int<>12 THEN RAISE EXCEPTION 'FAIL six-seat thresholds %',r; END IF;
 r:=fn_cash_cluster_lightning_thresholds('00000000-0000-4000-a000-000000000019');
 IF r->>'lightning_allowed' IS DISTINCT FROM 'false' OR r->>'reason' IS DISTINCT FROM 'LIGHTNING_TABLE_SIZE_NOT_ALLOWED' THEN RAISE EXCEPTION 'FAIL nine-seat thresholds %',r; END IF;
 r:=fn_cash_cluster_lightning_thresholds('00000000-0000-4000-a000-000000000012');
 IF r->>'lightning_allowed' IS DISTINCT FROM 'false' OR r->>'reason' IS DISTINCT FROM 'LIGHTNING_TABLE_SIZE_NOT_ALLOWED' THEN RAISE EXCEPTION 'FAIL two-seat thresholds %',r; END IF;
 IF fn_cash_cluster_lightning_thresholds(gen_random_uuid())->>'reason' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'FAIL thresholds not_found'; END IF;
END $test$;
RESET ROLE;

-- FORMATION: a pre-existing nine-seat Lightning row (simulated only inside this
-- rolled-back transaction) is refused before epoch/reap/reservation/money access.
BEGIN;
ALTER TABLE cash_games DROP CONSTRAINT cash_games_lightning_six_seat_only;
UPDATE cash_games SET lightning_enabled=true,cluster_mode='lightning' WHERE id IN ('00000000-0000-4000-a000-000000000019','00000000-0000-4000-a000-000000000029');
SET ROLE service_role;
DO $test$ DECLARE r jsonb; g uuid; BEGIN
 FOREACH g IN ARRAY ARRAY['00000000-0000-4000-a000-000000000019','00000000-0000-4000-a000-000000000029']::uuid[] LOOP
  r:=fn_lightning_form_hand(g,ARRAY[gen_random_uuid(),gen_random_uuid()],p_matcher_version=>'m1');
  IF r->>'reason' IS DISTINCT FROM 'lightning_table_size_not_allowed' OR r->>'formed' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'FAIL formation refusal %',r; END IF;
 END LOOP;
END $test$;
RESET ROLE;
ROLLBACK;

SET ROLE anon;
DO $test$ BEGIN
 BEGIN PERFORM fn_lightning_table_size_allowed(6); RAISE EXCEPTION 'FAIL anon size door'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
RESET ROLE;
