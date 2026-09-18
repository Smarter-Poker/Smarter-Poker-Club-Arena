#!/usr/bin/env python3
"""Qualify the metadata-only declaration using captured authorities in a private DB."""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]
psql,socket,port,work=sys.argv[1:]
work=Path(work)
fixture=root/'tests/fixtures/installed-funding-guard-declaration/captured-contract.json'
contract=json.loads(fixture.read_text())
original=next((root/'supabase/migrations').glob('20260917230925_*.sql'))
successor=next((root/'supabase/migrations').glob('20260918014359_*.sql'))
inputs=[Path(__file__),fixture,original,successor]
(work/'guard-declaration-tested-binding.json').write_text(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs},indent=2)+'\n')
def run(sql,label,db='installed_guard_declaration',error=None):
 path=work/(label+'.sql');path.write_text(sql)
 result=subprocess.run([psql,'-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-h',socket,'-p',port,'-d',db,'-f',str(path)],capture_output=True,text=True)
 (work/(label+'.log')).write_text(result.stdout+result.stderr)
 if error:
  assert result.returncode and error in result.stderr,(label,result.stderr)
 else:
  assert not result.returncode,(label,result.stderr)
 print('PASS '+label,flush=True)
def quote(s):return "'"+s.replace("'","''")+"'"
def assert_sql(expr):return "DO $$ BEGIN IF NOT ("+expr+") THEN RAISE EXCEPTION 'assertion failed'; END IF; END $$;\n"
run('CREATE DATABASE installed_guard_declaration;','guard-private-database',db='postgres')
bootstrap='''CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
CREATE TABLE public.ca_guard_defs(proname text PRIMARY KEY,def_hash text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),declared_ref text,declared_at timestamptz);
CREATE TABLE public.ca_guard_def_history(id bigserial PRIMARY KEY,proname text NOT NULL,def_hash text NOT NULL,def_text text NOT NULL,captured_at timestamptz NOT NULL DEFAULT now(),UNIQUE(proname,def_hash));
SET check_function_bodies=off;
'''
for row in contract['functions']:
 bootstrap+=row['definition']+';\nREVOKE ALL ON FUNCTION public.'+row['signature']+' FROM PUBLIC,anon,authenticated,service_role;\nGRANT EXECUTE ON FUNCTION public.'+row['signature']+' TO service_role;\n'
bootstrap+=contract['watchlist']+';\n'
bootstrap+="INSERT INTO public.ca_guard_defs(proname,def_hash) VALUES ('fn_club_members_ledger_writer','e7cae5f2fc19ef0d2c47e528764abd5a'),('unrelated_sentinel','unchanged');\n"
bootstrap+="INSERT INTO supabase_migrations.schema_migrations VALUES('20260917230925','cash_funding_retains_original_participant_custody',ARRAY["+quote(original.read_text())+"]);\n"
run(bootstrap,'guard-captured-authorities')
# Each failure runs the exact migration and must roll back its entire declaration.
run("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['wrong source'];",'guard-history-fault')
run(successor.read_text(),'guard-history-refuses',error='unmatched installed migration history')
run("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY["+quote(original.read_text())+"];",'guard-history-restored')
for name,fault,restore in [
 ('definition',"ALTER FUNCTION public.fn_club_members_ledger_writer() SET statement_timeout='1s';","ALTER FUNCTION public.fn_club_members_ledger_writer() RESET statement_timeout;"),
 ('grant','GRANT EXECUTE ON FUNCTION public.fn_club_members_ledger_writer() TO anon;','REVOKE ALL ON FUNCTION public.fn_club_members_ledger_writer() FROM anon;'),
 ('owner','ALTER FUNCTION public.fn_club_members_ledger_writer() OWNER TO service_role;','ALTER FUNCTION public.fn_club_members_ledger_writer() OWNER TO postgres; GRANT EXECUTE ON FUNCTION public.fn_club_members_ledger_writer() TO service_role;'),
 ('declarer',"ALTER FUNCTION public.fn_ca_declare_guard_redefinition(text,text) SET statement_timeout='1s';","ALTER FUNCTION public.fn_ca_declare_guard_redefinition(text,text) RESET statement_timeout;"),
]:
 run(fault,'guard-'+name+'-fault')
 run(successor.read_text(),'guard-'+name+'-refuses',error='changed definition, owner, or grants')
 run(restore,'guard-'+name+'-restored')
run(assert_sql("NOT EXISTS(SELECT 1 FROM public.ca_guard_defs WHERE declared_ref IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM public.ca_guard_def_history)"),'guard-faults-left-no-declaration')
run(successor.read_text(),'guard-exact-declaration')
run(successor.read_text(),'guard-exact-replay')
checks=assert_sql("EXISTS(SELECT 1 FROM public.ca_guard_defs WHERE proname='fn_club_members_ledger_writer' AND def_hash='e7cae5f2fc19ef0d2c47e528764abd5a' AND declared_ref LIKE '%20260917230925%20260918014359%' AND declared_at IS NOT NULL)")
checks+=assert_sql("(SELECT count(*) FROM public.ca_guard_def_history)=1 AND EXISTS(SELECT 1 FROM public.ca_guard_def_history WHERE proname='fn_club_members_ledger_writer' AND md5(def_text)=def_hash)")
checks+=assert_sql("EXISTS(SELECT 1 FROM public.ca_guard_defs WHERE proname='unrelated_sentinel' AND def_hash='unchanged' AND declared_ref IS NULL)")
for row in contract['functions']:
 checks+=assert_sql("EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid="+quote('public.'+row['signature'])+"::regprocedure AND md5(pg_get_functiondef(p.oid))="+quote(row['definition_md5'])+" AND pg_get_userbyid(p.proowner)="+quote(row['owner'])+" AND p.proacl::text="+quote(row['acl'])+")")
checks+=assert_sql("pg_get_functiondef('public.fn_ca_guard_watchlist()'::regprocedure)="+quote(contract['watchlist']))
run(checks,'guard-declaration-and-authorities-preserved')
