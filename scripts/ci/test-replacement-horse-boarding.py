#!/usr/bin/env python3
"""Actual captured join/referral owners in isolated PG17; no production connection.
Commerce admission and notification are controlled boundary fixtures, not their full products.
No global club-capacity lock is claimed: the CLI observes headroom and stops on drift.
"""
import concurrent.futures,hashlib,json,os,pathlib,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
PG=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
OUT=ROOT/'work/replacement-boarding-native';OUT.mkdir(parents=True,exist_ok=True)
cluster=pathlib.Path(tempfile.mkdtemp(prefix='board62-',dir=os.environ.get('TMPDIR',str(ROOT/'work'))));sock=cluster/'s';sock.mkdir()
owner=['runuser','-u','postgres','--'] if os.geteuid()==0 else []
if owner:shutil.chown(cluster,'postgres');shutil.chown(sock,'postgres')
env=dict(os.environ,LC_ALL='C',LANG='C');checks=[]
def run(args,sql=None,fail=False):
 r=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=env,timeout=60)
 if (r.returncode!=0)!=fail:raise RuntimeError(r.stdout+r.stderr)
 return r.stdout.strip()
psql=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55846','-U','postgres','-d','postgres']
def q(s,fail=False):return run(psql,s,fail)
def check(n,ok):
 checks.append({'name':n,'passed':bool(ok)})
 if not ok:raise AssertionError(n)
C='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';K='47965354-0e56-43ef-931c-ddaab82af765';H='8b27a10f-e57b-47d9-9af0-000000000001';R='8b27a10f-e57b-47d9-9af0-000000000002'
def call(user=H,request=R,ref="'kingfish'"):
 return json.loads(q(f"SET request.jwt.claim.sub='{user}'; SELECT fn_join_club_atomic('{C}','{request}',{ref});"))
