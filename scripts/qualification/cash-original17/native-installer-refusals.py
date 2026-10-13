#!/usr/bin/env python3
"""Exact installer refusals against one already-qualified private PG17 opening."""
import argparse,json,pathlib,os,subprocess,hashlib
p=argparse.ArgumentParser();p.add_argument('--state',type=pathlib.Path,required=True);p.add_argument('--parent-restore',type=pathlib.Path,required=True);a=p.parse_args();state=json.loads(a.state.read_text());root=pathlib.Path(__file__).resolve().parents[3];migration=root/'supabase/migrations/20261013035113_a_cash_original_hand_corrects_its_rolled_back_allocator.sql';sql=migration.read_text();assert sql.endswith('COMMIT;\n');assert str(a.state.resolve()).startswith('/Volumes/SmarterWork/agent-work/');assert str(pathlib.Path(state['socket']).resolve()).startswith('/Volumes/SmarterWork/agent-work/')
env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k not in ('DATABASE_URL','SUPABASE_DB_URL')};cmd=[state['pg_bin']+'/psql','-X','-qAt','-h',state['socket'],'-p','55496','-U','postgres','-d',state['database'],'-v','ON_ERROR_STOP=1'];out=a.state.parent

def run(text,label,expected=None):
 r=subprocess.run(cmd,input=text,text=True,capture_output=True,env=env,timeout=30);(out/(label+'.stdout')).write_text(r.stdout);(out/(label+'.stderr')).write_text(r.stderr)
 if expected is None:
  assert r.returncode==0,(label,r.stderr)
 else:assert r.returncode!=0 and expected in r.stderr,(label,r.stderr)
 return {'label':label,'expected':expected,'exit':r.returncode,'inputSHA256':hashlib.sha256(text.encode()).hexdigest()}
assert subprocess.run(cmd+['-c',"SELECT inet_server_addr() IS NULL AND current_setting('server_version_num')::int BETWEEN 170000 AND 179999"],env=env,text=True,capture_output=True,timeout=10).stdout.strip()=='t'
present=subprocess.run(cmd+['-c',"SELECT to_regprocedure('smarter_private.cash_original17_source_correction_proof(uuid)') IS NOT NULL"],env=env,text=True,capture_output=True,timeout=10).stdout.strip()=='t'
results=[run(sql,'installer-replay-alias','CASH17_PARENT30_FULL_AUTHORITY_CHANGED')] if present else []
restore=a.parent_restore.read_text()
if present:run(restore,'installer-parent-preimage-restoration')
body=sql[sql.index('BEGIN;')+6:];body=body[:-8]
variants=[('operator',"SET LOCAL ROLE service_role;",'CASH17_INSTALLER_OPERATOR_ONLY'),('jwt',"SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\"}',true);",'CASH17_INSTALLER_OPERATOR_ONLY'),('history',"INSERT INTO supabase_migrations.schema_migrations(version,statements) VALUES('20261013035113',ARRAY['not source']);",'CASH17_REPLAY_OR_PREIMAGE_REFUSED'),('parent-history',"UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['not source'] WHERE version='20261013022132';",'CASH17_PARENT22132_REQUIRED_OR_CHANGED'),('carry-history',"UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['not source'] WHERE version='20261013034406';",'CASH17_FIXED_ALLOCATOR_HISTORY_CHANGED'),('parent-security',"ALTER FUNCTION smarter_private.original_hand_source_correction_proof(uuid) SECURITY DEFINER;",'CASH17_PARENT30_FULL_AUTHORITY_CHANGED'),('alias',"CREATE FUNCTION smarter_private.cash_original17_fixed_sources_match() RETURNS boolean LANGUAGE sql AS 'SELECT false';",'CASH17_REPLAY_OR_PREIMAGE_REFUSED'),('freeze',"INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,enforce_freeze,ownership_token,updated_at) VALUES(true,'counting_down',clock_timestamp()-interval '1 minute',clock_timestamp(),clock_timestamp()+interval '5 minutes','native-only freeze',true,gen_random_uuid(),clock_timestamp()) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,break_ends_at=excluded.break_ends_at,enforce_freeze=true;",'CASH17_ORIGINAL_HAND_OWNER_OR_FREEZE')]
for name,setup,error in variants:results.append(run('BEGIN;\n'+setup+'\n'+body+'\nROLLBACK;\n','installer-refusal-'+name,error))
results.append(run(sql[:-8]+'ROLLBACK;\n','installer-exact-rollback'))
assert subprocess.run(cmd+['-c',"SELECT to_regprocedure('smarter_private.cash_original17_source_correction_proof(uuid)') IS NULL AND md5(pg_get_functiondef('smarter_private.original_hand_source_correction_proof(uuid)'::regprocedure))='9bf44c67db2cbcc0a86d9ccf26e8f8d8'"],env=env,text=True,capture_output=True,timeout=10).stdout.strip()=='t'
results.append(run(sql,'installer-final-exact-commit'))
(out/'cash17-final-installer-result.json').write_text(json.dumps({'status':'PASS','production':False,'migrationSHA256':hashlib.sha256(migration.read_bytes()).hexdigest(),'results':results},indent=2)+'\n');print(json.dumps({'status':'PASS','controls':len(results),'production':False}))
