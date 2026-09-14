"""Native PostgreSQL 17 proof for complete, account-bound statement pagination."""
import argparse,datetime,json,os,pathlib,shutil,subprocess,tempfile,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=pathlib.Path,default=ROOT/'artifacts/chip-statement-cursor')
a=p.parse_args();out=a.output.resolve();out.mkdir(parents=True,exist_ok=False)
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C'
cluster=pathlib.Path(tempfile.mkdtemp(prefix='codex-statement-'));sock=cluster/'socket';sock.mkdir(mode=0o700)
cmd=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55747','-U','postgres','-d','postgres']
results={'checks':[],'production_mutations':False,'scope':'Actual statement functions; external balance and club policy readers are fixture contracts.'}
user=str(uuid.UUID(int=1));other=str(uuid.UUID(int=2));club=str(uuid.UUID(int=3));club2=str(uuid.UUID(int=4))
def command(argv,sql=None):
 r=subprocess.run(list(map(str,argv)),input=sql,text=True,capture_output=True,env=env,timeout=40)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def run(sql):return command(cmd,sql)
def check(name,value):
 results['checks'].append({'name':name,'passed':bool(value)})
 if not value:raise AssertionError(name)
def lit(v):return "'"+str(v).replace("'","''")+"'"
def identity(who=user,role='authenticated'):
 return "SET ROLE "+role+"; SELECT set_config('request.jwt.claim.sub',"+lit(who or '')+",false); SELECT set_config('request.jwt.claim.role',"+lit(role)+",false);"
def page(cursor=None,limit=50,scope='player',filter_club=None,who=user,role='authenticated',rpc='fn_ca_chip_statement_page'):
 cur='NULL' if cursor is None else lit(json.dumps(cursor))+'::jsonb'
 raw=run(identity(who,role)+" SELECT public."+rpc+"("+lit(scope)+","+(lit(filter_club)+"::uuid" if filter_club else 'NULL')+","+cur+","+str(limit)+");")
 return json.loads(raw.splitlines()[-1])
def refuses(name,sql,match):
 r=subprocess.run(cmd,input=sql,text=True,capture_output=True,env=env,timeout=20)
 check(name,r.returncode!=0 and match in r.stderr)
