"""Finite real parent-lock schedule inside the existing private Spin allocation.

Uses the existing pinned Session owner. Modeled chair closure is not gameplay,
historical recovery, a financial operation or production qualification.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[2]
SESSION = 'scripts/qualification/spin-expiry-business-races.py'
SESSION_SHA = '619267d012bb64257d639006c133d03c95f16c7e243b334e6af661d5900b95c5'
STATE = 'scripts/qualification/fixtures/spin-history-retention/database-state.sql'


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(args, evidence, sessions, deadline):
    database = 'qual_spin_expiry_' + args.execution.replace('-', '')
    def new(name):
        session = R.Session(args.psql, database, 'horse_' + name + '_' + args.execution, deadline)
        sessions.append(session)
        session.pid = session.json('SELECT to_jsonb(pg_backend_pid());')
        require(type(session.pid) is int and session.pid > 0, 'missing backend identity')
        return session
    observer = new('observer')
    environment = observer.json("SELECT jsonb_build_object('database',current_database(),"
        "'user',current_user,'session_user',session_user,'port',current_setting('port'),"
        "'address',inet_server_addr(),'version',current_setting('server_version_num')::int,"
        "'others',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));")
    R.require_private_endpoint(environment, database)
    observer.no_errors(observer.command("SET statement_timeout='8s'; SET lock_timeout='1s'; SET timezone='UTC';\n" + (ROOT/STATE).read_text()))
    holder, writer = new('holder'), new('writer')
    writer.no_errors(writer.command((ROOT/STATE).read_text()))
    require(len({s.pid for s in sessions}) == 3, 'backend identity collision')
    evidence['backend_pids'] = {n:s.pid for n,s in [('observer',observer),('holder',holder),('writer',writer)]}
    evidence['environment'] = environment
    event, player = args.tournament, args.player
    require(observer.json("SELECT to_jsonb(status) FROM public.tournaments WHERE id='"+event+"';") == 'RUNNING',
            'genuine completed launch required')
    observer.no_errors(observer.command("BEGIN; UPDATE public.profiles SET is_horse=true WHERE id='"+player+"'; COMMIT;"))
    for case, expected in [('existing_live_chair', {'ok':True,'already_seated':True}),
                           ('modeled_closed_chair', {'ok':False,'reason':'game_already_started'})]:
        if case == 'modeled_closed_chair':
            observer.no_errors(observer.command("BEGIN; UPDATE public.table_seats s SET left_at=clock_timestamp() "
                "FROM public.tables t WHERE t.id=s.table_id AND t.tournament_id='"+event+"' AND s.user_id='"+player+"' "
                "AND s.left_at IS NULL; SET CONSTRAINTS ALL IMMEDIATE; COMMIT;"))
        before = observer.json("SELECT jsonb_build_object('rows',pg_temp.retention_database_state(),"
                               "'sequences',pg_temp.retention_sequence_state());")
        holder.begin()
        holder.no_errors(holder.command("SELECT id FROM public.tournaments WHERE id='"+event+"' FOR UPDATE;"))
        writer.begin(service_role=True)
        writer.start("SELECT public.fn_seat_horse_in_seat_first_game('"+event+"','"+player+"');")
        wait = None
        while time.monotonic() < deadline:
            require(writer.poll() is None, 'RPC completed before required parent lock wait')
            value = observer.json("SELECT jsonb_build_object('pid',pid,'wait_event_type',wait_event_type,"
                "'wait_event',wait_event,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid="
                +str(writer.pid)+" AND datname=current_database();")
            if value and value['wait_event_type']=='Lock' and value['wait_event']=='transactionid' and value['blockers']==[holder.pid]:
                wait=value
                break
            time.sleep(.01)
        require(wait is not None, 'exact owned parent lock wait absent')
        holder.no_errors(holder.command('ROLLBACK;'))
        raw=writer.wait(); writer.no_errors(raw)
        result=R.exact_json(raw)
        require(result == expected, 'actual post-lock result differs')
        writer.no_errors(writer.command('SET CONSTRAINTS ALL IMMEDIATE; RESET ROLE;'))
        inside = writer.json("SELECT jsonb_build_object('rows',pg_temp.retention_database_state(),"
                             "'sequences',pg_temp.retention_sequence_state());")
        require(inside == before, 'RPC race mutated persisted state before rollback')
        writer.no_errors(writer.command('ROLLBACK;'))
        after = observer.json("SELECT jsonb_build_object('rows',pg_temp.retention_database_state(),"
                              "'sequences',pg_temp.retention_sequence_state());")
        require(after == before, 'RPC race changed complete persisted state or sequences')
        evidence['cases'].append({'case':case,'wait':wait,'result':result,'before':before,'inside':inside,'after':after})
    evidence['passed']=True


def main():
    global R
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--psql',type=Path,required=True)
    for key in ('execution','tournament','player'):
        parser.add_argument('--'+key,required=True)
    args=parser.parse_args()
    require(args.psql.is_absolute() and args.psql.is_file(), 'absolute private psql required')
    require(hashlib.sha256((ROOT/SESSION).read_bytes()).hexdigest()==SESSION_SHA, 'existing Session owner changed')
    spec=importlib.util.spec_from_file_location('horse_existing_session', ROOT/SESSION)
    R=importlib.util.module_from_spec(spec);spec.loader.exec_module(R)
    for value in (args.execution,args.tournament,args.player): R.canonical_uuid(value)
    evidence={'execution':args.execution,'tournament':args.tournament,'player':args.player,
              'passed':False,'cleanup_verified':False,'modeled_chair_closure':True,
              'finalization_transition_qualified':False,'full_financial_qualification':False,
              'production_qualification':False,'work_deadline_seconds':20,'cleanup_deadline_seconds':5,'cases':[]}
    sessions=[]
    try:
        run(args,evidence,sessions,time.monotonic()+20)
    except BaseException as error:
        evidence['failure']={'type':type(error).__name__,'message':str(error)}
    finally:
        deadline=time.monotonic()+5
        evidence['clients']=[]
        for session in reversed(sessions):
            try: evidence['clients'].append(session.close(deadline))
            except BaseException as error: evidence['clients'].append({'backend_pid':session.pid,'cleanup_error':str(error)})
        evidence['transcripts']={s.name:bytes(s.raw).decode('utf-8',errors='replace') for s in sessions}
        verifier=None
        try:
            require(len(sessions)==3 and all(c.get('client_exit')==0 and 'cleanup_error' not in c for c in evidence['clients']), 'original client cleanup failed')
            verifier=R.Session(args.psql,'qual_spin_expiry_'+args.execution.replace('-',''),'horse_cleanup_'+args.execution,deadline)
            verifier.pid=verifier.json('SELECT to_jsonb(pg_backend_pid());')
            R.observe_backend_cleanup(verifier,','.join(str(s.pid) for s in sessions),deadline,evidence)
            evidence['cleanup_verified']=True
        except BaseException as error: evidence['cleanup_failure']=str(error)
        finally:
            if verifier:
                evidence['cleanup_transcript']=bytes(verifier.raw).decode('utf-8',errors='replace')
                try:
                    evidence['verifier_client']=verifier.close(deadline)
                    require(evidence['verifier_client']['client_exit']==0,'verifier client cleanup failed')
                except BaseException as error:
                    evidence['cleanup_verified']=False;evidence['verifier_cleanup_error']=str(error)
    print(json.dumps(evidence,default=R.evidence_value,allow_nan=False))
    return 0 if evidence['passed'] and evidence['cleanup_verified'] and 'failure' not in evidence else 1


if __name__=='__main__':
    raise SystemExit(main())
