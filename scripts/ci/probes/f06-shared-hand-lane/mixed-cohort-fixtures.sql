-- Isolated native snapshot-backed successor cohorts. No production IDs/data.
-- MTT has 30 old snapshots + one current prior-backed reserved hand, two
-- accepted siblings and one quiet table. Roster cardinalities follow the retained
-- 07:03 census (263 occupants); identities are synthetic. The current prior
-- receipt has nine exact occupants and 55,000 committed chips. Both Spin cohorts
-- retain one old snapshot-backed hand with a new lease.
DO $$DECLARE i integer;k integer;j integer;n integer;players integer;st numeric;t uuid;tab uuid;g uuid;u uuid;hn bigint;
payload jsonb:='{"version":1,"accepted_hand_facts":{},"pending_addons":{"ids":[]}}';
stacks jsonb;written jsonb;chips jsonb;
BEGIN FOR i IN 201..203 LOOP
  t:=md5('mct'||i)::uuid;g:=md5('mc-current'||i)::uuid;
  n:=CASE WHEN i=201 THEN 34 ELSE 1 END;
  -- This stale display counter must not replace exact playing/occupancy proof.
  INSERT INTO tournaments(id,status,format_contract,table_size,current_players)
    VALUES(t,'RUNNING',CASE WHEN i=201 THEN 'mtt-v1' ELSE 'spin-v1' END,
      CASE WHEN i=201 THEN 9 ELSE 3 END,CASE WHEN i=201 THEN 297 ELSE 3 END);
  INSERT INTO engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
    VALUES(t,'mixed-cohort-owner','fixed-post-cutover',now(),now(),g,2);
  FOR k IN 1..n LOOP
    tab:=md5('mctab'||i||':'||k)::uuid;hn:=3000000+i*100+k;
    INSERT INTO tables(id,tournament_id,status,max_players) VALUES(tab,t,'running',CASE WHEN i=201 THEN 9 ELSE 3 END);
    players:=CASE WHEN i=202 THEN 3 WHEN i=203 THEN 2 WHEN k<=30 THEN
     (ARRAY[7,9,9,8,6,8,7,7,8,9,8,6,8,8,9,8,6,9,8,9,8,7,9,8,9,6,9,7,8,9])[k]
     WHEN k=31 THEN 9 WHEN k=32 THEN 6 WHEN k=33 THEN 9 ELSE 2 END;
   FOR j IN 1..players LOOP
      u:=md5('mcu'||i||':'||k||':'||j)::uuid;
      st:=CASE WHEN i=201 AND k=31 THEN (ARRAY[4954,14495,5027,3944,10180,3121,3310,4729,5240])[j] ELSE 1000 END;
      INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,left_at,terminal_closed_at,occupancy_id,joined_at)
        VALUES(md5('mcs'||i||':'||k||':'||j)::uuid,tab,u,j,st,NULL,NULL,
          md5('mco'||i||':'||k||':'||j)::uuid,'2026-09-18 00:00:00+00');
      INSERT INTO tournament_players(id,tournament_id,table_id,user_id,seat_number,chips,status)
        VALUES(md5('mcr'||i||':'||k||':'||j)::uuid,t,tab,u,j,st,'playing');
    END LOOP;
    IF i<>201 OR k<>33 THEN
      IF i<>201 OR k<>31 THEN
      INSERT INTO hand_state_snapshots(table_id,hand_number,stage,state_json,is_complete)
      SELECT tab,hn,'preflop',jsonb_build_object('stage','preflop','pot',270,'players',
        jsonb_agg(jsonb_build_object('user_id',user_id,'seat',seat_number,
          'stack',stack-CASE seat_number WHEN 1 THEN 50 WHEN 2 THEN 220 ELSE 0 END,
          'totalInvested',CASE seat_number WHEN 1 THEN 50 WHEN 2 THEN 220 ELSE 0 END,
          'deadInvested',CASE seat_number WHEN 2 THEN 120 ELSE 0 END,
          'individualAnteInvested',0,'returnedUncalled',0) ORDER BY seat_number)),false
        FROM table_seats WHERE table_id=tab;
     ELSE
       SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,
           'stack',stack,'stack_before',stack) ORDER BY user_id),jsonb_object_agg(user_id::text,stack),
         jsonb_agg(jsonb_build_object('user_id',user_id,'chips',stack) ORDER BY user_id)
         INTO stacks,written,chips FROM table_seats WHERE table_id=tab;
       INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result,
         payload_hash,stack_result,committed_at,post_commit_payload,post_commit_request_hash,post_commit_payload_hash)
         VALUES(tab,hn-100,md5('mc-prior-atomic')::uuid,'2026-09-18 00:01:01+00',
           jsonb_build_object('ok',true,'hand_id',md5('mc-prior-atomic')::uuid,'hand_number',hn-100),repeat('b',64),
           jsonb_build_object('success',true,'mode','delta','table_id',tab,'tournament_id',t,'hand_number',hn-100,
             'hand_id',md5('mc-prior-stack')::uuid,'conservation_checked',true,'tournament_players_synced',true,
             'rebased','{}'::jsonb,'departed','[]'::jsonb,'players',players,'tournament_player_count',players,
             'net_deltas',0,'inflow',0,'rake',0,'bbj',0,'request',jsonb_build_object('stacks',stacks),
             'written',written,'tournament_player_chips',chips),'2026-09-18 00:01:00+00',payload,
           encode(extensions.digest(convert_to(((payload-'accepted_hand_facts')#-'{pending_addons,ids}')::text,'UTF8'),'sha256'),'hex'),
           encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'));
       INSERT INTO hand_history(id,table_id,hand_number) VALUES(md5('mc-prior-atomic')::uuid,tab,hn-100);
     END IF;
     INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id)
        SELECT md5('mcp'||i||':'||k)::uuid,t,tab,f06_lifecycle,hn,md5('mchc'||i||':'||k)::uuid,
          CASE WHEN i=201 AND k=31 THEN g ELSE md5('mc-old'||i)::uuid END,'reserved',NULL
        FROM tables WHERE id=tab;
      IF i=201 AND k IN(32,34) THEN
        INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result)
          VALUES(tab,hn,md5('mch'||k)::uuid,now(),jsonb_build_object('ok',true));
        INSERT INTO hand_history(id,table_id,hand_number) VALUES(md5('mch'||k)::uuid,tab,hn);
        UPDATE hand_state_snapshots SET is_complete=true WHERE table_id=tab;
      END IF;
    END IF;
    IF (i=201 AND k=34) OR i>201 THEN
      INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation)
        SELECT md5('mcpark'||i)::uuid,t,tab,f06_lifecycle,md5('mcb'||i)::uuid,md5('mc-old'||i)::uuid
        FROM tables WHERE id=tab;
    END IF;
  END LOOP;
END LOOP;END $$;
INSERT INTO fixture_expected_inputs(i,expected)
  SELECT i,fixture_expected_mixed(md5('mct'||i)::uuid) FROM generate_series(201,203) i;

-- Alternate actually started current hand; callers wrap this shape in rollback.
CREATE FUNCTION fixture_mixed_cohort_current_snapshot() RETURNS void LANGUAGE sql AS $$
 INSERT INTO hand_state_snapshots(table_id,hand_number,stage,state_json,is_complete)
 SELECT md5('mctab201:31')::uuid,3020131,'preflop',jsonb_build_object('stage','preflop','pot',270,
   'players',jsonb_agg(jsonb_build_object('user_id',user_id,'seat',seat_number,
     'stack',stack-CASE seat_number WHEN 1 THEN 50 WHEN 2 THEN 220 ELSE 0 END,
     'totalInvested',CASE seat_number WHEN 1 THEN 50 WHEN 2 THEN 220 ELSE 0 END,
     'deadInvested',CASE seat_number WHEN 2 THEN 120 ELSE 0 END,'individualAnteInvested',0,'returnedUncalled',0)
     ORDER BY seat_number)),false FROM table_seats WHERE table_id=md5('mctab201:31')::uuid;
$$;
