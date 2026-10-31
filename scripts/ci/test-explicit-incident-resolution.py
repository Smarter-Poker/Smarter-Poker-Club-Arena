"""Real PostgreSQL regression for an investigated replacement of a silence age-out."""
import ast, os, pathlib, shutil, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
PG=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
BASE=pathlib.Path(tempfile.mkdtemp(prefix='ic-')); SOCK=BASE/'s'; SOCK.mkdir()
CMD=[str(PG/'psql'),'-XqAt','-v','ON_ERROR_STOP=1','-h',str(SOCK),'-p','55881','-U','postgres']
checks=[]
def command(args, source=None):
    r=subprocess.run(list(map(str,args)),input=source,text=True,capture_output=True,env=dict(os.environ,LC_ALL='C'),timeout=60)
    if r.returncode: raise RuntimeError(r.stderr+r.stdout)
    return r.stdout.strip()
def sql(s): return command(CMD,s)
def check(name,s):
    assert sql('SELECT ('+s+')::text')=='true',name
    checks.append(name)
def refuses(name,s,reason):
    try: sql(s)
    except RuntimeError as e:
        assert reason in str(e),str(e)
        checks.append(name); return
    raise AssertionError(name+' unexpectedly succeeded')
I='00000000-0000-0000-0000-000000000001'
CAUSE='The original detector did not recognize the exact finalized operator issuance receipt.'
REF='PR #8217; migration 20261026150531; three exact finalized receipts'
def resolve(cause=CAUSE,ref=REF,note='Exact original receipts independently verified; no chips moved.'):
    return "SELECT fn_ca_incident_action('%s','resolve','%s',NULL,'%s','%s')"%(I,note,cause,ref)
