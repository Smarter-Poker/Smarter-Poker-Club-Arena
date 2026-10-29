import json

def qualify_abort(e,db,root,hand):
 capture=json.loads((root/'scripts/ci/fixtures/played-clock-floor/abort-preimage.json').read_text())
 resolver=json.loads((root/'scripts/ci/fixtures/played-clock-floor/resolver-preimage.json').read_text())
 resolver['signature']='public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)'
 e.sql(db,hand.captured_function(resolver),label='current-blind-resolver')
 capture['signature']='public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'
 e.sql(db,hand.captured_function(capture),label='current-generation-abort')
 seed="""BEGIN;SET LOCAL session_replication_role=replica;
 UPDATE engine_maintenance_break SET enforce_freeze=false;
 UPDATE smarter_private.f06_hand_permits SET state='accepted',evidence_id='88888888-0000-4000-8000-000000000001'
  WHERE table_id='f855c60a-8223-4e83-88ae-8e32191f5c46';
 INSERT INTO hand_history(id,tournament_id,table_id,hand_number,started_at,ended_at,created_at,small_blind,big_blind)
 VALUES('99999999-0000-4000-8000-000000000001','853b3df9-9e15-4d05-97b1-7a38dd0345c1',
  'f855c60a-8223-4e83-88ae-8e32191f5c46',51229078,clock_timestamp()-interval '30 seconds',clock_timestamp(),clock_timestamp(),1000,2000);
 COMMIT;"""
 def invoke(expected,preserve=False):
  return """BEGIN;SELECT set_config('request.jwt.claim.role','service_role',true);SELECT set_config('app.smarter_data_actor','service',true);
DO $$DECLARE r jsonb;before_anchor timestamptz;after_anchor timestamptz;BEGIN SELECT level_started_at INTO before_anchor FROM tournaments WHERE id='853b3df9-9e15-4d05-97b1-7a38dd0345c1';r:=public.fn_f06_abort_abandoned_generation('853b3df9-9e15-4d05-97b1-7a38dd0345c1',
'c6b911a0-0847-4bbf-82a5-f40fb5b915fd','aaaaaaaa-0000-4000-8000-000000000001',
'Native clock regression: original lower-stakes hand completed after higher played level',false);
IF (SELECT current_level FROM tournaments WHERE id='853b3df9-9e15-4d05-97b1-7a38dd0345c1')<>"""+str(expected)+""" THEN RAISE EXCEPTION 'CLOCK_FLOOR_WRONG_LEVEL:%',r; END IF;
"""+("IF (SELECT level_started_at FROM tournaments WHERE id='853b3df9-9e15-4d05-97b1-7a38dd0345c1') IS DISTINCT FROM before_anchor THEN RAISE EXCEPTION 'CLOCK_FLOOR_CHANGED_RETAINED_ANCHOR';END IF;" if preserve else '')+"""
SELECT level_started_at INTO after_anchor FROM tournaments WHERE id='853b3df9-9e15-4d05-97b1-7a38dd0345c1';
r:=public.fn_f06_abort_abandoned_generation('853b3df9-9e15-4d05-97b1-7a38dd0345c1','c6b911a0-0847-4bbf-82a5-f40fb5b915fd','aaaaaaaa-0000-4000-8000-000000000001','Native clock regression: original lower-stakes hand completed after higher played level',false);
IF r->>'replayed' IS DISTINCT FROM 'true' OR (SELECT level_started_at FROM tournaments WHERE id='853b3df9-9e15-4d05-97b1-7a38dd0345c1') IS DISTINCT FROM after_anchor THEN RAISE EXCEPTION 'CLOCK_FLOOR_REPLAY_CHANGED_CLOCK';END IF;
END $$;ROLLBACK;"""
 old=e.database(db);e.sql(old,seed,label='older-river-predecessor-opening')
 code,_,err=e.sql(old,invoke(15),label='older-river-predecessor-regression',check=False)
 if not code or 'CLOCK_FLOOR_WRONG_LEVEL' not in err or '"to_level": 14' not in err:raise RuntimeError('predecessor failed before clock selection:'+err)
 e.report['abort_failed_before']=True;e.discard(old)
 from satellite_qualifier_fixture import module
 builder=module(root/'scripts/ci/build-played-level-recovery-migration.py','played_clock_builder')
 if builder.render()!=(root/builder.MIGRATION).read_text():raise RuntimeError('clock migration source differs')
 e.report['abort_installation_refusals']=[]
 for label,mutation in [
  ('body',"ALTER FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) SET search_path=public;"),
  ('acl',"GRANT EXECUTE ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) TO anon;"),
 ]:
  case=e.database(db);e.sql(case,mutation,label='clock-drift-'+label)
  baseline=(e.snapshot(case,label+'-install-before'),e.catalog_snapshot(case,label+'-install-catalog-before'),hand.private_snapshot(e,case,label+'-install-private-before'))
  code,_,error=e.sql(case,file=root/builder.MIGRATION,label='clock-install-refusal-'+label,check=False)
  if not code or 'PLAYED_CLOCK_OWNER_PREIMAGE_CHANGED' not in error:raise RuntimeError('installation drift was not refused:'+label)
  if baseline!=(e.snapshot(case,label+'-install-after'),e.catalog_snapshot(case,label+'-install-catalog-after'),hand.private_snapshot(e,case,label+'-install-private-after')):raise RuntimeError('installation refusal changed catalog/data:'+label)
  e.report['abort_installation_refusals'].append(label);e.discard(case)
 e.sql(db,file=root/builder.MIGRATION,label='candidate-generation-abort')
 e.report['abort_cases']=[]
 for label,level,mutation,expected in [
  ('restore-last-played',16,'',15),
  ('preserve-restored',15,'',15),
  ('legitimate-backward',16,"DELETE FROM hand_history WHERE big_blind=2500;",14),
  ('preserve-current-played',16,"UPDATE hand_history SET big_blind=3000,small_blind=1500 WHERE hand_number=51233523;",16),
  ('repeated-unplayed-pair',16,"UPDATE tournaments SET blind_structure=jsonb_set(blind_structure::jsonb,'{16}',jsonb_build_object('level',17,'smallBlind',1250,'bigBlind',2500,'ante',0,'durationMinutes',8))::text WHERE id='853b3df9-9e15-4d05-97b1-7a38dd0345c1';",15),
  ('preserve-scheduled-break',16,"UPDATE tournaments SET on_break=true WHERE id='853b3df9-9e15-4d05-97b1-7a38dd0345c1';",16),
 ]:
  case=e.database(db);e.sql(case,seed,label=label+'-opening')
  e.sql(case,"BEGIN;SET LOCAL session_replication_role=replica;UPDATE tournaments SET current_level="+str(level)+",blind_level_state=jsonb_build_object('index',"+str(level)+",'small_blind',CASE WHEN "+str(level)+"=15 THEN 1250 ELSE 1500 END,'big_blind',CASE WHEN "+str(level)+"=15 THEN 2500 ELSE 3000 END,'ante',0) WHERE id='853b3df9-9e15-4d05-97b1-7a38dd0345c1';"+mutation+'COMMIT;',label=label+'-state')
  baseline=(e.snapshot(case,label+'-before'),hand.private_snapshot(e,case,label+'-private-before'))
  e.sql(case,invoke(expected,expected==level),label=label+'-proof')
  if baseline!=(e.snapshot(case,label+'-after'),hand.private_snapshot(e,case,label+'-private-after')):raise RuntimeError('abort rollback changed state:'+label)
  e.report['abort_cases'].append(label);e.discard(case)


