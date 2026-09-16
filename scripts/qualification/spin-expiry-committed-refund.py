#!/usr/bin/env python3
"""SOURCE ONLY / UNRUN. R2 real committed cancellation versus waiting expiry.

Requires an independently admitted genuinely funded/aged disposable allocation.
Commits are intentionally NOT rolled back: the protected owner must dispose the
whole allocation and retain uncertain originals. No production-capable default.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time


DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[1]
R1 = DIRECTORY/'spin-expiry-business-races.py'
R1_SQL = DIRECTORY/'spin-expiry-business-state.sql'
R2_SQL = DIRECTORY/'spin-expiry-committed-refund-state.sql'
ORACLE = DIRECTORY/'spin-expiry-committed-refund-oracle.py'
AUTHORITY = DIRECTORY/'spin-expiry-committed-refund.authority.json'
FROZEN = {
    R1:'f2634dd0fab034137ba3d9c356b31ea1715645be21c073f1453322bc8497b391',
    R1_SQL:'eb052a103771b40e473a34b8b730e3126db7d9a9cbe18ece152b7a0afeab588a',
    DIRECTORY/'spin-expiry-lock-order.authority.json':
        '204c8528c4963c723139a2636fe7482abbad6ebcf3a247ec8a2f1de5fbccc09c',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path, name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Journal:
    """Exclusive fsynced local evidence; the owner must retain this exact inode.

    No record is an admission or teardown receipt. COMMIT intent is durable before
    sending COMMIT; process/connection loss thereafter never implies rollback.
    """
    def __init__(self,path,encode):
        self.file=path.open('x',encoding='utf-8')
        self.encode=encode; self.bytes=0; self.sequence=0
        # Persist the new directory entry before any transaction can COMMIT.
        # This is qualified only on the protected Linux filesystem, not assumed
        # durable from a successful write() or a provider-supplied boolean.
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def append(self,event,**payload):
        self.sequence+=1
        text=json.dumps({'sequence':self.sequence,'event':event,
                         'monotonic':str(time.monotonic()),**payload},
                        default=self.encode,allow_nan=False,separators=(',',':'))+'\n'
        size=len(text.encode())
        if self.bytes+size>32*1024*1024:
            raise RuntimeError('R2 evidence journal bound exceeded; retain original and stop')
        self.file.write(text); self.file.flush(); os.fsync(self.file.fileno())
        self.bytes+=size

    def close(self):
        self.file.close()


def authority(observer,lib):
    base=lib.authority(observer,'candidate')
    captures=lib.exact_json(AUTHORITY.read_text())['captures']
    results=[]
    for capture in captures:
        # Literal SELECT source is copied from the reviewed public catalog read.
        # It is never provided by a command-line caller or admission flag.
        actual=observer.json("SELECT COALESCE(jsonb_agg(to_jsonb(q)-'observed_at'),'[]'::jsonb) "
                             'FROM ('+capture['select']+')q;')
        # Catalog reads without ORDER BY have no stable row order. Compare exact
        # row multisets, retaining duplicates, rather than an accidental plan order.
        key=lambda row: json.dumps(row,sort_keys=True,default=lib.evidence_value,
                                   allow_nan=False,separators=(',',':'))
        actual=sorted(actual,key=key)
        lib.require(actual==sorted(capture['rows'],key=key),
                    'R2 selected authority drift: '+capture['origin'])
        results.append({'origin':capture['origin'],'actual':actual})
    return {'B':base,'R2':results}


def main():
    for path,expected in FROZEN.items():
        if digest(path)!=expected:
            raise SystemExit('unchanged R1/R5 dependency differs; do not import')
    lib=load(R1,'spin_expiry_r1_frozen')
    oracle=load(ORACLE,'spin_expiry_r2_oracle')
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--psql',type=Path,required=True)
    p.add_argument('--execution',type=lib.canonical_uuid,required=True)
    p.add_argument('--tournament',type=lib.canonical_uuid,required=True)
    p.add_argument('--journal',type=Path,required=True)
    args=p.parse_args()
    lib.require(args.psql.is_absolute() and args.psql.is_file(),'explicit protected psql required')
    lib.require(args.journal.is_absolute() and args.journal.parent.is_dir()
                and not args.journal.exists(),'new journal in admitted retained output required')
    files=[Path(__file__),R1,R1_SQL,R2_SQL,ORACLE,AUTHORITY,
           DIRECTORY/'spin-expiry-lock-order.authority.json']
    hashes={str(f.relative_to(ROOT)):digest(f) for f in files}
    journal=Journal(args.journal,lib.evidence_value)
    journal.append('original_operation',execution=args.execution,tournament=args.tournament,
        database='qual_spin_expiry_'+args.execution.replace('-',''),source_sha256=hashes,
        psql_path=str(args.psql.resolve()),psql_sha256=digest(args.psql),
        whole_allocation_teardown_required=True,full_qualification=False)
    deadline=time.monotonic()+20
    database='qual_spin_expiry_'+args.execution.replace('-','')
    sessions=[]; commits={}; failure=None; observed=False; cleanup=False

    def open_session(name):
        s=lib.Session(args.psql,database,'spin5_R2_'+args.execution+'_'+name,deadline)
        sessions.append(s)
        s.pid=s.json('SELECT to_jsonb(pg_backend_pid());')
        lib.require(type(s.pid) is int and s.pid>0,'invalid actual backend identity')
        journal.append('backend_opened',name=name,pid=s.pid)
        return s

    def commit(s,name):
        # Transaction identity is evidence, never caller-chosen monetary authority.
        xid=s.json('SELECT to_jsonb(pg_current_xact_id()::text);')
        commits[name]='may_have_committed'
        journal.append('commit_intent',step=name,backend_pid=s.pid,transaction_id=xid,
                       tournament=args.tournament,state=commits[name])
        result=s.command('COMMIT;')
        s.no_errors(result)
        commits[name]='acknowledged_not_yet_independently_verified'
        journal.append('commit_acknowledgement',step=name,result=result,state=commits[name])

    def state(observer,name,full=False):
        value=observer.json('SELECT pg_temp.spin_expiry_r2_state();')
        encoded=json.dumps(value,sort_keys=True,default=lib.evidence_value,
                           allow_nan=False,separators=(',',':'))
        journal.append('state_observation',step=name,sha256=hashlib.sha256(encoded.encode()).hexdigest(),
                       rows=value if full else None)
        return value

    try:
        journal.append('numeric_controls',controls=lib.numeric_controls())
        observer=open_session('observer')
        environment=observer.json("""SELECT jsonb_build_object('database',current_database(),
          'user',current_user,'session_user',session_user,'port',current_setting('port'),
          'address',inet_server_addr(),'version',current_setting('server_version_num')::int,
          'others',(SELECT count(*) FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()));""")
        journal.append('environment',value=environment)
        lib.require(environment=={'database':database,'user':'postgres','session_user':'postgres',
                    'port':'5432','address':'127.0.0.1','version':environment['version'],'others':0}
                    and 170000<=environment['version']<180000,'private current PG17 tripwire differs')
        observer.no_errors(observer.command("SET statement_timeout='3s'; SET timezone='UTC'; "
            'SET search_path=public,pg_temp;'+R1_SQL.read_text()+R2_SQL.read_text()))
        before_authority=authority(observer,lib)
        journal.append('authority_before',value=before_authority)
        fixture=observer.json(f"SELECT pg_temp.spin_expiry_fixture('{args.tournament}'::uuid);")
        diamond=observer.json(f"SELECT to_jsonb(public.fn_poker_diamond_tournament('{args.tournament}'::uuid));")
        lib.require(diamond is False,'ordinary chip-rail classifier must actually be false')
        journal.append('fixture_before',value=fixture,diamond=diamond)
        before=state(observer,'before',True)
        basis=oracle.initial(before,args.tournament)
        journal.append('paid_fixture_oracle',basis=basis)
        a,b=open_session('expiry'),open_session('cancel')
        a.begin(service_role=True); b.begin(service_role=True)
        b.no_errors(b.command('SELECT public.fn_ca_lock_settlement_lane_global();'))
        a.start('SELECT public.fn_spin_expire_unfilled(1)::text;')
        while time.monotonic()<deadline:
            sample=lib.waits(observer,[a,b])
            current=next((x for x in sample if x['pid']==a.pid),None)
            lib.require(a.poll() is None,'expiry completed before observed original global wait')
            if current and current['wait_event']=='advisory' and b.pid in current['blockers']:
                journal.append('expiry_scanned_and_waiting',backends=sample)
                break
            time.sleep(.02)
        else:
            raise TimeoutError('actual expiry global wait not observed before original deadline')
        journal.append('canonical_cancel_dispatch',backend_pid=b.pid,tournament=args.tournament,
                       function='public.atomic_cancel_tournament(uuid,uuid)')
        provisional=b.json(f"SELECT public.atomic_cancel_tournament('{args.tournament}'::uuid,NULL);")
        journal.append('provisional_cancellation_receipt',receipt=provisional,committed=False)
        b.no_errors(b.command('SET CONSTRAINTS ALL IMMEDIATE;'))
        commit(b,'canonical_cancel')
        # Fresh session/statement observation after B's acknowledged COMMIT.
        committed_state=state(observer,'after_B_commit',True)
        reader=observer.json(f"SELECT public.fn_ca_tournament_cancellation_receipt('{args.tournament}'::uuid,NULL);")
        positive=oracle.committed(before,committed_state,args.tournament,provisional,reader)
        commits['canonical_cancel']='independently_observed_in_this_allocation'
        journal.append('committed_cancellation_oracle',proof=positive,receipt=reader,
                       state=commits['canonical_cancel'])
        journal.append('observation_oracle_negative_controls',
            controls=oracle.negative_controls(before,committed_state,args.tournament),database_mutations=False)
        actual_a=a.wait(); a.no_errors(actual_a)
        expiry=lib.exact_json(actual_a)
        lib.require(expiry.get('ok') is True and expiry.get('expired')==0
                    and expiry.get('failed')==0 and expiry.get('skipped_raced')==1
                    and expiry.get('tournament_ids')==[], 'waiting expiry did not return exact fresh-state skip')
        journal.append('expiry_fresh_state_skip',receipt=expiry)
        a.no_errors(a.command('SET CONSTRAINTS ALL IMMEDIATE;'))
        commit(a,'waiting_expiry')
        after_a=state(observer,'after_A_commit')
        lib.require(after_a==committed_state,'waiting expiry committed additional selected changes')
        commits['waiting_expiry']='independently_observed_no_selected_change'
        journal.append('expiry_no_second_refund',state=commits['waiting_expiry'])
        replay=open_session('replay'); replay.begin(service_role=True)
        replayed=replay.json(f"SELECT public.atomic_cancel_tournament('{args.tournament}'::uuid,NULL);")
        lib.require(replayed==reader,'canonical replay altered original receipt')
        replay.no_errors(replay.command('SET CONSTRAINTS ALL IMMEDIATE;'))
        commit(replay,'canonical_replay')
        after_replay=state(observer,'after_replay_commit')
        latest=observer.json(f"SELECT public.fn_ca_tournament_cancellation_receipt('{args.tournament}'::uuid,NULL);")
        lib.require(after_replay==committed_state and latest==reader,
                    'committed replay changed financial rows/identities or original receipt')
        oracle.committed(before,after_replay,args.tournament,provisional,latest)
        commits['canonical_replay']='independently_observed_no_selected_change'
        lib.require(authority(observer,lib)==before_authority,'selected authority changed during R2')
        lib.require(all(row['state']=='idle' and not row['blockers']
                        for row in lib.waits(observer,[a,b,replay])), 'scenario backend remains active')
        observed=True
        journal.append('R2_observations_complete',commits=commits,full_qualification=False,
                       whole_allocation_teardown_required=True)
    except BaseException as error:
        failure=error
        journal.append('original_failure',type=type(error).__name__,message=str(error),
            commit_states=commits,retry_authorized=False,whole_allocation_teardown_required=True)
    finally:
        cleanup_deadline=time.monotonic()+5
        clients=[]
        for s in reversed(sessions):
            try:
                clients.append(s.close(cleanup_deadline))
            except BaseException as error:
                clients.append({'backend_pid':s.pid,'cleanup_error':str(error)})
        clients_verified=(len(clients)==len(sessions) and all('cleanup_error' not in c
                           and c.get('client_exit') is not None for c in clients))
        verifier=None
        try:
            lib.require(time.monotonic()<cleanup_deadline,'no cleanup observation budget remains')
            verifier=lib.Session(args.psql,database,'spin5_R2_cleanup_'+args.execution,cleanup_deadline)
            verifier.pid=verifier.json('SELECT to_jsonb(pg_backend_pid());')
            lib.require(type(verifier.pid) is int and verifier.pid>0,'invalid cleanup backend identity')
            ids=','.join(str(s.pid) for s in sessions if type(s.pid) is int and s.pid>0) or '0'
            remaining=verifier.json("SELECT jsonb_build_object('backends',"
                "(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()),"
                f"'locks',(SELECT count(*) FROM pg_locks WHERE pid IN ({ids})));" )
            lib.require(remaining=={'backends':0,'locks':0} and clients_verified,
                        'client/server termination requirements did not both hold')
            cleanup=True
            journal.append('original_backend_cleanup',clients=clients,remaining=remaining,
                           client_terminal_verified=clients_verified,allocation_disposed=False)
        except BaseException as error:
            cleanup=False
            journal.append('cleanup_failure',clients=clients,message=str(error),allocation_disposed=False)
        finally:
            if verifier:
                try:
                    result=verifier.close(cleanup_deadline)
                    journal.append('verifier_client_exit',result=result,
                                   independent_owner_observation_still_required=True)
                except BaseException as error:
                    cleanup=False
                    journal.append('verifier_cleanup_failure',message=str(error))
        readback={}; stable=True
        for name,expected in hashes.items():
            try:
                actual=digest(ROOT/name)
                readback[name]={'sha256':actual,'matches':actual==expected}
                stable=stable and actual==expected
            except (OSError,ValueError) as error:
                stable=False; readback[name]={'read_error':str(error),'matches':False}
        for s in sessions:
            journal.append('session_transcript',backend_pid=s.pid,name=s.name,
                           text=bytes(s.raw).decode('utf-8',errors='replace'))
        journal.append('source_readback',files=readback,stable=stable)
        journal.append('terminal_source_oracle_result',observed=observed,
            client_and_server_cleanup=cleanup,source_stable=stable,commit_states=commits,
            full_qualification=False,allocation_disposed=False,
            required_next_step='Independent protected whole-allocation terminal/teardown receipt; no automatic retry')
        journal.close()
    if failure or not observed or not cleanup or not stable:
        raise SystemExit(1)


if __name__=='__main__':
    main()