try:
 check('postgres17',command([pg/'postgres','--version']).startswith('postgres (PostgreSQL) 17.'))
 if shutil.disk_usage('/tmp').free<1024**3:raise RuntimeError('one GiB disk reserve required')
 command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'server.log','-o',f"-k {sock} -p 55747 -c listen_addresses='' -c shared_buffers=16MB -c max_connections=10",'-w','start'])
 run("""
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
 CREATE TABLE clubs(id uuid PRIMARY KEY,name text);
 CREATE TABLE club_members(user_id uuid,club_id uuid,chip_balance numeric);
 CREATE TABLE ca_account_snapshots(account_key text,balance numeric,taken_at timestamptz,cum_unexplained numeric,is_baseline boolean);
 CREATE TABLE chip_ledger(id uuid PRIMARY KEY,created_at timestamptz NOT NULL,amount numeric,category text,description text,club_id uuid,table_id uuid,tournament_id uuid,hand_id uuid,settlement_id uuid,from_type text,from_label text,from_entity_id uuid,to_type text,to_label text,to_entity_id uuid);
 CREATE FUNCTION fn_ca_account_balance(text,uuid,uuid,text) RETURNS numeric LANGUAGE sql STABLE AS $$SELECT 123::numeric$$;
 """)
 run("CREATE FUNCTION ca_can_view_club_finances(c uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT auth.role()='service_role' OR (auth.uid()="+lit(user)+"::uuid AND c="+lit(club)+"::uuid)$$;")
 old=(ROOT/'supabase/migrations/20260907222626_a_player_can_audit_their_own_chips.sql').read_text()
 old=old[old.index('CREATE OR REPLACE FUNCTION public.fn_ca_chip_statement('):];old=old[:old.index('END $fn$;')+len('END $fn$;')]
 run(old)
 results['definition_hashes']={'baseline':run("SELECT md5(pg_get_functiondef('fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure))")}
 run(f"INSERT INTO clubs VALUES('{club}','One'),('{club2}','Two');INSERT INTO club_members VALUES('{user}','{club}',123);")
 run(f"""
 INSERT INTO chip_ledger(id,created_at,amount,category,club_id,from_type,from_entity_id,to_type,to_entity_id)
 SELECT lpad(to_hex(g),32,'0')::uuid,'2099-01-02T03:04:05.123456Z',g,'transfer',
 CASE WHEN g%3=0 THEN '{club2}'::uuid ELSE '{club}'::uuid END,
 'player_wallet',CASE WHEN g%2=0 THEN '{user}'::uuid ELSE '{other}'::uuid END,
 'player_wallet',CASE WHEN g%2=0 THEN '{other}'::uuid ELSE '{user}'::uuid END FROM generate_series(10,146)g;
 INSERT INTO chip_ledger(id,created_at,amount,category,club_id,table_id,tournament_id,hand_id,settlement_id,from_type,from_label,from_entity_id,to_type,to_label,to_entity_id) VALUES('{uuid.UUID(int=500)}','2099-01-02T03:04:05.123456Z',5,'self',NULL,NULL,NULL,NULL,NULL,'player_wallet',NULL,'{user}','player_wallet',NULL,'{user}');
 INSERT INTO chip_ledger(id,created_at,amount,category,from_type,from_entity_id,to_type,to_entity_id)
 VALUES('{uuid.UUID(int=600)}','2099-01-01T00:00:00Z',3,'older','player_wallet','{other}','player_wallet','{user}');
 INSERT INTO chip_ledger(id,created_at,amount,category,from_type,from_entity_id,to_type,to_entity_id)
 VALUES('{uuid.UUID(int=700)}','2099-01-03T00:00:00Z',999,'not-the-caller','system_mint',NULL,'player_wallet','{other}');
 """)
 first=json.loads(run(identity()+ "SELECT fn_ca_chip_statement('player',NULL,NULL,50);").splitlines()[-1])
 second=json.loads(run(identity()+ "SELECT fn_ca_chip_statement('player',NULL,"+lit(first['next_before'])+"::timestamptz,50);").splitlines()[-1])
 check('baseline-timestamp-cursor-skips-89-same-transaction-legs',len(first['legs'])==50 and first['has_more'] and len(second['legs'])==1)
 snapshot=run("SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM chip_ledger l")
 migration=(ROOT/'supabase/migrations/20260914060300_chip_statement_complete_page_cursor.sql').read_text()+(ROOT/'supabase/migrations/20260914062000_chip_statement_legacy_cursor_refusal.sql').read_text();run(migration)
 def expected(filter_club=None):
  predicate="" if filter_club is None else " AND club_id="+lit(filter_club)+"::uuid"
  return json.loads(run("SELECT jsonb_agg(jsonb_build_array(id,direction) ORDER BY created_at DESC,id DESC,direction ASC) FROM(SELECT id,created_at,'in' direction FROM chip_ledger WHERE to_type='player_wallet' AND to_entity_id="+lit(user)+"::uuid"+predicate+" UNION ALL SELECT id,created_at,'out' FROM chip_ledger WHERE from_type='player_wallet' AND from_entity_id="+lit(user)+"::uuid"+predicate+")q"))
 for size in (1,2,7,50,200):
  cursor=None;seen=[];pages=0
  while True:
   got=page(cursor,size);pages+=1
   check(f'page-{size}-{pages}-bounded',len(got['legs'])<=size)
   seen.extend([[x['id'],x['direction']] for x in got['legs']])
   if not got['has_more']:
    check(f'page-{size}-end-has-no-cursor',got['next_cursor'] is None);break
   check(f'page-{size}-{pages}-cursor-advances',got['next_cursor'] is not None and got['next_cursor']!=cursor)
   cursor=got['next_cursor']
   if pages>145:raise RuntimeError('page loop did not terminate')
  check(f'page-{size}-exact-once-complete-order',seen==expected())
 check('self-transfer-retains-both-directions',expected().count([str(uuid.UUID(int=500)),'in'])==1 and expected().count([str(uuid.UUID(int=500)),'out'])==1)
 cursor=page(limit=1)['next_cursor']
 check('cursor-keeps-postgres-microseconds',datetime.datetime.fromisoformat(cursor['at']).microsecond==123456)
 check('cursor-is-bound-to-account-and-filter',cursor['account']=='player_wallet:'+user+':club_members.chip_balance' and cursor['club_filter'] is None)
 check('club-filter-returns-only-authorized-account-legs',[[x['id'],x['direction']] for x in page(limit=200,filter_club=club)['legs']]==expected(club))
 check('limit-zero-clamps-to-one',len(page(limit=0)['legs'])==1)
 check('limit-large-clamps-to-200',len(page(limit=9999)['legs'])==140)
 for label,cur in [('array',[]),('null',None),('partial',{'at':cursor['at']}),('direction',{**cursor,'direction':'sideways'}),('other-account',{**cursor,'account':'player_wallet:'+other+':club_members.chip_balance'}),('infinity',{**cursor,'at':'infinity'}),('invalid-uuid',{**cursor,'id':'bad'})]:
  literal=lit(json.dumps(cur))+'::jsonb'
  refuses('reject-cursor-'+label,identity()+f"SELECT fn_ca_chip_statement_page('player',NULL,{literal},5);",'ERROR')
 refuses('reject-cursor-other-club',identity()+f"SELECT fn_ca_chip_statement_page('player','{club}',"+lit(json.dumps(cursor))+"::jsonb,5);",'cursor')
 refuses('unauthenticated-player-refused',identity(None)+ "SELECT fn_ca_chip_statement_page('player');",'authentication required')
 refuses('service-cannot-request-unnamed-player',identity(None,'service_role')+ "SELECT fn_ca_chip_statement_page('player');",'own')
 refuses('unauthorized-treasury-refused',identity()+f"SELECT fn_ca_chip_statement_page('club_treasury','{club2}');",'not authorized')
 check('authorized-treasury-allowed',page(scope='club_treasury',filter_club=club)['scope']=='club_treasury')
 refuses('anonymous-execute-refused',"SET ROLE anon;SELECT fn_ca_chip_statement_page();",'permission denied for function')
 check('browser-cannot-read-base-ledger',run("SELECT NOT has_table_privilege('authenticated','chip_ledger','SELECT')")=='t')
 check('accounting-fields-unchanged',{k:page()[k] for k in ('balance_now','balance_exists','clubs','account','audit')}=={k:first[k] for k in ('balance_now','balance_exists','clubs','account','audit')})
 policy=run("SELECT pg_get_functiondef('ca_can_view_club_finances(uuid)'::regprocedure)")
 run("CREATE OR REPLACE FUNCTION ca_can_view_club_finances(c uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT NULL::boolean$$;")
 refuses('null-policy-cannot-authorize-new-reader',identity()+f"SELECT fn_ca_chip_statement_page('club_treasury','{club}');",'not authorized')
 refuses('null-policy-cannot-authorize-legacy-reader',identity()+f"SELECT fn_ca_chip_statement('club_treasury','{club}');",'not authorized')
 run(policy)
 check('legacy-browser-ACL-remains-closed',run("SELECT NOT has_function_privilege('anon','fn_ca_chip_statement(text,uuid,timestamptz,integer)','EXECUTE') AND has_function_privilege('authenticated','fn_ca_chip_statement(text,uuid,timestamptz,integer)','EXECUTE')")=='t')
 before_replay=page()['legs'];run(migration);check('migration-replay-preserves-first-page',page()['legs']==before_replay)
 refuses('legacy-cached-reader-refuses-timestamp-tie',identity()+"SELECT fn_ca_chip_statement('player',NULL,NULL,50);",'refresh the page')
 legacy_old=json.loads(run(identity()+"SELECT fn_ca_chip_statement('player',NULL,'2099-01-02T00:00:00Z',50);").splitlines()[-1])
 check('legacy-unambiguous-page-still-works',len(legacy_old['legs'])==1 and not legacy_old['has_more'])
 check('all-reader-probes-preserve-ledger',run("SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM chip_ledger l")==snapshot)
 current_page=run("SELECT pg_get_functiondef('fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure)")
 current_legacy=run("SELECT pg_get_functiondef('fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure)")
 run(current_page.replace('DECLARE','DECLARE\n-- unqualified native fixture change',1))
 refuses('unqualified-paged-definition-is-preserved',migration,'paged statement reader changed')
 run(current_page)
 run(current_legacy.replace('DECLARE','DECLARE\n-- unqualified native fixture change',1))
 refuses('unqualified-legacy-definition-is-preserved',migration,'statement reader changed')
 run(current_legacy)
 cached_cursor=identity()+"SELECT fn_ca_chip_statement('player',NULL,"+lit(first['next_before'])+"::timestamptz,50);"
 cached_before=json.loads(run(cached_cursor).splitlines()[-1])
 check('baseline-pre-upgrade-cached-cursor-still-skips-ties',len(cached_before['legs'])==1)
 cached_migration=(ROOT/'supabase/migrations/20260914070300_chip_statement_cached_boundary_refusal.sql').read_text()
 run(cached_migration)
 refuses('pre-upgrade-cached-cursor-requires-refresh',cached_cursor,'refresh the page')
 check('complete-cursor-reader-unchanged-after-compatibility-fix',page()['legs']==before_replay)
 legacy_after=json.loads(run(identity()+"SELECT fn_ca_chip_statement('player',NULL,'2099-01-02T00:00:00Z',50);").splitlines()[-1])
 check('unambiguous-legacy-continuation-preserved',{k:v for k,v in legacy_after.items() if k not in ('generated_at','ms')}=={k:v for k,v in legacy_old.items() if k not in ('generated_at','ms')})
 run(cached_migration)
 refuses('cached-boundary-migration-replay-remains-safe',cached_cursor,'refresh the page')
 refuses('cached-boundary-does-not-open-anonymous-reader',"SET ROLE anon;SELECT fn_ca_chip_statement();",'permission denied for function')
 check('compatibility-fix-preserves-ledger',run("SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM chip_ledger l")==snapshot)
 new_legacy=run("SELECT pg_get_functiondef('fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure)")
 run(new_legacy.replace('DECLARE','DECLARE\n-- unknown compatibility change',1))
 refuses('cached-boundary-rejects-unqualified-definition',cached_migration,'legacy statement reader changed')
 run(new_legacy)
 results['definition_hashes']['page']=run("SELECT md5(pg_get_functiondef('fn_ca_chip_statement_page(text,uuid,jsonb,integer)'::regprocedure))")
 results['definition_hashes']['legacy_guard']=run("SELECT md5(pg_get_functiondef('fn_ca_chip_statement(text,uuid,timestamptz,integer)'::regprocedure))")
 results['passed']=True
finally:
 if (cluster/'data/postmaster.pid').exists():command([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster);results['owned_cluster_removed']=not cluster.exists()
 (out/'RESULTS.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps({'passed':results.get('passed',False),'checks':len(results['checks']),'evidence':str(out)}))