try:
    command([PG/'initdb','-D',BASE/'db','-A','trust','-U','postgres','--no-locale'])
    command([PG/'pg_ctl','-D',BASE/'db','-l',BASE/'log','-o',f"-k {SOCK} -p 55881 -c listen_addresses='' -c shared_buffers=16MB",'-w','start'])
    tree=ast.parse((ROOT/'scripts/ci/test-alert-ledger-roots.py').read_text())
    schema=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='schema' for t in n.targets))
    sql(schema)
    sql("""ALTER TABLE ca_drift_incidents ADD COLUMN closure_basis text CHECK(closure_basis IS NULL OR closure_basis IN ('verified_remeasured','aged_out_unverified','operator','repair')),ADD COLUMN metadata jsonb DEFAULT '{}';
    CREATE TABLE financial_alerts(id uuid PRIMARY KEY,context jsonb,resolved boolean DEFAULT false,resolved_at timestamptz,resolution text);
    CREATE TABLE ca_incident_file_failures(source text,dedupe_key text,classification text,severity text,discrepancy numeric,sqlstate text,message text);
    CREATE TABLE pushes(id uuid);
    CREATE OR REPLACE FUNCTION fn_ca_incident_notify(uuid,text,text,boolean) RETURNS void LANGUAGE sql AS $$INSERT INTO pushes VALUES($1)$$;
    """)
    F=ROOT/'scripts/ci/fixtures/alert-ledger-roots'
    for name in ['fn_ca_incident_action','fn_ca_resolution_needs_a_cause','fn_ca_incident_resolution_reaches_the_alerts']:
        sql((F/('closure-preimage-'+name+'.sql')).read_text())
    sql("""CREATE TRIGGER trg_ca_resolution_needs_a_cause BEFORE UPDATE ON ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_resolution_needs_a_cause();
    CREATE TRIGGER zz_ca_incident_resolution_reaches_the_alerts AFTER UPDATE OF status ON ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION fn_ca_incident_resolution_reaches_the_alerts();
    REVOKE ALL ON FUNCTION fn_ca_incident_action(uuid,text,text,uuid,text,text) FROM PUBLIC,anon;
    GRANT EXECUTE ON FUNCTION fn_ca_incident_action(uuid,text,text,uuid,text,text) TO authenticated,service_role;
    """)
    sql(f"""INSERT INTO ca_drift_incidents(id,status,classification,severity,closure_basis,root_cause,correction_ref,resolution,resolved_at,detected_at,deadline_at)
    VALUES('{I}','resolved','ledger_imbalance','critical','aged_out_unverified','Never established. The event stream stopped reporting; no evidence was measured.','aged-out: silence','Original age-out',now()-interval '1 day',now()-interval '2 days',now()-interval '2 days'+interval '20 minutes');
    INSERT INTO ca_incident_events VALUES('{I}','status_change',NULL,'{{"closure_basis":"aged_out_unverified","note":"original"}}');
    INSERT INTO operational_alert_events(id,source) VALUES(1,'owner-operational-notifications'),(2,'owner-operational-notifications');
    INSERT INTO operational_notification_destinations VALUES(1,'{{"data":{{"incident_id":"{I}"}}}}');
    INSERT INTO financial_alerts(id,context) VALUES('{I}','{{"incident_id":"{I}"}}'),('00000000-0000-0000-0000-000000000002','{{}}');
    """)
    # Actual preimage reproduces the contradiction in the isolated fixture.
    check('preimage-retains-aged-basis',"((fn_ca_incident_action('%s','resolve','fixture',NULL,'%s','%s')->>'ok')::boolean AND (SELECT closure_basis='aged_out_unverified' FROM ca_drift_incidents WHERE id='%s'))"%(I,CAUSE,REF,I))
    # Restore only the isolated fixture, never production.
    sql(f"""UPDATE ca_drift_incidents SET root_cause='Never established. The event stream stopped reporting; no evidence was measured.',correction_ref='aged-out: silence',resolution='Original age-out' WHERE id='{I}';
    DELETE FROM ca_incident_events WHERE kind<>'status_change'; TRUNCATE pushes;
    UPDATE operational_alert_events SET investigation='{{}}',investigation_status='new';""")
    migration=next((ROOT/'supabase/migrations').glob('*_an_explicit_investigation_can_replace_an_unverified_age_out.sql'))
    sql(migration.read_text())
    check('missing-new-evidence-refused',"(fn_ca_incident_action('%s','resolve')->>'reason')='explicit_resolution_evidence_required'"%I)
    refuses('short-cause-refused',resolve('short'), 'at least 40')
    refuses('invalid-reference-refused',resolve(ref='arbitrary text'),'correction_ref')
    refuses('age-out-reference-refused',resolve(ref='aged-out: still quiet'),'closure_basis')
    check('failed-actions-atomic',"(SELECT count(*)=1 FROM ca_incident_events) AND (SELECT count(*)=0 FROM pushes)")
    sql("SET test.uid='00000000-0000-0000-0000-000000000099'; DO $$BEGIN IF fn_ca_incident_action('%s','resolve')->>'reason'<>'not_authorized' THEN RAISE EXCEPTION 'authorization'; END IF; END$$;"%I)
    # Relevant consumer failures refuse the source action and append no event.
    sql("CREATE FUNCTION refuse_consumer() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'consumer refused'; END$$; CREATE TRIGGER refuse_consumer BEFORE UPDATE ON financial_alerts FOR EACH ROW EXECUTE FUNCTION refuse_consumer();")
    refuses('financial-consumer-failure-atomic',resolve(),'consumer refused')
    check('no-partial-event',"(SELECT count(*)=1 FROM ca_incident_events) AND (SELECT closure_basis='aged_out_unverified' FROM ca_drift_incidents WHERE id='%s')"%I)
    sql('DROP TRIGGER refuse_consumer ON financial_alerts;')
    sql('CREATE TRIGGER refuse_consumer BEFORE UPDATE ON operational_alert_events FOR EACH ROW EXECUTE FUNCTION refuse_consumer();')
    refuses('inbox-consumer-failure-atomic',resolve(),'consumer refused')
    check('financial-change-rolled-back',"(SELECT NOT resolved FROM financial_alerts WHERE id='%s')"%I)
    sql('DROP TRIGGER refuse_consumer ON operational_alert_events;')
    sql(resolve())
    check('operator-disposition',"(SELECT status='resolved' AND closure_basis='operator' AND root_cause='%s' AND correction_ref='%s' FROM ca_drift_incidents WHERE id='%s')"%(CAUSE,REF,I))
    check('original-event-preserved',"(SELECT count(*)=1 FROM ca_incident_events WHERE kind='status_change' AND detail->>'closure_basis'='aged_out_unverified')")
    check('new-event-preserves-previous-disposition',"(SELECT count(*)=1 FROM ca_incident_events WHERE kind='resolved' AND detail->>'previous_closure_basis'='aged_out_unverified' AND detail->>'previous_resolution'='Original age-out' AND detail->>'previous_correction_ref'='aged-out: silence' AND detail->>'previous_root_cause' LIKE 'Never established.%')")
    check('linked-alert-resolved',"(SELECT resolved FROM financial_alerts WHERE id='%s')"%I)
    check('linked-inbox-verified',"(SELECT investigation_status='verified_fixed' AND investigation->>'incident_action'='resolve' FROM operational_alert_events WHERE id=1)")
    check('unrelated-rows-preserved',"(SELECT NOT resolved FROM financial_alerts WHERE id='00000000-0000-0000-0000-000000000002') AND (SELECT investigation='{}' AND investigation_status='new' FROM operational_alert_events WHERE id=2)")
    before=sql("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(x)) FROM ca_drift_incidents x),(SELECT jsonb_agg(to_jsonb(x)) FROM ca_incident_events x),(SELECT jsonb_agg(to_jsonb(x)) FROM operational_alert_events x),(SELECT jsonb_agg(to_jsonb(x)) FROM pushes x))")
    check('exact-duplicate-readback',"(fn_ca_incident_action('%s','resolve','Exact original receipts independently verified; no chips moved.',NULL,'%s','%s')->>'already_resolved')='true'"%(I,CAUSE,REF))
    assert before==sql("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(x)) FROM ca_drift_incidents x),(SELECT jsonb_agg(to_jsonb(x)) FROM ca_incident_events x),(SELECT jsonb_agg(to_jsonb(x)) FROM operational_alert_events x),(SELECT jsonb_agg(to_jsonb(x)) FROM pushes x))")
    checks.append('duplicate-no-new-effects')
    refuses('already-resolved-still-validates-new-evidence',resolve('short'),'at least 40')
    check('grants-preserved',"NOT has_function_privilege('anon','fn_ca_incident_action(uuid,text,text,uuid,text,text)','EXECUTE') AND has_function_privilege('authenticated','fn_ca_incident_action(uuid,text,text,uuid,text,text)','EXECUTE')")
    print({'passed':len(checks),'checks':checks})
finally:
    if (BASE/'db/postmaster.pid').exists(): command([PG/'pg_ctl','-D',BASE/'db','-m','fast','-w','stop'])
    shutil.rmtree(BASE)
