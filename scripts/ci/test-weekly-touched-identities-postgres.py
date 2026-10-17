#!/usr/bin/env python3
"""PG17: actual touched queries/helpers, independent event oracle, callbacks and atomic seal."""
import argparse,json,os,re,shutil,subprocess,tempfile,uuid,hashlib
from pathlib import Path
REPO=Path(__file__).resolve().parents[2]
P=REPO/'scripts/ci/fixtures/weekly-touched-identities'
a=argparse.ArgumentParser();a.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'));a.add_argument('--scratch',required=True);a.add_argument('--migration',type=Path);args=a.parse_args();pg=Path(args.pg_bin)
root=Path(tempfile.mkdtemp(prefix='native-',dir=args.scratch));data=root/'d';started=False
psql=[pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',root,'-U','postgres','-d','postgres']
def run(cmd,sql=None,error=None):
 r=subprocess.run([str(x)for x in cmd],input=sql,text=True,capture_output=True,timeout=60)
 if error:assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else:assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):return run(psql,'SET check_function_bodies=false;'+sql,error)
def raw(name):
 x=json.loads(Path(name).read_text());s=json.loads(x['content'][0]['text'])['result'];return json.loads(s[s.index('\n[')+1:s.index('\n</untrusted')])
def lit(v):return "'"+str(v).replace("'","''")+"'"
def uid(n):return str(uuid.UUID(int=n))
U='fade0000-0000-0000-0000-000000000001';C=uid(5000);USER=uid(6000);A='2026-10-05 07:00Z';B='2026-10-12 07:00Z'
queries={k:(P/f'touched-query-{k}.sql').read_text().replace(' INTO v_bad','').replace('p_start',lit(A)+'::timestamptz').replace('p_end',lit(B)+'::timestamptz').replace('p_union_id',lit(U)+'::uuid')for k in ['before','after']}
def query(k,opened=[],projected=True,counters=False):
 arr='NULL::uuid[]'if opened is None else 'ARRAY['+','.join('NULL::uuid'if v is None else lit(v)+'::uuid'for v in opened)+']::uuid[]'
 s=queries[k].replace('v_inv','true'if projected else'false').replace('v_open_resolved',arr)
 if counters:s=s.replace('public.fn_union_pnl_tournament_in_union','public.native_count_union').replace('public.fn_union_pnl_satellite_seat_owner','public.native_count_seat')
 return s
