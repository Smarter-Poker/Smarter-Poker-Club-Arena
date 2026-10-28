#!/usr/bin/env python3
"""Real trigger regression in an isolated PostgreSQL database; no production writes."""
import json, os, pathlib, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[2]
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
parent = os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not parent:
    raise RuntimeError('Set TMPDIR to the owned SSD scratch directory or provider runner temp')
with tempfile.TemporaryDirectory(prefix='owner-finding-', dir=parent) as folder:
    scratch = pathlib.Path(folder)
    def run(tool, *args, input=None, check=True):
        return subprocess.run([str(pg/tool), *args], input=input, text=True, capture_output=True, check=check)
    run('initdb','-D',str(scratch/'data'),'-A','trust','--no-locale','-E','UTF8')
    # TCP avoids the Mac's 104-byte Unix socket path limit on long owned paths.
    import socket
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0)); port=str(reserve.getsockname()[1])
    run('pg_ctl','-D',str(scratch/'data'),'-l',str(scratch/'server.log'),'-o',f'-k {parent} -p {port} -h 127.0.0.1','start')
    try:
        def sql(source):
            return run('psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-d','postgres', input=source).stdout.strip()
        original = (root/'supabase/migrations/20261007000420_a_real_alert_reaches_the_owner.sql').read_text()
        start=original.index('CREATE FUNCTION public.fn_ca_a_real_alert_reaches_the_owner()')
        function=original[start:original.index('$function$;',start)+len('$function$;')]
        sql("""CREATE TABLE public.ca_owner_page_state(kind text primary key,last_firing_at timestamptz,last_paged_at timestamptz,held_since_page integer default 0,pages_sent bigint default 0);
CREATE TABLE public.ca_incident_recipients(user_id uuid,scope text,active boolean,senior boolean);
INSERT INTO ca_incident_recipients VALUES ('00000000-0000-4000-8000-000000000001','platform',true,true);
INSERT INTO ca_owner_page_state(kind) VALUES('money');
CREATE TABLE public.captured(title text,message text);
CREATE FUNCTION public.fn_ca_owner_page_kind(text,text,text) RETURNS text LANGUAGE sql AS $$ SELECT 'money'::text $$;
CREATE FUNCTION public.fn_raise_notification(uuid,text,text,text,text,jsonb) RETURNS void LANGUAGE sql AS $$ INSERT INTO public.captured VALUES($3,$4) $$;
CREATE TABLE public.operational_alert_events(id bigint,source text,alertname text,severity text,payload jsonb);
"""+function+"""CREATE TRIGGER owner_page AFTER INSERT ON operational_alert_events FOR EACH ROW EXECUTE FUNCTION fn_ca_a_real_alert_reaches_the_owner();""")
        def page(payload):
            literal=json.dumps(payload).replace("'","''")
            return sql("TRUNCATE captured; UPDATE ca_owner_page_state SET last_firing_at=NULL,last_paged_at=NULL,held_since_page=0; INSERT INTO operational_alert_events VALUES(1,'owner-operational-notifications','fallback','critical','"+literal+"'::jsonb); SELECT message FROM captured;")
        payload={'original_notification':{'title':'0.00 chip drift: ledger_imbalance','message':'CRITICAL | fn_ca_absent_tournament_players: 1 finding(s)'}}
        expected=payload['original_notification']['message']
        assert page(payload) != expected, 'baseline must reproduce the lost finding'
        sql((root/'supabase/migrations/20261011190747_an_owner_alert_keeps_the_actual_finding.sql').read_text())
        assert page(payload)==expected
        assert page({'original_notification':{'title':'legacy title','message':'   '}})=='legacy title'
        assert page({'original_notification':{'title':'legacy title','message':None}})=='legacy title'
        assert page({'alert':{'annotations':{'summary':'authoritative annotation'}},**payload})=='authoritative annotation'
        assert page({'original_event':{'summary':'event summary'},**payload})=='event summary'
        assert page({})=='fallback'
        assert len(page({'original_notification':{'message':'x'*450}}))==300
        # Original debounce still holds a repeated event rather than paging twice.
        sql("INSERT INTO operational_alert_events VALUES(2,'owner-operational-notifications','fallback','critical','{}');")
        assert sql('SELECT count(*) FROM captured;')=='1'
        assert sql("SELECT held_since_page FROM ca_owner_page_state WHERE kind='money';")=='1'
        # An unknown preimage refuses; no blind or repeated installation.
        try:
            sql((root/'supabase/migrations/20261011190747_an_owner_alert_keeps_the_actual_finding.sql').read_text())
            raise AssertionError('second apply must refuse')
        except subprocess.CalledProcessError as error:
            assert 'OWNER_FINDING_PREIMAGE_CHANGED' in error.stderr
        print('PASS: baseline reproduction, actual trigger, fallback, priority, truncation, debounce and preimage refusal')
    finally:
        run('pg_ctl','-D',str(scratch/'data'),'-m','immediate','stop')

# The same required accounting job also proves the canonical native intake's
# exact database capture, permissions, read acknowledgements and silence rule.
import sys
subprocess.run([sys.executable,str(root/'scripts/ci/test-native-alert-event.py')],check=True,timeout=90)
