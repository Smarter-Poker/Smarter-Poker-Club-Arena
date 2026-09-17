"""Native SQL driver; import is inert. Only run_fixture.py may start a cluster.

Real source bodies create every financial leg. Python controls ordering and
asserts results; it supplies no replacement SQL financial implementation.
"""
import json
import queue
import subprocess
import threading
import time
import uuid
from decimal import Decimal

ACTOR = '7beef002-0002-4000-8000-000000000001'
CLUB = '7beef002-0002-4000-8000-000000000002'


class Psql:
    def __init__(self, args, env, label, record):
        self.label, self.record, self.seq = label, record, 0
        self.q, self.errors = queue.Queue(), []
        self.p = subprocess.Popen(args + ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                                        '-v', 'VERBOSITY=verbose'], env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1)
        def pump(stream, target):
            for line in stream:
                target(line.rstrip('\n'))
            if stream is self.p.stdout:
                self.q.put(None)
        threading.Thread(target=pump, args=(self.p.stdout, self.q.put), daemon=True).start()
        threading.Thread(target=pump, args=(self.p.stderr, self.errors.append), daemon=True).start()

    def sql(self, sql, timeout=60):
        self.seq += 1
        marker = 'g8_barrier_' + uuid.uuid4().hex
        at, errstart = time.monotonic(), len(self.errors)
        attempt={'connection':self.label,'step':self.seq,'sql':sql,
                 'stdout':[],'stderr':[],'barrier':marker,'status':'ATTEMPTED'}
        self.record.append(attempt)
        self.p.stdin.write(sql.rstrip().rstrip(';') + ';\n\\echo ' + marker + '\n')
        self.p.stdin.flush()
        rows = []
        while True:
            try:
                line = self.q.get(timeout=max(.001, timeout-(time.monotonic()-at)))
            except queue.Empty:
                attempt.update(stdout=rows,stderr=self.errors[errstart:],status='TIMEOUT',elapsed_seconds=time.monotonic()-at)
                raise TimeoutError(self.label + ': statement/barrier timeout')
            if line is None:
                attempt.update(stdout=rows,stderr=self.errors[errstart:],status='PSQL_EXIT',elapsed_seconds=time.monotonic()-at)
                raise RuntimeError(self.label + ': psql ended: ' + '\n'.join(self.errors))
            if line == marker:
                break
            rows.append(line)
        attempt.update(stdout=rows,stderr=self.errors[errstart:],status='BARRIER_REACHED',elapsed_seconds=time.monotonic()-at)
        return rows

    def one(self, sql):
        rows = self.sql(sql)
        if len(rows) != 1:
            raise AssertionError('Expected exactly one JSON result: '+repr(rows))
        return json.loads(rows[0], parse_float=Decimal)

    def close(self):
        if self.p.poll() is None:
            try:
                self.p.stdin.write('ROLLBACK;\n\\q\n')
                self.p.stdin.flush()
                self.p.wait(timeout=5)
            except Exception:
                self.p.kill()
                self.p.wait(timeout=5)


def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


def begin_writer(w):
    w.sql("BEGIN; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='10s';"
          "SELECT set_config('request.jwt.claim.role','service_role',true);"
          f"SELECT set_config('request.jwt.claim.sub','{ACTOR}',true);"
          "SELECT set_config('request.jwt.claims',"
          f"'{{\"role\":\"service_role\",\"sub\":\"{ACTOR}\"}}',true)")
    # Allocates the real top-level xid before the function's EXCEPTION subxids.
    return w.one("SELECT jsonb_build_object('top_xid',pg_current_xact_id()::text,"
                 "'snapshot',pg_current_snapshot()::text,'backend',pg_backend_pid())")


def send(w, amount, operation):
    result = w.one(f"SELECT public.fn_club_bank_send('{CLUB}','{ACTOR}',{amount},"
                   f"'player_wallet','Native ledger sequence {operation}','{operation}')")
    require(result.get('success') is True and result.get('replayed') is False,
            'Real writer refused/replayed unexpectedly: '+repr(result))
    legs = w.one("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'xmin',xmin::text,"
                 "'created_at',created_at,'amount',amount,'from_type',from_type,"
                 "'to_type',to_type,'from_entity_id',from_entity_id,'to_entity_id',to_entity_id,"
                 "'key',idempotency_key,'chain_seq',chain_seq,'epoch_id',epoch_id)), '[]'::jsonb) "
                 f"FROM public.chip_ledger WHERE idempotency_key='club_bank_send:{operation}'")
    require(len(legs) == 1, 'Writer must produce exactly one original-key journal leg')
    leg = legs[0]
    require(Decimal(str(leg['amount'])) == Decimal(str(amount)) and
            leg['from_type']=='club_treasury' and leg['to_type']=='player_wallet' and
            leg['from_entity_id']==CLUB and leg['to_entity_id']==ACTOR,
            'Writer journal side/amount mismatch')
    return {'result':result, 'legs':legs}


