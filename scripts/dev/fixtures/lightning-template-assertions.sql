SET ROLE authenticated;
DO $test$
DECLARE g record; req uuid; r jsonb; c text; action text;
BEGIN
 FOR g IN SELECT * FROM cash_games ORDER BY id LOOP
  r:=fn_lightning_rollout_readiness(g.id);
  IF r->>'verdict'='go' THEN RAISE EXCEPTION 'FAIL fixture falsely claims readiness GO'; END IF;
  IF (g.template_name IN ('action','madness') AND g.ruleset_snapshot->>'template'=g.template_name) IS TRUE THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'reasons')x WHERE x->>'code'='LIGHTNING_TEMPLATE_NOT_ALLOWED') THEN RAISE EXCEPTION 'FAIL allowed template readiness blocked'; END IF;
  ELSE
   IF r->>'verdict' IS DISTINCT FROM 'no_go' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'reasons')x WHERE x->>'code'='LIGHTNING_TEMPLATE_NOT_ALLOWED' AND x->>'severity'='blocking') THEN RAISE EXCEPTION 'FAIL unsupported readiness %',r; END IF;
  END IF;
  IF g.template_name IN ('action','madness') AND g.ruleset_snapshot->>'template'=g.template_name THEN
   UPDATE cash_games SET lightning_enabled=true,cluster_mode='pending_on' WHERE id=g.id;
   UPDATE cash_games SET cluster_mode='lightning' WHERE id=g.id;
   INSERT INTO lightning_hand(cluster_id) VALUES(g.id);
   BEGIN
    UPDATE cash_games SET ruleset_snapshot='{"template":"classic"}' WHERE id=g.id;
    RAISE EXCEPTION 'FAIL active template edit admitted';
   EXCEPTION WHEN check_violation THEN NULL; END;
   UPDATE cash_games SET lightning_enabled=false,cluster_mode='must_move' WHERE id=g.id;
  ELSE
   BEGIN
    UPDATE cash_games SET lightning_enabled=true WHERE id=g.id;
    RAISE EXCEPTION 'FAIL unsupported enable admitted';
   EXCEPTION WHEN check_violation THEN NULL; END;
   BEGIN
    UPDATE cash_games SET cluster_mode='pending_on' WHERE id=g.id;
    RAISE EXCEPTION 'FAIL unsupported pending conversion admitted';
   EXCEPTION WHEN check_violation THEN NULL; END;
   BEGIN
    UPDATE cash_games SET cluster_mode='lightning' WHERE id=g.id;
    RAISE EXCEPTION 'FAIL unsupported direct conversion admitted';
   EXCEPTION WHEN check_violation THEN NULL; END;
   BEGIN
    INSERT INTO lightning_hand(cluster_id) VALUES(g.id);
    RAISE EXCEPTION 'FAIL unsupported direct formation admitted';
   EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS c=CONSTRAINT_NAME;
    IF c IS DISTINCT FROM 'lightning_hand_template_allowed' THEN RAISE; END IF;
   END;
   req:=gen_random_uuid();
   r:=fn_lightning_operator_control(g.id,'enable_lightning','native qualification',jsonb_build_object('request_id',req));
   IF r->>'code' IS DISTINCT FROM 'LIGHTNING_TEMPLATE_NOT_ALLOWED' THEN RAISE EXCEPTION 'FAIL operator refusal %',r; END IF;
   IF NOT EXISTS(SELECT 1 FROM lightning_operator_request WHERE request_id=req AND answer=r) THEN RAISE EXCEPTION 'FAIL refusal not durable'; END IF;
   IF (fn_lightning_operator_control(g.id,'enable_lightning','native qualification',jsonb_build_object('request_id',req))->>'replayed') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FAIL replay'; END IF;
   FOREACH action IN ARRAY ARRAY['resume','enable_joins','set_flag'] LOOP
    r:=fn_lightning_operator_control(g.id,action,'native qualification',jsonb_build_object('request_id',gen_random_uuid(),'flag','lightning_v1','value',true));
    IF r->>'code' IS DISTINCT FROM 'LIGHTNING_TEMPLATE_NOT_ALLOWED' THEN RAISE EXCEPTION 'FAIL alternate operator enable % %',action,r; END IF;
   END LOOP;
   -- Ordinary cash configuration changes and the safe off state remain legal.
   UPDATE cash_games SET handedness=9,lightning_enabled=false,cluster_mode='must_move' WHERE id=g.id;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM lightning_hand)<>2 THEN RAISE EXCEPTION 'FAIL formation census'; END IF;
END $test$;
RESET ROLE;
-- Simulate a pre-existing unsupported active row solely in this isolated DB.
-- The real formation door must refuse before epoch/reap/reservation/money access.
ALTER TABLE cash_games DROP CONSTRAINT cash_games_lightning_template_allowed;
UPDATE cash_games SET lightning_enabled=true,cluster_mode='lightning' WHERE ruleset_snapshot->>'template'='classic';
SET ROLE service_role;
DO $test$ DECLARE r jsonb; BEGIN
 r:=fn_lightning_form_hand('00000000-0000-4000-a000-000000000001',ARRAY[gen_random_uuid(),gen_random_uuid()],p_matcher_version=>'m1');
 IF r->>'reason' IS DISTINCT FROM 'lightning_template_not_allowed' OR r->>'formed' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'FAIL formation refusal %',r; END IF;
END $test$;
RESET ROLE;


SET ROLE anon;
DO $test$ BEGIN
 BEGIN PERFORM fn_lightning_operator_control('00000000-0000-4000-a000-000000000001','enable_lightning','native qualification',jsonb_build_object('request_id',gen_random_uuid())); RAISE EXCEPTION 'FAIL anon operator'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM fn_lightning_rollout_readiness('00000000-0000-4000-a000-000000000001'); RAISE EXCEPTION 'FAIL anon readiness'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
RESET ROLE;
