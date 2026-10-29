#!/usr/bin/env python3
"""Qualify exact digest function transition on disposable PostgreSQL 17."""
import json, os, pathlib, socket, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[2]
pg = pathlib.Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
parent = os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not parent:
    raise RuntimeError('Set TMPDIR to owned SSD scratch or provider runner temp')
if os.uname().sysname == 'Darwin' and not parent.startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('Mac fixture storage must be on SmarterWork')
migration = root/'supabase/migrations/20261025143717_digest_counts_original_alerts_rather_than_source_updates.sql'
with tempfile.TemporaryDirectory(prefix='digest-original-', dir=parent) as folder:
    scratch = pathlib.Path(folder)
    def run(tool, *args, input=None, check=True):
        result = subprocess.run([str(pg/tool), *args], input=input, text=True,
                                capture_output=True, timeout=90)
        if check and result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result
    run('initdb', '-D', str(scratch/'data'), '-A', 'trust', '--no-locale', '-E', 'UTF8')
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0)); port = str(reserve.getsockname()[1])
    run('pg_ctl', '-D', str(scratch/'data'), '-l', str(scratch/'server.log'),
        '-o', f'-k {parent} -p {port} -h 127.0.0.1', 'start')
    try:
        def sql(source, check=True):
            return run('psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
                       '-h', '127.0.0.1', '-p', port, '-d', 'postgres', input=source, check=check)
        sql('''CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
CREATE TABLE sp_daily_metrics(day date,metrics jsonb,attention jsonb,computed_at timestamptz,compute_ms int);
CREATE TABLE sp_daily_digest_runs(day date,status text,sent_at timestamptz);
CREATE TABLE club_rake_daily_user(day date,rake_amount numeric);
CREATE FUNCTION fn_ca_horse_roster_digest(date) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION fn_sp_dispatch_attention(date,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT $2 $$;
CREATE FUNCTION fn_sp_daily_metrics_snapshot(date) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE TABLE ca_drift_incidents(resolved_at timestamptz,deadline_at timestamptz);
CREATE TABLE tournaments(id uuid,name text,tournament_type text,status text,started_at timestamptz);
CREATE TABLE cashout_requests(completed_at timestamptz,cancelled_at timestamptz,status text,created_at timestamptz);
CREATE TABLE settlement_invoices(invoice_type text,created_at timestamptz,message_sent boolean);
CREATE TABLE wheel_configs(enabled boolean,exposure_allowance_chips numeric);
CREATE TABLE diamond_game_configs(enabled boolean,exposure_allowance_chips numeric);
CREATE FUNCTION fn_sp_setting(text,numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT $2 $$;
CREATE FUNCTION fn_diamond_spins_allowance_floor() RETURNS numeric LANGUAGE sql AS $$ SELECT 2500 $$;
CREATE TABLE operational_alert_events(id bigint,alertname text,severity text,received_at timestamptz,
 investigation_status text,payload jsonb,investigation jsonb);
INSERT INTO operational_alert_events(id,alertname,severity,received_at,investigation_status,payload)
 SELECT n,'Refusal','critical','2026-10-24 12:00Z','new',jsonb_build_object('snapshot_kind','insert') FROM generate_series(1,6) n;
INSERT INTO operational_alert_events(id,alertname,severity,received_at,investigation_status,payload)
 SELECT n+10,'Refusal','critical','2026-10-24 12:10Z','new',jsonb_build_object('snapshot_kind','update_new','original_event',jsonb_build_object('resolved',true)) FROM generate_series(1,6) n;
INSERT INTO operational_alert_events(id,alertname,severity,received_at,investigation_status,payload)
 SELECT n+20,'Refusal','critical','2026-10-23 12:00Z','new',jsonb_build_object('snapshot_kind','insert') FROM generate_series(1,3) n;
INSERT INTO operational_alert_events(id,alertname,severity,received_at,investigation_status,payload)
 SELECT n+30,'Refusal','critical','2026-10-23 12:10Z','new',jsonb_build_object('snapshot_kind','update_new') FROM generate_series(1,3) n;
''')
        sql((root/'tests/fixtures/digest-alert-count-preimages.sql').read_text())
        for sig in ['fn_sp_daily_metrics_compute(date)', 'fn_sp_digest_attention(date,jsonb)', 'fn_sp_daily_digest(date,boolean)']:
            sql(f'REVOKE ALL ON FUNCTION {sig} FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION {sig} TO service_role;')
        before = sql("SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,proconfig) ORDER BY oid) FROM pg_proc WHERE proname IN ('fn_sp_daily_metrics_compute','fn_sp_digest_attention','fn_sp_daily_digest');").stdout
        def count_query(candidate):
            predicate = "AND payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'" if candidate else ''
            return f"SELECT count(*) FROM operational_alert_events WHERE received_at >= '2026-10-24 05:00Z' AND received_at < '2026-10-25 05:00Z' AND investigation_status IS DISTINCT FROM 'informational' AND severity='critical' {predicate};"
        assert sql(count_query(False)).stdout.strip() == '12', 'must reproduce double counting'
        old = json.loads(sql("SELECT fn_sp_digest_attention('2026-10-24','{\"health\":{\"alert_names\":{\"Refusal\":12}}}');").stdout)
        assert any('(12, 6 the day before)' in x['title'] for x in old)
        sql("INSERT INTO sp_daily_metrics VALUES ('2026-10-24','{\"money\":{\"ledger_rake_utc_day\":343158.54,\"rollup_rake_utc_day\":0}}','[{\"rule\":\"rake_rollup_mismatch\",\"title\":\"Original zero rollup\",\"severity\":\"warning\",\"alert_event_id\":200}]',now(),1);")
        sql("INSERT INTO operational_alert_events(id,investigation_status) VALUES (200,'new'); INSERT INTO club_rake_daily_user VALUES ('2026-10-24',343158.54),('2026-10-25',999999);")
        stored = sql("SELECT row_to_json(m) FROM sp_daily_metrics m;").stdout
        baseline_report = json.loads(sql("SELECT fn_sp_daily_digest('2026-10-24',false);").stdout)
        assert baseline_report['metrics']['money']['rollup_rake_utc_day'] == 0
        assert baseline_report['attention'][0]['status'] == 'not_picked_up'
        sql(migration.read_text())
        assert sql(count_query(True)).stdout.strip() == '6', 'six incidents, irrespective of resolution updates'
        new = json.loads(sql("SELECT fn_sp_digest_attention('2026-10-24','{\"health\":{\"alert_names\":{\"Refusal\":6}}}');").stdout)
        assert not any(x['rule'] == 'critical_alert_rising' for x in new), new
        # Six incidents are below the unchanged ten-event rising threshold.
        comparison = json.loads(sql("SELECT fn_sp_digest_attention('2026-10-24','{\"health\":{\"alert_names\":{\"Refusal\":12}}}');").stdout)
        assert any('(12, 3 the day before)' in x['title'] for x in comparison), comparison
        definition = sql("SELECT pg_get_functiondef('fn_sp_daily_metrics_compute(date)'::regprocedure);").stdout
        assert definition.count("payload->>'snapshot_kind' IS DISTINCT FROM 'update_new'") == 3
        assert before == sql("SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,proconfig) ORDER BY oid) FROM pg_proc WHERE proname IN ('fn_sp_daily_metrics_compute','fn_sp_digest_attention','fn_sp_daily_digest');").stdout
        # Legacy direct alerts without snapshot metadata remain counted; informational
        # source rows do not. An update-only observation is never a new failure.
        sql("INSERT INTO operational_alert_events(id,alertname,severity,received_at,investigation_status,payload) VALUES (100,'Direct','critical','2026-10-24 13:00Z','new','{}'),(101,'Info','critical','2026-10-24 13:00Z','informational','{}'),(102,'OldResolved','critical','2026-10-24 13:00Z','new','{\"snapshot_kind\":\"update_new\"}');")
        assert sql(count_query(True)).stdout.strip() == '7'
        # The real read-only and dispatch paths re-read the rollup against its recorded ledger while
        # retaining the stored zero and original alert. No synthetic money RPC.
        for dispatch in ['false','true']:
            report = json.loads(sql(f"SELECT fn_sp_daily_digest('2026-10-24',{dispatch});").stdout)
            assert report['metrics']['money']['rollup_rake_utc_day'] == 343158.54
            assert report['metrics']['money']['ledger_rake_utc_day'] == 343158.54
            assert report['metrics']['money']['rollup_rechecked_at']
            assert report['attention'][0]['status'] == 'fixed'
            assert '343158.54' in report['attention'][0]['resolution']
            assert stored == sql("SELECT row_to_json(m) FROM sp_daily_metrics m;").stdout
            assert sql("SELECT investigation_status FROM operational_alert_events WHERE id=200;").stdout.strip() == 'new'
        sql("UPDATE operational_alert_events SET investigation_status='verified_fixed' WHERE id=200;")
        sql("UPDATE club_rake_daily_user SET rake_amount=10 WHERE day='2026-10-24';")
        report = json.loads(sql("SELECT fn_sp_daily_digest('2026-10-24',false);").stdout)
        assert report['attention'][0]['status'] == 'not_picked_up'
        assert report['metrics']['money']['rollup_rake_utc_day'] == 10
        assert stored == sql("SELECT row_to_json(m) FROM sp_daily_metrics m;").stdout
        repeated = sql(migration.read_text(), check=False)
        assert repeated.returncode and 'DIGEST_ALERT_PREIMAGE_DRIFT' in repeated.stderr
        # Oct27 assembly timeout: exact live predecessor vs one-pass history.
        sql((root/'tests/fixtures/digest-spin-attention-preimage.sql').read_text())
        cases = [
          '{}',
          '{"health":{"alert_names":{"Refusal":12,"Direct":1,"Info":1,"OldResolved":1,"UnknownNew":1}}}',
          '{"health":{"alert_names":{"Refusal":6}}}',
          '{"health":{"alert_names":{"Refusal":10}}}',
          '{"health":{"alert_names":{"Refusal":9}}}',
        ]
        def attention_values():
            return [json.loads(sql("SELECT fn_sp_digest_attention('2026-10-24','"+case+"');").stdout) for case in cases]
        # Preserve new-type, doubling, minimum-ten, update-only and informational rules.
        old_values=attention_values()
        metadata=sql("SELECT proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid='fn_sp_digest_attention(date,jsonb)'::regprocedure;").stdout
        candidate=root/'supabase/migrations/20261027142826_digest_attention_reads_critical_history_once.sql'
        sql(candidate.read_text())
        assert attention_values()==old_values
        body=sql("SELECT pg_get_functiondef('fn_sp_digest_attention(date,jsonb)'::regprocedure);").stdout
        start=body.index('  WITH history AS MATERIALIZED')
        query=body[start:body.index('  IF v > 0 THEN',start)].replace('    INTO v, t\n','')
        query=query.replace('p_metrics',"'{\"health\":{\"alert_names\":{\"Refusal\":12}}}'::jsonb")
        query=query.replace("s - interval", "'2026-10-24 05:00Z'::timestamptz - interval").replace('< s\n',"< '2026-10-24 05:00Z'::timestamptz\n")
        plan=json.loads(sql('EXPLAIN (FORMAT JSON) '+query).stdout)[0]['Plan']
        def history_scans(node):
            return int(node.get('Relation Name')=='operational_alert_events')+sum(history_scans(x) for x in node.get('Plans',[]))
        assert history_scans(plan)==1, plan
        assert sql("SELECT proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid='fn_sp_digest_attention(date,jsonb)'::regprocedure;").stdout==metadata
        assert 'DIGEST_SPIN_PREIMAGE_DRIFT' in sql(candidate.read_text(),check=False).stderr
        print('PASS: exact attention predecessor and candidate agree on new/rising/unchanged/empty alert cases; single materialized history scan; access/config preserved; drift/replay refused')
        print('PASS: 12-to-6 baseline, unchanged ten-event threshold and actual prior-day count 3, all metric consumers, direct/optional metadata, informational/update-only exclusion, unchanged ACL/owner/settings, read-only and dispatch freshness, original snapshot/alert retained, real mismatch remains open, replay refusal')
        # Grouped signals retain exact original provenance rather than an
        # assignment badge that can never observe the originals resolving.
        group_migration=root/'supabase/migrations/20261029182643_digest_grouped_critical_alerts_retain_original_identity.sql'
        group_defs=json.loads((root/'tests/fixtures/digest-group-preimages.json').read_text())
        sql("ALTER TABLE operational_alert_events ADD COLUMN source text,ADD COLUMN status text,ADD COLUMN last_received_at timestamptz; CREATE TABLE financial_alerts(id uuid PRIMARY KEY,source text,created_at timestamptz,resolved boolean,resolved_at timestamptz);")
        for definition in group_defs:
            sql(definition['definition'])
        group_metadata=sql("SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,proconfig) ORDER BY oid) FROM pg_proc WHERE proname IN ('fn_sp_digest_attention','fn_sp_daily_digest');").stdout
        def literal(value):
            return "'"+json.dumps(value).replace("'","''")+"'::jsonb"
        labels={'alertname':'OpenClawFleetLongSilence','host':'engine-01'}
        firing={'alert':{'fingerprint':'75619586bd3b2224','startsAt':'2026-10-28T17:01:00.848Z','labels':labels,'status':'firing'}}
        financial_payload={'original_event':{'id':'10063685-5d51-4fd9-9d46-b4a8fcd28744','created_at':'2026-10-28T23:42:42.382429+00:00'}}
        sql("INSERT INTO operational_alert_events(id,alertname,severity,received_at,investigation_status,payload,source,status) VALUES (289742,'OpenClawFleetLongSilence','critical','2026-10-28T17:01:11.415596Z','new',"+literal(firing)+",'alertmanager','firing'),(291196,'Tournament.atomic_satellite_finish_refused','critical','2026-10-28T23:42:42.454884Z','new',"+literal(financial_payload)+",'financial-alerts-backfill','firing');")
        names={'OpenClawFleetLongSilence':1,'Tournament.atomic_satellite_finish_refused':1}
        metrics={'health':{'alert_names':names},'money':{'ledger_rake_utc_day':0}}
        text='OpenClawFleetLongSilence (1, 0 the day before); Tournament.atomic_satellite_finish_refused (1, 0 the day before)'
        original={'rule':'critical_alert_rising','severity':'critical','dispatch':False,'title':'Original daily signal','detail':{'count':2,'alerts':text}}
        sql("INSERT INTO sp_daily_metrics VALUES ('2026-10-28',"+literal(metrics)+","+literal([original])+",'2026-10-29T05:21:21.075476Z',1);")
        def grouped_report():
            report=json.loads(sql("SELECT fn_sp_daily_digest('2026-10-28',false);").stdout)
            return next(x for x in report['attention'] if x['rule']=='critical_alert_rising')
        assert grouped_report()['status']=='tracked', 'old consumer has no original linkage'
        sql(group_migration.read_text())
        linked=json.loads(sql("SELECT attention FROM sp_daily_metrics WHERE day='2026-10-28';").stdout)[0]
        assert {k:v for k,v in linked['detail'].items() if k!='source_events'}==original['detail']
        assert linked['title']==original['title']
        assert linked['detail']['source_events'][0]['event_ids']==[289742]
        assert grouped_report()['status']=='not_picked_up'
        sql("UPDATE operational_alert_events SET investigation_status='investigating' WHERE id=289742;")
        assert grouped_report()['status']=='in_progress'
        sql("UPDATE operational_alert_events SET investigation_status='historical' WHERE id IN(289742,291196);")
        assert grouped_report()['status']=='fixed'
        # Canonical source resolution needs no manual review on every future
        # episode, but an identically named different episode is not proof.
        sql("UPDATE operational_alert_events SET investigation_status='new' WHERE id IN(289742,291196);")
        closed={'alert':{'fingerprint':'75619586bd3b2224','startsAt':'2026-10-28T17:01:00.848Z','endsAt':'2026-10-29T06:38:00.848Z','labels':labels,'status':'resolved'}}
        sql("INSERT INTO operational_alert_events(id,alertname,severity,received_at,investigation_status,payload,source,status) VALUES(292824,'OpenClawFleetLongSilence','critical','2026-10-29T06:41:11.119124Z','new',"+literal(closed)+",'alertmanager','resolved'); INSERT INTO financial_alerts VALUES('10063685-5d51-4fd9-9d46-b4a8fcd28744','Tournament.atomic_satellite_finish_refused','2026-10-28T23:42:42.382429Z',true,'2026-10-29T00:18Z');")
        assert grouped_report()['status']=='fixed', grouped_report()
        for bad_id in ['not-a-uuid','9999999999999999999999999999999999999999']:
            wrong={'original_event':financial_payload['original_event']|{'id':bad_id}}
            sql("UPDATE operational_alert_events SET payload="+literal(wrong)+" WHERE id=291196;")
            assert grouped_report()['status']!='fixed', 'invalid financial identity cannot borrow a source resolution'
        sql("UPDATE operational_alert_events SET payload="+literal(financial_payload)+" WHERE id=291196;")
        canonical=sql("SELECT attention FROM sp_daily_metrics WHERE day='2026-10-28';").stdout
        for changes in [
            {'startsAt':'2026-10-28T18:01:00.848Z'},
            {'fingerprint':'other-fingerprint'},
            {'labels':{'alertname':'OpenClawFleetLongSilence','host':'different-host'}},
            {'endsAt':'not-a-timestamp'},
        ]:
            wrong={'alert':closed['alert']|changes}
            sql("UPDATE operational_alert_events SET payload="+literal(wrong)+" WHERE id=292824;")
            assert grouped_report()['status']!='fixed', changes
        sql("UPDATE operational_alert_events SET payload="+literal(closed)+" WHERE id=292824;")
        assert grouped_report()['status']=='fixed'
        sql("UPDATE operational_alert_events SET last_received_at='2026-10-29T07:00Z' WHERE id=289742;")
        assert grouped_report()['status']!='fixed', 'a later firing observation cannot borrow an older resolve'
        sql("UPDATE operational_alert_events SET last_received_at=NULL WHERE id=289742;")
        assert grouped_report()['status']=='fixed'
        # Later recurrence cannot rewrite this daily signal's recorded member
        # set. A new producer call captures its own exact members and counts.
        sql("INSERT INTO operational_alert_events(id,alertname,severity,received_at,investigation_status,payload,source,status) VALUES(400000,'BrandNew','critical','2026-10-29T13:00Z','new','{}','other','firing');")
        fresh=json.loads(sql("SELECT fn_sp_digest_attention('2026-10-29','{\"health\":{\"alert_names\":{\"BrandNew\":1}}}');").stdout)
        fresh=next(x for x in fresh if x['rule']=='critical_alert_rising')
        assert fresh['detail']['source_events']==[{'alertname':'BrandNew','expected_count':1,'event_ids':[400000]}]
        assert grouped_report()['status']=='fixed'
        assert sql("SELECT attention FROM sp_daily_metrics WHERE day='2026-10-28';").stdout==canonical
        bad_cases=[None,{},[{'alertname':'OpenClawFleetLongSilence','expected_count':1,'event_ids':[999999999999999999999999999999]}],
                   [{'alertname':'OpenClawFleetLongSilence','expected_count':1,'event_ids':[289742]}, {'alertname':'Tournament.atomic_satellite_finish_refused','expected_count':1,'event_ids':[289742]}]]
        for bad in bad_cases:
            altered=linked|{'detail':linked['detail']|{'source_events':bad}}
            sql("UPDATE sp_daily_metrics SET attention="+literal([altered])+" WHERE day='2026-10-28';")
            unknown=grouped_report()
            assert unknown['status']=='tracked' and 'incomplete' in unknown['resolution'],unknown
        sql("UPDATE sp_daily_metrics SET attention="+literal([linked])+" WHERE day='2026-10-28';")
        assert grouped_report()['status']=='fixed'
        assert group_metadata==sql("SELECT jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosecdef,proconfig) ORDER BY oid) FROM pg_proc WHERE proname IN ('fn_sp_digest_attention','fn_sp_daily_digest');").stdout
        body=sql("SELECT pg_get_functiondef('fn_sp_digest_attention(date,jsonb)'::regprocedure);").stdout
        start=body.index('  WITH original_inbox AS MATERIALIZED')
        query=body[start:body.index('  IF v > 0 THEN',start)].replace('    INTO v, t, v_source_events\n','')
        query=query.replace('p_metrics',literal(metrics)).replace('>= s',">= '2026-10-28 05:00Z'::timestamptz").replace('< s',"< '2026-10-28 05:00Z'::timestamptz").replace('< e',"< '2026-10-29 05:00Z'::timestamptz")
        plan=json.loads(sql('EXPLAIN (FORMAT JSON) '+query).stdout)[0]['Plan']
        assert history_scans(plan)==1, 'Linkage must not restore repeated inbox scans'
        consumer=sql("SELECT pg_get_functiondef('fn_sp_daily_digest(date,boolean)'::regprocedure);").stdout
        financial_query='SELECT 1 FROM public.financial_alerts financial'+consumer.split('OR EXISTS(SELECT 1 FROM public.financial_alerts financial',1)[1].split('OR EXISTS(SELECT 1 FROM public.operational_alert_events closed',1)[0].rstrip()[:-1]
        sql("INSERT INTO financial_alerts SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'Other',now(),false,NULL FROM generate_series(1,2000)n; ANALYZE financial_alerts; ANALYZE operational_alert_events;")
        plan=json.loads(sql('EXPLAIN (FORMAT JSON) SELECT original.id FROM operational_alert_events original WHERE original.id=291196 AND EXISTS('+financial_query+');').stdout)[0]['Plan']
        def uses_financial_pk(node):
            return node.get('Index Name')=='financial_alerts_pkey' or any(uses_financial_pk(x) for x in node.get('Plans',[]))
        assert uses_financial_pk(plan), 'Canonical lookup must use the UUID primary key'
        proof=next(x.split(':',1)[1].strip() for x in group_migration.read_text().splitlines() if x.startswith('-- @live-proof:'))
        assert sql('SELECT '+proof+';').stdout.strip()=='t', 'Installed byte proof must match both actual function bodies'
        assert 'DIGEST_GROUP_PREIMAGE_DRIFT' in sql(group_migration.read_text(),check=False).stderr
        print('PASS: exact grouped originals, native source transition, producer IDs, read-only status, historical count preservation, reviewed/investigating/new, canonical financial outcome and same-episode recovery, different episode/labels/fingerprint rejection, malformed/missing/duplicate/overflow IDs conservative unknown, source ACL/config preservation, replay refusal')
    finally:
        run('pg_ctl', '-D', str(scratch/'data'), '-m', 'immediate', 'stop')
