"""Original preparation cancellation in the existing isolated F06 qualification."""
from contextlib import contextmanager
import hashlib
import json
import subprocess
import time


def qualify(root, out, cmd, command, run, probe, require, results):
    migration = root / 'supabase/migrations/20260918071546_f06_original_preparation_cancellations_survive_maintenance_r.sql'
    capture_path=root/'scripts/ci/probes/f06-shared-hand-lane/prepared-preimages.json'
    captured=json.loads(capture_path.read_text())
    current_identity=next(row for row in captured['functions'] if 'definition' in row)
    # Dependency shape copied from the installed generation authority. No
    # disposition is invoked or requalified here; its immutable guard is real.
    run('prepared-current-generation-receipt-shape', '''
    CREATE TABLE smarter_private.f06_generation_aborts(
      receipt_id uuid PRIMARY KEY,tournament_id uuid NOT NULL,generation uuid NOT NULL,
      expected jsonb NOT NULL,outcome text NOT NULL DEFAULT 'aborted_unsettled' CHECK(outcome='aborted_unsettled'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tournament_id,generation),UNIQUE(receipt_id,tournament_id,generation));
    CREATE TABLE smarter_private.f06_generation_abort_hands(
      permit_id uuid PRIMARY KEY,receipt_id uuid NOT NULL,tournament_id uuid NOT NULL,generation uuid NOT NULL,
      table_id uuid NOT NULL,hand_number bigint NOT NULL,snapshot_id uuid NOT NULL,break_id uuid UNIQUE,expected jsonb NOT NULL,
      UNIQUE(table_id,hand_number),FOREIGN KEY(receipt_id,tournament_id,generation)
      REFERENCES smarter_private.f06_generation_aborts(receipt_id,tournament_id,generation));
    ''')
    run('prepared-current-immutable-authority',current_identity['definition'])
    for row in captured['functions']:
      signature=row['signature']
      run('prepared-current-dependency-'+signature.split('(')[0].split('.')[-1],
        "SELECT md5(pg_get_functiondef(oid))||'|'||pg_get_userbyid(proowner)||'|'||proacl::text FROM pg_proc WHERE oid='"+signature+"'::regprocedure;",
        row['definition_md5']+'|'+row['owner']+'|'+row['acl'])

    run('prepared-private-card-shape', '''
    CREATE TABLE public.table_hole_cards(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id uuid NOT NULL,hand_number bigint NOT NULL,user_id uuid NOT NULL,seat_number integer NOT NULL,
      cards jsonb NOT NULL DEFAULT '[]',created_at timestamptz DEFAULT now(),UNIQUE(table_id,hand_number,user_id));
    ''')
    run('prepared-original-seed', '''
    INSERT INTO tournaments VALUES(md5('prepared-event')::uuid,'RUNNING','mtt-v2',9,2);
    INSERT INTO tables(id,tournament_id,status) VALUES(md5('prepared-table')::uuid,md5('prepared-event')::uuid,'waiting');
    INSERT INTO engine_tournament_leases VALUES(md5('prepared-event')::uuid,'original','prepared',now(),now(),md5('prepared-gen')::uuid,2);
    INSERT INTO smarter_private.f06_hand_permits SELECT md5('prepared-permit')::uuid,tournament_id,id,f06_lifecycle,11000001,
      md5('prepared-custody')::uuid,md5('prepared-gen')::uuid,'reserved',NULL FROM tables WHERE id=md5('prepared-table')::uuid;
    ''')
    auth = '''SET request.jwt.claims='{"role":"service_role"}'; SET app.smarter_data_actor='tournament-manager';
    SELECT set_config('app.smarter_tournament_id',md5('prepared-event')::uuid::text,false) AS ignored;
    SELECT set_config('app.smarter_tournament_lease_generation',md5('prepared-gen')::uuid::text,false) AS ignored;'''
    # SET with DO avoids output in exact-value assertions.
    auth = auth[:auth.index('SELECT')] + '''DO $$ BEGIN
      PERFORM set_config('app.smarter_tournament_id',md5('prepared-event')::uuid::text,false);
      PERFORM set_config('app.smarter_tournament_lease_generation',md5('prepared-gen')::uuid::text,false);
    END $$;'''
    args = "md5('prepared-event')::uuid,md5('prepared-gen')::uuid,md5('prepared-table')::uuid,(SELECT f06_lifecycle FROM tables WHERE id=md5('prepared-table')::uuid),md5('prepared-permit')::uuid,11000001,md5('prepared-custody')::uuid"
    cancel = 'SELECT public.fn_f06_cancel_prepared_hand(' + args + ");"
    state = "SELECT state||':'||COALESCE(evidence_id::text,'null') FROM smarter_private.f06_hand_permits WHERE permit_id=md5('prepared-permit')::uuid;"
    probe('prepared-baseline-authority-absent',auth + cancel,error='42883')
    before = run('prepared-baseline-original-state',state)
    @contextmanager
    def held(sql, finish='ROLLBACK'):
      process = subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
      process.stdin.write('BEGIN;'+sql+'SELECT pg_advisory_lock(180971546);\n');process.stdin.flush()
      deadline = time.monotonic()+5
      while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=180971546 AND granted);").stdout.strip()!='t':
        require(process.poll() is None and time.monotonic()<deadline,'Preparation contender never acquired its barrier')
        time.sleep(.01)
      try: yield process
      finally:
        process.stdin.write(finish+';\n');process.stdin.close();process.wait(timeout=5)
        require(process.returncode==0,process.stderr.read())
    with held("INSERT INTO hand_state_snapshots(table_id,hand_number) VALUES(md5('prepared-table')::uuid,11000001);"):
      run('prepared-install-refuses-busy-before-ddl',migration.read_text(),error='55P03')
      run('prepared-install-busy-rolled-back',"SELECT to_regclass('smarter_private.f06_prepared_hand_cancellations') IS NULL;",'t')
    private_write="INSERT INTO hand_private_state VALUES(md5('prepared-table')::uuid,11000001);"
    with held(private_write):
      started=time.monotonic()
      run('prepared-install-private-writer-bounded-refusal',migration.read_text(),error='F06_PREPARED_INSTALL_ADMISSION_BUSY')
      require(time.monotonic()-started<5,'Preparation installer exceeded its finite admission budget')
      run('prepared-install-private-refusal-atomic',"SELECT to_regclass('smarter_private.f06_prepared_hand_cancellations') IS NULL AND to_regprocedure('public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)') IS NULL;",'t')
      probe('prepared-install-private-refusal-released-all',"SET LOCAL lock_timeout='100ms'; LOCK TABLE hand_atomic_commits,hand_history,hand_state_snapshots IN ROW EXCLUSIVE MODE NOWAIT;")
    # The late private writer was the observed production blocker. Wait for
    # actual admission yielding, then make that same writer take the earlier
    # atomic relation. It can finish only if every partial lock was released.
    pending=None
    try:
      with held(private_write) as writer:
        pending=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        pending.stdin.write("SET application_name='prepared_transient_installer';\n"+migration.read_text())
        pending.stdin.close()
        deadline=time.monotonic()+2
        while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='prepared_transient_installer' AND wait_event='PgSleep');").stdout.strip()!='t':
          require(pending.poll() is None and time.monotonic()<deadline,'Preparation installer did not retain bounded admission after transient private writer')
          time.sleep(.005)
        writer.stdin.write("SET LOCAL statement_timeout='1s'; LOCK TABLE hand_atomic_commits IN ROW EXCLUSIVE MODE; SELECT pg_advisory_lock(180971547);\n")
        writer.stdin.flush()
        while command(cmd,"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=180971547 AND granted);").stdout.strip()!='t':
          require(writer.poll() is None and time.monotonic()<deadline,'Preparation installer retained an earlier relation across private-writer refusal')
          time.sleep(.005)
      pending.wait(timeout=5)
      output=pending.stdout.read()+pending.stderr.read()
      (out/'prepared-install-transient-private-writer.log').write_text(output)
      require(pending.returncode==0,'Preparation installation failed after transient private writer: '+output)
      results['cases'].append({'name':'prepared-install-transient-private-writer','passed':True})
    finally:
      if pending is not None and pending.poll() is None:
        pending.wait(timeout=8)
    results['preparedCancellationInputs'] = {str(capture_path.relative_to(root)): hashlib.sha256(capture_path.read_bytes()).hexdigest(), str(migration.relative_to(root)): hashlib.sha256(migration.read_bytes()).hexdigest(),
      'scripts/ci/probes/f06-shared-hand-lane/prepared_cancellation_qualification.py': hashlib.sha256(__import__('pathlib').Path(__file__).read_bytes()).hexdigest()}
    one = json.loads(probe('prepared-exact-original-cancel',auth + cancel))
    require(one['ok'] is True and one['state']=='never_started' and one['evidence_id']==one['permit_id'], 'Exact cancellation receipt missing')
    expected = json.loads(run('prepared-original-exact-identity', "SELECT to_jsonb(h)||jsonb_build_object('ok',true,'state','never_started','evidence_id',permit_id,'lifecycle',lifecycle::text,'hand_number',hand_number::text) FROM smarter_private.f06_hand_permits h WHERE permit_id=md5('prepared-permit')::uuid;"))
    require(one == expected, 'Cancellation changed exact identity')
    duplicate = probe('prepared-duplicate-original-cancel',auth + cancel + cancel + "SELECT count(*) FROM smarter_private.f06_prepared_hand_cancellations;").splitlines()
    require(json.loads(duplicate[0])==one and json.loads(duplicate[1])==one and duplicate[2]=='1', 'Duplicate cancellation changed receipt or effect count')
    quiet_cancel='DO $cancel$ BEGIN PERFORM public.fn_f06_cancel_prepared_hand('+args+'); END $cancel$;'
    results['cases'].append({'name':'prepared-exact-receipt-and-single-effect','passed':True})
    require(run('prepared-cancellation-rollback',state)==before,'Rolled-back cancellation changed original')
    for label,change in [
      ('expired-lease',"UPDATE engine_tournament_leases SET heartbeat_at=now()-interval '1 hour' WHERE tournament_id=md5('prepared-event')::uuid;"),
      ('successor-lease',"UPDATE engine_tournament_leases SET lease_generation=md5('successor')::uuid WHERE tournament_id=md5('prepared-event')::uuid;"),
      ('unmarked-actor',"SET app.smarter_data_actor='service';"),
      ('browser',"SET request.jwt.claims='{\"role\":\"authenticated\"}';"),
    ]:
      probe('prepared-refuses-'+label,auth+change+cancel,error='42501')
    for label,newargs in [('custody',args.replace("md5('prepared-custody')","md5('different-custody')")),
                          ('permit',args.replace("md5('prepared-permit')","md5('different-permit')")),
                          ('hand',args.replace('11000001','11000002'))]:
      probe('prepared-refuses-changed-'+label,auth+'SELECT public.fn_f06_cancel_prepared_hand('+newargs+');',error='F06_PREPARED_ORIGINAL_REQUIRED')
    for label,change in [
      ('lifecycle', "UPDATE tables SET f06_lifecycle=f06_lifecycle+1 WHERE id=md5('prepared-table')::uuid;"),
      ('closed-table', "UPDATE tables SET status='closed' WHERE id=md5('prepared-table')::uuid;"),
      ('terminal-event', "UPDATE tournaments SET status='COMPLETED' WHERE id=md5('prepared-event')::uuid;"),
      ('accepted-permit', "UPDATE smarter_private.f06_hand_permits SET state='accepted',evidence_id=md5('accepted')::uuid WHERE permit_id=md5('prepared-permit')::uuid;"),
    ]:
      probe('prepared-refuses-'+label,auth+change+cancel,error='55000')
    probe('prepared-cancel-during-maintenance',auth+"INSERT INTO engine_maintenance_break VALUES(true,now(),'counting_down',now(),now()+interval '5 minutes');"+quiet_cancel+"SELECT state FROM smarter_private.f06_hand_permits WHERE permit_id=md5('prepared-permit')::uuid;",'never_started')
    writers = {
      'snapshot': "INSERT INTO hand_state_snapshots(table_id,hand_number) VALUES(md5('prepared-table')::uuid,11000001);",
      'private': "INSERT INTO hand_private_state VALUES(md5('prepared-table')::uuid,11000001);",
      'cards': "INSERT INTO table_hole_cards(table_id,hand_number,user_id,seat_number) VALUES(md5('prepared-table')::uuid,11000001,md5('player')::uuid,1);",
      'atomic': "INSERT INTO hand_atomic_commits(table_id,hand_number) VALUES(md5('prepared-table')::uuid,11000001);",
      'history': "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('prepared-table')::uuid,11000001);",
      'dispatch': "INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('prepared-permit')::uuid,txid_current());",
    }
    for label,write in writers.items():
      probe('prepared-refuses-existing-'+label,auth+write+cancel,error='F06_PREPARED_START_EVIDENCE')
      if label != 'dispatch':
        probe('prepared-refuses-late-'+label,auth+cancel+write,error='F06_CANCELLED_PREPARATION_FENCED')
    probe('prepared-terminal-receipt-immutable',auth+cancel+"DELETE FROM smarter_private.f06_prepared_hand_cancellations;",error='F06_PREPARED_CANCELLATION_IMMUTABLE')
    probe('prepared-permit-cannot-resurrect',auth+cancel+"UPDATE smarter_private.f06_hand_permits SET state='reserved' WHERE permit_id=md5('prepared-permit')::uuid;",error='F06_HAND_IDENTITY_IMMUTABLE')
    probe('prepared-exact-begin-replay-terminal',auth+quiet_cancel+'SELECT (public.fn_f06_begin_hand('+args+"))->>'ok';",'false')
    probe('prepared-replacement-cannot-reuse-number',auth+quiet_cancel+'SELECT (public.fn_f06_begin_hand('+args.replace("md5('prepared-permit')","md5('next-permit')")+"))->>'reason';",'hand_number_already_used')
    probe('prepared-canonical-dispatch-fenced',auth+cancel+"SELECT smarter_private.f06_hand_dispatch_guard(md5('prepared-table')::uuid,11000001);",error='F06_HAND_PERMIT_FENCED')
    run('prepared-browser-execution-denied',"SELECT NOT has_function_privilege('anon','public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)','EXECUTE');",'t')
    with held(auth+cancel):
      for label,write in writers.items():
        if label != 'dispatch': probe('prepared-cancel-holds-'+label,write,error='F06_RETRY_CANONICAL_LANE')
      probe('prepared-concurrent-duplicate-waits',"SET LOCAL lock_timeout='150ms';"+auth+cancel,error='55P03')
    with held(writers['snapshot']):
      probe('prepared-existing-writer-serializes',"SET LOCAL lock_timeout='150ms';"+auth+cancel,error='55P03')
    require(run('prepared-all-probes-rollback',state)==before,'Prepared hand changed outside a rollback')
    with held("INSERT INTO hand_private_state VALUES(md5('prepared-table')::uuid,11000003);"):
      probe('prepared-writer-before-begin-serializes',"SET LOCAL lock_timeout='150ms';"+auth+'SELECT public.fn_f06_begin_hand('+args.replace("md5('prepared-permit')","md5('early-permit')").replace('11000001','11000003')+');',error='55P03')
    # All durable postimages below stay within this disposable database.
    # The original positive no-start canceller wins: later raw writers refuse.
    with held(auth+quiet_cancel, finish='COMMIT'):
      pass
    for label,write in writers.items():
      if label != 'dispatch': probe('prepared-committed-cancel-fences-'+label,write,error='F06_CANCELLED_PREPARATION_FENCED')
    require(json.loads(run('prepared-durable-exact-retry',auth+cancel))==one,'Durable retry changed receipt')
    probe('prepared-next-hand-can-reserve',auth+'SELECT (public.fn_f06_begin_hand('+args.replace("md5('prepared-permit')","md5('next-permit')").replace('11000001','11000002')+"))->>'ok';",'true')
    # A separate fresh original identity proves writer-first commit cannot be
    # certified never-started. The actual table lane is acquired before BEGIN.
    run('prepared-second-original-seed',auth+'SELECT public.fn_f06_begin_hand('+args.replace("md5('prepared-permit')","md5('next-permit')").replace('11000001','11000002')+');')
    with held(writers['snapshot'].replace('11000001','11000002'), finish='COMMIT'):
      probe('prepared-writer-first-cancel-waits',"SET LOCAL lock_timeout='150ms';"+auth+cancel.replace("md5('prepared-permit')","md5('next-permit')").replace('11000001','11000002'),error='55P03')
    probe('prepared-writer-first-commit-refuses',auth+cancel.replace("md5('prepared-permit')","md5('next-permit')").replace('11000001','11000002'),error='F06_PREPARED_START_EVIDENCE')
    results['preparedCancellation']={'passed':True,'scope':'Original current-lease prepared cancellation; no live financial qualification'}
