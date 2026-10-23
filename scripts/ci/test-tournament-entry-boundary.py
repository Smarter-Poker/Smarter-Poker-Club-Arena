import json, os, pathlib, shutil, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
FIX=ROOT/'scripts/ci/fixtures/tournament-entry-boundary'
MIGRATION=ROOT/'supabase/migrations/20261023014339_entry_close_and_rebuy_use_the_earliest_configured_deadline.sql'
PG=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
cluster=pathlib.Path(tempfile.mkdtemp(prefix='entry-boundary-',dir=os.environ.get('TMPDIR')))
sock=pathlib.Path(tempfile.mkdtemp(prefix='sph-sock-',dir=os.environ.get('CA_PG_SOCKET_ROOT',os.environ.get('TMPDIR'))))
env={**os.environ,'LC_ALL':'C','LANG':'C'}
def cmd(args,sql=None,ok=True):
 r=subprocess.run([str(a) for a in args],input=sql,text=True,capture_output=True,env=env)
 if ok and r.returncode: raise RuntimeError(r.stderr)
 return r
psql=[PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55937','-U','postgres']
def sql(s):return cmd(psql,s).stdout.strip()
ID='00000000-0000-4000-8000-000000000001'
checks=[]
def check(name,yes):
 assert yes,name
 checks.append(name)
def fixture(**extra):
 data=dict(id=ID,status='RUNNING',late_reg_levels=9,rebuy_levels=9,late_reg_mins=90,current_level=8,prize_pool_finalized=False,add_on_available=True,is_rebuy=True,is_reentry=False,addon_period_triggered=False)
 data.update(extra)
 payload=json.dumps(data).replace("'","''")
 sql("truncate tournaments;insert into tournaments select * from json_populate_record(null::tournaments,'"+payload+"'::json);")
 if 'started_at' not in extra:sql("update tournaments set started_at=clock_timestamp()-interval '91 minutes'")
def call(name):return json.loads(sql("select public."+name+"('"+ID+"')"))
try:
 cmd([PG/'initdb','-D',cluster/'data','-U','postgres','-A','trust','--no-locale'])
 cmd([PG/'pg_ctl','-D',cluster/'data','-l',cluster/'pg.log','-o',f'-k {sock} -p 55937 -h 127.0.0.1','-w','start'])
 sql('''create role service_role;
create table tournaments(id uuid,status text,current_level int,late_reg_levels int,rebuy_levels int,late_reg_mins int,started_at timestamptz,prize_pool_finalized bool,add_on_available bool,is_rebuy bool,is_reentry bool,addon_period_triggered bool,addon_period_started_at timestamptz,addon_period_ends_at timestamptz);
create function fn_tournament_late_registration_open(tid uuid) returns boolean language sql as $$ select coalesce((select status='RUNNING' and not coalesce(prize_pool_finalized,false) and (case when coalesce(late_reg_levels,rebuy_levels,0)>0 then coalesce(current_level,0)<coalesce(late_reg_levels,rebuy_levels,0) else coalesce(late_reg_mins,0)>0 end) and (coalesce(late_reg_mins,0)<=0 or (started_at is not null and clock_timestamp()<started_at+make_interval(mins=>late_reg_mins))) from tournaments where id=tid),false) $$;
create function fn_finalize_tournament_entry_pool_locked(uuid,text,text) returns jsonb language sql as $$select '{"ok":true,"entry_closed":true,"finalized":true}'::jsonb$$;''')
 for name,file in [('fn_close_tournament_entry_window','close-before.sql'),('fn_ca_tournament_rebuy_window','rebuy-before.sql')]:
  sql((FIX/file).read_text())
  sig=name+'(uuid'+(',text' if 'close' in name else '')+')'
  sql(f'revoke all on function {sig} from public;grant execute on function {sig} to service_role;')
 fixture();check('RED transition waits for the level despite expired clock',not call('fn_close_tournament_entry_window')['entry_closed']);check('RED rebuy admits expired mixed window',call('fn_ca_tournament_rebuy_window')['open'])
 sql(MIGRATION.read_text())
 fixture();check('GREEN close immediately hands the expired mixed window to addon',call('fn_close_tournament_entry_window')['reason']=='addon_required');check('GREEN rebuy refuses expired clock before level edge',not call('fn_ca_tournament_rebuy_window')['open'])
 fixture(started_at=None);check('missing clock anchor cannot open a rebuy',not call('fn_ca_tournament_rebuy_window')['open']);check('missing clock anchor is an explicit close error',call('fn_close_tournament_entry_window')['ok'] is False)
 fixture();sql("update tournaments set started_at=clock_timestamp()-interval '89 minutes'");r=call('fn_close_tournament_entry_window');check('hybrid arms existing serving-engine minute timer',r['window_mode']=='minutes' and 58000<r['retry_after_ms']<=60000);check('rebuy inside both windows is open',call('fn_ca_tournament_rebuy_window')['open'])
 fixture(current_level=9);sql("update tournaments set started_at=clock_timestamp()-interval '10 minutes'");check('level boundary still closes earlier than clock',call('fn_close_tournament_entry_window')['entry_closed']);check('rebuy level boundary still closes earlier than clock',not call('fn_ca_tournament_rebuy_window')['open'])
 fixture(late_reg_mins=0);check('levels only remain open',not call('fn_close_tournament_entry_window')['entry_closed']);check('rebuy levels only remain open',call('fn_ca_tournament_rebuy_window')['open'])
 fixture(late_reg_levels=0,rebuy_levels=0,late_reg_mins=0);check('no window is closed',not call('fn_ca_tournament_rebuy_window')['open'])
 fixture();sql("update tournaments set addon_period_triggered=true,addon_period_started_at=clock_timestamp()-interval '10 seconds',addon_period_ends_at=clock_timestamp()+interval '50 seconds'");check('preserves owner rebuy entitlement during real addon minute',call('fn_ca_tournament_rebuy_window')['open'])
 fixture();sql("update tournaments set started_at=clock_timestamp()-interval '89 minutes 59 seconds'");r=call('fn_ca_tournament_rebuy_window');check('prompt never extends beyond configured cutoff',sql("select ('"+r['prompt_until']+"'::timestamptz<=started_at+interval '90 minutes') from tournaments")=='t')
 check('same migration cannot silently replay',cmd(psql,MIGRATION.read_text(),ok=False).returncode!=0)
 print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
finally:
 cmd([PG/'pg_ctl','-D',cluster/'data','-m','immediate','-w','stop'],ok=False)
 shutil.rmtree(cluster)
 shutil.rmtree(sock)