try:
 run(owner+[PG/'initdb','-D',cluster/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
 run(owner+[PG/'pg_ctl','-D',cluster/'d','-l',cluster/'log','-o',f"-k {sock} -p 55846 -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
 q('''CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE ROLE authenticated; CREATE ROLE anon;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE TABLE profiles(id uuid PRIMARY KEY,username text,player_number text,alias text);
 CREATE TABLE clubs(id uuid PRIMARY KEY,club_id int,slug text,name text,owner_id uuid,requires_approval bool,lifecycle_status text DEFAULT 'active',logo_url text,avatar_url text);
 CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,tier text,rank_level int,orange_ball_status text,chip_balance numeric DEFAULT 0,agent_id uuid,invited_by uuid,is_active bool DEFAULT true,membership_lifecycle_status text DEFAULT 'active',departed_at timestamptz,departed_by uuid,departure_reason text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(club_id,user_id));
 CREATE TABLE club_entry_feature_flags(key text,enabled bool,rollout_percent int);
 CREATE TABLE club_join_idempotency(user_id uuid,request_id uuid,club_id uuid,result jsonb,PRIMARY KEY(user_id,request_id));
 CREATE TABLE rate_limits(user_id uuid,action text,created_at timestamptz DEFAULT now());
 CREATE TABLE agents(id uuid,user_id uuid,club_id uuid,status text,total_players int,active_player_count int,updated_at timestamptz);
 CREATE TABLE club_invite_attributions(id uuid DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,inviter_id uuid,code text,status text,block_reason text,claimed_at timestamptz DEFAULT now(),joined_at timestamptz,UNIQUE(user_id,club_id));
 CREATE TABLE club_invite_links(club_id uuid,inviter_id uuid,code text);
 CREATE TABLE notifications(recipient uuid);
 CREATE FUNCTION fn_club_invite_notify(uuid,text,text,text,text,jsonb) RETURNS void LANGUAGE sql AS $$INSERT INTO notifications VALUES($1)$$;
 CREATE FUNCTION fn_club_membership_lock(uuid) RETURNS void LANGUAGE sql AS $$SELECT pg_advisory_xact_lock(hashtextextended($1::text,77431))$$;
 CREATE FUNCTION fn_club_membership_count(uuid,uuid DEFAULT NULL) RETURNS int LANGUAGE sql AS $$SELECT count(*)::int FROM club_members WHERE user_id=$1 AND club_id IS DISTINCT FROM $2 AND membership_lifecycle_status='active'$$;
 CREATE FUNCTION fn_club_membership_cap() RETURNS int LANGUAGE sql AS $$SELECT 10$$;
 CREATE FUNCTION fn_ca_commerce_admit(text,uuid,text,text,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('allowed',coalesce(current_setting('fixture.allow_admission',true),'true')<>'false','message','Admission refused')$$;
 ''')
 q(f"INSERT INTO profiles VALUES('{K}','kingfish','1',NULL),('{H}','horse','2',NULL); INSERT INTO clubs(id,club_id,name,owner_id,requires_approval) VALUES('{C}',12345,'DSS','{K}',false); INSERT INTO club_members(club_id,user_id,role,status) VALUES('{C}','{K}','owner','active'); INSERT INTO club_invite_links VALUES('{C}','{K}','original-kingfish');")
 fixtures=ROOT/'scripts/ci/fixtures/replacement-boarding'
 for name in ['fn_join_club_membership_impl','fn_join_club','fn_redeem_club_invite_code','fn_join_club_atomic']:q((fixtures/(name+'.sql')).read_text())
 pins={'fn_join_club':'ca1bdbb859127e65be013b2946fca2f1','fn_join_club_atomic':'9aacdb3a9a2e083d30141d7d56f0373d','fn_join_club_membership_impl':'b31effd0156fd162f2420bdf7b4560a7','fn_redeem_club_invite_code':'16f8badbcc4ebf359bbfe478ab3bca83'}
 check('all-four-actual-function-definitions-match-live-catalog-pins',all(q(f"SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname='{name}'")==digest for name,digest in pins.items()))
 q('REVOKE ALL ON FUNCTION fn_join_club_atomic(text,uuid,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION fn_join_club_atomic(text,uuid,text) TO authenticated;')
 check('owner-placement-needs-no-active-agent-row',q(f"SELECT count(*) FROM agents WHERE club_id='{C}' AND user_id='{K}' AND status='active'")=='0')
 r=call();m=r['membership']
 check('actual-normal-join-referral-is-active-owner-direct-zero-chip',r['success'] and m['status']=='active' and m['agent_id']==K and m['invited_by']==K and m['chip_balance']==0)
 check('same-original-request-replays-exact-receipt',call()==r)
 check('replay-does-not-repeat-membership-notification',q(f"SELECT (SELECT count(*) FROM club_members WHERE user_id='{H}')=1 AND (SELECT count(*) FROM notifications)=1")=='t')
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as p:replies=list(p.map(lambda _:call(),range(4)))
 check('concurrent-original-replays-return-exact-receipt',all(x==r for x in replies))
 H4='8b27a10f-e57b-47d9-9af0-000000000007';R4='8b27a10f-e57b-47d9-9af0-000000000008';q(f"INSERT INTO profiles VALUES('{H4}','horse4','5',NULL)")
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as p:firsts=list(p.map(lambda _:call(H4,R4),range(4)))
 check('concurrent-first-original-request-creates-one-membership-and-receipt',all(x==firsts[0] for x in firsts) and q(f"SELECT (SELECT count(*) FROM club_members WHERE user_id='{H4}')=1 AND (SELECT count(*) FROM club_join_idempotency WHERE user_id='{H4}')=1 AND (SELECT count(*) FROM club_invite_attributions WHERE user_id='{H4}')=1")=='t')
 # The same inviter may legitimately be both the club owner and an active agent.
 HA='8b27a10f-e57b-47d9-9af0-000000000009';RA='8b27a10f-e57b-47d9-9af0-000000000010'
 q(f"INSERT INTO agents(id,user_id,club_id,status,total_players,active_player_count) VALUES(gen_random_uuid(),'{K}','{C}','active',0,0); INSERT INTO profiles VALUES('{HA}','horse-agent','6',NULL)")
 ar=call(HA,RA);am=ar['membership']
 check('actual-owner-with-active-agent-role-attributes-to-original-Kingfish',ar['success'] and am['agent_id']==K and am['invited_by']==K and am['role']=='player' and am['chip_balance']==0)
 check('owner-agent-replay-preserves-original-receipt',call(HA,RA)==ar)
 check('owner-agent-counters-reflect-three-original-players',q(f"SELECT total_players=3 AND active_player_count=3 FROM agents WHERE club_id='{C}' AND user_id='{K}'")=='t')
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as p:agent_replays=list(p.map(lambda _:call(HA,RA),range(4)))
 check('concurrent-owner-agent-replays-retain-one-membership-attribution',all(x==ar for x in agent_replays) and q(f"SELECT count(*) FROM club_invite_attributions WHERE club_id='{C}' AND user_id='{HA}' AND inviter_id='{K}'")=='1')
 H2='8b27a10f-e57b-47d9-9af0-000000000003';q(f"INSERT INTO profiles VALUES('{H2}','horse2','3',NULL)")
 r2=call(H2,'8b27a10f-e57b-47d9-9af0-000000000004','NULL')
 check('null-referral-retains-normal-owner-placement-without-inventing-inviter',r2['membership']['agent_id']==K and r2['membership']['invited_by'] is None)
 H3='8b27a10f-e57b-47d9-9af0-000000000005';q(f"INSERT INTO profiles VALUES('{H3}','horse3','4',NULL)")
 bad=call(H3,'8b27a10f-e57b-47d9-9af0-000000000006',"'unknown-code'")
 check('invalid-referral-rolls-back-membership-and-retains-refusal',bad['code']=='invalid_invitation' and q(f"SELECT count(*) FROM club_members WHERE user_id='{H3}'")=='0')
 check('explicit-refusal-replays-original-result',call(H3,'8b27a10f-e57b-47d9-9af0-000000000006',"'kingfish'")==bad)
 q(f"SET request.jwt.claim.sub='{H3}';SET fixture.allow_admission='false';SELECT fn_join_club_atomic('{C}',gen_random_uuid(),'kingfish');",True)
 check('commerce-admission-refusal-writes-no-member',q(f"SELECT count(*) FROM club_members WHERE user_id='{H3}'")=='0')
 q(f"INSERT INTO club_members(club_id,user_id,role,status) SELECT md5('club'||i)::uuid,'{H3}','player','active' FROM generate_series(1,10)i")
 q(f"SET request.jwt.claim.sub='{H3}';SELECT fn_join_club_atomic('{C}',gen_random_uuid(),'kingfish');",True)
 check('ordinary-ten-club-user-cap-is-preserved',q(f"SELECT count(*) FROM club_members WHERE user_id='{H3}' AND club_id='{C}'")=='0')
 q(f"SET ROLE anon;SELECT fn_join_club_atomic('{C}',gen_random_uuid(),'kingfish');",True)
 check('anonymous-cannot-enter-authenticated-join-door',True)
 q(f"SET ROLE authenticated;SELECT fn_join_club_atomic('{C}',gen_random_uuid(),'kingfish');",True)
 check('missing-subject-is-refused-by-real-join-owner',True)
 check('no-account-birth-wallet-funding-or-seat-fixture-exists',q("SELECT to_regclass('auth.users') IS NULL AND to_regclass('wallet_transactions') IS NULL AND to_regclass('table_seats') IS NULL")=='t')
finally:
 run(owner+[PG/'pg_ctl','-D',cluster/'d','-m','immediate','-w','stop'])
 shutil.rmtree(cluster)
 (OUT/'RESULTS.json').write_text(json.dumps({'checks':checks,'passed':all(c['passed'] for c in checks),'cluster_removed':not cluster.exists(),'production_mutations':False,'scope':'Actual captured join, membership implementation and referral functions; controlled commerce/notification boundary fixtures; no global club capacity claim','fixtures':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in (ROOT/'scripts/ci/fixtures/replacement-boarding').glob('*.sql')}},indent=2)+'\n')
print(f'{len(checks)}/{len(checks)} native PG17 checks passed')
