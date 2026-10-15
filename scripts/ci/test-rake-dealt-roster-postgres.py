#!/usr/bin/env python3
"""Private PG17 test: actual audit readers, controlled unchanged spec inputs."""
import argparse, ast, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
FIX=ROOT/'scripts/ci/fixtures/rake-dealt-roster'
MIG=ROOT/'supabase/migrations/20261015214329_rake_audits_read_the_dealt_roster_rather_than_contribution_c.sql'
parser=argparse.ArgumentParser()
parser.add_argument('--pg-bin',default=os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
parser.add_argument('--scratch',default=os.environ.get('RUNNER_TEMP',tempfile.gettempdir()))
args=parser.parse_args(); pg=Path(args.pg_bin)
scratch=Path(tempfile.mkdtemp(prefix='rd-',dir=args.scratch)); data=scratch/'data'; started=False
def run(argv,sql=None,error=None):
 r=subprocess.run([str(v) for v in argv],input=sql,text=True,capture_output=True,timeout=60)
 if error: assert r.returncode and error in r.stderr,r.stdout+r.stderr
 else: assert r.returncode==0,r.stdout+r.stderr
 return r.stdout.strip()
def q(sql,error=None):
 return run([pg/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',scratch,'-U','postgres','-d','postgres'],sql,error)
def schema_from(path):
 tree=ast.parse(path.read_text())
 return next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SCHEMA' for t in n.targets))
try:
 assert ' 17.' in run([pg/'postgres','--version'])
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(scratch)+"'\nautovacuum=off\n")
 run([pg/'pg_ctl','-D',data,'-l',scratch/'server.log','-w','start']);started=True
 q(schema_from(ROOT/'scripts/ci/test-rake-audit-diamond-accrual.py'))
 q('''ALTER TABLE clubs ADD COLUMN default_rake_percent numeric, ADD COLUMN rake_cap numeric, ADD COLUMN bbj_rake_enabled boolean;
 ALTER TABLE tables ADD COLUMN max_players integer, ADD COLUMN rake_percent numeric, ADD COLUMN rake_cap_bb numeric;
 ALTER TABLE hand_history ADD COLUMN players jsonb, ADD COLUMN bbj_amount numeric, ADD COLUMN pot_size numeric,
 ADD COLUMN community_cards2 text[], ADD COLUMN showdown jsonb, ADD COLUMN actions jsonb;
 CREATE TABLE poker_diamond_hand_receipts(table_id uuid,hand_number bigint,request jsonb,receipt jsonb,created_at timestamptz);
 CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text);
 CREATE TABLE fixture_freeze(frozen boolean); INSERT INTO fixture_freeze VALUES(false);
 CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT frozen FROM fixture_freeze$$;
 CREATE FUNCTION fn_active_maintenance_release_boundary() RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;
 -- Controlled price dependency: the real reader must forward dealt count,
 -- not contribution count. This does not qualify production pricing rules.
 CREATE FUNCTION fn_effective_rake(numeric,numeric,integer,boolean,numeric,numeric,numeric,integer)
 RETURNS TABLE(rake numeric,cap numeric,percent numeric) LANGUAGE sql AS $$
 SELECT round($2*CASE WHEN $3=2 THEN .05 ELSE .10 END,2),100::numeric,CASE WHEN $3=2 THEN 5 ELSE 10 END::numeric$$;
 CREATE OR REPLACE FUNCTION fn_effective_bbj_drop(numeric,integer,boolean,uuid,uuid,text,numeric,numeric,numeric)
 RETURNS numeric LANGUAGE sql AS $$SELECT CASE WHEN $2>=3 AND $3 THEN .02 ELSE 0 END::numeric$$;
 ''')
 pins=json.loads((FIX/'pins.json').read_text())
 for p in pins:
  src=(FIX/p['file']).read_text();assert hashlib.md5(src.encode()).hexdigest()==p['before']
  q(src);q('REVOKE ALL ON FUNCTION '+p['signature']+' FROM PUBLIC; GRANT EXECUTE ON FUNCTION '+p['signature']+' TO service_role;')
 q('''INSERT INTO clubs(id,asset,default_rake_percent,rake_cap,bbj_rake_enabled) VALUES(md5('club')::uuid,'chips',-1,-1,true);
 INSERT INTO tables(id,club_id,small_blind,big_blind,game_variant,max_players,rake_percent,rake_cap_bb)
 VALUES(md5('table')::uuid,md5('club')::uuid,.02,.04,'nlh',3,-1,-1);
 INSERT INTO hand_history(id,table_id,hand_number,created_at,game_variant,rake_amount,bbj_amount,pot_size,community_cards,players,actions)
 SELECT md5(x)::uuid,md5('table')::uuid,row_number() OVER(),now()-interval '10 minutes','nlh',
 CASE WHEN x='real-overrake' THEN .05 ELSE .03 END,.02,.28,ARRAY['As','Kd','7c'],
 CASE WHEN x='real-two-dealt' THEN '[{},{}]'::jsonb WHEN x='missing-roster' THEN NULL ELSE '[{},{},{}]'::jsonb END,
 '[{"stage":"preflop"},{"stage":"flop"}]'::jsonb
 FROM unnest(ARRAY['three-dealt-two-contribute','real-two-dealt','real-overrake','missing-roster']) x;
 INSERT INTO rake_records(hand_id,table_id,rake_amount,bbj_contribution,pot_size,num_players,created_at,source,is_tournament)
 SELECT id,table_id,rake_amount,bbj_amount,pot_size,2,created_at,'atomic_distribute_rake',false FROM hand_history;
 ''')
 bbj=lambda:q("SELECT detail::text FROM fn_rake_bbj_invariants(2) WHERE check_name='I1_drop_under_3_dealt';")
 law=lambda:q("SELECT coalesce(jsonb_agg(jsonb_build_array(kind,hand_id) ORDER BY kind,hand_id),'[]') FROM fn_rake_law_violations(interval '2 hours');")
 before_bbj=bbj();before_law=law()
 assert q("SELECT violations FROM fn_rake_bbj_invariants(2) WHERE check_name='I1_drop_under_3_dealt';")=='4','fail-before BBJ'
 assert len(json.loads(before_law))>=4,'fail-before rake'
 catalog=q("SELECT jsonb_agg(jsonb_build_array(oid,proowner,prosecdef,provolatile,proconfig,proacl) ORDER BY oid) FROM pg_proc WHERE oid IN('fn_rake_bbj_invariants(integer)'::regprocedure,'fn_rake_law_violations(interval)'::regprocedure);")
 migration=MIG.read_text()
 q('UPDATE fixture_freeze SET frozen=true;');q(migration,'rake_roster_freeze_refused');q('UPDATE fixture_freeze SET frozen=false;')
 q(migration.replace('COMMIT;',"DO $$ BEGIN RAISE EXCEPTION 'fixture_abort'; END $$; COMMIT;"),'fixture_abort')
 assert bbj()==before_bbj and law()==before_law,'rollback unchanged'
 q(migration)
 assert q("SELECT violations FROM fn_rake_bbj_invariants(2) WHERE check_name='I1_drop_under_3_dealt';")=='2','real under-three and missing roster remain'
 for name,flagged in [('three-dealt-two-contribute',False),('real-two-dealt',True),('missing-roster',True)]:
  ident=q("SELECT md5('"+name+"')::uuid;");assert (ident in bbj())==flagged,name
 for name,flagged in [('three-dealt-two-contribute',False),('real-two-dealt',True),('real-overrake',True),('missing-roster',True)]:
  ident=q("SELECT md5('"+name+"')::uuid;");assert (ident in law())==flagged,name
 assert catalog==q("SELECT jsonb_agg(jsonb_build_array(oid,proowner,prosecdef,provolatile,proconfig,proacl) ORDER BY oid) FROM pg_proc WHERE oid IN('fn_rake_bbj_invariants(integer)'::regprocedure,'fn_rake_law_violations(interval)'::regprocedure);"),'authority unchanged'
 for p in pins:assert q("SELECT md5(pg_get_functiondef('"+p['signature']+"'::regprocedure));")==p['after'],'exact postimage'
 q(migration,'rake_roster_preimage_refused')
 print('PASS: fail-before/pass-after; real heads-up BBJ and over-rake remain; missing roster fallback; rollback; freeze; exact source and authority')
finally:
 if started:run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(scratch)
