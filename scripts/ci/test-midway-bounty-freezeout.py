#!/usr/bin/env python3
"""Exercise the real bounty trigger before/after in private PostgreSQL."""
import os, pathlib, subprocess, tempfile, socket
root = pathlib.Path(__file__).resolve().parents[2]
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
parent = os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not parent: raise RuntimeError('Set TMPDIR to owned SSD scratch')
with tempfile.TemporaryDirectory(prefix='bounty-', dir=parent) as folder:
    scratch=pathlib.Path(folder)
    def run(tool,*args,input=None):
        return subprocess.run([str(pg/tool),*args],input=input,text=True,capture_output=True,check=True)
    run('initdb','-D',str(scratch/'data'),'-A','trust','--no-locale','-E','UTF8')
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0));port=str(reserve.getsockname()[1])
    run('pg_ctl','-D',str(scratch/'data'),'-l',str(scratch/'server.log'),'-o',f'-k {parent} -p {port} -h 127.0.0.1','start')
    try:
        def sql(source):
            return run('psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-d','postgres',input=source).stdout.strip()
        sql('''CREATE TABLE tournaments(id uuid,club_id uuid,union_id uuid,schedule_id uuid,start_time timestamptz,
          is_bounty boolean,is_pko boolean default false,is_mystery_bounty boolean default false,
          tournament_type text default 'MTT',variant text default 'bounty',satellite_target_id uuid,
          status text default 'REGISTERING',buy_in_amount numeric default 36,buy_in_fee numeric default 4,
          starting_chips integer default 20000,bounty_amount numeric default 10,
          is_rebuy boolean default false,is_reentry boolean default false,add_on_available boolean default false,
          rebuy_cost numeric default 0,rebuy_chips integer default 0,rebuy_levels integer default 0,
          max_rebuys integer default 0,max_reentries integer default 0,
          addon_cost numeric default 0,addon_chips integer default 0,addon_levels integer default 0,
          late_reg_levels integer default 0,late_reg_mins integer default 0,blind_structure text,addon_from_start boolean,addon_break_minutes integer);''')
        old=(root/'supabase/migrations/20261022044423_bounty_mtts_rebuy_until_registration_closes.sql').read_text()
        fn=old[old.index('CREATE OR REPLACE FUNCTION'):old.index('COMMENT ON FUNCTION')]
        sql(fn+'''CREATE TRIGGER normalize BEFORE INSERT OR UPDATE ON tournaments
           FOR EACH ROW EXECUTE FUNCTION fn_ca_bounty_mtt_rebuys_until_registration_closes();''')
        owner="'fade0000-0000-0000-0000-000000000001'"
        def event(event_id, schedule=None, club=owner, **overrides):
            fields={'id':"'"+event_id+"'",'club_id':club,'union_id':club,'is_bounty':'true'}
            if schedule: fields['schedule_id']="'"+schedule+"'"
            fields.update(overrides)
            values=','.join(fields.values())
            return sql('TRUNCATE tournaments; INSERT INTO tournaments('+','.join(fields)+') VALUES('+values+'); SELECT is_rebuy::text||\',\'||is_reentry::text||\',\'||COALESCE(max_rebuys::text,\'unlimited\') FROM tournaments;')
        exact='a70c1028-2000-4000-8000-000000000001'
        future='11111111-1111-4111-8111-111111111111'
        schedule='a70c1028-2000-4000-9000-000000000001'
        assert event(exact) != 'false,false,0', 'baseline must force rebuys'
        sql(next((root/'supabase/migrations').glob('*allow_explicitly_authored_bounty_freezeouts.sql')).read_text())
        assert event(exact)=='false,false,0'
        assert event(future,schedule,is_rebuy='true',is_reentry='true',max_rebuys='NULL')=='false,false,0'
        assert event(future,schedule,buy_in_amount='31.5',buy_in_fee='3.5')=='false,false,0'
        assert sql('SELECT (buy_in_amount+buy_in_fee)::integer FROM tournaments;')=='40'
        event(future,'a70c1028-1200-4000-9000-000000000001',is_bounty='false',buy_in_amount='31.5',buy_in_fee='3.5')
        assert sql('SELECT (buy_in_amount+buy_in_fee)::integer FROM tournaments;')=='40'
        event(future,'a70c1028-1600-4000-9000-000000000001',is_bounty='false',buy_in_amount='31.5',buy_in_fee='3.5')
        assert sql('SELECT (buy_in_amount+buy_in_fee)::integer FROM tournaments;')=='40'
        event(future,is_bounty='false',buy_in_amount='31.5',buy_in_fee='3.5')
        assert sql('SELECT (buy_in_amount+buy_in_fee)::integer FROM tournaments;')=='35'
        assert event(future).startswith('true,true,')
        assert event(future,schedule,club="'22222222-2222-4222-8222-222222222222'").startswith('true,true,')
        assert event(future,schedule,bounty_amount='11').startswith('true,true,')
        assert event(future,schedule,is_mystery_bounty='true').startswith('true,true,')
        assert event(future,schedule,status="'RUNNING'",is_rebuy='true',is_reentry='true',max_rebuys='5')=='true,true,5'
        sql("CREATE TABLE tournament_schedules(id uuid,config jsonb); CREATE FUNCTION fn_ca_mtt_blind_contract(text,integer) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;")
        sched='a70c1028-1800-2500-9000-000000000001'
        sql("INSERT INTO tournament_schedules VALUES ('"+sched+"','{\"blindStructure\":[{\"level\":1,\"smallBlind\":25,\"bigBlind\":50,\"durationMinutes\":8},{\"level\":2,\"smallBlind\":30,\"bigBlind\":60,\"durationMinutes\":8}]}');")
        event(future,sched,is_bounty='false',buy_in_amount='22.5',buy_in_fee='2.5',add_on_available='true')
        assert sql('SELECT add_on_available FROM tournaments;')=='t', 'baseline reproduces add-on override'
        sql((root/'supabase/migrations/20261028162424_daily_6pm_rebuy_terms.sql').read_text())
        event(future,sched,is_bounty='false',buy_in_amount='22.5',buy_in_fee='2.5',add_on_available='true')
        assert sql("SELECT concat_ws(',',starting_chips,max_rebuys,rebuy_cost,rebuy_chips,is_reentry,add_on_available,blind_structure::jsonb->0->>'bigBlind') FROM tournaments;")=='15000,1,25,15000,f,f,50'
        event(future,is_bounty='false',buy_in_amount='22.5',buy_in_fee='2.5',add_on_available='true')
        assert sql('SELECT add_on_available FROM tournaments;')=='t', 'unrelated event preserved'
        event(future,sched,is_bounty='false',status="'RUNNING'",buy_in_amount='22.5',buy_in_fee='2.5',add_on_available='true')
        assert sql('SELECT add_on_available FROM tournaments;')=='t', 'running contract preserved'
        print('PASS: reproduced default override; exact event and future series stay freezeout; unrelated clubs, prices, mystery and running contracts preserved')
    finally:
        run('pg_ctl','-D',str(scratch/'data'),'-m','immediate','stop')

# The existing native CI step also exercises the new fixed-field satellite creator.
subprocess.run([os.environ.get('PYTHON', 'python3'), '-B', str(root/'scripts/ci/test-fixed-sng-satellites.py')], check=True)