def qualify(e,root,hand):
 # A separate real F06 database leaves the continuation fixture untouched.
 db=e.database()
 foundation=(e.output/'foundation.sql').read_text()
 roles='CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE supabase_auth_admin;'
 if foundation.count(roles)!=1:raise RuntimeError('foundation role declaration changed')
 # The combined lane has already created these cluster-wide roles in its
 # first database. Reuse only the exact original attributes, never another
 # role identity or application owner. Standalone qualification creates them.
 declarations="DO $clock_roles$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['anon','authenticated','service_role','supabase_auth_admin'] LOOP IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n) THEN EXECUTE 'CREATE ROLE '||quote_ident(n)||CASE WHEN n='service_role' THEN ' BYPASSRLS' ELSE '' END; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolcanlogin AND NOT rolreplication AND rolinherit AND rolbypassrls=(n='service_role')) THEN RAISE EXCEPTION 'CLOCK_NATIVE_ROLE_CHANGED:%',n; END IF; END LOOP; END $clock_roles$;"
 e.sql(db,foundation.replace(roles,declarations),label='foundation',seconds=180)
 e.sql(db,file=e.output/'current-authorities.sql',label='f06')
 e.sql(db,file=root/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='opening-template')
 e.sql(db,file=root/hand.MIGRATION,label='real-retained-submission-owner')
 custody=(root/'supabase/migrations/20260918232558_mixed_f06_custody_transfer_retains_original_operations.sql').read_text()
 transfers=custody[custody.index('CREATE TABLE smarter_private.f06_manager_custody_transfers'):custody.index('-- Admission binds the real lease row')]
 completions=custody[custody.index('CREATE TABLE smarter_private.f06_manager_custody_completions'):custody.index('CREATE TABLE smarter_private.f06_manager_custody_intents')]
 e.sql(db,transfers+completions+"ALTER TABLE smarter_private.f06_manager_custody_completions ENABLE ROW LEVEL SECURITY; REVOKE ALL ON smarter_private.f06_manager_custody_completions FROM PUBLIC,anon,authenticated,service_role; CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON smarter_private.f06_manager_custody_completions FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_manager_transfer_immutable();",label='actual-empty-custody-read-shapes')
 for shape in json.loads((root/'scripts/ci/fixtures/played-clock-floor/empty-read-shapes.json').read_text()):
  name='public.'+shape['relation'];cols=[]
  for c in shape['columns']:
   cols.append('"'+c['name']+'" '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '')+(' NOT NULL' if c['notnull'] else ''))
  ddl='CREATE TABLE '+name+'('+','.join(cols)+');'
  for c in shape['constraints'] or []:ddl+='ALTER TABLE '+name+' ADD CONSTRAINT "'+c['name']+'" '+c['definition']+';'
  if shape['relrowsecurity']:ddl+='ALTER TABLE '+name+' ENABLE ROW LEVEL SECURITY;'
  ddl+='ALTER TABLE '+name+' OWNER TO '+shape['owner']+';REVOKE ALL ON '+name+' FROM PUBLIC,anon,authenticated,service_role,postgres;'
  rights={'a':'INSERT','r':'SELECT','w':'UPDATE','d':'DELETE','D':'TRUNCATE','x':'REFERENCES','t':'TRIGGER','m':'MAINTAIN'}
  for grant in shape['acl'].strip('{}').split(','):
   role,raw=grant.split('=');letters=raw.split('/')[0]
   if '*' in letters:raise RuntimeError('unexpected grant option in captured read shape')
   ddl+='GRANT '+','.join(rights[c] for c in letters)+' ON '+name+' TO '+(role or 'PUBLIC')+';'

  e.sql(db,ddl,label='captured-empty-read-'+shape['relation'])
 e.sql(db,'ALTER TABLE public.tournaments ADD COLUMN format_contract text;',label='current-nullable-format-contract')
 e.sql(db,'BEGIN;'+(e.output/'opening.sql').read_text()+'\n'+(root/'scripts/ci/fixtures/played-clock-floor/opening.sql').read_text()+'COMMIT;',label='clock-opening')
 qualify_abort(e,db,root,hand)
 e.discard(db)
