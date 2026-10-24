DO $test$
DECLARE n int; a int[]; d jsonb; g uuid:='10000000-0000-4000-8000-000000000001'; i uuid; h uuid; p uuid; slot uuid; sess uuid; cps uuid; result jsonb;
BEGIN
 FOR n IN 0..4 LOOP
  a:=fn_lightning_formation_sizes(n,2,9,9,now()-interval '1 day',now());
  IF cardinality(a)<>0 THEN RAISE EXCEPTION 'under-five group: % -> %',n,a; END IF;
 END LOOP;
 IF fn_lightning_formation_sizes(5,2,9,9,now()-interval '2999 milliseconds',now())<>ARRAY[]::int[] THEN RAISE EXCEPTION 'fifth released early'; END IF;
 IF fn_lightning_formation_sizes(5,2,9,9,now()-interval '3 seconds',now())<>ARRAY[5] THEN RAISE EXCEPTION 'fifth not released at deadline'; END IF;
 IF fn_lightning_formation_sizes(6,2,9,9,now(),now())<>ARRAY[6] THEN RAISE EXCEPTION 'six not immediate'; END IF;
 IF fn_lightning_formation_sizes(11,2,9,9,now(),now())<>ARRAY[6] THEN RAISE EXCEPTION 'fresh remainder released early'; END IF;
 IF fn_lightning_formation_sizes(11,2,9,9,now()-interval '3 seconds',now())<>ARRAY[6,5] THEN RAISE EXCEPTION 'aged remainder not released'; END IF;
 IF cardinality(fn_lightning_formation_sizes(5,5,6,6,NULL,now()))<>0 THEN RAISE EXCEPTION 'unknown fifth-ready time treated as ready'; END IF;
 FOREACH d IN ARRAY ARRAY[fn_cash_template_defaults('action','nlh'),fn_cash_template_defaults('madness','plo4'),fn_cash_template_defaults('lightning','plo6')] LOOP
  IF d->>'template'<>'madness' OR d->>'regular_ante'<>'bb' OR (d->>'vpip_floor')::int<>40 OR d->'seat_choices'<>'[6]'::jsonb THEN RAISE EXCEPTION 'Lightning vocabulary/defaults disagree: %',d; END IF;
 END LOOP;
 d:=fn_cash_template_defaults('classic','nlh');
 IF d->>'regular_ante'<>'none' OR (d->>'vpip_floor')::int<>0 OR d->'bombs'->>'enabled'<>'false' THEN RAISE EXCEPTION 'Classic changed'; END IF;
 INSERT INTO cash_games(id,template_name,ruleset_snapshot,variant,sb,bb,name) VALUES(g,'madness','{}','nlh',0.25,0.50,'Lightning Games');
 INSERT INTO cash_cluster_epoch VALUES(g,1,NULL);
 FOR n IN 2..7 LOOP
  i:=gen_random_uuid();h:=gen_random_uuid();
  INSERT INTO lightning_instance VALUES(i,'reserved',h,g,1,now()+interval '10 minutes',now(),NULL);
  INSERT INTO lightning_hand VALUES(h,now(),n);
  FOR seat IN 1..n LOOP
   p:=gen_random_uuid();slot:=gen_random_uuid();sess:=gen_random_uuid();cps:=gen_random_uuid();
   INSERT INTO cash_player_session VALUES(cps,NULL);
   INSERT INTO lightning_pool_session VALUES(sess,g,1,p,gen_random_uuid(),cps,NULL);
   INSERT INTO lightning_pool_slot VALUES(slot,sess,g,p,NULL,now()-interval '10 seconds');
   INSERT INTO lightning_hand_player VALUES(h,p,seat,slot);
   INSERT INTO lightning_reservation VALUES(i,'committed',p,seat);
  END LOOP;
  result:=fn_lightning_instance_begin_dealing(i);
  IF n BETWEEN 5 AND 6 THEN
   IF result->>'dealing'<>'true' THEN RAISE EXCEPTION 'valid group refused: % %',n,result; END IF;
  ELSE
   IF result->>'reason'<>'FIVE_READY_PLAYERS_REQUIRED' OR result->>'dealing'<>'false' THEN RAISE EXCEPTION 'invalid group released: % %',n,result; END IF;
   IF (SELECT state FROM lightning_instance WHERE id=i)<>'reserved' THEN RAISE EXCEPTION 'refused group mutated'; END IF;
  END IF;
 END LOOP;
END $test$;
