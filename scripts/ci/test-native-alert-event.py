"""Isolated PostgreSQL: exact migration, real RLS/ACL/atomic source delivery."""
import os, pathlib, subprocess, tempfile, shutil, json
ROOT=pathlib.Path(__file__).resolve().parents[2]
PG=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
BASE=pathlib.Path(tempfile.mkdtemp(prefix='native-alert-'))
SOCK=BASE/'s'; SOCK.mkdir()
ENV=dict(os.environ,LC_ALL='C')
CMD=[PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',SOCK,'-p','55883','-U','postgres']
def command(args,sql=None):
    r=subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=ENV,timeout=45)
    if r.returncode: raise RuntimeError(r.stderr+r.stdout)
    return r.stdout.strip()
def sql(s): return command(CMD,s)
def check(s):
    assert sql('SELECT ('+s+')::text;')=='true',s
try:
    command([PG/'initdb','-D',BASE/'db','-A','trust','-U','postgres','--no-locale'])
    command([PG/'pg_ctl','-D',BASE/'db','-l',BASE/'log','-o',f"-k {SOCK} -p 55883 -c listen_addresses=''",'-w','start'])
    sql('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA smarter_private; CREATE SCHEMA realtime; CREATE SCHEMA vault;
CREATE TABLE public.ca_browser_definer_allowlist(proname text PRIMARY KEY,reason text NOT NULL,recorded_at timestamptz DEFAULT now());
CREATE TABLE vault.decrypted_secrets(name text PRIMARY KEY,decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES('ca_native_alert_receive_capability_v1',repeat('a',64));
CREATE TABLE public.operational_alert_events(id bigint PRIMARY KEY,payload jsonb NOT NULL, investigation_status text DEFAULT 'new',investigation_touched_at timestamptz);
CREATE TABLE realtime.messages(id bigint GENERATED ALWAYS AS IDENTITY,payload jsonb,event text,topic text,private boolean);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA realtime TO anon,authenticated;
GRANT SELECT,INSERT ON realtime.messages TO anon,authenticated;
GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO anon,authenticated;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('test.topic',true)$$;
CREATE FUNCTION realtime.send(jsonb,text,text,boolean) RETURNS void LANGUAGE plpgsql AS $$BEGIN
IF current_setting('test.signal_down',true)='yes' THEN RAISE EXCEPTION 'transport unavailable'; END IF;
INSERT INTO realtime.messages(payload,event,topic,private) VALUES($1,$2,$3,$4); END$$;
REVOKE ALL ON FUNCTION realtime.send(jsonb,text,text,boolean) FROM PUBLIC;
INSERT INTO operational_alert_events(id,payload,investigation_status) VALUES(1,'{"private":"not a wake"}','new');''')
    check('(SELECT count(*)=0 FROM realtime.messages)')
    print('preimage reproduced: durable inbox insert has no native event')
    sql("""CREATE TABLE public.notifications(id uuid DEFAULT gen_random_uuid(),user_id uuid,type text,title text,message text,data jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE public.operational_notification_destinations(notification_id uuid,recipient_user_id uuid,original_notification jsonb,captured_at timestamptz DEFAULT now());
CREATE FUNCTION public.fn_raise_notification(uuid,text,text,text,text,jsonb) RETURNS uuid LANGUAGE plpgsql AS $$DECLARE r uuid; BEGIN
INSERT INTO public.notifications(user_id,type,title,message,data) VALUES($1,$2,$3,$4,$6) RETURNING id INTO r; RETURN r; END$$;""")
    preimage=(ROOT/'tests/fixtures/native-alert-event/reader-silence-preimage.sql').read_text()
    sql(preimage)
    sql((ROOT/'supabase/migrations/20261027175950_native_alert_event_delivery.sql').read_text())
    sql('''INSERT INTO operational_alert_events(id,payload,investigation_status) VALUES(2,'{"target_task_id":"01a09b86-5ba8-7290-8657-1041f13dd3ca","private":"complete evidence"}','new'),
(3,'{"target_task_id":"00000000-0000-0000-0000-000000000001"}','new'),(4,'{}','new');''')
    check('(SELECT count(*)=2 FROM smarter_private.ca_native_alert_deliveries)')
    check("(SELECT bool_and(private AND topic='ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' AND event='inbox_committed' AND (SELECT count(*)=2 FROM jsonb_object_keys(payload)) AND NOT payload ? 'private') FROM realtime.messages)")
    check("NOT has_table_privilege('anon','public.operational_alert_events','SELECT')")
    for role in ['anon','authenticated']:
        check(f"NOT has_table_privilege('{role}','smarter_private.ca_native_alert_deliveries','SELECT')")
        check(f"NOT has_function_privilege('{role}','fn_ca_read_native_alert(uuid)','EXECUTE')")
        check(f"NOT has_function_privilege('{role}','fn_ca_ack_native_alert(uuid[],uuid)','EXECUTE')")
        value=json.loads(sql(f"SET ROLE {role}; SELECT fn_ca_native_alert_pending('ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');"))
        assert sorted(value)==['active_acknowledged','pending','version'] and len(value['pending'])==2
    for role in ['anon','authenticated']:
        for channel in ['missing', 'ca-native-alert-intake-v1:'+'b'*64]:
            try:
                sql(f"SET ROLE {role}; SELECT fn_ca_native_alert_pending('{channel}');")
                raise AssertionError('public key alone exposed pending state')
            except RuntimeError as e: assert 'native receive capability required' in str(e)
        check(f"NOT has_table_privilege('{role}','vault.decrypted_secrets','SELECT')")
    check("NOT fn_ca_native_alert_capability(NULL) AND NOT fn_ca_native_alert_capability('wrong')")
    # Verify RLS against the real role, not only catalog policy strings.
    check("(SELECT count(*)=0 FROM realtime.messages WHERE false)")
    assert sql("SET test.topic='ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; SET ROLE anon; SELECT count(*) FROM realtime.messages;")=='2'
    assert sql("SET test.topic='another-topic'; SET ROLE anon; SELECT count(*) FROM realtime.messages;")=='0'
    sql('''CREATE POLICY simulated_future_broad_sender ON realtime.messages FOR INSERT TO anon,authenticated WITH CHECK(true);''')
    try:
        sql("SET test.topic='ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; SET ROLE anon; INSERT INTO realtime.messages(payload,event,topic,private) VALUES('{}','intake_acknowledged','ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',true);")
        raise AssertionError('forged signal allowed')
    except RuntimeError as e: assert 'row-level security' in str(e)
    sql("SET test.topic='unrelated'; SET ROLE anon; INSERT INTO realtime.messages(payload,event,topic,private) VALUES('{}','other','unrelated',true);")
    # An aborted original insertion leaves neither delivery nor signal.
    sql("BEGIN; INSERT INTO operational_alert_events(id,payload,investigation_status) VALUES(5,'{}','new'); ROLLBACK;")
    check('(SELECT count(*)=2 FROM smarter_private.ca_native_alert_deliveries)')
    sql("SET test.signal_down='yes'; INSERT INTO operational_alert_events(id,payload,investigation_status) VALUES(6,'{}','new');")
    check('(SELECT count(*)=3 FROM smarter_private.ca_native_alert_deliveries)')
    w=sql('SELECT wake_id FROM smarter_private.ca_native_alert_deliveries WHERE inbox_event_id=2;')
    read=json.loads(sql(f"SET ROLE service_role; SELECT fn_ca_read_native_alert('{w}');"))
    assert read['inbox']['payload']['private']=='complete evidence'
    for expr in [f"ARRAY['{w}','00000000-0000-0000-0000-000000000001']::uuid[]",f"ARRAY['{w}','{w}']::uuid[]","ARRAY[NULL]::uuid[]"]:
        try:
            sql(f"SET ROLE service_role; SELECT fn_ca_ack_native_alert({expr},'01a09b86-5ba8-7290-8657-1041f13dd3ca');")
            raise AssertionError('invalid acknowledgement allowed')
        except RuntimeError: pass
    check('(SELECT bool_and(read_at IS NULL) FROM smarter_private.ca_native_alert_deliveries)')
    ack=f"SET ROLE service_role; SELECT fn_ca_ack_native_alert(ARRAY['{w}']::uuid[],'01a09b86-5ba8-7290-8657-1041f13dd3ca');"
    sql(ack); stamp=sql(f"SELECT read_at FROM smarter_private.ca_native_alert_deliveries WHERE wake_id='{w}';")
    sql(ack); assert sql(f"SELECT read_at FROM smarter_private.ca_native_alert_deliveries WHERE wake_id='{w}';")==stamp
    check("(SELECT investigation_status='new' FROM operational_alert_events WHERE id=2)")
    check(f"(fn_ca_native_alert_pending('ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ARRAY['{w}']::uuid[])->>'active_acknowledged')::boolean")
    check("NOT (fn_ca_native_alert_pending('ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ARRAY['00000000-0000-0000-0000-000000000001']::uuid[])->>'active_acknowledged')::boolean")
    sql("UPDATE operational_alert_events SET investigation_status='investigating' WHERE id=2;")
    check('(SELECT count(*)=3 FROM smarter_private.ca_native_alert_deliveries)')
    # Regression: one unread active ID currently holds every later delivery.
    blocked=sql('SELECT wake_id FROM smarter_private.ca_native_alert_deliveries WHERE inbox_event_id=4;')
    check(f"NOT (fn_ca_native_alert_pending('ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ARRAY['{w}','{blocked}']::uuid[])->>'active_acknowledged')::boolean")
    sql((ROOT/'supabase/migrations/20261029153652_an_unreadable_alert_cannot_stop_unrelated_native_intake.sql').read_text())
    for role in ['anon','authenticated']:
        check(f"NOT has_table_privilege('{role}','smarter_private.ca_native_alert_read_failures','SELECT')")
        check(f"NOT has_function_privilege('{role}','fn_ca_defer_native_alert(uuid,uuid,text)','EXECUTE')")
    for bad in ["NULL", "''", "repeat('x',2001)"]:
        try:
            sql(f"SET ROLE service_role; SELECT fn_ca_defer_native_alert('{blocked}','00000000-0000-0000-0000-000000000099',{bad});")
            raise AssertionError('invalid failure accepted')
        except RuntimeError as e: assert 'failure reason required' in str(e)
    defer=f"SET ROLE service_role; SELECT fn_ca_defer_native_alert('{blocked}','00000000-0000-0000-0000-000000000099','stored summary completeness requires inspection');"
    sql(defer)
    stamp_failure=sql(f"SELECT recorded_at FROM smarter_private.ca_native_alert_read_failures WHERE wake_id='{blocked}';")
    sql(defer)
    assert sql(f"SELECT recorded_at FROM smarter_private.ca_native_alert_read_failures WHERE wake_id='{blocked}';")==stamp_failure
    check(f"(fn_ca_native_alert_pending('ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ARRAY['{w}','{blocked}']::uuid[])->>'active_acknowledged')::boolean")
    check(f"NOT (fn_ca_native_alert_pending('ca-native-alert-intake-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')->'pending') ? '{blocked}'")
    check(f"(SELECT read_at IS NULL AND reader_task_id IS NULL FROM smarter_private.ca_native_alert_deliveries WHERE wake_id='{blocked}')")
    check("(SELECT investigation_status='new' FROM operational_alert_events WHERE id=4)")
    check("(SELECT count(*)=1 FROM smarter_private.ca_native_alert_read_failures)")
    check(f"(fn_ca_read_native_alert('{blocked}')->>'stored_inbox_characters')::integer = length((fn_ca_read_native_alert('{blocked}')->'inbox')::text)")
    check(f"fn_ca_read_native_alert('{blocked}')->>'stored_inbox_md5' = md5((fn_ca_read_native_alert('{blocked}')->'inbox')::text)")
    check(f"fn_ca_read_native_alert('{blocked}')->'read_failure'->>'reason'='stored summary completeness requires inspection'")
    # Missing deliveries and already-read deliveries cannot get fake failures.
    for candidate in [w,'00000000-0000-0000-0000-000000000001']:
        try:
            sql(f"SET ROLE service_role; SELECT fn_ca_defer_native_alert('{candidate}','00000000-0000-0000-0000-000000000099','failure');")
            raise AssertionError('invalid delivery deferred')
        except RuntimeError: pass
    # Real ACK after a later complete read remains possible; failure history stays.
    sql(f"SET ROLE service_role; SELECT fn_ca_ack_native_alert(ARRAY['{blocked}']::uuid[],'01a09b86-5ba8-7290-8657-1041f13dd3ca');")
    print('PASS: failed individual read unblocks unrelated delivery, retains unread evidence and named failure, real ACLs, duplicate receipt, full-read length/digest, later real ACK')
    # Compile the exact retained preimage body under an isolated test-only name.
    # Its two false verdicts must differ from the new actual trigger body.
    sql(preimage.replace('public.fn_ca_owner_route_reader_silence()', 'public.native_reader_silence_preimage()'))
    sql("""CREATE TABLE public.native_old_destinations(LIKE public.operational_notification_destinations INCLUDING DEFAULTS);
CREATE TRIGGER old_reader AFTER INSERT ON public.native_old_destinations FOR EACH ROW EXECUTE FUNCTION public.native_reader_silence_preimage();
CREATE TRIGGER native_reader AFTER INSERT ON public.operational_notification_destinations FOR EACH ROW EXECUTE FUNCTION public.fn_ca_owner_route_reader_silence();
UPDATE smarter_private.ca_native_alert_deliveries SET created_at=now()-interval '13 hours',read_at=NULL,reader_task_id=NULL;
UPDATE public.operational_alert_events SET investigation_touched_at=now();
INSERT INTO public.native_old_destinations VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000010','{}',now());""")
    check('(SELECT count(*)=0 FROM public.notifications)')
    sql("INSERT INTO public.operational_notification_destinations VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000010','{}',now());")
    check('(SELECT count(*)=1 FROM public.notifications)')
    sql("INSERT INTO public.operational_notification_destinations VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000010','{}',now());")
    check('(SELECT count(*)=1 FROM public.notifications)')
    sql(ack)
    sql("""UPDATE public.operational_alert_events SET investigation_touched_at=NULL;
INSERT INTO public.native_old_destinations VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000011','{}',now());
INSERT INTO public.operational_notification_destinations VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000012','{}',now());""")
    check('(SELECT count(*)=2 FROM public.notifications)')
    check("NOT EXISTS(SELECT 1 FROM public.notifications WHERE user_id='00000000-0000-0000-0000-000000000012')")
    sql("UPDATE smarter_private.ca_native_alert_deliveries SET created_at=now(),read_at=NULL,reader_task_id=NULL; INSERT INTO public.operational_notification_destinations VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000013','{}',now());")
    check('(SELECT count(*)=2 FROM public.notifications)')
    print('PASS: exact old reader masks silence with unrelated edits and ignores native ACK; actual reader uses complete receipts, pending age, fresh/empty intake and duplicate-page protection')
    print('PASS: native capture, destination isolation, real RLS, future broad-policy forgery refusal, private full reads, rollback, signal outage, atomic invalid ack, duplicate ack, unknown state, no financial/investigation mutation')
finally:
    subprocess.run(list(map(str,[PG/'pg_ctl','-D',BASE/'db','-m','immediate','-w','stop'])),capture_output=True)
    shutil.rmtree(BASE)
