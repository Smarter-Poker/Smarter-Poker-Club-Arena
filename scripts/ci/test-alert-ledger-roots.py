"""Real isolated PostgreSQL regression for mint receipts and explicit investigation."""
import os, pathlib, subprocess, tempfile, shutil, json
ROOT = pathlib.Path(__file__).resolve().parents[2]
PG = pathlib.Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='alert-ledger-'))
SOCK = BASE / 's'; SOCK.mkdir()
ENV = dict(os.environ, LC_ALL='C')
CMD = [str(PG/'psql'), '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', str(SOCK), '-p', '55879', '-U', 'postgres']
def command(args, sql=None):
    r = subprocess.run(list(map(str,args)), input=sql, text=True, capture_output=True, env=ENV, timeout=60)
    if r.returncode: raise RuntimeError(r.stderr + r.stdout)
    return r.stdout.strip()
def sql(s): return command(CMD, s)
def check(s):
    assert sql('SELECT ('+s+')::text;') == 'true', s
F = ROOT/'scripts/ci/fixtures/alert-ledger-roots'
schema = '''
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
CREATE TABLE chip_ledger(id uuid PRIMARY KEY,amount numeric,from_type text,to_type text,status text,category text,to_entity_id uuid,club_id uuid,idempotency_key text,created_at timestamptz DEFAULT now());
CREATE TABLE ca_mint_ledger(op_id text,chip_ledger_id uuid,origin text,performed_by_label text,action text,asset text,amount numeric,reason text,holder_type text,holder_id uuid,balance_before numeric,balance_after numeric,performed_by uuid);
CREATE TABLE ca_op_claims(op_id text,fn_name text,result jsonb,finalized_at timestamptz);
CREATE FUNCTION fn_ca_launch_velocity_receipt(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_ca_declare_guard_redefinition(text,text) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_ca_raise_drift_incident(VARIADIC text[]) RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE TABLE ca_drift_incidents(id uuid PRIMARY KEY,status text,acknowledged_by uuid,acknowledged_at timestamptz,assigned_to uuid,classification text,root_cause text,correction_ref text,resolved_by uuid,resolved_at timestamptz,resolution text,severity text,past_target boolean,escalation_level int,detected_at timestamptz,deadline_at timestamptz);
CREATE TABLE ca_incident_events(incident_id uuid,kind text,actor uuid,detail jsonb);
CREATE FUNCTION fn_ca_incident_recipient_ids(ca_drift_incidents,boolean) RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['00000000-0000-0000-0000-000000000010'::uuid]$$;
CREATE FUNCTION fn_ca_incident_notify(uuid,text,text,boolean) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE TABLE operational_alert_events(id bigint PRIMARY KEY,source text,investigation jsonb DEFAULT '{}',investigation_status text DEFAULT 'new',investigation_touched_at timestamptz);
CREATE TABLE operational_notification_destinations(inbox_event_id bigint,original_notification jsonb);
'''
try:
    command([PG/'initdb','-D',BASE/'db','-A','trust','-U','postgres','--no-locale'])
    command([PG/'pg_ctl','-D',BASE/'db','-l',BASE/'log','-o',f"-k {SOCK} -p 55879 -c listen_addresses=''",'-w','start'])
    sql(schema)
    # The production trigger stamps only actual investigation changes.
    sql('''CREATE FUNCTION stamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.investigation_touched_at:=clock_timestamp(); RETURN NEW; END$$;
CREATE TRIGGER stamp BEFORE UPDATE OF investigation,investigation_status ON operational_alert_events FOR EACH ROW WHEN (OLD.investigation IS DISTINCT FROM NEW.investigation OR OLD.investigation_status IS DISTINCT FROM NEW.investigation_status) EXECUTE FUNCTION stamp();''')
    sql((F/'fn_ca_mint_velocity_watch.sql').read_text())
    sql((F/'fn_ca_incident_action.sql').read_text())
    # Avoid mocking the raised result: compile the actual watch's complete
    # signature against a recorder with the same concrete argument types.
    sql('DROP FUNCTION fn_ca_raise_drift_incident(text[]);')
    sql('''CREATE TABLE raised(amount numeric);
CREATE FUNCTION fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb) RETURNS uuid LANGUAGE plpgsql AS $$BEGIN INSERT INTO raised VALUES($5); RETURN NULL; END$$;''')
    sql('''INSERT INTO ca_drift_incidents(id,status,classification,severity) VALUES('00000000-0000-0000-0000-000000000001','open','ledger_imbalance','warning');
INSERT INTO operational_alert_events(id,source) VALUES(1,'owner-operational-notifications'),(2,'owner-operational-notifications');
INSERT INTO operational_notification_destinations VALUES(1,'{"data":{"incident_id":"00000000-0000-0000-0000-000000000001"}}');
SELECT fn_ca_incident_action('00000000-0000-0000-0000-000000000001','acknowledge');''')
    check('(SELECT investigation_touched_at IS NULL FROM operational_alert_events WHERE id=1)')
    def mint(i):
        uid = f'00000000-0000-0000-0000-{i:012d}'
        sql(f'''INSERT INTO chip_ledger VALUES('{uid}',620000,'issuance_reserve','club_treasury','posted','mint','{uid}','{uid}','mint:op{i}',now());
INSERT INTO ca_mint_ledger VALUES('op{i}','{uid}','operator','operator display name','mint','chips',620000,'A recorded operator funding','club','{uid}',100,620100,NULL);
INSERT INTO ca_op_claims SELECT 'op{i}','fn_ca_mint',jsonb_build_object('ok',true,'op_id','op{i}','action','mint','asset','chips','ledger_id','{uid}','amount',620000,'destination','club','target_id','{uid}','balance_before',100,'balance_after',620100,'minted_by',NULL,'reason','A recorded operator funding'),now();''')
    for i in range(11,14): mint(i)
    check('fn_ca_mint_velocity_watch()=1860000')
    sql('TRUNCATE raised;')
    migration = ROOT/'supabase/migrations/20261026150531_the_mint_watch_recognizes_its_completed_issuance_receipt_and.sql'
    sql(migration.read_text())
    check('fn_ca_mint_velocity_watch()=0')
    check('(SELECT count(*)=0 FROM raised)')
    mint(14); check('fn_ca_mint_velocity_watch()=2480000')
    sql("DELETE FROM chip_ledger WHERE idempotency_key='mint:op14'; TRUNCATE raised;")
    for mutation in ["result=result||'{\"ok\":false}'", "result=result||'{\"amount\":1}'", "finalized_at=NULL", "result=result||'{\"target_id\":\"bad\"}'", "result=result||'{\"ledger_id\":\"bad\"}'"]:
        # One call owns BEGIN through ROLLBACK; no transaction crosses connections.
        checksql='BEGIN; UPDATE ca_op_claims SET '+mutation+" WHERE op_id='op11'; DO $$BEGIN IF fn_ca_mint_velocity_watch()<>620000 THEN RAISE EXCEPTION 'invalid receipt excluded'; END IF; END$$; ROLLBACK;"
        sql(checksql)
    sql("SELECT fn_ca_incident_action('00000000-0000-0000-0000-000000000001','comment','evidence reviewed');")
    check("(SELECT investigation_touched_at IS NOT NULL AND investigation_status='investigating' FROM operational_alert_events WHERE id=1)")
    check('(SELECT investigation_touched_at IS NULL FROM operational_alert_events WHERE id=2)')
    # A failure to persist the investigation rolls the incident action back.
    sql('''CREATE FUNCTION refuse_stamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'persistence failed'; END$$;
CREATE TRIGGER refuse_stamp BEFORE UPDATE ON operational_alert_events FOR EACH ROW EXECUTE FUNCTION refuse_stamp();
DO $$DECLARE before_count bigint; BEGIN SELECT count(*) INTO before_count FROM ca_incident_events;
BEGIN PERFORM fn_ca_incident_action('00000000-0000-0000-0000-000000000001','comment','must roll back'); RAISE EXCEPTION 'unexpected success';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'persistence failed' THEN RAISE; END IF; END;
IF (SELECT count(*) FROM ca_incident_events)<>before_count THEN RAISE EXCEPTION 'partial action committed'; END IF; END$$;
DROP TRIGGER refuse_stamp ON operational_alert_events;''')
    sql("UPDATE operational_alert_events SET investigation_status='verified_fixed' WHERE id=1; SELECT fn_ca_incident_action('00000000-0000-0000-0000-000000000001','acknowledge');")
    check("(SELECT investigation_status='verified_fixed' FROM operational_alert_events WHERE id=1)")
    check("(fn_ca_incident_action('00000000-0000-0000-0000-000000000001','invalid')->>'ok')='false'")
    sql("SET test.uid='00000000-0000-0000-0000-000000000099'; DO $$BEGIN IF fn_ca_incident_action('00000000-0000-0000-0000-000000000001','comment')->>'reason'<>'not_authorized' THEN RAISE EXCEPTION 'authorization'; END IF; END$$;")
    print('PASS: preimage reproduced; completed receipts, fourth mint, malformed/unfinished claims, explicit action stamps, unrelated row, terminal state, unknown action, authorization')
finally:
    subprocess.run([str(PG/'pg_ctl'),'-D',str(BASE/'db'),'-m','immediate','-w','stop'],capture_output=True)
    shutil.rmtree(BASE)
