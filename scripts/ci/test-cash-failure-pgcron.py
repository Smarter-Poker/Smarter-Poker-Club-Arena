#!/usr/bin/env python3
"""Finite real pg_cron1.6.4 failure-intake qualification on owned PG17.

The financial source fixtures are synthetic and do not prove production money
reconciliation. Native SPI terminal updates, failure containment and receipts
are observed using the actual compiled scheduler, never a modeled cron table.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import re
import time
import uuid
from build_pg17_isolationtester import VERSION_NUM, validate_version, OUTPUT as ISOLATION_OUTPUT, TOOL_LEAF
from build_pg17_cash_pgcron import OUTPUT as CRON_BUILD, SOURCE_SHA

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/production-alerts-cash-native'
FIXED_INPUTS=('.github/workflows/ci.yml', 'scripts/ci/build_pg17_cash_pgcron.py', 'scripts/ci/classify-ci-changes.mjs', 'scripts/ci/probes/production-alert-core/cash-checker-preimage.sql', 'scripts/ci/probes/production-alert-core/notification/manifest.json', 'scripts/ci/test-cash-failure-pgcron.py', 'scripts/ci/test-production-alert-core-postgres.py', 'scripts/ci/test_cash_native_pgcron.py', 'scripts/ci/test_production_alert_core_postgres.py', 'scripts/operational-alerts/cash-pot-failed-run-intake.md', 'scripts/operational-alerts/cash-pot-failed-run-intake.sql', 'scripts/qualification/cash-pot-check-connected.sql', 'scripts/qualification/cash-pot-check-evidence-concurrency.spec', 'scripts/qualification/cash-pot-check-evidence.manifest.json', 'scripts/qualification/cash-pot-check-evidence.md', 'scripts/qualification/cash-pot-check-evidence.sql', 'scripts/qualification/cash-pot-failed-run-intake.sql', 'scripts/qualification/fixtures/cash-native-pgcron/pg_cron-heap-tables.patch', 'scripts/qualification/fixtures/cash-pot-check-evidence/original-40538.sql', 'scripts/qualification/fixtures/cash-pot-check-evidence/preimage.sql', 'scripts/qualification/fixtures/cash-pot-failed-run-intake/reader-source.sql', 'scripts/qualification/fixtures/cash-pot-failed-run-intake/writer.sql', 'supabase/components/cash-failed-run-intake.rollback.sql', 'supabase/components/cash-failed-run-intake.sql', 'supabase/components/cash-pot-check-evidence.rollback.sql', 'supabase/components/cash-pot-check-evidence.sql', 'tests/unit/fixtureNativeCi.test.ts')
COMMAND="SET statement_timeout = '600s'; SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-cash-pot-conservation')) THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check()) ELSE -1 END;"
COMPONENT=ROOT/'supabase/components/cash-failed-run-intake.sql'
ROLLBACK=ROOT/'supabase/components/cash-failed-run-intake.rollback.sql'
ENV={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','PGCONNECT_TIMEOUT':'3'}


def require(ok,msg):
    if not ok: raise RuntimeError(msg)


def literal(text):
    return "'"+text.replace("'","''")+"'"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()



def record_interruption(receipt, signum, *, during_cleanup):
    receipt['passed'] = False
    receipt['interrupted'] = signum
    if not receipt.get('failure'):
        receipt['failure'] = 'qualification interrupted by signal ' + str(signum)
    if not during_cleanup:
        raise RuntimeError('qualification interrupted by signal ' + str(signum))


def qualifies(receipt, failure):
    return (failure is None and not receipt.get('failure')
            and not receipt.get('interrupted')
            and receipt.get('checksPassed') is True
            and receipt.get('cleanup', {}).get('stopped') is True)


def validate_outcome(result, state):
    require(result=={'count':1,'state':state,'same_failure':True,'receipt_exact':True},
            'outcome/receipt not exact')


def validate_race_output(stdout, stderr):
    require(not re.search(r'(?mi)^(?:ERROR|FATAL|PANIC):|(?:setup|teardown) failed:|unexpected result status:|canceling step |timed out',stdout+'\n'+stderr),'Native cash race reported SQL failure')
    steps=re.findall(r'^step (\w+):',stdout,re.M)
    expected=('hold','scan_begin','scan','mutate_source','release','invisible_before_commit','scan_commit',
        'assert_snapshot','durable_after_commit','restore_source','scan_begin_again','scan_again',
        'second_begin','second_scan','scan_commit_again','second_commit','assert_distinct_invocations')
    require(tuple(dict.fromkeys(steps))==expected,'Cash native permutation differs')
    matches=list(re.finditer(r'^step (\w+):',stdout,re.M))
    chunks=[stdout[m.end():matches[i+1].start() if i+1<len(matches) else len(stdout)] for i,m in enumerate(matches)]
    waits=[i for i,c in enumerate(chunks) if '<waiting ...>' in c]
    completes=[i for i,c in enumerate(chunks) if c.lstrip().startswith('<... completed>')]
    require(any(steps[i]=='scan' and i<steps.index('release') for i in waits)
            and any(steps[i]=='scan' and i>steps.index('release') for i in completes),
            'Real scan wait and post-release completion were not observed')


def load_inputs():
    manifest=json.loads((ROOT/'scripts/qualification/cash-native-hosted.manifest.json').read_text())
    require(manifest['schemaVersion']==1 and set(manifest['files'])==set(FIXED_INPUTS), 'Cash manifest fixed input set differs')
    for name,pin in manifest['files'].items():
        path=ROOT/name
        require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(ROOT)
            and path.stat().st_size==pin['bytes'] and digest(path)==pin['sha256'], 'Cash source pin differs: '+name)
    return manifest


def main():
    require(os.geteuid()!=0,'Original nonroot hosted runner required')
    pg=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')).resolve()
    out=OUT;out.mkdir(parents=True,exist_ok=False)
    receipt={'passed':False,'native_scheduler':False,'cases':[],'cleanup':{},'steps':[],
             'inputs':load_inputs()}
    build=json.loads((CRON_BUILD/'receipt.json').read_text())
    require(build['passed'] and build['sourceSha256']==SOURCE_SHA,'Pinned native pg_cron build required')
    for name,pin in build['installed'].items():
        require(Path(name).is_file() and digest(Path(name))==pin['sha256'],'Installed extension changed')
    work=Path(tempfile.mkdtemp(prefix='cash-pgcron-',dir='/tmp'));work.chmod(0o700)
    sock=work/'socket';sock.mkdir(mode=0o700);data=work/'data'
    receipt['ownedCluster']=str(work);receipt['buildReceiptSha256']=digest(CRON_BUILD/'receipt.json')
    execution=str(uuid.uuid4());db='qual_cash_'+execution.replace('-','')
    deadline=time.monotonic()+240;cleanup_started=False;started=False;holder=None;failure=None
    handlers={}

    def persist():
        tmp=out/'receipt.tmp'
        with tmp.open('w') as f:
            json.dump(receipt,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
        os.replace(tmp,out/'receipt.json')

    def interrupted(signum,_frame):
        record_interruption(receipt, signum, during_cleanup=cleanup_started)

    def run(argv,label,*,text=None,timeout=30,allowed=(0,),env=None):
        budget=timeout if cleanup_started else min(timeout,deadline-time.monotonic())
        require(budget>0,'Finite fixture deadline exhausted')
        stdout=out/(label+'.stdout');stderr=out/(label+'.stderr')
        with stdout.open('wb') as o,stderr.open('wb') as e:
            child=subprocess.Popen([str(x) for x in argv],cwd=ROOT,env=env or ENV,
                stdin=subprocess.PIPE,stdout=o,stderr=e,start_new_session=True)
            try: child.communicate(None if text is None else text.encode(),timeout=budget)
            except BaseException:
                if child.poll() is None:
                    os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
                raise
        receipt['steps'].append({'label':label,'exit':child.returncode,
            'stdoutSha256':digest(stdout),'stderrSha256':digest(stderr)})
        persist();require(child.returncode in allowed,label+' failed; inspect scoped artifact')
        require(stdout.stat().st_size+stderr.stat().st_size<2*1024*1024,label+' output overflow')
        return stdout.read_text().strip()

    def psql(sql,label,*,database='postgres',user='postgres',file=None,options=()):
        cmd=[pg/'psql','-X','-w','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','5432',
             '-U',user,'-d',database,*options]
        return run(cmd+(['-f',file] if file else ['-c',sql]),label,timeout=50)

    counter=0
    def poll(sql,condition,label,seconds=12,user='postgres'):
        # Finite fixture observation only. Never used in production or to repair.
        nonlocal counter
        stop=min(deadline,time.monotonic()+seconds)
        while time.monotonic()<stop:
            counter+=1;result=psql(sql,label+'-'+str(counter),user=user)
            if condition(result): return result
            time.sleep(.1)
        raise RuntimeError(label+' did not reach its required native boundary')

    def component(path,label):
        return psql('',label,file=path)

    def native_run(label,*,malformed=True,expected='failed'):
        nonlocal holder
        before=int(psql('SELECT coalesce(max(runid),0) FROM cron.job_run_details WHERE jobid=259;',label+'-before'))
        winners='[{"amount":"fixture-invalid-number"}]' if malformed else '[{"amount":1}]'
        psql("TRUNCATE public.hand_history; INSERT INTO public.hand_history(id,table_id,hand_number,created_at,pot_size,rake_amount,bbj_amount,winners) VALUES('c4053804-0000-4000-8000-000000000001','c4053804-1111-4000-8000-000000000001',1,clock_timestamp(),1,0,0,"+literal(winners)+"::jsonb);",label+'-input')
        # Hold the actual source table while the native job starts. Restore the
        # production job contract before releasing the real checker query.
        holder_log=(out/(label+'-holder.log')).open('wb')
        holder=subprocess.Popen([str(pg/'psql'),'-X','-w','-qAt','-v','ON_ERROR_STOP=1',
            '-h',str(sock),'-p','5432','-U','postgres','-d','postgres'],env=dict(ENV,PGAPPNAME='cash-fixture-holder'),
            stdin=subprocess.PIPE,stdout=holder_log,stderr=holder_log,start_new_session=True)
        try:
            holder.stdin.write(b'BEGIN; LOCK TABLE public.hand_history IN ACCESS EXCLUSIVE MODE;\n');holder.stdin.flush()
            poll("SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='cash-fixture-holder' AND l.relation='public.hand_history'::regclass AND l.mode='AccessExclusiveLock' AND l.granted;",lambda s:s=='1',label+'-holder-ready',user='supabase_admin')
            psql("UPDATE cron.job SET schedule='1 second',nodename="+literal(str(sock))+",nodeport=5432 WHERE jobid=259;",label+'-temporary-test-interval')
            # The real job table invalidation trigger handles the UPDATE.
            state=poll("SELECT coalesce(jsonb_agg(jsonb_build_object('runid',r.runid,'pid',r.job_pid,'wait',a.wait_event_type)),'[]') FROM cron.job_run_details r JOIN pg_stat_activity a ON a.pid=r.job_pid WHERE r.jobid=259 AND r.runid>"+str(before)+" AND a.wait_event_type='Lock';",lambda s:len(json.loads(s))==1,label+'-native-start',user='supabase_admin')
            witness=json.loads(state)[0]
            psql("UPDATE cron.job SET schedule='34 */6 * * *',nodename='localhost',nodeport=5432 WHERE jobid=259;",label+'-restore-contract')
            holder.stdin.write(b'ROLLBACK;\n\\q\n');holder.stdin.flush();holder.stdin.close();holder.wait(timeout=5)
            require(holder.returncode==0,'Source holder failed');holder=None
            terminal=poll("SELECT jsonb_build_object('runid',runid,'status',status,'message_md5',md5(return_message),'has_error',return_message LIKE '%fixture-invalid-number%','snapshot_md5',md5(to_jsonb(r)::text)) FROM cron.job_run_details r WHERE runid="+str(witness['runid'])+" AND status IN ('failed','succeeded') AND NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.pid=r.job_pid);",lambda s:bool(s),label+'-terminal')
            result=json.loads(terminal);require(result['status']==expected,label+' original scheduler status changed')
            if expected=='failed': require(result['has_error'],label+' lost actual checker error')
            require(psql('SELECT count(*) FROM cron.job_run_details WHERE jobid=259 AND runid>'+str(before),label+'-single-run')=='1','Unexpected additional scheduled fixture run')
            receipt['cases'].append({'label':label,'nativeWitness':witness,'terminal':result});persist()
            return result
        finally:
            if holder is not None:
                try:
                    holder.stdin.write(b'ROLLBACK;\n\\q\n');holder.stdin.flush();holder.stdin.close();holder.wait(timeout=3)
                except BaseException:
                    if holder.poll() is None: os.killpg(holder.pid,signal.SIGKILL);holder.wait(timeout=3)
                holder=None
            holder_log.close()

    def assert_outcome(run,state,label):
        result=json.loads(psql("SELECT jsonb_build_object('count',count(*),'state',min(o.outcome),'same_failure',bool_and(r.status='failed' AND md5(to_jsonb(r)::text)=o.snapshot_md5),'receipt_exact',bool_and(CASE WHEN o.outcome='delivered' THEN e.id=o.receipt_id AND e.source=o.receipt_source AND e.event_key=o.receipt_key AND e.payload=o.receipt_payload AND e.status='firing' AND e.alertname='CashPotConservationCheckFailed' ELSE o.receipt_id IS NULL AND o.receipt_payload IS NULL AND o.intake_sqlstate IS NOT NULL END)) FROM public.ca_cash_failed_run_outcomes o JOIN cron.job_run_details r ON r.runid=o.runid LEFT JOIN public.operational_alert_events e ON e.id=o.receipt_id WHERE o.runid="+str(run['runid'])+';',label+'-outcome'))
        validate_outcome(result,state)
        return result

    try:
        for sig in (signal.SIGTERM,signal.SIGINT): handlers[sig]=signal.signal(sig,interrupted)
        validate_version(run([pg/'postgres','--version'],'version'),'postgres')
        run([pg/'initdb','-D',data,'-U','supabase_admin','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],'initdb')
        with (data/'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nunix_socket_permissions=0700\nport=5432\nshared_buffers='16MB'\nmax_connections=12\n")
        run([pg/'pg_ctl','-D',data,'-l',work/'server.log','-w','-t','20','start'],'start');started=True
        require(psql("SELECT current_setting('server_version_num')::int="+str(VERSION_NUM)+" AND inet_server_addr() IS NULL AND current_setting('listen_addresses')='';",'endpoint',user='supabase_admin')=='t','Private exact PG17 endpoint required')
        psql('CREATE ROLE postgres LOGIN SUPERUSER; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;','roles',user='supabase_admin')
        # Retain and execute the original positive checker assertions unchanged.
        positive_id=str(uuid.uuid4());positive_db='qual_cash_'+positive_id.replace('-','')
        psql('CREATE DATABASE '+positive_db+' OWNER postgres TEMPLATE template0;','positive-database',user='supabase_admin')
        psql('', 'positive-primary',database=positive_db,
            file=ROOT/'scripts/qualification/cash-pot-check-evidence.sql',
            options=('-v','approved_execution_uuid='+positive_id))
        require(psql("SELECT NOT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace);",'positive-rollback',database=positive_db)=='t','Positive qualifier did not roll back')
        psql('DROP DATABASE '+positive_db+';','positive-drop',user='supabase_admin')
        race_id=str(uuid.uuid4());race_db='qual_cash_'+race_id.replace('-','')
        psql('CREATE DATABASE '+race_db+' OWNER postgres TEMPLATE template0;','positive-race-database',user='supabase_admin')
        race_env=dict(ENV,PGOPTIONS='-c cash_qualification.execution_uuid='+race_id,PG_TEST_TIMEOUT_DEFAULT='15')
        race_prep='SET cash_qualification.execution_uuid='+literal(race_id)+';\n'
        for leaf in ('scripts/qualification/fixtures/cash-pot-check-evidence/preimage.sql',
            'scripts/qualification/fixtures/cash-pot-check-evidence/original-40538.sql',
            'supabase/components/cash-pot-check-evidence.sql'):
            race_prep+='\\i '+str(ROOT/leaf)+'\n'
        run([pg/'psql','-X','-w','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','5432','-U','postgres','-d',race_db],
            'positive-race-prepare',text=race_prep,env=race_env)
        isolation=ISOLATION_OUTPUT/TOOL_LEAF
        isolation_receipt=json.loads((ISOLATION_OUTPUT/'receipt.json').read_text())
        require(isolation_receipt['passed'] and isolation_receipt['tool']['sha256']==digest(isolation),'Pinned native isolation tool required')
        validate_version(run([isolation,'-V'],'isolation-version'),'isolationtester')
        race_stdout=run([isolation,'host='+str(sock)+' port=5432 user=postgres dbname='+race_db],
            'positive-native-race',text=(ROOT/'scripts/qualification/cash-pot-check-evidence-concurrency.spec').read_text(),env=race_env,timeout=90)
        race_stderr=(out/'positive-native-race.stderr').read_text()
        validate_race_output(race_stdout,race_stderr)
        psql('DROP DATABASE '+race_db+';','positive-race-drop',user='supabase_admin')
        receipt['positivePrimaryAndNativeRace']=True
        psql('CREATE DATABASE '+db+' OWNER postgres TEMPLATE template0;','fixture-database',user='supabase_admin')
        # Real positive checker and exact composed dependency bodies. This is the
        # donor's explicit synthetic narrow schema, not a financial graph proof.
        env=dict(ENV,PGOPTIONS='-c cash_qualification.execution_uuid='+execution)
        prep='SET cash_qualification.execution_uuid='+literal(execution)+';\n\\i '+str(ROOT/'scripts/qualification/fixtures/cash-pot-check-evidence/preimage.sql')+'\n\\i '+str(ROOT/'supabase/components/cash-pot-check-evidence.sql')+'\n'
        run([pg/'psql','-X','-w','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','5432','-U','postgres','-d',db], 'prepare-real-checker',text=prep,env=env)
        psql('DROP DATABASE postgres;','remove-empty-default-database',database='template1',user='supabase_admin')
        psql('ALTER DATABASE '+db+' RENAME TO postgres;','bind-metadata-database',database='template1',user='supabase_admin')
        # Production postgres inherits pg_monitor while remaining a non-superuser
        # without supabase_admin membership. The installer reads protected cron
        # settings through pg_read_all_settings inherited from that monitor role.
        psql('ALTER ROLE postgres NOSUPERUSER CREATEDB CREATEROLE; GRANT anon,authenticated,service_role,pg_monitor TO postgres;','native-caller-authority',user='supabase_admin')
        require(psql("SELECT NOT rolsuper AND pg_has_role(current_user,'pg_read_all_settings','USAGE') AND NOT pg_has_role(current_user,'supabase_admin','USAGE') FROM pg_roles WHERE rolname=current_user;",'native-settings-authority')=='t','Native caller must retain production settings visibility without extension-owner authority')
        run([pg/'pg_ctl','-D',data,'-w','-t','20','stop','-m','fast'],'stop-before-extension');started=False
        with (data/'postgresql.conf').open('a') as f:
            f.write("\nshared_preload_libraries='pg_cron'\ncron.database_name='postgres'\ncron.use_background_workers=off\ncron.log_run=on\ncron.host='"+str(sock)+"'\n")
        run([pg/'pg_ctl','-D',data,'-l',work/'server.log','-w','-t','20','start'],'start-native-cron');started=True
        psql("CREATE EXTENSION pg_cron; GRANT USAGE ON SCHEMA cron TO postgres; GRANT ALL ON ALL TABLES IN SCHEMA cron TO postgres; GRANT ALL ON ALL SEQUENCES IN SCHEMA cron TO postgres; SELECT setval('cron.jobid_seq',259,false);",'native-extension',user='supabase_admin')
        require(psql("SELECT extversion FROM pg_extension WHERE extname='pg_cron';",'native-version')=='1.6.4','Provider-aligned native version differs')
        psql("SELECT cron.schedule('ca-cash-pot-conservation-hourly','34 */6 * * *',"+literal(COMMAND)+"); UPDATE cron.job SET nodename='localhost',nodeport=5432 WHERE jobid=259;",'job259')
        baseline=native_run('before-intake')
        require(psql("SELECT to_regclass('public.ca_cash_failed_run_outcomes') IS NULL AND NOT EXISTS(SELECT 1 FROM public.operational_alert_events WHERE source='cash-pot-conservation-cron-failure');",'before-oracle')=='t','Baseline unexpectedly contains intake')
        receipt['beforeMissingReceiptDetected']=True
        component(COMPONENT,'install');component(COMPONENT,'replay-install')
        delivered=native_run('after-intake');assert_outcome(delivered,'delivered','after-intake')
        # Same source row is a no-op, not a hidden retry or receipt rewrite.
        psql('UPDATE cron.job_run_details SET status=status WHERE runid='+str(delivered['runid'])+';','identical-event')
        assert_outcome(delivered,'delivered','identical-event')
        require(psql("SELECT bool_and(delivery_count=1) FROM public.operational_alert_events WHERE source='cash-pot-conservation-cron-failure';",'no-duplicate-delivery')=='t','Repeated row changed delivery count')
        original_receipt=psql("SELECT md5(to_jsonb(e)::text) FROM public.operational_alert_events e WHERE source='cash-pot-conservation-cron-failure' AND event_key='259:"+str(delivered['runid'])+"';",'original-before-source-update')
        psql("UPDATE cron.job_run_details SET return_message=return_message||' [fixture later scheduler snapshot]' WHERE runid="+str(delivered['runid'])+';','changed-terminal-snapshot')
        require(psql("SELECT count(*)=1 AND bool_and(e.payload->>'original_inbox_id'=b.id::text) FROM public.operational_alert_events e JOIN public.operational_alert_events b ON b.source='cash-pot-conservation-cron-failure' AND b.event_key='259:"+str(delivered['runid'])+"' WHERE e.source='cash-pot-conservation-cron-failure-updates' AND e.event_key LIKE '259:"+str(delivered['runid'])+":%';",'linked-source-update')=='t','Changed snapshot lost original receipt link')
        require(psql("SELECT md5(to_jsonb(e)::text) FROM public.operational_alert_events e WHERE source='cash-pot-conservation-cron-failure' AND event_key='259:"+str(delivered['runid'])+"';",'original-after-source-update')==original_receipt,'Changed snapshot overwrote original')
        native_run('successful-check',malformed=False,expected='succeeded')
        # Real native terminal UPDATE under a queue-trigger failure; the queue
        # subtransaction aborts, while the failure row and failed outcome commit.
        psql("CREATE FUNCTION cash_qualification.reject_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='ZC402',MESSAGE='fixture queue unavailable'; END $$; CREATE TRIGGER fixture_queue_failure BEFORE INSERT ON public.operational_alert_events FOR EACH ROW EXECUTE FUNCTION cash_qualification.reject_queue();",'queue-fault-setup')
        failed=native_run('queue-failure');assert_outcome(failed,'intake_failed','queue-failure')
        require(psql("SELECT count(*) FROM public.operational_alert_events WHERE event_key='259:"+str(failed['runid'])+"';",'queue-rollback')=='0','Failed queue attempt leaked a receipt')
        psql('DROP TRIGGER fixture_queue_failure ON public.operational_alert_events; DROP FUNCTION cash_qualification.reject_queue();','queue-fault-cleanup')
        # A valid writer ID pointing at mutated output must not certify delivery.
        psql("CREATE FUNCTION cash_qualification.mutate_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.event_key:=NEW.event_key||':wrong'; RETURN NEW; END $$; CREATE TRIGGER fixture_wrong_receipt BEFORE INSERT ON public.operational_alert_events FOR EACH ROW EXECUTE FUNCTION cash_qualification.mutate_queue();",'wrong-receipt-setup')
        wrong=native_run('wrong-receipt');assert_outcome(wrong,'intake_failed','wrong-receipt')
        require(psql("SELECT count(*) FROM public.operational_alert_events WHERE event_key LIKE '259:"+str(wrong['runid'])+"%';",'wrong-receipt-rollback')=='0','Wrong receipt survived rollback')
        psql('DROP TRIGGER fixture_wrong_receipt ON public.operational_alert_events; DROP FUNCTION cash_qualification.mutate_queue();','wrong-receipt-cleanup')
        # Queue permission failure is distinct from a fabricated writer return.
        psql('REVOKE INSERT ON public.operational_alert_events FROM postgres,service_role;','permission-fault-setup')
        denied=native_run('queue-permission-failure');assert_outcome(denied,'intake_failed','queue-permission-failure')
        require(psql('SELECT intake_sqlstate FROM public.ca_cash_failed_run_outcomes WHERE runid='+str(denied['runid'])+';','permission-sqlstate')=='42501','Expected actual permission denial')
        psql('GRANT INSERT ON public.operational_alert_events TO postgres,service_role;','permission-fault-cleanup')
        # Failure to retain the outcome rolls back its queue write. The original
        # pg_cron failure still commits and the readback explicitly finds no outcome.
        psql("CREATE FUNCTION cash_qualification.reject_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='ZC403',MESSAGE='fixture outcome unavailable'; END $$; CREATE TRIGGER fixture_outcome_failure BEFORE INSERT ON public.ca_cash_failed_run_outcomes FOR EACH ROW EXECUTE FUNCTION cash_qualification.reject_outcome();",'outcome-fault-setup')
        unavailable=native_run('outcome-store-failure')
        require(psql('SELECT count(*) FROM public.ca_cash_failed_run_outcomes WHERE runid='+str(unavailable['runid'])+';','outcome-unavailable')=='0','Unavailable outcome falsely acknowledged')
        require(psql("SELECT count(*) FROM public.operational_alert_events WHERE event_key LIKE '259:"+str(unavailable['runid'])+"%';",'outcome-queue-rollback')=='0','Outcome failure leaked queue delivery')
        psql('DROP TRIGGER fixture_outcome_failure ON public.ca_cash_failed_run_outcomes; DROP FUNCTION cash_qualification.reject_outcome();','outcome-fault-cleanup')
        # Ordinary scheduler operation still executes after observer failures.
        native_run('scheduler-after-observer-faults',malformed=False,expected='succeeded')
        # Reproduce the real provider authority: TRIGGER permission does not
        # confer table ownership. The original DROP TRIGGER must fail42501.
        require(psql("SELECT NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AND has_table_privilege(current_user,'cron.job_run_details','TRIGGER') AND NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='cron.job_run_details'::regclass),'USAGE');",'rollback-authority')=='t','Rollback fixture accidentally owns extension run table')
        psql("DO $$ DECLARE denied boolean:=false; BEGIN BEGIN DROP TRIGGER ca_cash_failed_run_intake ON cron.job_run_details; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END; IF NOT denied THEN RAISE EXCEPTION 'original DROP TRIGGER unexpectedly authorized'; END IF; END $$;",'original-rollback-denied')
        # A foreign dependent must block the actual guarded rollback. Roll back
        # this temporary fixture setup whether the command rejects or not.
        negative="BEGIN; CREATE TABLE cash_qualification.extra_dependency(jobid bigint,status text); CREATE TRIGGER extra_handler_dependency AFTER INSERT ON cash_qualification.extra_dependency FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_failed_run_intake();\n\\set ON_ERROR_STOP off\n"+ROLLBACK.read_text()+"\n\\set rollback_state :SQLSTATE\n\\set ON_ERROR_STOP on\nROLLBACK;\nSELECT :'rollback_state';\n"
        state=run([pg/'psql','-X','-w','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','5432','-U','postgres','-d','postgres'], 'foreign-dependency-refused',text=negative)
        require(state.strip()=='P0001' and 'rollback dependency boundary drift' in (out/'foreign-dependency-refused.stderr').read_text(),'Actual guarded rollback failed to reject foreign dependency')
        retained_sql="SELECT jsonb_build_object('outcomes',(SELECT jsonb_agg(to_jsonb(o) ORDER BY runid,snapshot_md5) FROM public.ca_cash_failed_run_outcomes o),'receipts',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.operational_alert_events e),'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY runid) FROM cron.job_run_details r WHERE jobid=259),'job',(SELECT to_jsonb(j) FROM cron.job j WHERE jobid=259),'evidence',(SELECT jsonb_agg(to_jsonb(h) ORDER BY check_id) FROM public.ca_cash_pot_check_evidence h));"
        before=psql(retained_sql,'history-before-rollback')
        component(ROLLBACK,'remove-handler')
        require(psql(retained_sql,'history-after-rollback')==before,'Rollback changed retained outcomes/receipts/runs/job/positive evidence')
        require(psql("SELECT to_regprocedure('public.fn_ca_cash_failed_run_intake()') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='cron.job_run_details'::regclass AND NOT tgisinternal);",'observer-removed')=='t','Rollback left owned handler or observer')
        component(COMPONENT,'reinstall-retaining-history')
        receipt['native_scheduler']=True;receipt['checksPassed']=True
    except BaseException as exc:
        failure=exc;receipt['failure']=str(exc)
    finally:
        cleanup_started=True
        if (data/'postmaster.pid').exists():
            try:
                run([pg/'pg_ctl','-D',data,'-w','-t','20','stop','-m','fast'],'cleanup-stop',timeout=25)
                require(not (data/'postmaster.pid').exists() and not (sock/'.s.PGSQL.5432').exists(),'Owned server identity remains after stop')
                receipt['cleanup']['stopped']=True
            except BaseException as exc:
                receipt['cleanup']['error']=str(exc);failure=failure or exc
        if not (data/'postmaster.pid').exists(): receipt['cleanup']['stopped']=True
        if (work/'server.log').exists():
            import shutil
            shutil.copyfile(work/'server.log',out/'server.log')
        if receipt['cleanup'].get('stopped') and not receipt['cleanup'].get('error'):
            import shutil
            try:
                shutil.rmtree(work)
                receipt['cleanup']['allocationRemoved']=not work.exists()
            except BaseException as exc:
                receipt['cleanup']['allocationRemovalError']=str(exc);failure=failure or exc
        receipt['passed']=qualifies(receipt, failure)
        persist()
        for sig,handler in handlers.items():signal.signal(sig,handler)
    if not receipt['passed']: raise RuntimeError('Cash native qualification failed; inspect '+str(out)) from failure


if __name__=='__main__':main()
