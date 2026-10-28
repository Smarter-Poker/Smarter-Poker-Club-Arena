ALTER TABLE hand_atomic_commits ADD COLUMN hand_id uuid, ADD COLUMN committed_at timestamptz,
 ADD COLUMN post_commit_completed_at timestamptz, ADD COLUMN post_commit_result jsonb, ADD COLUMN stack_result jsonb;
CREATE FUNCTION fixture_postflop() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('addon-event')::uuid; tab uuid; hid uuid; uid uuid; sid uuid; j integer; k integer; n integer; stage text; stacks jsonb;
BEGIN
 TRUNCATE table_seats,tournament_players,table_hole_cards,hand_history,smarter_private.f06_hand_permits;
 FOR k IN 1..3 LOOP
  tab:=CASE WHEN k=3 THEN md5('addon-table')::uuid ELSE md5('preflop-table'||k)::uuid END;
  hid:=md5('prior'||k)::uuid; n:=k+3; stage:=CASE WHEN k=3 THEN 'river' ELSE 'preflop' END;
  INSERT INTO tables(id,tournament_id,is_deleted,status,f06_lifecycle) VALUES(tab,t,false,'running',md5('life'||k)::uuid) ON CONFLICT(id) DO UPDATE SET f06_lifecycle=excluded.f06_lifecycle;
  FOR j IN 1..n LOOP
   uid:=CASE WHEN k=3 AND j<=2 THEN md5('addon-user'||j)::uuid ELSE md5('player'||k||'-'||j)::uuid END;
   sid:=md5('chair'||k||'-'||j)::uuid;
   INSERT INTO table_seats VALUES(sid,tab,md5('occupancy'||k||'-'||j)::uuid,uid,j,3000,NULL,now()-interval '1 hour');
   INSERT INTO tournament_players VALUES(md5('reg'||k||'-'||j)::uuid,t,tab,uid,j,'playing',3000,false);
   INSERT INTO table_hole_cards VALUES(tab,11,uid);
  END LOOP;
  INSERT INTO hand_history(id,table_id,tournament_id,hand_number,created_at,players)
   SELECT hid,tab,t,10,now()-interval '30 minutes',jsonb_agg(jsonb_build_object('userId',user_id,'stack',stack)) FROM table_seats WHERE table_id=tab;
  SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack',stack)) INTO stacks FROM table_seats WHERE table_id=tab;
  INSERT INTO hand_atomic_commits VALUES(tab,10,hid,now()-interval '30 minutes',now()-interval '29 minutes',jsonb_build_object('ok',true,'hand_id',hid,'hand_number',10),
   jsonb_build_object('success',true,'mode','delta','conservation_checked',true,'tournament_players_synced',true,'table_id',tab,'tournament_id',t,'hand_number',10,
   'written',(SELECT jsonb_object_agg(user_id,stack) FROM table_seats WHERE table_id=tab),'request',jsonb_build_object('stacks',stacks)));
  INSERT INTO hand_state_snapshots SELECT md5('snapshot'||k)::uuid,tab,11,false,stage,
   jsonb_build_object('stage',stage,'pot',n*300,'actionHistory','[]'::jsonb,'players',
    (SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat',seat_number,'stack',2700,'totalInvested',300,'deadInvested',0,'returnedUncalled',0)) FROM table_seats WHERE table_id=tab)),
   '{"gameVariant":"plo5","smallBlind":1,"bigBlind":2}'::jsonb,now()-interval '10 minutes';
  INSERT INTO smarter_private.f06_hand_permits VALUES(CASE WHEN k=3 THEN md5('addon-permit')::uuid ELSE md5('permit'||k)::uuid END,t,tab,md5('old-generation')::uuid,'reserved',NULL,md5('life'||k)::uuid,11);
  IF k IN (1,3) THEN
   FOR j IN 1..CASE WHEN k=1 THEN 2 ELSE 1 END LOOP
    uid:=CASE WHEN k=3 THEN md5('late')::uuid ELSE md5('late'||k||'-'||j)::uuid END;
    INSERT INTO table_seats VALUES(md5('late-chair'||k||'-'||j)::uuid,tab,md5('late-occ'||k||'-'||j)::uuid,uid,n+j,3000,NULL,now());
    INSERT INTO tournament_players VALUES(md5('late-reg'||k||'-'||j)::uuid,t,tab,uid,n+j,'playing',3000,false);
   END LOOP;
  END IF;
 END LOOP;
END $$;
