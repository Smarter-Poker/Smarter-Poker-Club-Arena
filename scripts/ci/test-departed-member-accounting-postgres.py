#!/usr/bin/env python3
"""Finite native actual lifecycle guard regression; never connects to an external DB.
18 behavior + 8 installer cases, actual guard/caller preimages + entire candidate migration. No financial RPC execution.
"""
import argparse,hashlib,json,os,re,shutil,socket,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent/'fixtures'/'departed-member-accounting'
CLUB='10000000-0000-0000-0000-000000000001';USER='20000000-0000-0000-0000-000000000001';OTHER='20000000-0000-0000-0000-000000000002'
BEFORE='bb2eca3ab004597dbd9137f78951e943';CALLER='d9a70f1d932538025e656bfe2b4d091d'
def need(v,m):
 if not v:raise RuntimeError(m)
def sha(b):return hashlib.sha256(b).hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--candidate-migration',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);p.add_argument('--scratch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 scratch=a.scratch.resolve();output=a.output.resolve();need(scratch.is_absolute()and not scratch.exists()and scratch!=Path('/'),'new uniquely owned scratch required');need(not output.exists()and output.parent.is_dir(),'new output with existing parent required')
 if sys.platform=='darwin':
  need(str(scratch).startswith('/Volumes/SmarterWork/agent-work/'),'Mac scratch must be own external SSD');need(str(output).startswith(('/Volumes/SmarterWork/agent-work/','/Volumes/SmarterArchives/agent-evidence/')),'Mac output must be external')
 candidate=a.candidate_migration.read_bytes();guard=(ROOT/'guard-before.sql').read_bytes();caller=(ROOT/'caller-is-engine-actual.sql').read_bytes();need(hashlib.md5(guard).hexdigest()==BEFORE and hashlib.md5(caller).hexdigest()==CALLER,'exact actual source fixtures required')
 env={k:v for k,v in os.environ.items()if not k.startswith('PG')};scratch.mkdir();(scratch/'tmp').mkdir();(scratch/'socket').mkdir();env['TMPDIR']=str(scratch/'tmp');data=scratch/'data';log=scratch/'postgres.log';pg=a.pg_bin.resolve();cases=[];error=None;cleanup=False;started=False;t=time.monotonic()
 def run(binary,args=(),text=None,timeout=45):return subprocess.run([str(pg/binary),*map(str,args)],input=text,text=True,capture_output=True,env=env,timeout=timeout)
 with socket.socket()as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 def sql(text,expected_error=None,label=None,sqlstate="42501"):
  r=run('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',scratch/'socket','-p',port,'-U','postgres','-d','postgres'],text)
  ok=(r.returncode==0)if expected_error is None else(r.returncode!=0 and expected_error in r.stderr and sqlstate in r.stderr)
  if label:cases.append({'case':label,'passed':ok})
  need(ok,(label or'SQL')+' failed: '+r.stderr[:1600]);return r.stdout.strip()
 def tx(body,role=None,claim=None):
  claims=''if claim is None else json.dumps({'role':claim})
  return "BEGIN;SELECT set_config('request.jwt.claims','"+claims+"',true);"+(('SET LOCAL ROLE '+role+';')if role else'')+body+'ROLLBACK;'
 def update(assign):return f"UPDATE public.club_members SET {assign} WHERE club_id='{CLUB}'AND user_id='{USER}';"
 exact_credit=f"DO $x$ DECLARE edge record;prior jsonb;BEGIN SELECT '{CLUB}'::uuid club_id,'{USER}'::uuid payee_user,1.25::numeric amount INTO edge;SELECT to_jsonb(m)-ARRAY['chip_balance','updated_at'] INTO prior FROM public.club_members m WHERE club_id=edge.club_id AND user_id=edge.payee_user;UPDATE public.club_members SET chip_balance=chip_balance+edge.amount,updated_at=now() WHERE club_id=edge.club_id AND user_id=edge.payee_user;IF (SELECT chip_balance FROM public.club_members WHERE club_id=edge.club_id AND user_id=edge.payee_user)<>101.25 OR (SELECT to_jsonb(m)-ARRAY['chip_balance','updated_at'] FROM public.club_members m WHERE club_id=edge.club_id AND user_id=edge.payee_user)IS DISTINCT FROM prior THEN RAISE EXCEPTION 'credit or whole other row changed';END IF;END $x$;"
 fixture=f"""
 CREATE ROLE authenticated NOLOGIN;CREATE ROLE anon NOLOGIN;CREATE ROLE service_role NOLOGIN;
 CREATE SCHEMA auth;CREATE SCHEMA supabase_migrations;CREATE SCHEMA smarter_private;
 CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
 -- Narrow migration preflight dependency fixtures: not production freeze or 40-source proof.
 CREATE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $a$SELECT coalesce(nullif(current_setting('native.frozen',true),''),'false')::boolean$a$;
 CREATE FUNCTION public.fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $a$SELECT NULL::timestamptz$a$;
 CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $a$SELECT 'native-unchanged-generation'$a$;
 CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $a$SELECT true$a$;
 -- Minimal request-context fixture; real public.fn_caller_is_engine below is unmodified actual source.
 CREATE FUNCTION auth.role()RETURNS text LANGUAGE sql STABLE AS $a$SELECT NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'role'$a$;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon,service_role;GRANT EXECUTE ON FUNCTION auth.role()TO PUBLIC;
 CREATE TABLE public.club_members(id uuid PRIMARY KEY,club_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL DEFAULT 'active',role text NOT NULL DEFAULT 'player',is_active boolean NOT NULL DEFAULT true,agent_id uuid,parent_agent_id uuid,chip_balance numeric NOT NULL DEFAULT 0,held_chips numeric NOT NULL DEFAULT 0,locked_chips numeric NOT NULL DEFAULT 0,promo_balance numeric NOT NULL DEFAULT 0,membership_lifecycle_status text NOT NULL CHECK(membership_lifecycle_status IN('active','departed')),departed_at timestamptz,departed_by uuid,departure_reason text,updated_at timestamptz NOT NULL DEFAULT now(),future_nonmoney_field text DEFAULT 'unchanged');
 CREATE TABLE public.ca_declared_money_triggers(table_name text NOT NULL,trigger_name text NOT NULL,declared_at timestamptz DEFAULT now(),note text,PRIMARY KEY(table_name,trigger_name));
 INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)VALUES('club_members','trg_club_members_guard_lifecycle_write','Existing declared baseline lifecycle trigger; native qualification keeps attachment unchanged.');
 GRANT SELECT,UPDATE ON public.club_members TO authenticated,anon,service_role;
 INSERT INTO public.club_members(id,club_id,user_id,status,is_active,chip_balance,membership_lifecycle_status,departed_at,departed_by,departure_reason)VALUES('30000000-0000-0000-0000-000000000001','{CLUB}','{USER}','suspended',false,100,'departed','2026-09-01 00:00:00+00','{OTHER}','Native original departure'),('30000000-0000-0000-0000-000000000002','{CLUB}','{OTHER}','active',true,100,'active',NULL,NULL,NULL);
 """
 try:
  version=run('postgres',['--version']);need(version.returncode==0 and' 17.'in version.stdout,'PostgreSQL17 required');r=run('initdb',['-D',data,'-U','postgres','--auth=trust','--no-locale','--encoding=UTF8']);need(r.returncode==0,'initdb failed: '+r.stderr)
  r=run('pg_ctl',['-D',data,'-l',log,'-o',f'-F -h 127.0.0.1 -p {port} -k {scratch / "socket"}','-w','start']);need(r.returncode==0,'pg_ctl start failed: '+r.stderr);started=True
  sql(fixture);sql(guard.decode()+';\n'+caller.decode()+";\nREVOKE ALL ON FUNCTION public.fn_guard_membership_lifecycle_write()FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.fn_guard_membership_lifecycle_write()TO service_role;CREATE TRIGGER trg_club_members_guard_lifecycle_write BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_guard_membership_lifecycle_write();")
  need(sql("SELECT md5(pg_get_functiondef('public.fn_guard_membership_lifecycle_write()'::regprocedure))||':'||md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure));")==BEFORE+':'+CALLER,'actual preimage/claim helper canonicalization differs')
  sql(tx(exact_credit),expected_error='MEMBERSHIP_DEPARTED',label='before_actual_R2_exact_update_refused')
  attachment=sql("SELECT md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE tgrelid='public.club_members'::regclass AND tgname='trg_club_members_guard_lifecycle_write';")
  candidate_text=candidate.decode();need(len(re.findall(r'^BEGIN;$',candidate_text,re.M))==1 and candidate_text.rstrip().endswith('COMMIT;'),'whole transactional candidate required')
  def refuse_candidate(prefix,reason,label):
   sql(candidate_text.replace('BEGIN;','BEGIN;'+prefix,1),expected_error=reason,label=label,sqlstate='P0001')
   need(sql("SELECT md5(pg_get_functiondef('public.fn_guard_membership_lifecycle_write()'::regprocedure));")==BEFORE,'refused migration changed guard')
  refuse_candidate("SET LOCAL request.jwt.claims='{\"role\":\"service_role\"}';",'departed_accounting_operator_refused','installer_claimed_actor_refused')
  refuse_candidate("SET LOCAL native.frozen='true';",'departed_accounting_freeze_or_override_refused','installer_freeze_refused')
  sql("INSERT INTO supabase_migrations.schema_migrations VALUES('20261017053808');")
  refuse_candidate('','departed_accounting_history_replay','installer_history_replay_refused')
  sql("DELETE FROM supabase_migrations.schema_migrations;")
  sql("REVOKE EXECUTE ON FUNCTION public.fn_guard_membership_lifecycle_write()FROM service_role;")
  refuse_candidate('','departed_accounting_guard_preimage_authority_changed','installer_changed_ACL_refused')
  sql("GRANT EXECUTE ON FUNCTION public.fn_guard_membership_lifecycle_write()TO service_role;")
  sql("ALTER TABLE public.club_members DISABLE TRIGGER trg_club_members_guard_lifecycle_write;")
  refuse_candidate('','departed_accounting_declared_trigger_changed','installer_disabled_trigger_refused')
  sql("ALTER TABLE public.club_members ENABLE TRIGGER trg_club_members_guard_lifecycle_write;")
  sql("CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()RETURNS boolean LANGUAGE sql STABLE AS $a$SELECT false$a$;")
  refuse_candidate('','departed_accounting_caller_authority_changed','installer_caller_hash_refused')
  sql(caller.decode())
  sql(candidate_text.rstrip()[:-len('COMMIT;')]+'ROLLBACK;')
  need(sql("SELECT md5(pg_get_functiondef('public.fn_guard_membership_lifecycle_write()'::regprocedure));")==BEFORE,'rolled-back candidate persisted')
  cases.append({'case':'installer_whole_candidate_rollback_restores_preimage','passed':True})
  sql(candidate_text);after=sql("SELECT md5(pg_get_functiondef('public.fn_guard_membership_lifecycle_write()'::regprocedure));")
  need(after=='9d41bf84bc77ef026c604438c0c96b5e','exact candidate guard postimage required')
  need(sql("SELECT md5(prosrc)||':'||proowner::regrole::text||':'||prosecdef::text||':'||provolatile::text||':'||proacl::text||':'||array_to_string(proconfig,',') FROM pg_proc WHERE oid='public.fn_guard_membership_lifecycle_write()'::regprocedure;")=='ef2447ac697ae90492b538e1c8d643c5:postgres:true:v:{postgres=X/postgres,service_role=X/postgres}:search_path=public, pg_temp','exact postimage metadata required')
  cases.append({'case':'installer_actual_whole_migration_exact_hash_and_authority','passed':True})
  need(sql("SELECT md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE tgrelid='public.club_members'::regclass AND tgname='trg_club_members_guard_lifecycle_write';")==attachment,'trigger attachment changed')
  sql("CREATE FUNCTION public.native_definer_credit()RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public AS $n$"+update('chip_balance=chip_balance+1.25,updated_at=now()')+"$n$;GRANT EXECUTE ON FUNCTION public.native_definer_credit()TO authenticated;")
  sql(tx(exact_credit),label='after_system_credit_whole_other_row_unchanged')
  debit=f"DO $x$DECLARE prior jsonb;BEGIN SELECT to_jsonb(m)-ARRAY['chip_balance','updated_at'] INTO prior FROM club_members m WHERE user_id='{USER}';"+update('chip_balance=chip_balance-1.25,updated_at=now()')+f"IF(SELECT chip_balance FROM club_members WHERE user_id='{USER}')<>98.75 OR(SELECT to_jsonb(m)-ARRAY['chip_balance','updated_at']FROM club_members m WHERE user_id='{USER}')IS DISTINCT FROM prior THEN RAISE EXCEPTION 'debit or other fields changed';END IF;END $x$;"
  sql(tx(debit),label='after_system_owed_debit_whole_other_row_unchanged')
  sql(tx(exact_credit,'service_role','service_role'),label='service_role_claim_credit')
  sql(tx(update('chip_balance=chip_balance+1.25'),'postgres','authenticated'),expected_error='MEMBERSHIP_DEPARTED',label='browser_claim_even_postgres_execution_refused')
  sql(tx(update('chip_balance=chip_balance+1.25'),'authenticated','authenticated'),expected_error='MEMBERSHIP_DEPARTED',label='authenticated_credit_refused')
  sql(tx(update('chip_balance=chip_balance+1.25'),'anon','anon'),expected_error='MEMBERSHIP_DEPARTED',label='anonymous_credit_refused')
  sql(tx('SELECT public.native_definer_credit();','authenticated','authenticated'),expected_error='MEMBERSHIP_DEPARTED',label='browser_inside_postgres_definer_refused')
  for label,assign in [('trusted_status_change_refused',"status='active'"),('trusted_role_change_refused',"role='agent'"),('trusted_hierarchy_change_refused',f"agent_id='{OTHER}'"),('trusted_lifecycle_reactivation_refused',"membership_lifecycle_status='active'"),('trusted_departure_metadata_refused',"departure_reason='changed'"),('trusted_mixed_credit_status_refused',"chip_balance=chip_balance+1.25,status='active'"),('trusted_identity_change_refused',"user_id='20000000-0000-0000-0000-000000000003'"),('future_nonmoney_column_change_refused',"future_nonmoney_field='changed'")]:sql(tx(update(assign)),expected_error='MEMBERSHIP_DEPARTED',label=label)
  lifecycle=f"SELECT set_config('app.club_membership_lifecycle_write','depart',true);UPDATE club_members SET membership_lifecycle_status='departed',status='suspended',is_active=false,departed_at=now(),departed_by='{USER}',departure_reason='Native departure' WHERE user_id='{OTHER}';SELECT set_config('app.club_membership_lifecycle_write','rejoin',true);UPDATE club_members SET membership_lifecycle_status='active',status='active',is_active=true,departed_at=NULL,departed_by=NULL,departure_reason=NULL WHERE user_id='{OTHER}';DO $x$BEGIN IF NOT EXISTS(SELECT FROM club_members WHERE user_id='{OTHER}'AND membership_lifecycle_status='active'AND status='active'AND is_active AND departed_at IS NULL AND departed_by IS NULL AND departure_reason IS NULL)THEN RAISE EXCEPTION 'canonical flag transitions changed';END IF;END $x$;"
  sql(tx(lifecycle),label='canonical_depart_rejoin_flag_boundary_preserved')
  sql(tx(f"UPDATE club_members SET future_nonmoney_field='active permitted' WHERE user_id='{OTHER}';"),label='active_row_prior_behavior_preserved')
  need(len(cases)==26,'finite18 behavior+8 installer case count changed')
 except Exception as exc:error=str(exc)
 finally:
  try:
   if data.exists()and(data/'postmaster.pid').exists():
    r=run('pg_ctl',['-D',data,'-m','immediate','-w','-t','30','stop']);need(r.returncode==0,'owned cluster cleanup failed; scratch retained')
   shutil.rmtree(scratch);cleanup=True
  except Exception as exc:error=(error+'; 'if error else'')+str(exc)
 result={'status':'PASS'if error is None else'FAIL','candidate_sha256':sha(candidate),'before_guard_md5':BEFORE,'caller_md5':CALLER,'cases':cases,'case_count':len(cases),'owned_cluster_removed':cleanup,'elapsed_seconds':round(time.monotonic()-t,3),'scope':'actual lifecycle guard+actual caller with request-context and narrow club_members fixture; full Join RPC and financial ledger/stage are not executed','error':error};output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));return 0 if error is None else 1
if __name__=='__main__':sys.exit(main())
