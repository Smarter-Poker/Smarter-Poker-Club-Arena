#!/usr/bin/env python3
"""Finite empty-statement lane schedule; never a financial/historical fixture.

Uses the existing pinned Spin Session implementation, private socket, 20+5 second
bounds and original candidate allocation. No daemon, retry or alternate target.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
BASE = 'scripts/qualification/fixtures/spin-receipt-lane/'
SESSION_PATH = 'scripts/qualification/spin-expiry-business-races.py'
SESSION_SHA = '619267d012bb64257d639006c133d03c95f16c7e243b334e6af661d5900b95c5'
MANIFEST = 'scripts/qualification/spin-receipt-lane.hosted.manifest.json'
ORACLE = 'scripts/qualification/fixtures/spin-history-retention/database-state.sql'
CASES = ('receipt_insert', 'receipt_update', 'receipt_delete', 'history_insert',
         'history_identity_update', 'history_metadata_update', 'reverse_shared_lane',
         'truncate_relation_then_refusal', 'zero_rake_rpc_entry_and_replay')


def require(value, message):
    if not value:
        raise RuntimeError(message)


def snapshot(observer):
    return observer.json("SELECT jsonb_build_object('catalog',pg_temp.receipt_lane_catalog(),"
                         "'handler',pg_temp.receipt_lane_handler(),'business',pg_temp.retention_database_state());")


def wait_for_block(observer, holder, writer, expected_type, deadline):
    # Finite synchronization with already started owned commands, not a task poller.
    while time.monotonic() < deadline:
        require(writer.poll() is None, 'statement completed before its required lane wait')
        value = observer.json("SELECT jsonb_build_object('pid',pid,'wait_event_type',wait_event_type,"
            "'wait_event',wait_event,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity "
            f"WHERE pid={writer.pid} AND datname=current_database();")
        if (value and value['wait_event_type'] == 'Lock' and value['wait_event'] == expected_type
                and value['blockers'] == [holder.pid]):
            return value
        time.sleep(0.01)
    raise TimeoutError('exact owned backend wait was not observed inside original deadline')


def zero_result(session, sql=None):
    raw = session.command(sql) if sql is not None else session.wait()
    session.no_errors(raw)
    value = R.exact_json(raw)
    require(type(value) is int and value == 0, 'empty statement changed a row')
    return value


def run(args, events, sessions, deadline):
    db = 'qual_spin_expiry_' + args.execution.replace('-', '')
    def new(name):
        s = R.Session(args.psql, db, 'lane_' + name + '_' + args.execution, deadline)
        sessions.append(s)
        s.pid = s.json('SELECT to_jsonb(pg_backend_pid());')
        require(type(s.pid) is int and s.pid > 0, 'invalid backend PID')
        return s
    observer = new('observer')
    environment = observer.json("SELECT jsonb_build_object('database',current_database(),"
        "'user',current_user,'session_user',session_user,'port',current_setting('port'),"
        "'address',inet_server_addr(),'version',current_setting('server_version_num')::int,"
        "'others',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));")
    R.require_private_endpoint(environment, db)
    observer.no_errors(observer.command("SET statement_timeout='8s'; SET lock_timeout='1s'; "
        "SET timezone='UTC'; SET search_path=public,pg_temp; "
        "SET qualification.execution_uuid='" + args.execution + "';\n"
        + (ROOT / BASE / 'boundary.sql').read_text() + '\n'
        + (ROOT / ORACLE).read_text() + '\n' + (ROOT / BASE / 'state.sql').read_text()))
    helper = observer.json("SELECT jsonb_build_object('owner',pg_get_userbyid(p.proowner),"
        "'acl',p.proacl::text,'security_definer',p.prosecdef,'volatility',p.provolatile,"
        "'config',p.proconfig,'full_md5',md5(pg_get_functiondef(p.oid))) FROM pg_proc p "
        "WHERE p.oid=to_regprocedure('public.fn_ca_share_settlement_lane_for_table(uuid)');")
    require(helper == {'owner':'postgres','acl':'{postgres=X/postgres,service_role=X/postgres}',
        'security_definer':False,'volatility':'v','config':['search_path=public, pg_temp'],
        'full_md5':'409b14ee72ce888d3b26524c52d49a68'}, 'shared helper source/owner/ACL differs')
    events['shared_helper_authority'] = helper
    before = snapshot(observer)
    require(before['handler'] == {'owner':'postgres','acl':'{postgres=X/postgres}',
        'body_md5':'534850c97847e72075044d8604b0a09d','config':['search_path=pg_catalog, public, pg_temp'],
        'security_definer':False,'volatility':'v'}, 'installed candidate handler authority differs')
    require(before['business']['public.hand_history'] == []
            and before['business']['public.settlement_idempotency_keys'] == [],
            'requires empty real source/receipt relations; no invented successful receipts')
    events['environment'], events['before'] = environment, before
    holder, writer = new('holder'), new('writer')
    require(len({s.pid for s in sessions}) == 3, 'backend identity collision')
    events['backend_pids'] = {k: s.pid for k, s in [('observer',observer),('holder',holder),('writer',writer)]}
    # Zero-row DML runs the real statement triggers; row functions never receive
    # fabricated histories/receipts. CTE RETURNING independently observes row count.
    fixed = '00000000-0000-4000-8000-000000000000'
    operations = [
      ('receipt_insert', 'service_role', f"INSERT INTO public.settlement_idempotency_keys(table_id,hand_id,status) SELECT '{fixed}'::uuid,'{fixed}'::uuid,'in_flight' WHERE false RETURNING 1"),
      ('receipt_update', 'service_role', 'UPDATE public.settlement_idempotency_keys SET attempt_count=attempt_count WHERE false RETURNING 1'),
      ('receipt_delete', 'service_role', 'DELETE FROM public.settlement_idempotency_keys WHERE false RETURNING 1'),
      ('history_insert', 'postgres', f"INSERT INTO public.hand_history(id) SELECT '{fixed}'::uuid WHERE false RETURNING 1"),
      ('history_identity_update', 'postgres', 'UPDATE public.hand_history SET players=players WHERE false RETURNING 1'),
      ('history_metadata_update', 'postgres', 'UPDATE public.hand_history SET reported=reported WHERE false RETURNING 1'),
    ]
    for name, role, operation in operations:
        holder.begin()
        holder.no_errors(holder.command('SELECT public.fn_ca_lock_settlement_lane_global();'))
        writer.begin(service_role=role == 'service_role')
        actual_role = writer.json("SELECT to_jsonb(current_user::text);")
        require(actual_role == role, 'statement writer role differs')
        statement = 'WITH affected AS (' + operation + ') SELECT to_jsonb(count(*)) FROM affected;'
        writer.start(statement)
        record = {'case': name, 'role': role, 'holder_pid': holder.pid, 'writer_pid': writer.pid}
        if name != 'history_metadata_update':
            record['wait'] = wait_for_block(observer, holder, writer, 'advisory', deadline)
            holder.no_errors(holder.command('ROLLBACK;'))
            record['affected_rows'] = zero_result(writer)
        else:
            # The original compactor/reporting field must remain outside the hook.
            record['affected_rows'] = zero_result(writer)
            holder.no_errors(holder.command('ROLLBACK;'))
        writer.no_errors(writer.command('ROLLBACK;'))
        events['cases'].append(record)
    writer.begin(service_role=True)
    zero_result(writer, 'WITH affected AS (UPDATE public.settlement_idempotency_keys SET attempt_count=attempt_count WHERE false RETURNING 1) SELECT to_jsonb(count(*)) FROM affected;')
    holder.begin()
    holder.start('SELECT public.fn_ca_lock_settlement_lane_global();')
    observed = wait_for_block(observer, writer, holder, 'advisory', deadline)
    writer.no_errors(writer.command('ROLLBACK;'))
    holder.no_errors(holder.wait())
    holder.no_errors(holder.command('ROLLBACK;'))
    events['cases'].append({'case':'reverse_shared_lane','role':'postgres',
        'holder_pid':writer.pid,'writer_pid':holder.pid,'wait':observed,'affected_rows':0})
    # TRUNCATE obtains its relation lock before statement triggers. Preserve that
    # ordering: wait behind an owned AccessShare reader, then exact refusal. Never
    # claim it joins the advisory lane before taking a relation lock.
    holder.begin()
    zero_result(holder, 'SELECT to_jsonb(count(*)) FROM public.settlement_idempotency_keys;')
    writer.begin(service_role=True)
    writer.start("DO $refuse$ DECLARE m text; BEGIN BEGIN "
        "TRUNCATE public.settlement_idempotency_keys; "
        "RAISE EXCEPTION 'truncate was accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN "
        "GET STACKED DIAGNOSTICS m=MESSAGE_TEXT; "
        "IF m<>'retained settlement receipt history cannot be truncated' THEN RAISE; END IF; "
        "END; END $refuse$; SELECT to_jsonb('truncate_refused'::text);")
    observed = wait_for_block(observer, holder, writer, 'relation', deadline)
    holder.no_errors(holder.command('ROLLBACK;'))
    raw = writer.wait(); writer.no_errors(raw)
    require(R.exact_json(raw) == 'truncate_refused', 'truncate refusal observation absent')
    writer.no_errors(writer.command('ROLLBACK;'))
    events['cases'].append({'case':'truncate_relation_then_refusal','role':'service_role',
        'holder_pid':holder.pid,'writer_pid':writer.pid,'wait':observed,'affected_rows':0,'sqlstate':'55000'})
    # Genuine legacy RPC, including its new first entry into the lane. Its real
    # zero-rake callee exits before financial lookup/write and contributions are
    # empty. The RPC creates its own receipt; no success row is injected.
    table_id=str(uuid.uuid5(uuid.UUID(args.execution),'receipt-lane-zero-rake-table'))
    hand_id=str(uuid.uuid5(uuid.UUID(args.execution),'receipt-lane-zero-rake-hand'))
    require(observer.json("SELECT to_jsonb(count(*)) FROM pg_constraint WHERE conrelid="
        "'public.settlement_idempotency_keys'::regclass AND contype='f';")==0,
        'zero-rake isolated request requires authentic no-FK receipt contract')
    holder.begin()
    holder.no_errors(holder.command('SELECT public.fn_ca_lock_settlement_lane_global();'))
    writer.begin(service_role=True)
    call=("SELECT public.settle_hand_atomically('"+table_id+"'::uuid,'"+hand_id+
          "'::uuid,'{\"rake\":0,\"pot\":0,\"num_players\":0,\"player_contributions\":{},\"is_tournament\":false}'::jsonb);")
    writer.start(call)
    observed=wait_for_block(observer,holder,writer,'advisory',deadline)
    require(observer.json('SELECT to_jsonb(count(*)) FROM public.settlement_idempotency_keys;')==0,
            'RPC published a receipt before lane release')
    write_locks=observer.json("SELECT to_jsonb(count(*)) FROM pg_locks WHERE pid="+str(writer.pid)+
        " AND relation='public.settlement_idempotency_keys'::regclass AND mode='RowExclusiveLock' AND granted;")
    require(write_locks==0,'RPC reached receipt INSERT/UPDATE before first-entry lane acquisition')
    holder.no_errors(holder.command('ROLLBACK;'))
    raw=writer.wait();writer.no_errors(raw);first=R.exact_json(raw)
    expected={'success':True,'table_id':table_id,'hand_id':hand_id,
              'rake':{'success':True,'skipped':'zero_rake'},'commissions':[]}
    require(first==expected,'actual zero-rake RPC result differs')
    row_query=("SELECT jsonb_build_object('count',count(*),'rows',jsonb_agg(jsonb_build_object("
        "'row',to_jsonb(r),'ctid',r.ctid::text,'xmin',r.xmin::text,'cmin',r.cmin::text))) "
        "FROM public.settlement_idempotency_keys r;")
    one=writer.json(row_query)
    require(one['count']==1 and len(one['rows'])==1,'RPC did not create exactly one receipt')
    row=one['rows'][0]['row']
    require(row['table_id']==table_id and row['hand_id']==hand_id and row['status']=='succeeded'
            and row['result']==expected and row['error'] is None and row['attempt_count']==1
            and row['completed_at'] is not None and row['first_attempt_at']==row['last_attempt_at']==row['completed_at'],
            'canonical zero-rake receipt is incomplete')
    replay=writer.json(call);two=writer.json(row_query)
    require(replay==first and two==one,'same-key replay changed receipt identity, contents or tuple')
    writer.no_errors(writer.command('ROLLBACK;'))
    require(observer.json('SELECT to_jsonb(count(*)) FROM public.settlement_idempotency_keys;')==0,
            'zero-rake receipt survived rollback')
    events['cases'].append({'case':'zero_rake_rpc_entry_and_replay','role':'service_role',
        'holder_pid':holder.pid,'writer_pid':writer.pid,'wait':observed,
        'before_receipt_count':0,'pre_entry_receipt_write_locks':write_locks,'created_receipts':1,'rollback_receipts':0,'receipt_fk_count':0,
        'request_compatibility_only':True,'first_result':first,'replay_result':replay,
        'receipt_before_replay':one,'receipt_after_replay':two})
    after = snapshot(observer)
    require(after == before, 'statement schedule changed catalog or complete business state')
    events['after'] = after
    events['passed'] = True


def main():
    global R
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--psql', required=True, type=Path)
    parser.add_argument('--execution', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    require(args.psql.is_absolute() and args.psql.is_file(), 'absolute existing psql required')
    require(args.output == ROOT.parent / 'work/receipt-lane.json' and not args.output.exists(),
            'new exact owned evidence output required')
    require(hashlib.sha256((ROOT/SESSION_PATH).read_bytes()).hexdigest() == SESSION_SHA,
            'existing Session source differs')
    spec = importlib.util.spec_from_file_location('receipt_lane_existing_session', ROOT/SESSION_PATH)
    R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
    R.canonical_uuid(args.execution)
    manifest = json.loads((ROOT/MANIFEST).read_text())
    sources = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in manifest['files']}
    require(all(sources[name] == pin['sha256'] for name,pin in manifest['files'].items()),
            'qualification input changed before session start')
    sources[MANIFEST] = hashlib.sha256((ROOT/MANIFEST).read_bytes()).hexdigest()
    events = {'execution':args.execution, 'qualification':'receipt_statement_lane_and_zero_rake_compatibility',
        'passed':False, 'cleanup_verified':False, 'full_qualification':False,
        'historical_rows_qualified':False,'financial_completion_qualified':False,
        'work_deadline_seconds':20,'cleanup_deadline_seconds':5,
        'cases':[], 'source_sha256':sources}
    sessions=[]
    try:
        run(args, events, sessions, time.monotonic()+20)
    except BaseException as error:
        events['failure'] = {'type':type(error).__name__,'message':str(error)}
    finally:
        # Same original Session cleanup protocol, one absolute five-second budget.
        deadline = time.monotonic()+5
        events['clients'] = []
        for s in reversed(sessions):
            try: events['clients'].append(s.close(deadline))
            except BaseException as error: events['clients'].append({'backend_pid':s.pid,'cleanup_error':str(error)})
        events['transcripts'] = {s.name:bytes(s.raw).decode('utf-8',errors='replace') for s in sessions}
        verifier = None
        try:
            require(len(sessions)==3 and all(c.get('client_exit') == 0 and 'cleanup_error' not in c
                    for c in events['clients']), 'original client terminal success absent')
            require(time.monotonic()<deadline,'no original cleanup budget remains')
            verifier = R.Session(args.psql,'qual_spin_expiry_'+args.execution.replace('-',''),
                                 'lane_cleanup_'+args.execution,deadline)
            verifier.pid = verifier.json('SELECT to_jsonb(pg_backend_pid());')
            ids=','.join(str(s.pid) for s in sessions if s.pid is not None) or '0'
            events['backend_cleanup'] = verifier.json("SELECT jsonb_build_object('backends',"
                "(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()),"
                f"'locks',(SELECT count(*) FROM pg_locks WHERE pid IN ({ids})));" )
            require(events['backend_cleanup']=={'backends':0,'locks':0},'owned backend or lock remains')
            events['cleanup_verified']=True
        except BaseException as error: events['cleanup_failure']=str(error)
        finally:
            if verifier:
                events['cleanup_transcript']=bytes(verifier.raw).decode('utf-8',errors='replace')
                try:
                    events['verifier_client']=verifier.close(deadline)
                    require(events['verifier_client']['client_exit']==0,'cleanup observer exited unsuccessfully')
                except BaseException as error:
                    events['cleanup_verified']=False; events['verifier_cleanup_error']=str(error)
        events['source_stable'] = True
        events['source_readback'] = {}
        for name,sha in sources.items():
            try:
                actual=hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
                events['source_readback'][name]={'sha256':actual,'matches':actual==sha}
                if actual != sha: events['source_stable']=False
            except OSError as error:
                events['source_stable']=False
                events['source_readback'][name]={'read_error':str(error),'matches':False}
        with args.output.open('x') as out:
            out.write(json.dumps(events,indent=2,default=R.evidence_value,allow_nan=False)+'\n')
            out.flush(); os.fsync(out.fileno())
    if not events['passed'] or not events['cleanup_verified'] or not events['source_stable'] or 'failure' in events:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