def begin_reader(r):
    r.sql("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='10s'")
    # BEGIN alone does not establish a snapshot. This returned SQL result is the
    # deterministic barrier before another connection is allowed to commit.
    return r.one("SELECT jsonb_build_object('snapshot',pg_current_snapshot()::text,"
                 "'isolation',current_setting('transaction_isolation'),'backend',pg_backend_pid())")


def pair(r, already_begun=False):
    cut = None if already_begun else begin_reader(r)
    # Mirrors cron's session advisory-lock choice. Lock refusal skips replay,
    # while meter remains part of the same transaction; no wrapper mock.
    replay = r.one("SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-ledger-replay')) "
                   "THEN public.fn_ca_ledger_replay(5000) ELSE to_jsonb('locked'::text) END")
    meter = r.one('SELECT public.fn_ca_currency_meter()')
    state = r.one("SELECT jsonb_build_object("
       "'snapshots',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM public.ca_account_snapshots s),'[]'::jsonb),"
       "'currencies',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.ca_currency_meter m WHERE at=now()),'[]'::jsonb),"
       "'treasury',(SELECT chip_treasury FROM public.clubs WHERE id='"+CLUB+"'),"
       "'wallet',(SELECT chip_balance FROM public.club_members WHERE club_id='"+CLUB+"' AND user_id='"+ACTOR+"'),"
       "'incidents',(SELECT count(*) FROM public.ca_drift_incidents),"
       "'file_failures',(SELECT count(*) FROM public.ca_incident_file_failures),"
       "'journal_failures',(SELECT count(*) FROM public.ca_ledger_write_failures),"
       "'freezes',(SELECT count(*) FROM public.ca_payout_freeze))")
    r.sql('COMMIT')
    r.sql("SELECT pg_advisory_unlock_all()")
    return {'cut':cut,'replay':replay,'meter':meter,'state':state}


def balanced(p, treasury=None, wallet=None, require_accounts=False):
    require(isinstance(p['replay'],dict), 'Unexpected advisory-lock refusal')
    require(p['replay']['disagree']==0, 'Replay reported a disagreement')
    state=p['state']
    require(len(state['currencies'])==3, 'Meter must persist all three currency rows')
    for c in state['currencies']:
        require(c['drifted']==0 and Decimal(str(c['worst']))==0,
                'Empty derivative currency class drifted: '+repr(c))
    for key in ('incidents','file_failures','journal_failures','freezes'):
        require(state[key]==0, 'Unexpected '+key+': '+str(state[key]))
    if treasury is not None:
        require(Decimal(str(state['treasury']))==Decimal(str(treasury)), 'Wrong snapshot treasury')
        require(Decimal(str(state['wallet']))==Decimal(str(wallet)), 'Wrong snapshot wallet')
    last={s['account_key']:s for s in state['snapshots']}
    if require_accounts:
        require(any(s['column_name']=='clubs.chip_treasury' for s in last.values()),'Missing treasury snapshot')
        require(any(s['column_name']=='club_members.chip_balance' for s in last.values()),'Missing wallet snapshot')
    for s in last.values():
        require(s['read_snapshot'] is not None, 'Snapshot visibility proof not saved')
        require(s['unexplained'] in (None,0) and s['cum_unexplained']==0,
                'Unexpected unexplained/cumulative movement: '+repr(s))


