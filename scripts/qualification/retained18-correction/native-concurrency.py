"""Two actual original resume transactions; observed lock barrier, no timed guess."""
import json,subprocess,time,select

def line(process,deadline):
    buf=b''
    while not buf.endswith(b'\n'):
        left=deadline-time.monotonic()
        if left<=0: raise TimeoutError('original resume race marker not observed')
        if not select.select([process.stdout],[],[],left)[0]:raise TimeoutError('original resume race marker timeout')
        c=process.stdout.read(1)
        if not c:raise RuntimeError('original resume race client exited before marker')
        buf+=c
    return buf.decode().strip()

def run(execution,db):
    _,out,_=execution.sql(db,"SELECT jsonb_build_object('submission',s.submission_id,'hash',s.request_hash,'table',s.table_id,'hand',s.hand_number,'tour',l.tournament_id,'instance',l.instance_id,'generation',l.lease_generation)::text FROM smarter_private.hand_submissions s JOIN public.engine_tournament_leases l ON l.tournament_id=(s.request#>>'{p_hand_row,tournament_id}')::uuid ORDER BY s.submission_id LIMIT 1;",label='finite-race-identity')
    x=json.loads(out.strip())
    # Values are database-typed immutable UUIDs/scalars; never a raw request.
    for key in ('table','tour','generation'):
        import uuid
        uuid.UUID(x[key])
    literal=lambda v:"'"+str(v).replace("'","''")+"'"
    setup="BEGIN;SET LOCAL statement_timeout='12s';SET LOCAL lock_timeout='10s';SELECT set_config('request.jwt.claim.role','service_role',true);SELECT set_config('app.smarter_data_actor','tournament-manager',true);SELECT set_config('app.smarter_tournament_id',%s,true);SELECT set_config('app.smarter_tournament_lease_generation',%s,true);UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=%s;"%(literal(x['tour']),literal(x['generation']),literal(x['tour']))
    call="SELECT native_original_assert.consumer_return(public.fn_ca_resume_hand_submission(%s,%s,%s),%s,%s,%d,%s);"%(literal(x['table']),literal(x['instance']),literal(x['generation']),literal(x['table']),literal(x['submission']),x['hand'],literal(x['hash']))
    argv=[str(execution.pg/'psql'),'-X','-qAt','-h',str(execution.socket),'-p',execution.port,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1']
    a=b=None
    err_a=open(execution.output/'race-A.stderr','wb');err_b=open(execution.output/'race-B.stderr','wb')
    try:
        a=subprocess.Popen(argv,cwd=execution.root,env=execution.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err_a,bufsize=0)
        a.stdin.write((setup+call+"SELECT 'A_CORRECTION_ACCEPTED_HELD';\n").encode());a.stdin.flush()
        seen=[];deadline=time.monotonic()+10
        while True:
            value=line(a,deadline);seen.append(value)
            if value=='A_CORRECTION_ACCEPTED_HELD':break
        if 't' not in seen:raise RuntimeError('actual race A original correction did not complete')
        b=subprocess.Popen(argv,cwd=execution.root,env=execution.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err_b,bufsize=0)
        b.stdin.write(("SELECT pg_backend_pid();"+setup[:setup.index("UPDATE public.engine_tournament_leases")]+call+"COMMIT;SELECT 'B_REPLAY_FINISHED';\n").encode());b.stdin.flush()
        pid=int(line(b,time.monotonic()+5))
        observed=False;deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            _,out,_=execution.sql(db,"SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=%d;"%pid,label='actual-original-race-lock-witness',seconds=3)
            if out.strip()=='t':observed=True;break
        if not observed:raise RuntimeError('actual second resume never observed waiting on first owner')
        a.stdin.write(b'COMMIT;\\q\n');a.stdin.flush();a.communicate(timeout=5)
        if a.returncode:raise RuntimeError('first original resume transaction failed')
        seen=[];deadline=time.monotonic()+10
        while True:
            value=line(b,deadline);seen.append(value)
            if value=='B_REPLAY_FINISHED':break
        if 't' not in seen:raise RuntimeError('actual race B did not read accepted original')
        b.stdin.write(b'\\q\n');b.stdin.flush();b.communicate(timeout=5)
        if b.returncode:raise RuntimeError('second original resume transaction failed')
        execution.sql(db,"DO $q$ BEGIN IF (SELECT count(*) FROM smarter_private.hand_submission_correction_claims)<>1 OR (SELECT count(*) FROM smarter_private.hand_submission_correction_results WHERE result->>'success'='true')<>1 OR (SELECT count(*) FROM public.hand_atomic_commits)<>1 THEN RAISE EXCEPTION 'CONCURRENT_ORIGINAL_DUPLICATED';END IF;RAISE NOTICE 'PASS two actual corrected-original resume transactions: observed Lock wait, one claim/result/atomic and accepted-receipt second caller';END $q$;",label='actual-original-race-cardinality')
        execution.report['races'].append({'scope':'one actual closed18 original','observed_lock_wait':True,'first_commit':True,'second_accepted_readback':True,'one_claim_result_atomic':True})
    finally:
        for p in (a,b):
            if p is not None and p.poll() is None:p.kill();p.communicate(timeout=5)
        err_a.close();err_b.close()
