#!/usr/bin/env python3
"""Original Lightning intent -> real platform funding doors, isolated PostgreSQL 17.

Exact catalog-captured funding/ledger/baseline/idempotency and terminal-transition
functions run unchanged. No network, production writes, financial mocks or repair
loop. Formation concurrency exercises the actual barrier's anchor lock and exact
pending predicate; this is not a whole matcher qualification.
"""
import argparse, concurrent.futures, hashlib, json, os, pathlib, re, shutil, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--output',type=pathlib.Path,default=ROOT/'work/lightning-topup-native')
out=parser.parse_args().output;out.mkdir(parents=True,exist_ok=True)
PG=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
env=dict(os.environ,LC_ALL='C',LANG='C');results=[]
# Short socket path on the external work volume on the Mac; CI's TMPDIR is local runner scratch.
scratch=pathlib.Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or str(ROOT/'work'))
scratch.mkdir(parents=True,exist_ok=True)
cluster=pathlib.Path(tempfile.mkdtemp(prefix='ltu-',dir=scratch))
sock=cluster/'s';sock.mkdir()
owner=['runuser','-u','postgres','--'] if os.geteuid()==0 else []
if owner: shutil.chown(cluster,'postgres');shutil.chown(sock,'postgres')
port='55843';psql=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p',port,'-U','postgres','-d','postgres']
def cmd(args,sql=None,fail=False):
 p=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=60)
 if (p.returncode!=0)!=fail: raise RuntimeError(p.stdout+p.stderr)
 return p.stdout.strip()
def q(sql,fail=False): return cmd(psql,'SET check_function_bodies=off;\n'+sql,fail)
def check(name,value):
 results.append({'name':name,'passed':bool(value)})
 if not value: raise AssertionError(name)
def uuid(n): return f'00000000-0000-4000-8000-{n:012d}'
T,U,C,S,O,P,CS,H=[uuid(n) for n in range(1,9)]
def request(key='request01',amount=30):
 return json.loads(q(f"SELECT public.fn_lightning_top_up_request('{T}','{U}','{key}',{amount})"))
def funding(): return q('SELECT jsonb_build_array((SELECT chip_balance FROM club_members),(SELECT stack FROM table_seats),(SELECT baseline FROM cash_player_session),(SELECT count(*) FROM chip_ledger),(SELECT count(*) FROM wallet_transactions),(SELECT count(*) FROM cash_participant_funding_receipts))')
def reset():
 q('TRUNCATE smarter_private.lightning_top_up_sessions,smarter_private.lightning_top_up_intents,table_seats,club_members,clubs,cash_player_session,lightning_pool_session,lightning_instance,lightning_hand_player,lightning_reservation,lightning_pool_slot,cash_cluster_events,chip_ledger,wallet_transactions,cash_participant_funding_receipts,entry_purchase_idempotency_receipts,table_addon_idempotency,engine_maintenance_break;')
 q(f"""INSERT INTO clubs(id,asset) VALUES('{C}','chips');
 INSERT INTO tables(id,club_id,max_buy_in,cluster_id) VALUES('{T}','{C}',100,'{C}') ON CONFLICT(id) DO UPDATE SET max_buy_in=100;
 INSERT INTO cash_games(id,cluster_mode) VALUES('{C}','lightning') ON CONFLICT(id) DO NOTHING;
 INSERT INTO table_seats(id,table_id,user_id,occupancy_id,club_id,stack,joined_at,leave_pending,is_sitting_out) VALUES('{S}','{T}','{U}','{O}','{C}',20,now(),false,false);
 INSERT INTO club_members(user_id,club_id,chip_balance,status) VALUES('{U}','{C}',100,'active');
 INSERT INTO cash_player_session(id,player_id,table_id,scope_type,scope_id,baseline,stay_remaining_ms,stay_running) VALUES('{CS}','{U}','{T}','table','{T}',20,0,false);
 INSERT INTO lightning_pool_session(id,anchor_seat_id,player_id,cluster_id,cash_player_session_id,state,cluster_epoch,entered_at) VALUES('{P}','{S}','{U}','{C}','{CS}','active',1,now());
 INSERT INTO lightning_pool_slot(id,pool_session_id,cluster_id,cluster_epoch,player_id,opened_at) VALUES('{uuid(10)}','{P}','{C}',1,'{U}',now());
 INSERT INTO lightning_instance(id,hand_id,cluster_id,state,started_at,cluster_epoch) VALUES('{H}','{H}','{C}','dealing',now(),1);
 INSERT INTO lightning_hand_player(hand_id,player_id) VALUES('{H}','{U}');""")
