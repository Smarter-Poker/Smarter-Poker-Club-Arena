#!/usr/bin/env python3
"""Isolated read-contract proof. Real canonical fee, batch P/L and roster-access
functions are captured/hash-pinned; unrelated P/L data providers use fixed values.
No production connection or money writer is used. All fixture data rolls back.
"""
import json,os,pathlib,subprocess,tempfile,shutil,hashlib
R=pathlib.Path(__file__).resolve().parents[2]
PG=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
parent=pathlib.Path(os.environ.get('RUNNER_TEMP',tempfile.gettempdir()))
if os.uname().sysname=='Darwin':
 assert str(parent).startswith('/Volumes/SmarterWork/agent-work/') and parent.stat().st_dev!=pathlib.Path('/').stat().st_dev
w=pathlib.Path(tempfile.mkdtemp(prefix='pf-',dir=parent));(w/'s').mkdir();started=False
out=pathlib.Path(os.environ.get('PERIOD_FEE_EVIDENCE',str(R/'artifacts/player-period-fees')));out.mkdir(parents=True,exist_ok=True)
env={'PATH':str(PG)+':/usr/bin:/bin','LC_ALL':'C'};serial=0
checks=[]
def run(argv,sql=None,error=None):
 global serial
 p=subprocess.run(list(map(str,argv)),input=sql,text=True,capture_output=True,env=env,timeout=60);serial+=1
 (out/f'{serial}.stdout').write_text(p.stdout);(out/f'{serial}.stderr').write_text(p.stderr)
 if sql:(out/f'{serial}.sql').write_text(sql)
 if error: assert p.returncode and error in p.stderr,p.stderr
 else: assert p.returncode==0,p.stderr
 return p.stdout.strip()
def q(sql,error=None):return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',w/'s','-U','postgres','-d','postgres'],sql,error)
def check(name,sql,expected='t'):
 value=q(sql);assert value==expected,(name,value,expected);checks.append(name)
