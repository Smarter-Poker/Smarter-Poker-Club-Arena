
DO $transition$
DECLARE g uuid:='70000000-0000-4000-8000-000000000001'; t uuid; req uuid; result jsonb;
BEGIN
 INSERT INTO cash_games(id,club_id,template_name,variant,sb,bb,cluster_mode,ruleset_snapshot)
 VALUES(g,'40000000-0000-4000-8000-000000000001','madness','nlh',5,10,'must_move',
 '{"regular_ante":"bb","vpip_floor":40,"lightning":{"always_on":true,"worker_mode":"form","on_threshold":5,"off_threshold":4}}');
 t:=fn_cash_cluster_open_table(g,'feeder',NULL,'live',NULL);
 IF (SELECT auto_start_players FROM tables WHERE id=t)<>6 THEN RAISE EXCEPTION 'new physical anchor can deal short'; END IF;
 result:=fn_cash_cluster_lightning_drive(g);
 IF result->>'action'<>'begin_pending_on' OR (SELECT cluster_mode FROM cash_games WHERE id=g)<>'pending_on' THEN RAISE EXCEPTION 'zero population canonical conversion did not begin: %',result; END IF;
 IF (SELECT dealing_halted_reason FROM tables WHERE id=t)<>'lightning_pending_on' THEN RAISE EXCEPTION 'original conversion did not halt physical anchor'; END IF;
 SELECT conversion_request_id INTO req FROM cash_cluster_conversion WHERE cluster_id=g;
 INSERT INTO hand_state_snapshots(table_id,is_complete,updated_at) VALUES(t,false,now());
 result:=fn_cash_cluster_commit_lightning(g,req);
 IF result->>'reason'<>'hands_in_flight' THEN RAISE EXCEPTION 'always_on bypassed hand boundary: %',result; END IF;
 UPDATE hand_state_snapshots SET is_complete=true WHERE table_id=t;
 INSERT INTO engine_table_leases(table_id,heartbeat_at) VALUES(t,now());
 result:=fn_cash_cluster_commit_lightning(g,req);
 IF result->>'reason'<>'halt_not_observed' THEN RAISE EXCEPTION 'always_on bypassed halt observation: %',result; END IF;
 UPDATE tables SET dealing_halt_observed_at=clock_timestamp() WHERE id=t;
 result:=fn_cash_cluster_lightning_drive(g);
 IF result->>'action'<>'commit_lightning' OR (SELECT cluster_mode FROM cash_games WHERE id=g)<>'lightning' THEN RAISE EXCEPTION 'empty canonical pool conversion failed: %',result; END IF;
 result:=fn_cash_cluster_lightning_drive(g);
 IF result->>'action'<>'hold' OR (SELECT cluster_mode FROM cash_games WHERE id=g)<>'lightning' THEN RAISE EXCEPTION 'zero population incorrectly reverted canonical Lightning: %',result; END IF;
 result:=fn_cash_cluster_commit_lightning(g,req);
 IF result->>'reason'<>'already_committed' OR result->>'converted'<>'true' THEN RAISE EXCEPTION 'conversion replay failed: %',result; END IF;
 UPDATE tables SET auto_start_players=2 WHERE id=t;
 PERFORM fn_cash_apply_ruleset(g);
 IF (SELECT auto_start_players FROM tables WHERE id=t)<>6 THEN RAISE EXCEPTION 'projection did not restore anchor minimum'; END IF;
 UPDATE cash_games SET enabled=false WHERE id=g;
 IF fn_cash_lightning_always_on(g) THEN RAISE EXCEPTION 'disabled canonical policy still always_on'; END IF;
 UPDATE cash_games SET enabled=true,template_name='classic' WHERE id=g;
 IF fn_cash_lightning_always_on(g) THEN RAISE EXCEPTION 'Classic incorrectly always_on'; END IF;
 UPDATE cash_games SET template_name='madness' WHERE id=g;
 INSERT INTO lightning_cluster_drain(cluster_id,completed_at) VALUES(g,NULL);
 IF fn_cash_lightning_always_on(g) THEN RAISE EXCEPTION 'explicit drain overridden by always_on'; END IF;
END $transition$;