def execute_case(case, connect, seed):
    record=[]
    r,w=connect('reader',record),connect('writer',record)
    z=None
    result={'case':case,'status':'RUNNING','events':record,'observations':[]}
    obs=result['observations']
    def write_committed(amount, op):
        identity=begin_writer(w); receipt=send(w,amount,op); w.sql('COMMIT')
        obs.append({'writer':identity,**receipt})
    try:
        if case=='SEQ01':
            p=pair(r); obs.append(p); balanced(p)
            require(p['replay']['baselines']==0 and p['replay']['checked']==0,
                    'Empty fixture unexpectedly had financial accounts')
            require(not p['state']['snapshots'],'Empty run wrote account snapshots')
        else:
            seed()
            write_committed('10.25','7beef002-0002-4000-8000-000000000010')
            p=pair(r); obs.append(p); balanced(p,'99989.75','10.25',True)
            require(p['replay']['baselines']>=2, 'First reading did not baseline both real accounts')
            p=pair(r); obs.append(p); balanced(p,'99989.75','10.25',True)
            if case=='SEQ02':
                write_committed('7.50','7beef002-0002-4000-8000-000000000020')
                p=pair(r); obs.append(p); balanced(p,'99982.25','17.75',True)
                p=pair(r); obs.append(p); balanced(p,'99982.25','17.75',True)
            elif case=='SEQ03':
                identity=begin_writer(w)
                receipt=send(w,'7.50','7beef002-0002-4000-8000-000000000030')
                obs.append({'writer':identity,**receipt,'held_uncommitted':True})
                cut=begin_reader(r); obs.append({'reader_cut_with_writer_open':cut})
                p=pair(r,True); obs.append(p); balanced(p,'99989.75','10.25',True)
                w.sql('COMMIT')
                p=pair(r); obs.append(p); balanced(p,'99982.25','17.75',True)
                p=pair(r); obs.append(p); balanced(p,'99982.25','17.75',True)
            elif case=='SEQ04':
                cut=begin_reader(r); obs.append({'reader_cut_before_writer':cut})
                write_committed('7.50','7beef002-0002-4000-8000-000000000040')
                p=pair(r,True); obs.append(p); balanced(p,'99989.75','10.25',True)
                p=pair(r); obs.append(p); balanced(p,'99982.25','17.75',True)
            elif case=='SEQ05':
                # A plain W-open straddle can accidentally work when child xmin
                # is beyond the snapshot xmax. Z advances xmax past that child
                # while W's top-level xid remains present in the snapshot xip.
                identity=begin_writer(w)
                operation='7beef002-0002-4000-8000-000000000050'
                receipt=send(w,'7.50',operation)
                obs.append({'writer':identity,**receipt,'held_uncommitted':True})
                z=connect('unrelated_z',record)
                z.sql('BEGIN')
                z_identity=z.one("SELECT jsonb_build_object('allocated_top_xid',pg_current_xact_id()::text,'backend',pg_backend_pid())")
                z.sql('COMMIT')
                obs.append({'unrelated_z_committed_before_reader_cut':z_identity})
                cut=begin_reader(r)
                obs.append({'reader_cut_with_parent_open_and_xmax_after_child':cut})
                p=pair(r,True); obs.append(p); balanced(p,'99989.75','10.25',True)
                stored=[s for s in p['state']['snapshots'] if s['column_name']=='club_members.chip_balance'][-1]['read_snapshot']
                require(int(z_identity['allocated_top_xid'])>int(receipt['legs'][0]['xmin']),
                        'Diagnostic did not advance xid allocation beyond the actual child')
                require(identity['top_xid']!=receipt['legs'][0]['xmin'],
                        'Selected actual writer did not expose the expected subtransaction row')
                w.sql('COMMIT')
                # Diagnostic reads only this real journal row. It does not add
                # a fake witness column or replace the financial visibility rule.
                vis=r.one("SELECT jsonb_build_object('stored_snapshot',"+literal_sql(stored)+","
                    "'actual_xmin',xmin::text,'converted_xid',public.fn_ca_xid8(xmin)::text,"
                    "'child_visible_in_previous',pg_visible_in_snapshot(public.fn_ca_xid8(xmin),"+literal_sql(stored)+"::pg_snapshot),"
                    "'top_visible_in_previous',pg_visible_in_snapshot("+literal_sql(identity['top_xid'])+"::xid8,"+literal_sql(stored)+"::pg_snapshot)) "
                    "FROM public.chip_ledger WHERE idempotency_key='club_bank_send:"+operation+"'")
                obs.append({'actual_parent_child_visibility_diagnostic':vis})
                p=pair(r); obs.append(p); balanced(p,'99982.25','17.75',True)
            else:
                raise ValueError('Unimplemented case '+case)
        result['status']='PASS'
    except Exception as e:
        result.update(status='FAIL',error_type=type(e).__name__,error=str(e))
    finally:
        r.close(); w.close()
        if z is not None: z.close()
        result['connection_stderr']={'reader':r.errors,'writer':w.errors}
        if z is not None: result['connection_stderr']['unrelated_z']=z.errors
    return result


def literal_sql(value):
    return "'"+str(value).replace("'","''")+"'"