try:
 cmd(owner+[PG/'initdb','-D',cluster/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 cmd(owner+[PG/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',f"-k {sock} -p {port} -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
 q('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA smarter_private; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
 CREATE TABLE clubs(id uuid PRIMARY KEY,asset text,union_id uuid);
 CREATE TABLE cash_games(id uuid PRIMARY KEY,cluster_mode text,lightning_enabled boolean DEFAULT true,cluster_epoch integer DEFAULT 1,handedness integer DEFAULT 6,template_name text DEFAULT 'action',ruleset_snapshot jsonb DEFAULT '{"template":"action"}');
 CREATE TABLE cash_cluster_epoch(cluster_id uuid,epoch integer,ended_at timestamptz);
 CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,max_buy_in numeric,cluster_id uuid,tournament_id uuid,is_template boolean DEFAULT false,is_deleted boolean DEFAULT false,lifecycle text DEFAULT 'active');
 CREATE TABLE ca_operator_policy(restrictions_enforced boolean);
 CREATE TABLE ca_player_restrictions(user_id uuid,status text,expires_at timestamptz,scope text,applied_at timestamptz,reason_code text);
 CREATE TABLE responsible_gaming_limits(user_id uuid,self_excluded_until timestamptz,cooling_off_until timestamptz);
 CREATE TABLE table_seats(id uuid PRIMARY KEY,table_id uuid,user_id uuid,occupancy_id uuid,club_id uuid,stack numeric,left_at timestamptz,joined_at timestamptz,leave_pending boolean,is_sitting_out boolean);
 CREATE TABLE club_members(user_id uuid,club_id uuid,chip_balance numeric CHECK(chip_balance>=0),status text,updated_at timestamptz,PRIMARY KEY(user_id,club_id));
 CREATE TABLE cash_player_session(id uuid PRIMARY KEY,player_id uuid,table_id uuid,scope_type text,scope_id uuid,baseline numeric,closed_at timestamptz,stay_remaining_ms integer,stay_running boolean,stay_last_tick_at timestamptz);
 CREATE TABLE lightning_pool_session(id uuid PRIMARY KEY,anchor_seat_id uuid,player_id uuid,cluster_id uuid,cash_player_session_id uuid,cluster_epoch integer,state text,stop_requested_at timestamptz,entered_at timestamptz,exited_at timestamptz,exit_reason text,ending_stack numeric,updated_at timestamptz);
 CREATE TABLE lightning_instance(id uuid PRIMARY KEY,hand_id uuid,cluster_id uuid,state text,started_at timestamptz,cluster_epoch integer,abandon_reason text,created_at timestamptz DEFAULT now(),deadline_at timestamptz DEFAULT now()+interval '10 minutes',completed_at timestamptz);
 CREATE TABLE lightning_hand_player(hand_id uuid,player_id uuid,pool_slot_id uuid,blind_role text,position text);
 CREATE TABLE lightning_hand(hand_id uuid,formed_at timestamptz);
 CREATE TABLE lightning_pool_slot(id uuid,pool_session_id uuid,cluster_id uuid,cluster_epoch integer,player_id uuid,closed_at timestamptz,opened_at timestamptz,close_reason text,updated_at timestamptz);
 CREATE TABLE lightning_settlement_marker(txid xid8,seat_id uuid);
 CREATE TABLE lightning_reservation(expires_at timestamptz,player_id uuid,lightning_instance_id uuid,state text,resolved_at timestamptz,reason text,cluster_id uuid);
 CREATE TABLE cash_cluster_events(game_id uuid,table_id uuid,kind text,payload jsonb,cluster_epoch integer);
 CREATE TABLE engine_maintenance_break(enforce_freeze boolean,announced_at timestamptz,phase text,break_started_at timestamptz,break_ends_at timestamptz);
 CREATE TABLE engine_maintenance_thaws(contract_version integer,release_target_at timestamptz,shifted jsonb);
 CREATE TABLE table_pending_addons(id uuid DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,amount numeric);
 CREATE TABLE table_addon_idempotency(key text PRIMARY KEY,user_id uuid,table_id uuid,amount numeric,applied_to_seat boolean);
 CREATE TABLE entry_purchase_idempotency_receipts(key_domain text,idempotency_key text,request jsonb,response jsonb,completed_at timestamptz,PRIMARY KEY(key_domain,idempotency_key));
 CREATE TABLE chip_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),performed_by uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric,category text,club_id uuid,tournament_id uuid,description text);
 CREATE TABLE wallet_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,wallet_type text,type text,amount numeric,category text,description text,table_id uuid,balance_after numeric);
 CREATE TABLE cash_participant_funding_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),operation_kind text,operation_key text,user_id uuid,table_id uuid,seat_id uuid,occupancy_id uuid,seat_joined_at timestamptz,source_ledger_id uuid,wallet_transaction_id uuid,account_type text,account_entity_id uuid,funding_club_id uuid,funding_union_id uuid,asset text,amount numeric,balance_before numeric,balance_after numeric,pending_addon_id uuid);
 ''')
 fixtures=ROOT/'scripts/ci/fixtures'
 # SQL-language dependencies must be installed before their callers.
 for file in ['lightning-topup-maintenance-doors.json','lightning-topup-funding-doors.json','lightning-topup-preimages.json','lightning-topup-anchor-door.json','lightning-topup-matcher-doors.json','lightning-topup-extra-doors.json','lightning-topup-legality-doors.json']:
  definitions=json.loads((fixtures/file).read_text())
  if file.startswith('lightning-topup-maintenance'): definitions.sort(key=lambda x: not x['signature'].startswith('fn_active_'))
  for d in definitions:
   q(d['definition']+';')
   check('exact-original-'+d['signature'],q(f"SELECT md5(pg_get_functiondef('public.{d['signature']}'::regprocedure))") == d['md5'])
 # Actual live-hand reader, not a cached matcher reservation: early folders count.
 source=(ROOT/'supabase/migrations/20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql').read_text()
 live=re.search(r'CREATE OR REPLACE FUNCTION public.fn_lightning_player_live_hand\(.*?\$function\$;',source,re.S).group(0)
 # Current coalesce fix, which doesn't affect the overlapping dealt-hand branch.
 q(live)
 q('CREATE TRIGGER actual_wallet_journal AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_ledger_writer();')
 migrations=list((ROOT/'supabase/migrations').glob('*_lightning_top_up_original_intents_finish_at_the_final_hand_*.sql'))
 if len(migrations)!=1: raise RuntimeError('exactly one maintained original-intent migration required')
 migration=migrations[0];sql=migration.read_text()
 q(sql)
 q("CREATE TRIGGER actual_anchor_guard BEFORE UPDATE OF stack,left_at,user_id ON table_seats FOR EACH ROW WHEN(ROW(OLD.stack,OLD.left_at,OLD.user_id) IS DISTINCT FROM ROW(NEW.stack,NEW.left_at,NEW.user_id)) EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard();")
 q("CREATE TRIGGER actual_terminal AFTER UPDATE ON lightning_instance FOR EACH ROW WHEN(NEW.state IN ('complete','abandoned') AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION fn_lightning_instance_releases_its_reservations();")
 q("CREATE TRIGGER actual_exit AFTER UPDATE OF left_at,user_id ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_table_seats_lightning_pool_follows_seat();")
 reset();before=funding();r=request();check('live-hand-intent-is-uncharged',r['queued'] and not r['charged'] and r['applied']==0 and funding()==before)
 check('same-original-request-replay',request()['replayed'] and funding()==before)
 check('changed-original-payload-refused',request(amount=31)['success'] is False and funding()==before)
 check('second-original-intent-refused',request('request02')['success'] is False and funding()==before)
 # Two outstanding hands, even after a fast fold released the reservation.
 H2=uuid(9);q(f"INSERT INTO lightning_instance(id,hand_id,cluster_id,state,started_at,cluster_epoch) VALUES('{H2}','{H2}','{C}','dealing',now(),1); INSERT INTO lightning_hand_player(hand_id,player_id) VALUES('{H2}','{U}'); UPDATE lightning_instance SET state='complete' WHERE id='{H}';")
 q(f"SELECT atomic_table_addon('{U}','{T}',30,true,'probe-key-123');",True)
 check('actual-anchor-guard-rolls-back-wallet-journal-on-live-credit',funding()==before)
 check('older-hand-completion-cannot-fund',funding()==before and q("SELECT status FROM smarter_private.lightning_top_up_intents")=='pending')
 q(f"UPDATE lightning_instance SET state='complete' WHERE id='{H2}';")
 check('last-hand-credit-needs-no-settlement-marker',q('SELECT count(*) FROM lightning_settlement_marker')=='0')
 check('final-hand-funds-once-with-real-wallet-ledger-and-origin',json.loads(funding())==[70,50,50,1,1,1])
 check('terminal-replay-does-not-fund-again',request()['replayed'] and json.loads(funding())==[70,50,50,1,1,1])
 check('canonical-applied-count-is-one-after-terminal-replay',q('SELECT applied_count FROM smarter_private.lightning_top_up_sessions')=='1')
 check('completion-event-one-private-terminal-receipt',q("SELECT count(*) FROM cash_cluster_events WHERE kind='lightning_top_up_completed'")=='1')
 check('original-funding-custody-preserved',q(f"SELECT count(*) FROM cash_participant_funding_receipts WHERE occupancy_id='{O}' AND funding_club_id='{C}' AND amount=30")=='1')
 reset();request(amount=90);q(f"BEGIN; INSERT INTO lightning_settlement_marker VALUES(pg_current_xact_id(),'{S}'); UPDATE table_seats SET stack=80; DELETE FROM lightning_settlement_marker; UPDATE lightning_instance SET state='complete' WHERE id='{H}'; COMMIT;")
 check('cap-applies-only-actual-headroom',json.loads(funding())==[80,100,40,1,1,1])
 reset();q(f"UPDATE tables SET max_buy_in=NULL WHERE id='{T}';");request();q(f"UPDATE lightning_instance SET state='complete' WHERE id='{H}';")
 check('unconfigured-maximum-preserves-original-addon-door-semantics',json.loads(funding())==[70,50,50,1,1,1])
 reset();q(f"UPDATE lightning_instance SET state='complete' WHERE id='{H}';")
 immediate=request()
 check('between-hands-original-request-applies-immediately-once',immediate['status']=='applied' and immediate['charged'] is True and immediate['queued'] is False and json.loads(funding())==[70,50,50,1,1,1])
 reset()
 check('non-cent-original-request-is-refused-without-intent-or-charge',request(amount=1.001)['success'] is False and q('SELECT count(*) FROM smarter_private.lightning_top_up_intents')=='0' and json.loads(funding())==[100,20,20,0,0,0])
 reset();request();q("UPDATE club_members SET chip_balance=5; TRUNCATE chip_ledger;")
 q(f"UPDATE lightning_instance SET state='complete' WHERE id='{H}';")
 check('insufficient-funds-terminal-refusal-is-atomic',json.loads(funding())==[5,20,20,0,0,0] and q("SELECT status FROM smarter_private.lightning_top_up_intents")=='refused')
 reset();request();q(f"UPDATE lightning_instance SET state='abandoned' WHERE id='{H}';")
 check('abandonment-closes-uncharged-intent',json.loads(funding())==[100,20,20,0,0,0] and q("SELECT reason FROM smarter_private.lightning_top_up_intents")=='hand_abandoned')
 reset();request();q(f"UPDATE table_seats SET left_at=now() WHERE id='{S}';",True)
 check('actual-anchor-guard-refuses-live-exit',json.loads(funding())==[100,20,20,0,0,0])
 q(f"UPDATE table_seats SET leave_pending=true; UPDATE lightning_instance SET state='complete' WHERE id='{H}';")
 check('requested-exit-refuses-topup-without-charge',json.loads(funding())==[100,20,20,0,0,0] and q("SELECT reason FROM smarter_private.lightning_top_up_intents")=='occupancy_or_session_closed')
 reset();request();q("INSERT INTO engine_maintenance_break VALUES(true,now()-interval '3 minutes','counting_down',now()-interval '1 minute',now()+interval '4 minutes');")
 q(f"UPDATE lightning_instance SET state='complete' WHERE id='{H}';")
 check('freeze-never-funds-an-intent',json.loads(funding())==[100,20,20,0,0,0] and q("SELECT reason FROM smarter_private.lightning_top_up_intents")=='maintenance')
 reset()
 for role in ['anon','authenticated']:
  q(f"SET ROLE {role}; SELECT public.fn_lightning_top_up_request('{T}','{U}','request01',30);",True)
  q(f"SET ROLE {role}; SELECT * FROM smarter_private.lightning_top_up_intents;",True)
 check('browser-cannot-submit-service-intent-or-read-private-table',True)
 q(f"SELECT set_config('test.uid','{U}',false); SELECT public.fn_lightning_top_up_receipts('{P}');")
 q(f"SELECT set_config('test.uid','{uuid(99)}',false); SELECT public.fn_lightning_top_up_receipts('{P}');",True)
 check('receipt-read-is-own-session-only',True)
 # Actual request under two concurrent callers: one immutable queue, zero debits.
 reset()
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: answers=list(pool.map(lambda _:request(),range(2)))
 check('concurrent-same-request-is-one-uncharged-intent',q('SELECT count(*) FROM smarter_private.lightning_top_up_intents')=='1' and sum(bool(a.get('replayed')) for a in answers)==1 and json.loads(funding())==[100,20,20,0,0,0])
 # Same lock/predicate used by the real formation barrier, after a plan existed.
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  a=pool.submit(q,f"BEGIN; SELECT id FROM table_seats WHERE id='{S}' FOR SHARE; SELECT smarter_private.lightning_top_up_pending('{S}'); COMMIT;")
  check('formation-under-anchor-lock-sees-pending-intent',a.result().splitlines()[-1]=='t')
 q(f"INSERT INTO cash_cluster_epoch VALUES('{C}',1,NULL);")
 form=json.loads(q(f"SELECT fn_lightning_form_hand('{C}',ARRAY['{U}'::uuid,'{uuid(20)}'::uuid],p_matcher_version=>'native-stale-plan')"))
 check('actual-formation-refuses-stale-plan-with-pending-intent',form.get('reason')=='top_up_pending' and form.get('formed') is False)
 legal=q(f"SELECT reason_code FROM fn_lightning_player_legality('{C}',now(),ARRAY[]::uuid[]) WHERE player_id='{U}'")
 check('actual-advisory-legality-reports-only-pending-player',legal=='TOP_UP_PENDING')
 # Keep history durable, but the own read returns one pending plus 32 latest terminals.
 q(f"""INSERT INTO smarter_private.lightning_top_up_intents
 (table_id,user_id,request_id,anchor_seat_id,occupancy_id,pool_session_id,cluster_id,cash_session_id,requested,status,reason,created_at,completed_at)
 SELECT '{T}','{U}','history-'||n,'{S}','{O}','{P}','{C}','{CS}',1,'refused','fixture',
 now()-make_interval(secs=>n),now() FROM generate_series(1,5000) n;
 ANALYZE smarter_private.lightning_top_up_intents;""")
 own=json.loads(q(f"SELECT set_config('test.uid','{U}',false); SELECT fn_lightning_top_up_receipts('{P}');").splitlines()[-1])
 check('bounded-own-read-keeps-pending-and-canonical-current-funding',len(own['receipts'])==33 and sum(r['status']=='pending' for r in own['receipts'])==1 and own['baseline']==20 and own['balance']==100)
 check('bounded-history-read-does-not-unbind-original-replay',request()['replayed'] is True and q('SELECT count(*) FROM smarter_private.lightning_top_up_intents')=='5001')
 q(f"""INSERT INTO smarter_private.lightning_top_up_intents
 (table_id,user_id,request_id,anchor_seat_id,occupancy_id,pool_session_id,cluster_id,cash_session_id,requested)
 SELECT '{T}','{U}','pending-'||n,gen_random_uuid(),gen_random_uuid(),'{uuid(99)}','{C}','{CS}',1
 FROM generate_series(1,500) n; ANALYZE smarter_private.lightning_top_up_intents;""")
 plan=q(f"EXPLAIN (COSTS OFF) SELECT 1 FROM smarter_private.lightning_top_up_intents WHERE anchor_seat_id='{S}' AND status='pending';")
 check('hot-matcher-pending-predicate-is-index-bound', 'lightning_top_up_anchor_pending' in plan)
 for name,predicate in [('table-player',f"table_id='{T}' AND user_id='{U}' AND status='pending'"),('terminal-cluster-player',f"cluster_id='{C}' AND user_id='{U}' AND status='pending'")]:
  hot=q('EXPLAIN (COSTS OFF) SELECT request_id FROM smarter_private.lightning_top_up_intents WHERE '+predicate)
  check('hot-'+name+'-pending-predicate-is-index-bound','Index' in hot and 'Seq Scan' not in hot)
 completed=q(f"EXPLAIN (COSTS OFF) SELECT request_id FROM smarter_private.lightning_top_up_intents WHERE pool_session_id='{P}' AND status<>'pending' ORDER BY created_at DESC,request_id DESC LIMIT 32")
 check('bounded-completed-history-is-descending-index-bound','lightning_top_up_own_completed' in completed)

 # Race a previously planned real formation against an uncommitted request.
 # The barrier must block on its actual anchor FOR SHARE, then revalidate.
 reset()
 held=subprocess.Popen(list(map(str,psql)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,bufsize=1)
 held.stdin.write(f"BEGIN; SELECT fn_lightning_top_up_request('{T}','{U}','race-request',30); SELECT 'REQUEST_HELD';\n");held.stdin.flush()
 while held.stdout.readline().strip()!='REQUEST_HELD':
  if held.poll() is not None: raise RuntimeError(held.stderr.read())
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
  running=pool.submit(q,f"SET application_name='ltu-native-formation'; SELECT fn_lightning_form_hand('{C}',ARRAY['{U}'::uuid,'{uuid(20)}'::uuid],p_matcher_version=>'native-stale-plan');")
  import time
  waiting=False;deadline=time.monotonic()+5
  while time.monotonic()<deadline:
   waiting=q("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='ltu-native-formation' AND wait_event_type='Lock')")=='t'
   if waiting: break
   time.sleep(.01)
  try:
   check('real-formation-waits-for-original-request-anchor-lock',waiting)
  finally:
   held.stdin.write('COMMIT;\n');held.stdin.close();held.wait(timeout=10)
  formed=json.loads(running.result())
  check('real-formation-revalidates-after-uncommitted-request-commits',formed.get('reason')=='top_up_pending' and formed.get('formed') is False)
 check('all-money-remains-wallet-plus-seat',q('SELECT (SELECT chip_balance FROM club_members)+(SELECT stack FROM table_seats)')=='120')
 print(json.dumps({'passed':len(results),'output':str(out/'RESULTS.json')}))
finally:
 if (cluster/'d/postmaster.pid').exists(): cmd(owner+[PG/'pg_ctl','-D',cluster/'d','-m','fast','-w','stop'])
 shutil.rmtree(cluster,ignore_errors=True)
 (out/'RESULTS.json').write_text(json.dumps({'checks':results,'production_mutations':False,'cluster_removed':not cluster.exists(),
   'migration':str(migration.relative_to(ROOT)) if 'migration' in globals() else None,
   'migration_sha256':hashlib.sha256(sql.encode()).hexdigest() if 'sql' in globals() else None},indent=2)+'\n')
