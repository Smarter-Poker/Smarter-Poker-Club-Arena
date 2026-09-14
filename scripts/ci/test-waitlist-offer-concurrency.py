"""Native concurrent offer, direct-join and sweep claims; no production access."""
import argparse,hashlib,json,os,pathlib,shutil,subprocess,tempfile,time,uuid

root=pathlib.Path(__file__).resolve().parents[2]
fixture=root/'scripts/ci/probes/waitlist-offer-concurrency'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=pathlib.Path,default=root/'artifacts/waitlist-offer-concurrency')
out=parser.parse_args().output.resolve();out.mkdir(parents=True,exist_ok=False)
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C'
cluster=pathlib.Path(tempfile.mkdtemp(prefix='offer-native-'));sock=cluster/'socket';sock.mkdir()
psql=[str(pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55785','-U','postgres','-d','postgres']
children=[];checks=[];started=False
installer=(root/'supabase/migrations/20260914104113_waitlist_offers_share_capacity_and_user_claims.sql').read_text()
def command(args,text=None,allow_error=False):
 r=subprocess.run(list(map(str,args)),input=text,text=True,capture_output=True,env=env,timeout=25)
 if r.returncode and not allow_error:raise RuntimeError(r.stderr)
 return r if allow_error else r.stdout.strip()
def sql(s):return command(psql,s)
def uid(n):return str(uuid.UUID(int=n))
def quote(s):return "'"+s.replace("'","''")+"'"
def offer(t):return "SELECT fn_offer_open_seat('"+uid(t)+"');"
def join(t,user=2):return "SET request.jwt.claim.sub='"+uid(user)+"';SELECT fn_cash_game_join('"+uid(100+t)+"');"
def check(name,value):
 checks.append({'name':name,'passed':bool(value)})
 if not value:raise AssertionError(name)
def reset(cap=1):
 sql(f"TRUNCATE table_waitlist,notifications,cash_seat_moves,cash_game_waitlist;UPDATE waitlist_policy SET max_concurrent_holds={cap};UPDATE tables SET current_players=1,max_players=2,tournament_id=NULL;")
def queue(table,user,age=1):
 sql(f"INSERT INTO table_waitlist(table_id,user_id,status,created_at) VALUES('{uid(table)}','{uid(user)}','waiting',now()-make_interval(mins=>{age}));")
def held(s):
 a=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(a)
 a.stdin.write("BEGIN; SET statement_timeout='3s';SET ROLE service_role;"+s+'\n');a.stdin.flush()
 line=a.stdout.readline()
 if not line:raise RuntimeError(a.stderr.read())
 return a,json.loads(line)
def finish(a,commit=True):
 a.stdin.write(('COMMIT;' if commit else 'ROLLBACK;')+'\n');a.stdin.close();a.stdin=None
 _,err=a.communicate(timeout=5)
 if a.returncode:raise RuntimeError(err)
def count_holds(user=None):
 return int(sql("SELECT count(*) FROM table_waitlist WHERE status='notified' AND hold_expires_at>now()"+(f" AND user_id='{uid(user)}'" if user else '')))
def as_service(s):return json.loads(sql("SET statement_timeout='2s'; SET ROLE service_role;"+s))
def race(mode,same_table):
 reset();queue(10,1,2);queue(10 if same_table else 11,2 if same_table else 1)
 a,first=held(offer(10));second=as_service(offer(10 if same_table else 11));finish(a)
 check(mode+'-first-offer',first['ok'] is True)
 if mode=='baseline':check(mode+('-same-table-double-promise' if same_table else '-same-user-double-hold'),second['ok'] is True and count_holds()==2)
 else:
  check(mode+('-same-table-refused' if same_table else '-same-user-refused'),second['ok'] is False and count_holds()==1)
  check(mode+'-only-one-notification',sql("SELECT count(*) FROM notifications WHERE type='waitlist_seat_open'")=='1')
 return {'mode':mode,'same_table':same_table,'first':first,'second':second,'holds':count_holds()}
try:
 check('postgres17','PostgreSQL) 17.' in command([pg/'postgres','--version']))
 command([pg/'initdb','-D',cluster/'data','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 command([pg/'pg_ctl','-D',cluster/'data','-l',cluster/'log','-o',f"-k {sock} -p 55785 -c listen_addresses='' -c timezone=UTC -c shared_buffers=16MB -c max_connections=10",'-w','start']);started=True
 sql((fixture/'schema.sql').read_text());sql(json.loads((fixture/'auth-uid.json').read_text())['definition']);sql((fixture/'callers.sql').read_text());sql((fixture/'baseline.sql').read_text())
 sql('REVOKE ALL ON FUNCTION fn_offer_open_seat(uuid,interval,interval) FROM PUBLIC;GRANT EXECUTE ON FUNCTION fn_offer_open_seat(uuid,interval,interval) TO service_role;')
 for n in (1,2,3):sql(f"INSERT INTO auth.users VALUES('{uid(n)}');INSERT INTO profiles VALUES('{uid(n)}',{str(n==2).lower()});")
 for n in (10,11):
  sql(f"INSERT INTO cash_games(id,enabled,variant,sb,bb) VALUES('{uid(100+n)}',true,'nlh',1,2);INSERT INTO tables(id,name,max_players,current_players,cluster_id) VALUES('{uid(n)}','native table',2,1,'{uid(100+n)}');INSERT INTO table_seats(table_id,user_id) VALUES('{uid(n)}','{uid(3)}');")
 digest="SELECT md5(pg_get_functiondef('fn_offer_open_seat(uuid,interval,interval)'::regprocedure))"
 check('unchanged-live-baseline',sql(digest)=='3dbcee6f093d9c36d7f0ee1e940d5a2b')
 races=[race('baseline',True),race('baseline',False)]
 sql(installer);candidate=sql(digest);check('exact-candidate',candidate=='153c27efa0ce07bf7208b9561c281796')
 sql(installer);check('installer-replay-identity',sql(digest)==candidate)
 races += [race('candidate',True),race('candidate',False)]
 # Locked head is preserved while an eligible next player is served.
 reset();queue(10,1);queue(11,1,2);queue(11,2,1)
 a,_=held(offer(10));b=as_service(offer(11));finish(a)
 check('busy-player-does-not-block-next-player',b['ok'] is True and b['user_id']==uid(2) and count_holds(1)==1 and count_holds(2)==1)
 check('busy-head-remains-waiting',sql(f"SELECT status FROM table_waitlist WHERE table_id='{uid(11)}' AND user_id='{uid(1)}'")=='waiting')
 check('horse-offer-retains-skip-push',sql(f"SELECT data->>'_push' FROM notifications WHERE user_id='{uid(2)}' AND type='waitlist_seat_open'")=='skip')
 check('human-offer-is-not-muted',sql(f"SELECT data ? '_push' FROM notifications WHERE user_id='{uid(1)}' AND type='waitlist_seat_open'")=='f')
 # Configured caps remain policy values, including unlimited zero.
 for cap in (0,2):
  reset(cap);queue(10,1);queue(11,1);as_service(offer(10));b=as_service(offer(11));check('configured-cap-'+str(cap),b['ok'] is True and count_holds(1)==2)
 # Both commit and rollback release the table and player claims naturally.
 reset();queue(10,1);a,_=held(offer(10));b=as_service(offer(10));finish(a,False)
 check('busy-response-does-not-invent-offer',b['ok'] is False and count_holds()==0)
 check('rollback-allows-real-next-call',as_service(offer(10))['ok'] is True and count_holds()==1)
 # Admission counts actual chairs and pending moves, not cached lobby counts.
 reset();queue(10,1);sql(f"UPDATE tables SET current_players=0 WHERE id='{uid(10)}';INSERT INTO cash_seat_moves(to_table_id,state) VALUES('{uid(10)}','pending');")
 check('pending-move-reserves-last-chair',as_service(offer(10))['ok'] is False and count_holds()==0)
 sql('UPDATE cash_seat_moves SET swap_move_id=gen_random_uuid();')
 check('swap-move-is-not-double-reserved',as_service(offer(10))['ok'] is True)
 reset();queue(10,1);sql(f"UPDATE tables SET current_players=99 WHERE id='{uid(10)}';")
 check('stale-full-cache-does-not-hide-real-chair',as_service(offer(10))['ok'] is True)
 reset();queue(10,1);sql(f"UPDATE tables SET current_players=0,max_players=1 WHERE id='{uid(10)}';")
 check('stale-empty-cache-does-not-create-chair',as_service(offer(10))['ok'] is False)
 reset();queue(10,1);sql(f"UPDATE tables SET tournament_id='{uid(50)}' WHERE id='{uid(10)}';")
 check('tournament-table-still-refused',as_service(offer(10))['reason']=='tournament_table')
 check('missing-table-still-refused',as_service(offer(999))['reason']=='table_not_found')
 # Legacy offers retain their fallback TTL until the actual sweep expires them.
 reset();queue(10,1,2);queue(10,2,1)
 sql(f"UPDATE table_waitlist SET status='notified',notified_at=now(),hold_expires_at=NULL WHERE user_id='{uid(1)}';")
 check('legacy-null-expiry-hold-reserves-chair',as_service(offer(10))['ok'] is False)
 check('legacy-live-hold-not-retired',sql(f"SELECT status FROM table_waitlist WHERE user_id='{uid(1)}'")=='notified')
 sql(f"UPDATE table_waitlist SET notified_at=now()-interval '2 minutes' WHERE user_id='{uid(1)}';")
 check('expired-legacy-offer-advances-queue',as_service(offer(10))['user_id']==uid(2) and count_holds(2)==1)
 # A sweep that owns expired rows never waits for another table claimant.
 reset();queue(10,1,2);queue(10,2,1)
 sql(f"UPDATE table_waitlist SET status='notified',notified_at=now()-interval '2 minutes',hold_expires_at=now()-interval '1 minute' WHERE user_id='{uid(1)}';")
 a,_=held("SELECT jsonb_build_object('claimed',pg_try_advisory_xact_lock(hashtextextended('table_seat:'||"+quote(uid(10))+",0)));")
 sweep=as_service('SELECT fn_sweep_stale_waitlists();');finish(a)
 check('sweep-busy-table-does-not-deadlock',sweep['offers_expired']==1 and sweep['seats_reoffered']==0)
 check('next-real-sweep-advances-preserved-queue',as_service('SELECT fn_sweep_stale_waitlists();')['seats_reoffered']==1 and count_holds(2)==1)
 # The actual direct-join body takes the same table key.
 reset();queue(10,1);a,j=held(join(10));b=as_service(offer(10));finish(a)
 check('direct-join-wins-one-chair',j['action']=='seat' and b['reason']=='table_claim_busy' and count_holds()==1)
 check('offer-sees-committed-join-hold',as_service(offer(10))['ok'] is False and count_holds()==1)
 reset();queue(10,1);a,_=held(offer(10))
 b=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);children.append(b)
 b.stdin.write("SET application_name='offer-native-join-b';SET statement_timeout='4s';SET ROLE service_role;"+join(10)+'\n');b.stdin.close();b.stdin=None
 waiting=False
 for _ in range(150):
  if sql("SELECT coalesce(wait_event,'') FROM pg_stat_activity WHERE application_name='offer-native-join-b'")=='advisory':waiting=True;break
  if b.poll() is not None:break
  time.sleep(.01)
 check('actual-direct-join-waits-on-offer-table-key',waiting);finish(a);result,err=b.communicate(timeout=5)
 check('actual-direct-join-does-not-oversubscribe',b.returncode==0 and json.loads(result)['action']=='waitlisted' and count_holds()==1)
 # The actual existing sweep continues an expired hold through this function.
 reset();queue(10,1,2);queue(10,2,1)
 sql(f"UPDATE table_waitlist SET status='notified',notified_at=now()-interval '2 minutes',hold_expires_at=now()-interval '1 minute' WHERE user_id='{uid(1)}';")
 sweep=as_service('SELECT fn_sweep_stale_waitlists();')
 check('actual-sweep-expires-and-reoffers',sweep['offers_expired']==1 and sweep['seats_reoffered']==1 and count_holds(2)==1)
 check('expiry-notification-does-not-push',sql("SELECT data->>'_push' FROM notifications WHERE type='waitlist_offer_expired'")=='skip')
 # A failed notification statement rolls back the offered status as well.
 reset();queue(10,1);sql("ALTER TABLE notifications ADD CONSTRAINT native_reject_offer CHECK(type<>'waitlist_seat_open') NOT VALID;")
 refusal=command(psql,"SET ROLE service_role;"+offer(10),True)
 check('notification-failure-rolls-back-hold',refusal.returncode!=0 and count_holds()==0 and sql('SELECT status FROM table_waitlist')=='waiting')
 sql('ALTER TABLE notifications DROP CONSTRAINT native_reject_offer;')
 check('post-refusal-offer-succeeds-once',as_service(offer(10))['ok'] is True and count_holds()==1)
 for role in ('anon','authenticated'):
  check(role+'-cannot-forge-offer',command(psql,'SET ROLE '+role+';'+offer(10),True).returncode!=0)
 # Installation also refuses unqualified changes to its admission dependencies.
 for dependency in ('fn_cash_game_open_seats(uuid)','fn_cash_game_join(uuid)'):
  original=sql('SELECT pg_get_functiondef('+quote(dependency)+'::regprocedure)')
  sql(original.replace('AS $function$','AS $function$\n-- native unqualified dependency drift',1))
  refused=command(psql,installer,True)
  check('dependency-drift-refused-'+dependency,refused.returncode!=0 and 'admission dependency drift' in refused.stderr and sql(digest)==candidate)
  sql(original)
 # Refuse replacing an unknown concurrently changed definition.
 changed=(fixture/'baseline.sql').read_text().replace('  v_cap      int := 1;','  v_cap      int := 7;')
 sql(changed);unknown=sql(digest);refusal=command(psql,installer,True)
 check('unknown-live-body-refuses-transaction',refusal.returncode!=0 and 'definition drift' in refusal.stderr and sql(digest)==unknown)
 result={'passed':True,'checks':checks,'races':races,'candidate_md5':candidate,'production_connections':0,'production_mutations':0,
 'scope':'Actual captured offer/open-seat/join/sweep/barred/identity bodies and current waitlist uniqueness/FK/check contracts. Native fixture contains no delivery triggers and sends no messages. Cash purchase, payout and historical impact acceptance remain separate.'}
 (out/'RESULTS.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'passed':True,'checks':len(checks),'candidate_md5':candidate}))
finally:
 for child in children:
  if child.poll() is None:child.kill();child.wait()
 if started:command([pg/'pg_ctl','-D',cluster/'data','-m','fast','-w','stop'])
 shutil.rmtree(cluster)
