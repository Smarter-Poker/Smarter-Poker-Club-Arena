#!/usr/bin/env python3
"""Execute original and atomic historical terms on an isolated PG17, never production."""
import argparse,json,os,re,shutil,socket,subprocess,tempfile
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--pg-bin',type=Path,required=True);ap.add_argument('--scratch',type=Path,required=True)
a=ap.parse_args();root=Path(__file__).resolve().parents[2]
base=Path(tempfile.mkdtemp(prefix='rd-',dir=a.scratch));data=base/'d';started=False
with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=str(listener.getsockname()[1])
env={**os.environ,'TMPDIR':str(base)}
def run(args,content=None,error=None):
 p=subprocess.run([str(x) for x in args],input=content,text=True,capture_output=True,env=env,timeout=90)
 if error:assert p.returncode and error in p.stderr,p.stdout+p.stderr
 else:assert p.returncode==0,p.stdout+p.stderr
 return p.stdout.strip()
def sql(s,error=None):return run([a.pg_bin/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],s,error)
try:
 run([a.pg_bin/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
 run([a.pg_bin/'pg_ctl','-D',data,'-l',base/'log','-o',f'-h 127.0.0.1 -k {base} -p {port}','-w','start']);started=True
 sql("""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE accounting_agreement_history(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,entity_type text,entity_key text,club_id uuid,subject_user_id uuid,event_type text,observed_at timestamptz,transaction_id bigint,actor_id uuid,before_terms jsonb,after_terms jsonb,union_id uuid);
 CREATE TABLE clubs(id uuid,is_union boolean,union_id uuid);
 CREATE INDEX history_identity ON accounting_agreement_history(entity_type,entity_key,observed_at,id);""")
 preimages=json.loads((root/'scripts/ci/fixtures/atomic-accounting-history-preimages.json').read_text())
 for p in preimages:
  sql(p['definition'])
  assert sql("SELECT md5(pg_get_functiondef('"+p['signature']+"'::regprocedure))")==p['md5']
 club='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';player='baf4b2c4-c335-47bd-be52-a992d71e35d8'
 leaf='6cea4bf4-50db-4e9d-8df9-0dac1e7f78d5';parent='af6dc0cc-8204-48fd-92ed-57ab78fd163c';user='00000000-0000-0000-0000-000000000033';top='00000000-0000-0000-0000-000000000002'
 at='2026-10-17 00:16:58.723653+00'
 def event(kind,key,user,when,xid,terms):
  sql("INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,observed_at,transaction_id,after_terms) VALUES('"+kind+"','"+key+"','"+club+"',"+("'"+user+"'" if user else 'NULL')+",'"+when+"',"+str(xid)+",'"+json.dumps(terms)+"')")
 m={'club_id':club,'user_id':player,'status':'active','is_active':True,'agent_id':user}
 l={'id':leaf,'club_id':club,'user_id':user,'role':'agent','status':'active','commission_rate':.36,'parent_agent_id':parent}
 t={'id':parent,'club_id':club,'user_id':top,'role':'super_agent','status':'active','commission_rate':.65,'parent_agent_id':None}
 for kind,key,who,terms in [('club_members',club+':'+player,player,m),('agents',leaf,user,l),('agents',parent,top,t)]:event(kind,key,who,'2026-09-14',100,terms)
 event('agents',parent,top,'2026-10-17 00:16:58.199989+00',200,{**t,'status':'suspended'})
 event('agents',leaf,user,'2026-10-17 00:17:01.700+00',200,{**l,'parent_agent_id':None})
 # Different entity later in the same transaction also proves it was unfinished.
 event('club_members','unrelated',None,'2026-10-17 00:17:03.084875+00',200,{'status':'active'})
 q="SELECT fn_accounting_earning_contract('"+club+"','"+player+"',0.06,NULL,'"+at+"')"
 sql(q,'cash_commission_hierarchy_invalid_at_earning')
 candidate=next((root/'supabase/migrations').glob('20261019183226_*')).read_text()
 before=sql('SELECT md5(string_agg(row_to_json(h)::text,chr(10) ORDER BY id)) FROM accounting_agreement_history h')
 sql(candidate)
 v=json.loads(sql(q));assert [x['amount'] for x in v['tiers']]==[.02,.03] and v['club_residual']==.01
 assert sql('SELECT md5(string_agg(row_to_json(h)::text,chr(10) ORDER BY id)) FROM accounting_agreement_history h')==before
 # After all observations, committed suspension stays suspended; no resurrection.
 sql("SELECT fn_accounting_agent_terms_at('"+club+"','"+top+"','2026-10-17 00:18+00')",'accounting_terms_not_active')
 assert json.loads(sql("SELECT fn_accounting_terms_at('agents','"+leaf+"','2026-10-17 00:18+00')"))['terms']['parent_agent_id'] is None
 # Candidate discovery must not resolve an identity created only by the unfinished transaction.
 event('agents','new-identity',top,'2026-10-17 00:16:58+00',200,{**t,'id':'00000000-0000-0000-0000-000000000099'})
 assert json.loads(sql("SELECT fn_accounting_agent_terms_at('"+club+"','"+top+"','"+at+"')"))['terms']['id']==parent
 # Retain own transaction read-your-writes while ignoring later own history rows.
 sql("BEGIN;INSERT INTO accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,observed_at,transaction_id,after_terms) VALUES('agents','own','"+club+"','"+top+"',clock_timestamp()-interval '1 hour',txid_current(),'{\"status\":\"active\"}'),('agents','own-later','"+club+"','"+top+"',clock_timestamp()+interval '1 hour',txid_current(),'{\"status\":\"suspended\"}');DO $$BEGIN IF fn_accounting_terms_at('agents','own',transaction_timestamp())->'terms'->>'status'<>'active' THEN RAISE EXCEPTION 'own_transaction_lost';END IF;END$$;ROLLBACK;")
 sql("SELECT fn_accounting_terms_at('agents','absent','"+at+"')",'accounting_terms_not_observed')
 sql("SELECT fn_accounting_terms_at('bad','x','"+at+"')",'invalid_accounting_terms_request')
 sql("SELECT fn_accounting_terms_at('agents','x',now()+interval '1 day')",'invalid_accounting_terms_request')
 assert sql("SELECT has_function_privilege('authenticated','fn_accounting_terms_at(text,text,timestamptz)','EXECUTE')")=='f'
 sql(candidate,'atomic_accounting_history_preimage_changed')
 print(json.dumps({'qualification':'passed','actual_historical_earning_contract':True,'before_intermediate_hierarchy_failure':True,'after_exact_tiers':[.02,.03],'residual':.01,'history_unchanged':True,'completed_suspension_preserved':True,'new_identity_excluded':True,'own_transaction_preserved':True,'unknown_and_invalid_requests_refused':True,'private_acl':True,'replay_refused':True,'production_payment':False}))
finally:
 if started:run([a.pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
 shutil.rmtree(base)
