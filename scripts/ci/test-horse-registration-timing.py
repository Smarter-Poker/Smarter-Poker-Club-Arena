#!/usr/bin/env python3
"""Actual purchase wrapper in disposable PG17; unchanged economic delegates are sinks."""
import json,os,re,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
BASE=Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir())
if __import__('sys').platform=='darwin' and not str(BASE).startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('Use task-owned external SSD scratch')
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}
MIGRATION='20261028195328_horse_scheduled_mtt_purchases_begin_ten_minutes_before_start.sql'
def main():
    passed=[]
    def check(label,ok):
        if not ok: raise AssertionError(label)
        passed.append(label)
    with tempfile.TemporaryDirectory(prefix='horse-registration-',dir=BASE) as folder:
        d=Path(folder);sock=d/'s';sock.mkdir()
        def cmd(args): return subprocess.run([str(v) for v in args],env=ENV,text=True,capture_output=True,check=True).stdout
        cmd([PG/'initdb','-D',d/'db','-U','postgres','-A','trust','--no-locale','--encoding=UTF8'])
        cmd([PG/'pg_ctl','-D',d/'db','-l',d/'log','-o',f"-k {sock} -p 55481 -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
        def run(sql,fail=False):
            p=subprocess.run([str(PG/'psql'),'-X','-At','-v','ON_ERROR_STOP=1','-h',str(sock),'-p','55481','-U','postgres','-d','postgres','-c',sql],env=ENV,text=True,capture_output=True)
            if p.returncode and not fail: raise AssertionError(p.stderr)
            return p.stderr if fail else p.stdout.strip()
        T='00000000-0000-4000-8000-000000000001';H='00000000-0000-4000-8000-000000000002'
        call=f"SELECT fn_register_horse_for_tournament('{T}','{H}',true);"
        try:
            run('''CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;
CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean);
CREATE TABLE tournaments(id uuid PRIMARY KEY,status text,start_time timestamptz,format_contract text);
CREATE TABLE tournament_players(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tournament_id uuid,user_id uuid,status text);
CREATE TABLE purchases(tournament_id uuid,user_id uuid);
CREATE FUNCTION fn_lightning_pilot_assignment_blocks(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_poker_diamond_tournament(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_ca_entry_paying_club(uuid,uuid) RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE FUNCTION fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT CASE WHEN current_setting('test.frozen',true)='true' THEN '{"ok":false,"reason":"platform_frozen"}'::jsonb ELSE '{"ok":true}'::jsonb END$$;
CREATE FUNCTION fn_register_horse_for_tournament_before_terminal_gate(uuid,uuid,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
IF EXISTS(SELECT 1 FROM tournament_players WHERE tournament_id=$1 AND user_id=$2 AND status IN ('registered','playing')) THEN RETURN '{"ok":true,"already_registered":true}'::jsonb; END IF;
IF current_setting('test.late_closed',true)='true' THEN RETURN '{"ok":false,"reason":"registration_closed"}'::jsonb; END IF;
INSERT INTO purchases VALUES($1,$2);INSERT INTO tournament_players(tournament_id,user_id,status)VALUES($1,$2,'registered');RETURN '{"ok":true}'::jsonb;END$$;''')
            before=(ROOT/'supabase/migrations/20261027062132_horse_future_tournament_purchase_budget.sql').read_text()
            fn=re.search(r'CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament\(.*?\$function\$;',before,re.S).group()
            run(fn)
            run('REVOKE ALL ON FUNCTION fn_register_horse_for_tournament(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION fn_register_horse_for_tournament(uuid,uuid,boolean) TO service_role;')
            run(f"INSERT INTO profiles VALUES('{H}',true);INSERT INTO tournaments VALUES('{T}','REGISTERING',now()+interval '3 hours','mtt-v2');")
            check('preimage actually purchases three hours early',json.loads(run(call))['ok'])
            run('TRUNCATE tournament_players,purchases;')
            migration=(ROOT/'supabase/migrations'/MIGRATION).read_text();run(migration)
            check('same early purchase now refuses',json.loads(run(call)).get('reason')=='horse_registration_not_open')
            check('refusal creates no funded entry',run('SELECT (SELECT count(*) FROM purchases)+(SELECT count(*) FROM tournament_players)')=='0')
            run(f"UPDATE tournaments SET status='ANNOUNCED' WHERE id='{T}';")
            check('announced purchase also refuses early',json.loads(run(call)).get('reason')=='horse_registration_not_open')
            check('announced refusal creates no funded entry',run('SELECT (SELECT count(*) FROM purchases)+(SELECT count(*) FROM tournament_players)')=='0')
            run(f"UPDATE tournaments SET status='REGISTERING' WHERE id='{T}';")
            for fmt in ['mtt-v1','mtt-v2']:
                for status in ['ANNOUNCED','REGISTERING']:
                    for delta,want in [('10 minutes 0.001 seconds',False),('10 minutes',True),('9 minutes 59.999 seconds',True)]:
                        check(fmt+' '+status+' exact boundary '+delta,run(f"SELECT fn_ca_horse_mtt_purchase_window_open('{fmt}','{status}','2026-10-28 20:00Z'::timestamptz+interval '{delta}','2026-10-28 20:00Z')") == ('t' if want else 'f'))
            check('null scheduled start refuses',run("SELECT fn_ca_horse_mtt_purchase_window_open('mtt-v2','REGISTERING',NULL,now())")=='f')
            for fmt in ['sng-v1','spin-v1','seat-first-satellite-v1']:
                check(fmt+' bought-seat timing unchanged',run(f"SELECT fn_ca_horse_mtt_purchase_window_open('{fmt}','REGISTERING',now()+interval '3 days',now())")=='t')
            run(f"UPDATE tournaments SET start_time=now()+interval '9 minutes' WHERE id='{T}';")
            check('inside window reaches funded delegate',json.loads(run(call))['ok'])
            check('one funded entry',run('SELECT count(*) FROM purchases')=='1')
            run(f"UPDATE tournaments SET start_time=now()+interval '3 hours' WHERE id='{T}';")
            check('paid retry survives schedule moving out',json.loads(run(call)).get('already_registered') is True)
            check('paid retry does not charge twice',run('SELECT count(*) FROM purchases')=='1')
            run('TRUNCATE tournament_players,purchases;')
            run(f"UPDATE tournaments SET status='RUNNING',start_time=now()-interval '30 minutes' WHERE id='{T}';")
            check('running late registration reaches existing door',json.loads(run(call))['ok'])
            run('TRUNCATE tournament_players,purchases;')
            check('late closed decision remains authoritative',json.loads(run("SET test.late_closed='true';"+call).splitlines()[-1]).get('reason')=='registration_closed')
            check('freeze still wins',json.loads(run("SET test.frozen='true';"+call).splitlines()[-1]).get('reason')=='platform_frozen')
            check('service ACL retained',run("SELECT proacl::text FROM pg_proc WHERE oid='fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure")=='{postgres=X/postgres,service_role=X/postgres}')
            check('public cannot invoke horse purchases','permission denied' in run('SET ROLE anon;'+call,True))
            check('replay refuses changed preimage','horse_registration_timing_preimage_changed' in run(migration,True))
            print(json.dumps({'passed':len(passed),'checks':passed,'scope':'actual wrapper and pure time predicate; unchanged economic delegates are sinks'}))
        finally: cmd([PG/'pg_ctl','-D',d/'db','-m','immediate','-w','stop'])
if __name__=='__main__':main()
