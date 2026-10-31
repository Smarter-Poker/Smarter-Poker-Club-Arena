#!/usr/bin/env python3
"""Real PG17 role/RLS/transaction tests using captured production definitions.
No production data or credentials. The test's dependencies model unchanged
membership lifecycle and union oversight; modified functions run verbatim.
"""
import json, os, subprocess, tempfile, shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
F=ROOT/'scripts/ci/fixtures/agent-data-boundary'
PG=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
parent=Path(os.environ.get('AGENT_BOUNDARY_SCRATCH',os.environ.get('RUNNER_TEMP','/Volumes/SmarterWork/agent-work/bank-downline-20261020')))
w=Path(tempfile.mkdtemp(prefix='ab-',dir=parent)); sock=w/'s';sock.mkdir(); data=w/'data'
def run(a,sql=None,fail=None):
 p=subprocess.run([str(x) for x in a],input=sql,text=True,capture_output=True,timeout=60)
 if fail: assert p.returncode and fail in p.stderr,(p.stdout,p.stderr,fail)
 else: assert p.returncode==0,(p.stdout,p.stderr)
 return p.stdout.strip()
def q(sql,fail=None):return run([PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','fixture_admin','postgres'],sql,fail)
def uid(n):return '00000000-0000-4000-8000-'+str(n).zfill(12)
def as_user(n,sql):return "SET ROLE authenticated; SET request.jwt.claim.sub='"+uid(n)+"';"+sql
restriction_path=next((ROOT/'supabase/migrations').glob('*_restrict_agent_banks_and_authorize_downline_reassignment.sql'))
migration=restriction_path.read_text()
assert restriction_path.name > next((ROOT/'supabase/migrations').glob('*_add_agent_assignment_transaction_before_client_publication.sql')).name, 'Full restrictions must follow the additive phase on fresh replay'
additive=next((ROOT/'supabase/migrations').glob('*_add_agent_assignment_transaction_before_client_publication.sql')).read_text()
try:
 run([PG/'initdb','-D',data,'-U','fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 run([PG/'pg_ctl','-D',data,'-o',"-h '' -k '"+str(sock)+"'",'-l',w/'pg.log','-w','start'])
 q("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth; CREATE SCHEMA extensions;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('role')$$;
 GRANT USAGE ON SCHEMA auth,public TO anon,authenticated,service_role;
 """)
 cols=json.loads((F/'columns.json').read_text())+json.loads((F/'roster-columns.json').read_text()); tables={}
 for c in cols:tables.setdefault(c['relname'],[]).append('"'+c['attname']+'" '+c['type'])
 for name,columns in tables.items():q('CREATE TABLE public.'+name+' ('+','.join(columns)+');')
 q("""CREATE FUNCTION public.fn_cashier_member_is_active(c uuid,u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM public.club_members WHERE club_id=c AND user_id=u AND status IN ('active','approved'))$$;
 CREATE FUNCTION public.fn_is_any_union_overseer(u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 CREATE FUNCTION public.fn_union_oversees_club(c uuid,u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 CREATE FUNCTION public.fn_ca_launch_accounting_start(s text,c uuid,t timestamptz) RETURNS timestamptz LANGUAGE sql AS $$SELECT t$$;
 CREATE FUNCTION public.fn_club_role_rank(r text) RETURNS integer LANGUAGE sql AS $$SELECT CASE r WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20 ELSE 0 END$$;
 CREATE FUNCTION public.fn_ca_declare_guard_redefinition(n text,r text) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
 SET check_function_bodies=off;""")
 for f in json.loads((F/'baseline.json').read_text())+[json.loads((F/'home.json').read_text()),json.loads((F/'admin-helper.json').read_text())]+[f for f in json.loads((F/'extra.json').read_text()) if f['proname'] in ['fn_actor_can_manage_club_treasury','fn_ca_is_club_staff','ca_club_operations_overview','fn_club_trade_ledger','ca_club_roster_rows','ca_club_roster_access','ca_club_members','ca_club_members_summary','fn_guard_agent_agreement']]:q('SET check_function_bodies=off;'+f['definition'])
 q("""CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION fn_is_platform_admin() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION fn_is_union_overseer(c uuid,u uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION fn_club_scope_ids(c uuid) RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY[c]$$;
 CREATE FUNCTION fn_ca_launch_accounting_cutoff(s text,c uuid) RETURNS timestamptz LANGUAGE sql AS $$SELECT NULL::timestamptz$$;
 CREATE FUNCTION fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql AS $$SELECT COALESCE($1,$2,$3,'Fixture')$$;
 CREATE FUNCTION ca_club_member_fee_totals(c uuid) RETURNS TABLE(user_id uuid,total_fees numeric) LANGUAGE sql AS $$SELECT NULL::uuid,0::numeric WHERE false$$;
 """)
 # Actors: owner1, super2, agent3, sub4, player5, sibling-agent6, unrelated7.
 club=uid(100)
 q("INSERT INTO clubs(id,name,owner_id) VALUES('"+club+"','Fixture Club','"+uid(1)+"');")
 for n,role,parent_id in [(1,'owner',None),(2,'super_agent',None),(3,'agent',2),(4,'sub_agent',3),(5,'player',4),(6,'agent',2),(7,'player',6),(8,'player',None)]:
  parent_sql="'"+uid(parent_id)+"'" if parent_id else 'NULL'
  q(f"INSERT INTO club_members(club_id,user_id,role,status,agent_id) VALUES('{club}','{uid(n)}','{role}','active',{parent_sql});")
  if role in ('super_agent','agent','sub_agent'):
   q(f"INSERT INTO agents(id,club_id,user_id,role,status,total_players) VALUES('{uid(200+n)}','{club}','{uid(n)}','{role}','active',0);")
 q("CREATE TRIGGER agreement BEFORE UPDATE OF parent_agent_id ON agents FOR EACH ROW EXECUTE FUNCTION fn_guard_agent_agreement();")
 q('GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated,anon; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;')
 q("ALTER TABLE club_members ENABLE ROW LEVEL SECURITY; CREATE POLICY base ON club_members FOR SELECT TO authenticated USING(true);")
 q("ALTER TABLE agents ENABLE ROW LEVEL SECURITY; CREATE POLICY base ON agents FOR SELECT TO authenticated USING(true);")
 q("ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY; CREATE POLICY base ON player_stats FOR SELECT TO authenticated USING(true);")
 q(f"INSERT INTO player_stats(club_id,user_id) SELECT club_id,user_id FROM club_members;")
 q("ALTER TABLE audit_trail ENABLE ROW LEVEL SECURITY; CREATE POLICY staff ON audit_trail FOR SELECT TO authenticated USING(is_club_admin(club_id));")
 q(f"INSERT INTO audit_trail(club_id,actor_id,action) VALUES('{club}','{uid(7)}','fixture_private');")
 assert q(as_user(3,f"SELECT is_club_admin('{club}');"))=='t'
 assert q(as_user(3,"SELECT count(*) FROM audit_trail;"))=='1'
 # Reproduce both actual flaws before installing the candidate.
 assert q(as_user(2,f"SELECT fn_can_use_club_bank('{club}');"))=='t'
 assert q(as_user(2,f"SELECT fn_cashier_statement_scope('{club}')->>'scope';"))=='all'
 assert q(as_user(3,f"SELECT count(*) FROM player_stats;"))=='8'
 # Check migration rollback and source-drift refusal, then apply once.
 q(migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'fixture_rollback';END$$;COMMIT;"),'fixture_rollback')
 assert q("SELECT to_regclass('public.club_assignment_operations') IS NULL;")=='t'
 # The first installation supports the client without changing old bank reads.
 q(additive)
 assert q(as_user(2,f"SELECT fn_can_use_club_bank('{club}');"))=='t'
 for n in [2,3,4]:
  assert q(as_user(n,f"SELECT fn_can_manage_club_assignments('{club}');"))=='f'
 assert q(as_user(1,f"SELECT fn_can_manage_club_assignments('{club}');"))=='t'
 q(migration)
 q(migration,'AGENT_BOUNDARY_SOURCE_CHANGED')
 for n in [2,3,4]:
  assert q(as_user(n,f"SELECT is_club_admin('{club}');"))=='f'
  assert q(as_user(n,"SELECT count(*) FROM audit_trail;"))=='0'
  assert q(as_user(n,f"SELECT fn_can_use_club_bank('{club}');"))=='f'
  assert q(as_user(n,f"SELECT fn_cashier_statement_scope('{club}')->>'scope';"))=='downline'
  assert q(as_user(n,f"SELECT ca_can_view_club_finances('{club}');"))=='f'
  assert q(as_user(n,f"SELECT fn_club_money_panel('{club}') ? 'club_treasury';"))=='f'
  q(as_user(n,f"SELECT chip_treasury FROM clubs;"),'permission denied')
  q(as_user(n,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(8)}'::uuid],'{uid(3)}','{uid(900+n)}');"),'not_authorised')
 assert q(as_user(3,f"SELECT count(*) FROM ca_club_roster_rows('{club}');"))=='3'
 assert q(as_user(3,f"SELECT ca_club_roster_access('{club}','{uid(7)}');"))=='none'
 q(as_user(3,f"SELECT ca_club_operations_overview('{club}');"),'not authorized')
 assert q(as_user(3,"SELECT count(*) FROM player_stats;"))=='3' # self, sub, player
 assert q(as_user(4,"SELECT count(*) FROM club_members;"))=='2'
 assert q(as_user(2,"SELECT count(*) FROM agents;"))=='4'
 assert q(as_user(1,f"SELECT fn_can_use_club_bank('{club}');"))=='t'
 assert q(as_user(1,f"SELECT is_club_admin('{club}');"))=='t'
 q(f"UPDATE club_members SET status='suspended' WHERE user_id='{uid(1)}';")
 assert q(as_user(1,f"SELECT is_club_admin('{club}');"))=='f'
 q(f"UPDATE club_members SET status='active' WHERE user_id='{uid(1)}';")
 op=uid(901)
 call=f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(5)}'::uuid],'{uid(6)}','{op}','{uid(4)}')->>'moved';"
 assert q(as_user(1,call))=='1'
 assert q(as_user(3,"SELECT count(*) FROM player_stats;"))=='2'
 assert q(as_user(6,"SELECT count(*) FROM player_stats;"))=='3'
 assert q(as_user(1,call.replace("->>'moved'","->>'replayed'")))=='true'
 q(as_user(1,call.replace(uid(6),uid(3))),'assignment_operation_conflict')
 q(as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(4)}'::uuid],'{uid(3)}','{uid(902)}','{uid(6)}');"),'assignment_changed_reload_members')
 q(as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(2)}'::uuid],'{uid(4)}','{uid(903)}');"),'would_create_cycle')
 q(as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(8)}'::uuid,'{uid(99)}'::uuid],'{uid(6)}','{uid(904)}');"),'member_not_active_in_club')
 assert q(f"SELECT agent_id IS NULL FROM club_members WHERE user_id='{uid(8)}';")=='t'
 q(as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(4)}'::uuid],'{uid(6)}','{uid(905)}');"))
 assert q(f"SELECT parent_agent_id='{uid(206)}' FROM agents WHERE user_id='{uid(4)}';")=='t'
 assert q("SELECT count(*) FROM audit_trail;")=='3'
 assert q(f"SELECT count(*) FROM audit_trail WHERE action='reassign_club_downline' AND club_id='{club}';")=='2'
 q("SET ROLE anon;SELECT * FROM club_assignment_operations;",'permission denied')
 q("SET ROLE authenticated;SELECT * FROM club_assignment_operations;",'permission denied')
 # The unchanged production agreement trigger must reject a transfer that
 # would exceed its new parent's commercial cap, rolling back both links.
 q(f"UPDATE agents SET commission_rate=CASE WHEN user_id='{uid(3)}' THEN .4 WHEN user_id='{uid(6)}' THEN .2 ELSE .3 END,player_rakeback_rate=.1,credit_limit=100 WHERE club_id='{club}';")
 q(as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(4)}'::uuid],'{uid(3)}','{uid(906)}');"))
 q(as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(4)}'::uuid],'{uid(6)}','{uid(907)}');"),'parent cap')
 assert q(f"SELECT agent_id='{uid(3)}' FROM club_members WHERE user_id='{uid(4)}';")=='t'
 assert q(f"SELECT parent_agent_id='{uid(203)}' FROM agents WHERE user_id='{uid(4)}';")=='t'
 # Two real connections contend on the club agreement. The waiting request
 # must re-check its source after the winning transfer commits.
 first=subprocess.Popen([str(PG/'psql'),'-XqAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-U','fixture_admin','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 second=None
 try:
  first.stdin.write("BEGIN;"+as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(7)}'::uuid],'{uid(3)}','{uid(908)}','{uid(6)}')->>'moved';SELECT 'ab_lock_held';")+"\n");first.stdin.flush()
  while first.stdout.readline().strip()!='ab_lock_held':
   if first.poll() is not None:raise RuntimeError(first.stderr.read())
  second=subprocess.Popen([str(PG/'psql'),'-XqAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-U','fixture_admin','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  second.stdin.write("SET application_name='ab_competing';"+as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(7)}'::uuid],'{uid(4)}','{uid(909)}','{uid(6)}');")+"\n");second.stdin.close()
  import time
  waiting=False
  for _ in range(40):
   if q("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='ab_competing' AND wait_event_type='Lock');")=='t':waiting=True;break
   time.sleep(.025)
  assert waiting,'Competing assignment did not wait for the original agreement transaction'
  first.stdin.write('COMMIT;\n');first.stdin.close();assert first.wait(timeout=5)==0
  assert second.wait(timeout=5)!=0 and 'assignment_changed_reload_members' in second.stderr.read()
  assert q(f"SELECT agent_id='{uid(3)}' FROM club_members WHERE user_id='{uid(7)}';")=='t'
 finally:
  for process in [first,second]:
   if process is not None and process.poll() is None:process.terminate();process.wait(timeout=5)
 print('PASS: unchanged commercial caps roll back both hierarchy links; competing original operations serialize and recheck committed source')
 print('PASS: baseline bank/statement/player-data flaws reproduced; exact migration rollback, replay refusal, role/RLS boundaries, private columns, assignment authorization, immediate scope change, idempotency conflict, source CAS, cycles, atomic refusal, agent subtree and audit verified')
 exec(compile((F/'transfer-controls-contract.py').read_text(),str(F/'transfer-controls-contract.py'),'exec'))
 exec(compile((F/'helper-oracle-contract.py').read_text(),str(F/'helper-oracle-contract.py'),'exec'))
 exec(compile((F/'data-player-search-contract.py').read_text(),str(F/'data-player-search-contract.py'),'exec'))
finally:
 if (data/'postmaster.pid').exists():run([PG/'pg_ctl','-D',data,'-m','fast','-w','stop'])
 shutil.rmtree(w)