c='faee0000-0000-0000-0000-000000000001';a='faee0000-0000-0000-0000-000000000002';b='faee0000-0000-0000-0000-000000000003';owner='faee0000-0000-0000-0000-000000000004';outsider='faee0000-0000-0000-0000-000000000005'
migration=R/'supabase/migrations/20261029043300_player_management_period_fees.sql'
try:
 run([PG/'initdb','-D',w/'d','-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 run([PG/'pg_ctl','-D',w/'d','-l',w/'log','-o',f"-h '' -k {w/'s'} -c shared_buffers=16MB",'-w','start']);started=True
 q('''CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA auth;CREATE SCHEMA smarter_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.actor',true),'')::uuid$$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('test.role',true),''),'authenticated')$$;
 CREATE TABLE club_members(club_id uuid,user_id uuid,agent_id uuid,role text,status text);
 CREATE TABLE profiles(id uuid,is_admin boolean);
 CREATE FUNCTION fn_club_cashier_scope(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'staff'::text$$;
 CREATE FUNCTION fn_can_read_club_member_data(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
 CREATE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
 CREATE FUNCTION fn_ca_launch_accounting_accepts(uuid,timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT $2>=coalesce(nullif(current_setting('test.cutoff',true),'')::timestamptz,'-infinity'::timestamptz)$$;
 CREATE TABLE rake_records(id uuid,created_at timestamptz);
 CREATE TABLE rake_attributions(club_id uuid,player_id uuid,rake_record_id uuid,rake_amount numeric,created_at timestamptz);
 CREATE TABLE ca_club_rake_daily_user(club_id uuid,user_id uuid,day date,rake_cents bigint);
 CREATE TABLE smarter_private.player_fee_redemptions(club_id uuid,user_id uuid,effective_on date,amount_cents bigint);
 CREATE TABLE smarter_private.player_rake_share_rules(rule_key text,club_id uuid,from_user uuid,to_user uuid,share_bps integer,effective_from timestamptz,effective_until timestamptz);
 CREATE TABLE ca_club_member_tournament_fee_daily(club_id uuid,user_id uuid,day date,fees numeric);
 CREATE TABLE accounting_tournament_fee_sources(club_id uuid,player_id uuid,charged_at timestamptz,rake_credit numeric);
 CREATE TABLE club_member_daily_facts_state(singleton boolean,initialized boolean);INSERT INTO club_member_daily_facts_state VALUES(true,true);
 CREATE FUNCTION ca_club_member_chicago_today_cash(uuid,uuid) RETURNS numeric LANGUAGE sql AS $$SELECT 11::numeric$$;
 CREATE FUNCTION ca_club_member_chicago_cash(uuid,uuid,date,date) RETURNS numeric LANGUAGE sql AS $$SELECT 11::numeric$$;
 CREATE FUNCTION ca_member_record_daily_facts(uuid,uuid,date,date) RETURNS TABLE(club_id uuid,user_id uuid,is_mtt boolean,net numeric) LANGUAGE sql AS $$SELECT $1,$2,false,11::numeric$$;
 CREATE FUNCTION ca_club_member_tournament_money(uuid,uuid,timestamptz,timestamptz) RETURNS numeric LANGUAGE sql AS $$SELECT -3::numeric$$;
 ''')
 fixture=json.loads((R/'scripts/ci/fixtures/player-period-current-readers.json').read_text())
 for f in sorted(fixture,key=lambda x:x['proname']!='fn_ca_fee_counting_start'):
  q(f['def']);check('current-'+f['proname'],f"SELECT md5(pg_get_functiondef(p.oid))='{f['md5']}' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='{f['proname']}'")
 q(migration.read_text())
 q(f"INSERT INTO club_members VALUES('{c}','{owner}',NULL,'owner','approved'),('{c}','{a}',NULL,'agent','approved'),('{c}','{b}','{a}','player','approved'),('{c}','{b}','{a}','player','approved'),('{c}','{outsider}',NULL,'player','approved');")
 # Fixed fall DST boundary and spring/year edges are exercised directly through
 # the same helper; the page wrapper uses transaction-now Chicago Monday.

 # Each q is one connection: retained fixture transaction is below, including
 # rollback and all assertions in the same backend.
 scenario=f"""BEGIN;SET LOCAL test.actor='{owner}';SET LOCAL timezone='Asia/Tokyo';
 INSERT INTO smarter_private.player_rake_share_rules VALUES('half','{c}','{a}','{b}',5000,'2026-10-12 00:00Z',NULL);
 INSERT INTO rake_records VALUES(md5('r')::uuid,'2026-10-26 05:00Z');
 INSERT INTO rake_attributions SELECT '{c}','{a}',md5('r')::uuid,amount,at FROM (VALUES
 ('2026-10-26 04:59:59.999999Z'::timestamptz,100.03::numeric),('2026-10-26 05:00Z',10.03),('2026-10-29 12:00Z',50.03))v(at,amount);
 INSERT INTO ca_club_rake_daily_user SELECT club_id,player_id,(created_at AT TIME ZONE 'UTC')::date,sum(round(rake_amount*100)) FROM rake_attributions GROUP BY 1,2,3;
 INSERT INTO smarter_private.player_fee_redemptions VALUES('{c}','{a}','2026-10-26',100);
 INSERT INTO accounting_tournament_fee_sources VALUES('{c}','{a}','2026-10-26 04:59:59.999999Z',200),('{c}','{a}','2026-10-26 05:00Z',7),('{c}','{a}','2026-10-29 12:00Z',300),('{c}','{a}','2026-10-26 05:00Z',-2);
 INSERT INTO ca_club_member_tournament_fee_daily SELECT club_id,player_id,(charged_at AT TIME ZONE 'UTC')::date,sum(rake_credit) FROM accounting_tournament_fee_sources GROUP BY 1,2,3;
 DO $$BEGIN
 IF (SELECT total_fees FROM ca_club_member_period_fee_totals('{c}',ARRAY['{a}'::uuid,'{b}'::uuid],'2026-10-26','2026-10-29 12:00Z') WHERE user_id='{a}')<>9.01 THEN RAISE EXCEPTION 'Chicago custody donor edge/rounding/redemption failed';END IF;
 IF (SELECT total_fees FROM ca_club_member_period_fee_totals('{c}',ARRAY['{a}'::uuid,'{b}'::uuid],'2026-10-26','2026-10-29 12:00Z') WHERE user_id='{b}')<>5.02 THEN RAISE EXCEPTION 'share recipient rounding failed';END IF;
 IF (SELECT total_fees FROM ca_club_member_period_fee_totals('{c}',ARRAY['{b}'::uuid],'2026-10-26','2026-10-29 12:00Z'))<>5.02 THEN RAISE EXCEPTION 'incoming donor outside scoped IDs lost';END IF;
 IF (SELECT count(*) FROM ca_club_member_period_fee_totals('{c}',ARRAY['{a}'::uuid,'{a}'::uuid,NULL],'2026-10-26','2026-10-29 12:00Z'))<>1 OR (SELECT total_fees FROM ca_club_member_period_fee_totals('{c}',ARRAY['{a}'::uuid],'2026-10-26','2026-10-29 12:00Z'))<>9.01 THEN RAISE EXCEPTION 'outgoing share or array dedup leaked';END IF;
 END$$;
 -- Current wrapper exact week start, duplicate request/access and descendants.
 TRUNCATE rake_attributions,rake_records,ca_club_rake_daily_user,smarter_private.player_rake_share_rules,smarter_private.player_fee_redemptions,accounting_tournament_fee_sources,ca_club_member_tournament_fee_daily;
 INSERT INTO accounting_tournament_fee_sources SELECT '{c}','{b}',at,amount FROM (VALUES
 ((date_trunc('week',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago')-interval '1 microsecond',100::numeric),
 (date_trunc('week',now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago',7))v(at,amount);
 INSERT INTO ca_club_member_tournament_fee_daily SELECT club_id,player_id,(charged_at AT TIME ZONE 'UTC')::date,sum(rake_credit) FROM accounting_tournament_fee_sources GROUP BY 1,2,3;
 DO $$DECLARE x record;BEGIN
 SELECT * INTO x FROM ca_club_members_period_summary('{c}',ARRAY['{a}'::uuid,'{a}'::uuid,NULL],'week');
 IF x.cash<>11 OR x.mtt<>-3 OR x.net<>8 OR x.fees<>0 OR x.downline_fees<>7 THEN RAISE EXCEPTION 'wrapper/currentweek/downline mismatch: %',row_to_json(x);END IF;
 IF (SELECT count(*) FROM ca_club_members_period_summary('{c}',ARRAY['{a}'::uuid,'{a}'::uuid],'week'))<>1 THEN RAISE EXCEPTION 'duplicate IDs';END IF;
 END$$;
 SET LOCAL test.actor='{a}';
 DO $$BEGIN IF (SELECT count(*) FROM ca_club_members_period_summary('{c}',ARRAY['{a}'::uuid,'{b}'::uuid,'{outsider}'::uuid],'week'))<>2 THEN RAISE EXCEPTION 'downline access';END IF;END$$;
 SET LOCAL test.actor='{outsider}';
 DO $$BEGIN IF EXISTS(SELECT 1 FROM ca_club_members_period_summary('{c}',ARRAY['{a}'::uuid],'week')) THEN RAISE EXCEPTION 'identity leak';END IF;END$$;
 SET LOCAL test.actor='';SET LOCAL test.role='service_role';
 DO $$BEGIN IF (SELECT count(*) FROM ca_club_members_period_summary('{c}',ARRAY['{a}'::uuid,'{b}'::uuid],'week'))<>2 THEN RAISE EXCEPTION 'service access';END IF;END$$;
 ROLLBACK;SELECT count(*)=0 FROM accounting_tournament_fee_sources;
 """
 check('exact-edges-custody-rounding-auth-downline-dedup-rollback',scenario)
 check('dst-calendar-edges',f"""BEGIN;
 DO $$DECLARE d date;st timestamptz;en timestamptz;v numeric;BEGIN
 FOREACH d IN ARRAY ARRAY[date '2026-11-01',date '2027-03-14',date '2027-01-01'] LOOP
 st:=d::timestamp AT TIME ZONE 'America/Chicago';en:=(d+1)::timestamp AT TIME ZONE 'America/Chicago';
 INSERT INTO accounting_tournament_fee_sources VALUES('{c}','{a}',st-interval '1 microsecond',100),('{c}','{a}',st,7),('{c}','{a}',en,200);
 INSERT INTO ca_club_member_tournament_fee_daily SELECT club_id,player_id,(charged_at AT TIME ZONE 'UTC')::date,sum(rake_credit) FROM accounting_tournament_fee_sources GROUP BY 1,2,3;
 SELECT total_fees INTO v FROM ca_club_member_period_fee_totals('{c}',ARRAY['{a}'::uuid,'{b}'::uuid],d,en) WHERE user_id='{a}';
 IF v<>7 THEN RAISE EXCEPTION 'DST/year edge % returned %',d,v;END IF;
 TRUNCATE accounting_tournament_fee_sources,ca_club_member_tournament_fee_daily;
 END LOOP;END$$;ROLLBACK;SELECT true;""")
 check('period-before-counting-floor',f"""BEGIN;
 INSERT INTO accounting_tournament_fee_sources VALUES('{c}','{a}','2026-10-11 23:59:59.999999Z',100),('{c}','{a}','2026-10-12 00:00Z',7),('{c}','{a}','2026-10-13 00:00Z',200);
 INSERT INTO ca_club_member_tournament_fee_daily SELECT club_id,player_id,(charged_at AT TIME ZONE 'UTC')::date,sum(rake_credit) FROM accounting_tournament_fee_sources GROUP BY 1,2,3;
 DO $$BEGIN IF (SELECT total_fees FROM ca_club_member_period_fee_totals('{c}',ARRAY['{a}'::uuid],'2026-10-01','2026-10-13 00:00Z'))<>7 THEN RAISE EXCEPTION 'month before counting floor lost UTC-floor first hours';END IF;END$$;
 ROLLBACK;SELECT true;""")
 check('read-only-transaction',f"BEGIN READ ONLY;SET LOCAL test.actor='{owner}';SELECT count(*)=1 FROM ca_club_members_period_summary('{c}',ARRAY['{a}'::uuid],'week');ROLLBACK;")
 check('helper-private',"SELECT NOT has_function_privilege('authenticated','ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz)','EXECUTE') AND NOT has_function_privilege('anon','ca_club_members_period_summary(uuid,uuid[],text)','EXECUTE')")
 q(f"SELECT * FROM ca_club_members_period_summary('{c}',ARRAY[]::uuid[],'invalid')",'Invalid win loss period');checks.append('invalid-period-refused')
 q(f"SELECT * FROM ca_club_members_period_summary('{c}',array_fill('{a}'::uuid,ARRAY[101]),'week')",'At most 100');checks.append('batch-cap')
 check('empty',f"SELECT count(*)=0 FROM ca_club_members_period_summary('{c}',ARRAY[]::uuid[],'week')")
 (out/'installed-catalog.json').write_text(q("SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition_md5',md5(pg_get_functiondef(p.oid)),'source_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig,'security_definer',p.prosecdef) ORDER BY p.proname) FROM pg_proc p WHERE p.proname IN ('ca_club_member_period_fee_totals','ca_club_members_period_summary')"))
 print('PLAYER_PERIOD_FEES PASS',len(checks))
finally:
 if started:run([PG/'pg_ctl','-D',w/'d','-m','immediate','-w','stop'])
 shutil.rmtree(w)
 (out/'result.json').write_text(json.dumps({'checks':checks,'passed':len(checks)==12,'migration_sha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'cluster_removed':not w.exists(),'production_calls':False},indent=2))
