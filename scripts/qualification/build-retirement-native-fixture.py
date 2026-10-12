"""Build scoped synthetic original generations; never imports user/game rows."""
from pathlib import Path
import json, argparse
ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,default=ROOT.parent/'pg-qualification')
OUT=parser.parse_args().output.resolve()
OUT.mkdir(parents=True,exist_ok=True)
manifest=json.loads((ROOT/'scripts/qualification/retirement-original-57-manifest.json').read_text())
if isinstance(manifest,dict):
 manifest=manifest.get('hands',manifest.get('qualifications',manifest.get('manifest')))
if not isinstance(manifest,list) or len(manifest)!=57:raise ValueError('exact source57 required')
counts=[len(x['rows']) for x in manifest]
assert sum(counts)==66
body=r'''
SET request.jwt.claim.role='service_role';
SET request.jwt.claims='{"role":"service_role"}';
BEGIN;
CREATE FUNCTION retirement_native.fixture_id(kind integer,n integer) RETURNS uuid
 LANGUAGE sql IMMUTABLE AS $$SELECT ('97'||lpad(kind::text,6,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
CREATE TABLE retirement_native.cases(i integer PRIMARY KEY,table_id uuid,tournament_id uuid,submission_id uuid,original_generation uuid,successor_generation uuid,affected integer,dealt integer);
COMMIT;
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.clubs SELECT (jsonb_populate_record(NULL::public.clubs,to_jsonb(c)||jsonb_build_object('id','a0000000-0000-0000-0000-000000000001','club_id',93482,'name','Synthetic legacy house board'))).* FROM public.clubs c WHERE id='20000000-0000-0000-0000-000000000001';
DO $seed$
DECLARE i integer;j integer;event integer;np integer;na integer;uid uuid;tid uuid;eid uuid;
 profile public.profiles;roster public.tournament_players;seat public.table_seats;
 counts integer[]:=ARRAY[COUNTS];
BEGIN
 FOR i IN 1..57 LOOP
  event:=CASE WHEN i<=4 THEN 1 ELSE i-3 END;
  na:=counts[i];np:=CASE WHEN i<=53 THEN 3 ELSE 2 END;
  tid:=retirement_native.fixture_id(1,i);eid:=retirement_native.fixture_id(2,event);
  INSERT INTO retirement_native.cases VALUES(i,tid,eid,retirement_native.fixture_id(3,i),retirement_native.fixture_id(4,event),retirement_native.fixture_id(5,event),na,np);
  INSERT INTO public.tournaments
  SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object('id',eid,'name','Retirement original synthetic event '||event,'status','RUNNING','format_contract','mtt-v1','started_at','2026-09-08T12:00:00+00:00','start_time','2026-09-08T12:00:00+00:00','created_at','2026-09-08T11:00:00+00:00','current_players',12,'max_players',60,'current_level',1,'club_id','a0000000-0000-0000-0000-000000000001'))).* FROM public.tournaments t WHERE id='86000000-0000-0000-0000-000000000001' ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,game_variant,club_id,max_players,seat_game_scope,seat_admission_key,small_blind,big_blind) VALUES(tid,'Retirement original synthetic table '||i,eid,'running',NULL,np,'tournament','nlh','a0000000-0000-0000-0000-000000000001',6,'table:'||tid,'tournament:'||eid,1,2);
  INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,lease_generation,protocol_version,heartbeat_at)
   VALUES(eid,'synthetic-original',retirement_native.fixture_id(4,event),2,clock_timestamp()) ON CONFLICT(tournament_id) DO NOTHING;
  FOR j IN 1..np LOOP
   uid:=retirement_native.fixture_id(6,i*10+j);
   INSERT INTO auth.users(id) VALUES(uid);
   INSERT INTO public.users(id,username) VALUES(uid,'retirement_synthetic_'||i||'_'||j);
   INSERT INTO public.profiles(id,username,display_name,is_horse,status,horse_status) VALUES(uid,'retirement_synthetic_'||i||'_'||j,'Synthetic paid entrant',true,'active','active');
   INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES('a0000000-0000-0000-0000-000000000001',uid,'player','active',0);
   INSERT INTO public.tournament_players
   SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(tp)||jsonb_build_object('id',retirement_native.fixture_id(7,i*10+j),'tournament_id',eid,'user_id',uid,'chips',100,'status','playing','table_id',tid,'seat_number',j,'position',NULL,'prize',0,'eliminated_at',NULL,'elimination_sequence',NULL,'add_on',(i=57 AND j=1),'rebuys',0))).* FROM public.tournament_players tp WHERE id='86200000-0000-0000-0000-000000000001';
   INSERT INTO public.table_seats
   SELECT (jsonb_populate_record(NULL::public.table_seats,to_jsonb(s)||jsonb_build_object('club_id','a0000000-0000-0000-0000-000000000001','id',retirement_native.fixture_id(8,i*10+j),'table_id',tid,'user_id',uid,'seat_number',j,'stack',100,'left_at',NULL,'status','active','joined_at','2026-09-08T12:00:00+00:00','occupancy_id',retirement_native.fixture_id(9,i*10+j),'is_sitting_out',false,'active_game_scope','table:'||tid,'active_parent_key','tournament:'||eid))).* FROM public.table_seats s WHERE id='86300000-0000-0000-0000-000000000001';
  END LOOP;
 END LOOP;
END $seed$;
SET LOCAL session_replication_role=origin;
COMMIT;
BEGIN;
CREATE TRIGGER zz_retirement_original_failure BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION retirement_native.submission_fault();
DO $retention$
DECLARE c retirement_native.cases;q jsonb;stacks jsonb;players jsonb;tb jsonb;r jsonb;
BEGIN
 FOR c IN SELECT * FROM retirement_native.cases ORDER BY i LOOP
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id',c.tournament_id::text,true);
  PERFORM set_config('app.smarter_tournament_lease_generation',c.original_generation::text,true);
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=c.tournament_id;
  INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state)
   VALUES(retirement_native.fixture_id(10,c.i),c.tournament_id,c.table_id,1,9700000+c.i,retirement_native.fixture_id(11,c.i),c.original_generation,'reserved');
  INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json,stage)
   VALUES(c.table_id,9700000+c.i,'{"stage":"river"}','{}',1,'[]','river');
  SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'seat_joined_at',s.joined_at,'stack_before',100,'stack',CASE s.seat_number WHEN 1 THEN 99 WHEN 2 THEN 101 ELSE 100 END) ORDER BY s.seat_number),
   jsonb_agg(jsonb_build_object('user_id',s.user_id,'stack',CASE s.seat_number WHEN 1 THEN 99 WHEN 2 THEN 101 ELSE 100 END) ORDER BY s.seat_number),
   jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'seat_joined_at',s.joined_at,'uses_remaining',3,'seconds_remaining',17) ORDER BY s.seat_number)
   INTO stacks,players,tb FROM public.table_seats s WHERE s.table_id=c.table_id;
  q:=jsonb_build_object('p_table_id',c.table_id,'p_hand_number',9700000+c.i,'p_stacks',stacks,'p_rake',0,'p_bbj',0,'p_ref','retirement-synthetic-original','p_inflow',0,'p_units','[]'::jsonb,'p_instance_id','synthetic-original','p_lease_generation',c.original_generation,
   'p_hand_row',jsonb_build_object('id',c.submission_id,'table_id',c.table_id,'tournament_id',c.tournament_id,'hand_number',9700000+c.i,'started_at','2026-09-08T12:00:02+00:00','ended_at','2026-09-08T12:00:03+00:00','game_variant','nlh','small_blind',1,'big_blind',2,'pot_size',2,'rake_amount',0,'bbj_amount',0,'players',players,'actions','[]'::jsonb,'winners',jsonb_build_array(jsonb_build_object('user_id',retirement_native.fixture_id(6,c.i*10+2),'amount',2)),'_accepted_post_commit_facts',jsonb_build_object('contributions',jsonb_build_object(retirement_native.fixture_id(6,c.i*10+1)::text,1,retirement_native.fixture_id(6,c.i*10+2)::text,1),'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb)),
   'p_post_commit_obligations',jsonb_build_object('version','1','time_banks',tb,'promo_playthrough','[]'::jsonb,'insurance','[]'::jsonb,'pending_addons',NULL,'rake',NULL,'bbj_contribution',NULL));
  r:=public.fn_ca_retain_hand_submission(q);
  IF r->>'retained' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'synthetic original not retained %',r; END IF;
  r:=public.fn_ca_commit_hand_submission(c.submission_id,'synthetic-original',c.original_generation);
  IF r->>'success' IS DISTINCT FROM 'false' OR (r->>'error' IS DISTINCT FROM 'isolated accepted-hand storage interruption' AND r->>'sqlstate' IS DISTINCT FROM 'XX000') OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=c.table_id) THEN RAISE EXCEPTION 'original fault not atomic %',r; END IF;
 END LOOP;
END $retention$;
DROP TRIGGER zz_retirement_original_failure ON public.hand_projection_outbox;
COMMIT;
BEGIN;
SET LOCAL session_replication_role=replica;
DO $force$
DECLARE c retirement_native.cases;j integer;uid uuid;
BEGIN
 FOR c IN SELECT * FROM retirement_native.cases ORDER BY i LOOP
  FOR j IN 1..c.affected LOOP
   uid:=retirement_native.fixture_id(6,c.i*10+j);
   UPDATE public.profiles SET status='deleted',horse_status='disabled' WHERE id=uid;
   INSERT INTO smarter_private.patterned_identity_retirements(old_id,cohort,username_before,display_name_before,full_name_before,alias_before,avatar_url_before,arena_avatar_url_before,cover_photo_url_before,bio_before,status_text_before,status_before,is_online_before,horse_status_before,users_username_before,users_avatar_url_before,tombstone,benched_at,retired_at)
    VALUES(uid,'horse','synthetic','synthetic','','','','','','','','active',false,'active','synthetic','','synthetic','2026-10-06 15:07:13Z','2026-10-06 15:41:00Z');
   UPDATE public.tournament_players SET status='eliminated',eliminated_at='2026-10-06 15:33:05Z' WHERE tournament_id=c.tournament_id AND user_id=uid;
   UPDATE public.table_seats SET left_at='2026-10-06 15:33:04.8Z',status='left',is_sitting_out=true,active_game_scope=NULL,active_parent_key=NULL WHERE table_id=c.table_id AND user_id=uid;
  END LOOP;
 END LOOP;
 UPDATE public.engine_tournament_leases l SET instance_id='synthetic-successor',lease_generation=cx.successor_generation,heartbeat_at=clock_timestamp() FROM retirement_native.cases cx WHERE l.tournament_id=cx.tournament_id;
END $force$;
SET LOCAL session_replication_role=origin;
COMMIT;
'''.replace('COUNTS',','.join(map(str,counts)))
(OUT/'cohort-native-opening.sql').write_text(body)
print(json.dumps({'cases':57,'affected':sum(counts),'dealt':53*3+4*2,'events':54,'same_event_tables':4,'bytes':len(body)}))