f=json.loads((REPO/'scripts/ci/fixtures/inventory-proof-lifetime-sources.json').read_text());proof={};cases=[]
try:
 assert ' 17.'in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (data/'postgresql.conf').open('a')as h:h.write("\nlisten_addresses=''\nunix_socket_directories='"+str(root)+"'\nmax_connections=12\nshared_buffers='16MB'\n")
 run([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start']);started=True
 q("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA smarter_private;SET check_function_bodies=false;"+(REPO/'scripts/qualification/original-flow-eligibility/maintenance-type-source.sql').read_text())
 for x in f['functions']+f['prerequisites']:
  d=x['definition']
  if x['signature'].startswith('fn_accounting_close_certificate('):d=d.replace("public.fn_accounting_close_proof_lifetime()","interval '12 hours'")
  q('SET check_function_bodies=false;'+d+';REVOKE ALL ON FUNCTION '+x['signature']+' FROM PUBLIC,postgres,anon,authenticated,service_role;')
  for item in x['acl'].strip('{}').split(','):q('GRANT EXECUTE ON FUNCTION '+x['signature']+' TO '+(item.split('=')[0]or'PUBLIC')+';')
 # Restore authentic sealed ordinary12h getter; full hash is checked below.
 d=(P/'certificate-before.sql').read_text();q(d)
 q("CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text,statements text[]);CREATE TABLE accounting_close_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb,certified_at timestamptz);CREATE TABLE smarter_private.original_inventory_restoration_cases(event_id bigint,source_refs jsonb,family text,original_witness jsonb);CREATE TABLE smarter_private.original_inventory_restoration_certificates(event_id bigint,witness_md5 text,proof_md5 text,boundary timestamptz);INSERT INTO smarter_private.original_inventory_restoration_cases SELECT n,'[]','fixture','{}'FROM generate_series(1,245)n;INSERT INTO smarter_private.original_inventory_restoration_certificates SELECT n,'witness','proof','2026-10-12 07:00Z'FROM generate_series(1,245)n;")
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t','actual original40 must match before candidate'
 oldgen=q('SELECT smarter_private.original_inventory_basis_generation();');assert oldgen.startswith('original-inventory-245-v1:')
 q("CREATE TABLE union_pnl_inventory_touches(source_name text,row_id uuid,event_id bigint,operation text,union_id text,tournament_id text,observed_at timestamptz,frame_observed_at timestamptz);CREATE INDEX touches_week ON union_pnl_inventory_touches(source_name,observed_at);CREATE INDEX touches_identity ON union_pnl_inventory_touches(source_name,row_id,event_id)INCLUDE(operation,union_id);CREATE TABLE union_pnl_inventory_events(source_name text,row_id uuid,event_id bigint,transaction_id bigint,after_row jsonb,before_row jsonb,observed_at timestamptz);CREATE INDEX event_identity ON union_pnl_inventory_events(source_name,row_id,event_id DESC);CREATE TABLE union_pnl_transaction_frames(transaction_id bigint,observed_at timestamptz);CREATE TABLE tournament_participant_funding_receipts(registration_id uuid,tournament_id uuid,user_id uuid,operation text,asset text,amount numeric,funding_club_id uuid,ledger_id uuid,entitlement_id uuid,registration_snapshot jsonb);CREATE INDEX receipt_registration ON tournament_participant_funding_receipts(registration_id);CREATE INDEX receipt_tournament ON tournament_participant_funding_receipts(tournament_id,registration_id);CREATE TABLE tournament_satellite_awards(tournament_id uuid,user_id uuid,delivery_kind text,registration_id uuid,ticket_id uuid);CREATE UNIQUE INDEX award_unique ON tournament_satellite_awards(tournament_id,user_id);CREATE TABLE tournament_satellite_settlements(tournament_id uuid,target_id uuid);CREATE TABLE tournament_tickets(id uuid,holder_id uuid,source_satellite_id uuid,source_tournament_id uuid,status text,redemption_mode text,redeemed_at timestamptz);CREATE TABLE chip_ledger(id uuid,status text,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,tournament_id uuid,amount numeric,club_id uuid,category text,row_hash text);")
 for r in json.loads((P/'actual-touched-helpers.json').read_text()):q(r['definition'])
 # authentic helper hashes must match exactly.
 for sig,h in [('fn_union_pnl_touched_registrations(timestamptz,timestamptz,boolean)','e45d89f53048f070a3ddc9264d1ecdff'),('fn_union_pnl_tournament_in_union(text,uuid,boolean)','e46d1253e8fc17f3fb8616d8a3e13793'),('fn_union_pnl_satellite_seat_owner(uuid,uuid)','9f0aff5616730556aa600d1027920433'),('fn_union_pnl_tournament_entry_club_of(text,numeric,uuid,uuid,uuid,jsonb)','b875ae9c879c65cd1db5ae207af9f3c3')]:assert q('SELECT md5(pg_get_functiondef('+lit(sig)+'::regprocedure));')==h
 event=0
 def reset():q('TRUNCATE union_pnl_inventory_touches,union_pnl_inventory_events,union_pnl_transaction_frames,tournament_participant_funding_receipts,tournament_satellite_awards,tournament_satellite_settlements,tournament_tickets,chip_ledger;')
 def tournament(t,owner=U):
  nonlocal_dummy=None
  global event
  event+=1;q("INSERT INTO union_pnl_inventory_touches VALUES('tournaments',"+lit(t)+','+str(event)+",'UPDATE',"+lit(owner)+',NULL,'+lit(A)+','+lit(A)+");INSERT INTO union_pnl_inventory_events VALUES('tournaments',"+lit(t)+','+str(event)+",1,"+lit(json.dumps({'union_id':owner}))+"::jsonb,NULL,"+lit(A)+");")
 def registration(reg,t,repeat=1,satellite=None,mode='seat',bad=False):
  global event
  row={'user_id':USER,'tournament_id':t,'registered_at':'2026-10-06T00:00:00Z'}
  if satellite:row['source_satellite_id']=satellite
  for _ in range(repeat):
   event+=1;q("INSERT INTO union_pnl_inventory_touches VALUES('tournament_players',"+('NULL'if reg is None else lit(reg))+','+str(event)+",'INSERT',NULL,"+lit(t)+','+lit('2026-10-06 00:00Z')+','+lit('2026-10-06 00:00Z')+");INSERT INTO union_pnl_transaction_frames VALUES("+str(event)+','+lit('2026-10-06 00:00Z')+");INSERT INTO union_pnl_inventory_events VALUES('tournament_players',"+('NULL'if reg is None else lit(reg))+','+str(event)+','+str(event)+','+lit(json.dumps(row))+"::jsonb,NULL,"+lit('2026-10-06 00:00Z')+");")
  if satellite:
   ticket=uid(9000);ledger=uid(9001)
   q("INSERT INTO tournament_satellite_settlements VALUES("+lit(satellite)+','+lit(t)+");INSERT INTO tournament_satellite_awards VALUES("+lit(satellite)+','+lit(USER)+','+lit(mode)+','+('NULL'if mode=='ticket'else lit(reg))+','+lit(ticket)+");INSERT INTO tournament_tickets VALUES("+','.join(map(lit,[ticket,USER,satellite,t,'redeemed','tournament_entry_only','2026-10-06 00:00Z']))+");INSERT INTO tournament_participant_funding_receipts VALUES("+','.join(map(lit,[uid(9999),satellite,USER,'entry','chips']))+",10,"+lit(C)+','+lit(ledger)+",NULL,'{}');INSERT INTO chip_ledger VALUES("+','.join(map(lit,[ledger,'bad'if bad else'posted','player_wallet',USER,'prize_liability',satellite,satellite]))+",10,"+lit(C)+",'tournament_buyin','hash');")
 def receipt(reg,asset,amount,funding=C,snapshot={}):q("INSERT INTO tournament_participant_funding_receipts VALUES("+lit(reg)+",NULL,NULL,'entry',"+('NULL'if asset is None else lit(asset))+','+('NULL'if amount is None else str(amount))+','+('NULL'if funding is None else lit(funding))+",NULL,NULL,"+lit(json.dumps(snapshot))+"::jsonb);")
 def check(name,expected,opened=[],projected=True,error=None):
  if error:
   for k in queries:q(query(k,opened,projected),error)
  else:
   vals={k:int(q(query(k,opened,projected)))for k in queries};assert vals=={'before':expected,'after':expected},(name,vals,expected)
  cases.append(name)
 T=uid(100);R=uid(200)
 reset();tournament(T);registration(R,T,7);check('duplicate unresolved events preserve count',7);check('fallback exact event source',7,projected=False);check('opening resolved avoids owner',0,[R]);check('NULL opening array',0,None);check('NULL element in opening array',0,[None]);check('NULLplusother opening',0,[None,uid(222)])
 receipt(R,'chips',10);check('positive chip receipt',0);receipt(R,'ticket',1);check('mixed receipt has_other wins',7)
 reset();tournament(T);registration(R,T,3);receipt(R,'chips',0,snapshot={'club_id':C,'is_satellite_qualifier':False});check('zero chips genuine snapshot',0)
 reset();tournament(T);registration(R,T,3);receipt(R,'chips',0,snapshot={'club_id':C,'is_satellite_qualifier':True});check('zero chips qualifier rejected',3)
 reset();tournament(T);registration(R,T,3);receipt(R,None,None);check('NULL receipt predicates',3)
 for mode in ['seat','ticket']:
  reset();tournament(T);registration(R,T,4,uid(300),mode);check('actual satellite '+mode+' owner',0)
 reset();tournament(T);registration(R,T,4,uid(300),bad=True);check('bad satellite ledger retains every bad event',4)
 reset();tournament(T,uid(999));registration(R,T,5);check('foreign tournament excluded',0)
 tournament(T,U);check('historical union event admits despite foreign earlier',5)
 reset();tournament(T);registration(None,T,3);check('NULL registration empty opening array',3);check('NULL registration nonempty opening array',0,[R]);check('NULL registration NULL opening array',0,None)
 reset();tournament(T);registration(R,T,2);q("UPDATE union_pnl_inventory_touches SET frame_observed_at="+lit(B)+"WHERE source_name='tournament_players';");check('half-open projected frame boundary',0)
 reset();tournament(T);registration(R,T,2);q("UPDATE union_pnl_inventory_touches SET observed_at="+lit(B)+"WHERE source_name='tournament_players';");check('half-open observed boundary',0)
 # Eligible invalid source raises in both; originally excluded registration stays excluded.
 reset();tournament(T);registration(R,T,2);q("UPDATE union_pnl_inventory_events SET after_row=after_row||'{\"source_satellite_id\":\"bad-uuid\"}'WHERE source_name='tournament_players';");check('invalid satellite absent award remains unresolved',2);q("INSERT INTO tournament_satellite_awards VALUES("+lit(uid(300))+','+lit(USER)+",'seat',"+lit(R)+",NULL);INSERT INTO tournament_satellite_settlements VALUES("+lit(uid(300))+','+lit(T)+");");check('invalid satellite cast error retained',0,error='invalid input syntax for type uuid');receipt(R,'ticket',1);check('mixed has_other corrupt satellite error parity',0,error='invalid input syntax for type uuid');q('TRUNCATE tournament_participant_funding_receipts;');check('open resolved suppresses original invalid owner',0,[R]);receipt(R,'chips',10);check('entry suppresses original invalid owner',0)
 # Callback-only wrappers do not replace any actual source. They preserve STABLE semantics and call actual helpers.
 q("CREATE SEQUENCE union_calls;CREATE SEQUENCE seat_calls;CREATE FUNCTION native_count_union(text,uuid,boolean)RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$BEGIN PERFORM nextval('union_calls');RETURN fn_union_pnl_tournament_in_union($1,$2,$3);END$$;CREATE FUNCTION native_count_seat(uuid,uuid)RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$BEGIN PERFORM nextval('seat_calls');RETURN fn_union_pnl_satellite_seat_owner($1,$2);END$$;")
 reset()
 for n in range(5):tournament(uid(100+n))
 # Insert scale rows as one SQL, no timing assert or broad stress.
 q("INSERT INTO union_pnl_inventory_touches SELECT 'tournament_players',('00000000-0000-0000-0000-'||lpad(to_hex(200+n%10),12,'0'))::uuid,n,'INSERT',NULL,('00000000-0000-0000-0000-'||lpad(to_hex(100+n%5),12,'0')),"+lit('2026-10-06 00:00Z')+","+lit('2026-10-06 00:00Z')+" FROM generate_series(1,1000)n;")
 counts={};plans={}
 for k in queries:
  q('ALTER SEQUENCE union_calls RESTART WITH 1;ALTER SEQUENCE seat_calls RESTART WITH 1;');assert int(q(query(k,counters=True)))==1000
  counts[k]={'ownership':int(q('SELECT last_value FROM union_calls;')),'satellite':int(q('SELECT last_value FROM seat_calls;'))}
  plans[k]=json.loads(q('EXPLAIN(ANALYZE,FORMAT JSON)'+query(k)))
 assert counts['before']['ownership']==1000 and counts['after']['ownership']==5,counts
 assert counts['before']['satellite']==1000 and counts['after']['satellite']==10,counts
 def walk(n):
  if isinstance(n,dict):
   yield n
   for v in n.values():yield from walk(v)
  elif isinstance(n,list):
   for v in n:yield from walk(v)
 assert any(n.get('Node Type')=='Hash Join'and 'o.row_id'in n.get('Hash Cond','')for n in walk(plans['after'])),'owner join must be hash equality, no N*M nullsafe loop'
 (Path(args.scratch)/'weekly-touched-identities-native-plans.json').write_text(json.dumps(plans,indent=2)+'\n')
 proof.update({'semantic_cases':cases,'actual_helpers_fullhashes_verified':True,'independent_expected_counts':True,'callback_counts':counts,'no_timing_assertion':True,'owner_hash_join':True})
 # Actual complete report+matcher catalog transition, not a mock source seal.
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
 q((P/'report-after.sql').read_text());assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='f';assert q('SELECT smarter_private.original_inventory_basis_generation()IS NULL;')=='t'
 q((P/'matcher-after.sql').read_text());assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t';newgen=q('SELECT smarter_private.original_inventory_basis_generation();');assert newgen!=oldgen and newgen.startswith('original-inventory-245-v1:')
 q("INSERT INTO accounting_close_certificates VALUES('pnl_touched',"+lit(U)+','+lit(A)+','+lit(B)+",jsonb_build_object('ok',true,'_original_inventory_generation',"+lit(oldgen)+"),clock_timestamp());")
 assert q("SET app.weekly_accounting_chunked='on';SET app.accounting_close_memo='on';SELECT smarter_private.inventory_basis_cache_read("+lit(newgen)+",false,'pnl_touched',"+lit(U)+','+lit(A)+','+lit(B)+")IS NULL;")=='t','old generation certificate must refuse'
 assert q("SELECT value->>'_original_inventory_generation'FROM accounting_close_certificates;")==oldgen,'no automatic certificate rewrite'
 q((P/'report-before.sql').read_text()+';'+(P/'matcher-before.sql').read_text());assert q('SELECT smarter_private.original_inventory_basis_generation();')==oldgen
 proof.update({'actual_40_before_and_after':True,'report_only_breaks_seal_and_generation':True,'coordinated_matcher_restores_new_generation':True,'old_generation_certificate_refused_without_update':True,'generation_before':oldgen,'generation_after':newgen,'production_financial_operation_qualified':False})
 # Actual guarded installer bytes; only normal native fixture mutations create refusal conditions.
 migration=(args.migration or next((REPO/'supabase/migrations').glob('20261017034258_*.sql'))).read_text()
 cert_before=q("SELECT md5(jsonb_agg(to_jsonb(c))::text)FROM accounting_close_certificates c;")
 q(migration.replace('COMMIT;','ROLLBACK;'))
 assert q('SELECT smarter_private.original_inventory_basis_generation();')==oldgen
 assert q("SELECT md5(jsonb_agg(to_jsonb(c))::text)FROM accounting_close_certificates c;")==cert_before
 refusals=[]
 def refuse(name,setup,cleanup,expected):
  if setup:q(setup)
  q(migration,expected);refusals.append(name)
  if cleanup:q(cleanup)
  assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
 refuse('history replay',"INSERT INTO supabase_migrations.schema_migrations VALUES('20261017034258',ARRAY['fixture']);","DELETE FROM supabase_migrations.schema_migrations;",'weekly_touched_history_replay')
 refuse('report ACL',"GRANT EXECUTE ON FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)TO anon;","REVOKE EXECUTE ON FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)FROM anon;",'weekly_touched_preimage_authority_refused_0')
 refuse('matcher ACL',"GRANT EXECUTE ON FUNCTION smarter_private.original_inventory_proof_sources_match()TO anon;","REVOKE EXECUTE ON FUNCTION smarter_private.original_inventory_proof_sources_match()FROM anon;",'weekly_touched_preimage_authority_refused_1')
 for alter,restore in [("ALTER FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) SECURITY INVOKER;",'report-before.sql'),("ALTER FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) STABLE;",'report-before.sql'),("ALTER FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)SET search_path=public;",'report-before.sql')]:
  refuse(alter,alter,(P/restore).read_text(),'weekly_touched_original_inventory_seal_required')
 # Ownership changes are restored explicitly; original40 owner check refuses them.
 refuse('report owner',"ALTER FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)OWNER TO anon;","ALTER FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)OWNER TO postgres;REVOKE ALL ON FUNCTION fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)FROM anon;",'weekly_touched_original_inventory_seal_required')
 getter_before=(P/'certificate-before.sql').read_text()
 refuse('other sealed source drift',"ALTER FUNCTION fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz) VOLATILE;",getter_before,'weekly_touched_original_inventory_seal_required')
 for prefix in ["SET request.jwt.claims='{}';","SET request.jwt.claim.role='service_role';","SET ROLE anon;"]:
  q(prefix+migration,'weekly_touched_operator_refused');refusals.append(prefix)
 q("SET ca.break_window_migration_override='fixture';"+migration,'weekly_touched_freeze_or_override_refused');refusals.append('override')
 refuse('active release boundary','INSERT INTO engine_maintenance_thaws(freeze_started_at,thawed_at,frozen_seconds,shifted,contract_version,release_target_at)VALUES(clock_timestamp()-interval \'1 minute\',clock_timestamp(),60,\'{"complete":true,"sit_out_at":true,"hold_expires_at":true,"addon_period_ends_at":true,"reversible_until":true,"reveal_deadline_at":true,"rebuy_prompt_until":true,"bomb_pot_next_due_at":true,"cash_stay_last_tick_at":true,"cash_rejoin_expires_at":true,"level_started_at":true,"cluster_break_eligible_since":true,"cluster_move_expires_at":true,"reconnect_presence":true,"reconnect_snapshots":true}\'::jsonb,3,clock_timestamp()+interval \'5 minutes\');SELECT 1/(CASE WHEN public.fn_active_maintenance_release_boundary()IS NOT NULL THEN 1 ELSE 0 END);','DELETE FROM engine_maintenance_thaws;','weekly_touched_freeze_or_override_refused')
 refuse('frozen',"INSERT INTO engine_maintenance_break(id,phase,announced_at,enforce_freeze,ownership_token)VALUES(true,'last_hand',clock_timestamp()-interval '3 minutes',true,'00000000-0000-0000-0000-000000000001');","DELETE FROM engine_maintenance_break;",'weekly_touched_freeze_or_override_refused')
 holder=subprocess.Popen([str(x)for x in psql],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  holder.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0));SELECT 'LOCKED';\n");holder.stdin.flush()
  while holder.stdout.readline().strip()!='LOCKED':pass
  q(migration,'weekly_touched_scheduler_owned');refusals.append('competing scheduler owner')
 finally:
  holder.stdin.write('ROLLBACK;\n');holder.stdin.close();holder.wait(timeout=5)
 q(migration)
 assert q('SELECT smarter_private.original_inventory_proof_sources_match();')=='t'
 assert q('SELECT smarter_private.original_inventory_basis_generation();')==newgen
 assert q("SELECT md5(jsonb_agg(to_jsonb(c))::text)FROM accounting_close_certificates c;")==cert_before
 # Actual replay is refused even without yet-recorded history by the exact old preimage guard.
 q(migration,'weekly_touched_preimage_authority_refused_0');refusals.append('postimage replay without history')
 proof.update({'actual_installer_sha256':hashlib.sha256(migration.encode()).hexdigest(),'actual_installer_positive':True,'actual_installer_rollback_both_sources_and_generation':True,'actual_installer_certificate_rows_unchanged':True,'installer_refusals':refusals})
 (Path(args.scratch)/'weekly-touched-identities-native-report.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof))
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(root)
