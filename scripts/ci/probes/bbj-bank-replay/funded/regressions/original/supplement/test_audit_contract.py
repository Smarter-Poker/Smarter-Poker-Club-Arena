"""UNRUN source-authored protocol tests. Protected execution only; no SQL launch.

Model tests cannot qualify actual PostgreSQL command or row production. The
separate required native composition checks remain mandatory.
"""
import copy
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('audit_under_test', HERE/'audit_contract.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
model = json.loads((HERE/'AUDIT-EXPECTED.json').read_text())
models = json.loads((HERE/'EXPECTED.json').read_text())
checks = []


def check(name, call, refusal=False):
    try:
        call()
    except AssertionError:
        if not refusal:
            raise
    else:
        assert not refusal, 'Required refusal missing: ' + name
    checks.append({'name':name,'passed':True})


def fixtures(noop=False, existing_lock=False, uncalled=False):
    choice = {kind:['after' if noop else 'before']*len(models[kind]) for kind in ('functions','tables','sequences')}
    plan = a.planned_events(models,choice)
    context = {'transaction_id':'5000','transaction_timestamp':'2026-09-15 12:00:00+00',
               'application_name':'g8-bbj-backup-0001','role':'postgres','session_role':'postgres','replication_role':'origin'}
    sequence = {'schema':'public','name':'ca_ddl_events_id_seq','owner':'postgres','type':'bigint',
                'start':'1','minimum':'1','maximum':'9223372036854775807','increment':'1','cache':'1','cycle':False,
                'last_value':None if uncalled else '100'}
    other = {**sequence,'name':'ca_bbj_bucket_moves_id_seq','last_value':'7'}
    before = {'errors':[],'raw':{a.AUDIT:[],a.LOCKS:[]},
              'sizes':{a.AUDIT:{'count':0,'bytes':0},a.LOCKS:{'count':0,'bytes':0}},
              'metadata':copy.deepcopy(model['tables']),
              'sequence_catalog':{'model':copy.deepcopy(model['sequence']),'raw_pg_class':{'oid':'123'},'raw_pg_sequence':{'seqrelid':'123'},'dependencies':[]},
              'sequence_state':{'last_value':'1' if uncalled else '100','is_called':not uncalled,'log_cnt':'0' if uncalled else '32'},
              'all_sequences':[other,sequence], 'sequence_count':2,
              'helpers':[{**copy.deepcopy(h),'raw':{'oid':str(900+i)}} for i,h in enumerate(model['helpers'])],
              'event_triggers_raw':[{'function':'public.ca_log_ddl_event()','raw':{'evtname':'ca_ddl_watchdog_log','evtevent':'ddl_command_end','evtenabled':'O','evttags':None}}],
              'nested_guard':{'eligible_grant_sweep':0,'graphql_oid_collision':0},'context':context}
    if existing_lock:
        before['raw'][a.LOCKS] = [{**model['move_lock'],'locked_at':'2026-09-14 12:00:00+00','_xmin':'20'}]
        before['sizes'][a.LOCKS]['count'] = 1
    after = copy.deepcopy(before)
    start = 1 if uncalled else 101
    for i,event in enumerate(plan['events']):
        after['raw'][a.AUDIT].append({**{k:v for k,v in event.items() if k!='query_snippets'},
            'id':str(start+i),'query_snippet':event['query_snippets'][0], 'occurred_at':context['transaction_timestamp'],
            'role_name':'postgres','application_name':context['application_name'],'_xmin':str(5001+i)})
    if plan['move_replaced'] and not existing_lock:
        after['raw'][a.LOCKS].append({**model['move_lock'],'locked_at':context['transaction_timestamp'],'_xmin':'5050'})
    for name in (a.AUDIT,a.LOCKS):
        after['sizes'][name]['count'] = len(after['raw'][name])
    if plan['events']:
        count = len(plan['events'])
        end = str(start+count-1)
        after['sequence_state'] = {'last_value':end,'is_called':True,'log_cnt':str(33-count if uncalled else 32-count)}
        after['all_sequences'][1]['last_value'] = end
    statements = [{'sql':sql,'status':'RETURNED'} for sql in plan['dispatches']]
    return before,after,plan,statements,context


check('Full source path includes 23 dispatches and 25 nested audit records',lambda: (
    a.require(len(fixtures()[2]['dispatches'])==23,'dispatch count'),
    a.require(len(fixtures()[2]['events'])==25,'event count')))
for name,opts in [('historical',{}),('already_locked',{'existing_lock':True}),
                  ('uncalled',{'uncalled':True}),('noop',{'noop':True}),('uncalled_noop',{'noop':True,'uncalled':True})]:
    check('Exact source transition '+name,lambda opts=opts:a.assert_transition(*fixtures(**opts)))

mutations = {
    'missing swallowed audit row':lambda x:x[1]['raw'][a.AUDIT].pop(),
    'zero audit rows with nontransactional advance':lambda x:x[1]['raw'].__setitem__(a.AUDIT,[]),
    'unaccounted sequence allocation':lambda x:x[1]['sequence_state'].__setitem__('last_value','126'),
    'audit identity gap':lambda x:x[1]['raw'][a.AUDIT][0].__setitem__('id','99'),
    'source command changed':lambda x:x[1]['raw'][a.AUDIT][0].__setitem__('command_tag','DROP TABLE'),
    'unrelated query':lambda x:x[1]['raw'][a.AUDIT][0].__setitem__('query_snippet','SELECT 1;'),
    'unrelated function identity':lambda x:x[1]['raw'][a.AUDIT][3].__setitem__('object_identity','public.other()'),
    'numeric bool':lambda x:x[1]['sequence_state'].__setitem__('is_called',1),
    'sequence config drift':lambda x:x[1]['sequence_catalog']['model'].__setitem__('cache','32'),
    'audit attachment drift':lambda x:x[1]['sequence_catalog']['model']['owned_by'][0].__setitem__('deptype','a'),
    'unrelated sequence advance':lambda x:x[1]['all_sequences'][0].__setitem__('last_value','8'),
    'unrelated sequence max drift':lambda x:x[1]['all_sequences'][0].__setitem__('maximum','1000'),
    'lock row missing':lambda x:x[1]['raw'][a.LOCKS].clear(),
    'lock reason changed':lambda x:x[1]['raw'][a.LOCKS][0].__setitem__('reason','invented'),
    'eligible unmodeled grant sweep':lambda x:x[1]['nested_guard'].__setitem__('eligible_grant_sweep',1),
    'eligible graphql branch':lambda x:x[0]['nested_guard'].__setitem__('graphql_oid_collision',1),
    'audit helper drift':lambda x:x[1]['helpers'][0].__setitem__('source','BEGIN RETURN; END'),
    'failed statement is not accepted':lambda x:x[3][0].__setitem__('status','ERROR'),
    'wrong transaction timestamp':lambda x:x[1]['raw'][a.AUDIT][0].__setitem__('occurred_at','2026-09-14 12:00:00+00'),
    'unbounded WAL metadata':lambda x:x[1]['sequence_state'].__setitem__('log_cnt','33'),
}
for name,mutate in mutations.items():
    value=list(fixtures());mutate(value)
    # Keep raw counts coherent so record/sequence provenance checks, rather
    # than only extraction-length checks, must reject the malformed result.
    for snapshot in value[:2]:
        for relation in (a.AUDIT,a.LOCKS):
            snapshot['sizes'][relation]['count']=len(snapshot['raw'][relation])
    check(name,lambda value=value:a.assert_transition(*value),True)

value=list(fixtures());value[1]['sequence_state']['log_cnt']='32'
check('Source-permitted checkpoint prelogging remains bounded',lambda:a.assert_transition(*value))
value=list(fixtures(noop=True));value[1]['sequence_state']['log_cnt']='31'
check('No-op cannot change physical sequence state',lambda:a.assert_transition(*value),True)
value=list(fixtures(existing_lock=True));value[1]['raw'][a.LOCKS][0]['_xmin']='999'
check('Existing lock is an exact row and xmin no-op',lambda:a.assert_transition(*value),True)
value=list(fixtures());committed=copy.deepcopy(value[1]);committed['context']['transaction_id']=None
check('Committed read preserves full accepted rows despite a new read transaction',lambda:a.assert_persisted(value[1],committed))
committed['raw'][a.AUDIT].pop();committed['sizes'][a.AUDIT]['count']-=1
check('Committed read cannot hide a rolled-back audit row',lambda:a.assert_persisted(value[1],committed),True)

if __name__ == '__main__':
    print(json.dumps({'status':'PASS','checks':checks,'count':len(checks),'native_sql_executed':False,
        'scope':'Source model/protocol only; actual original trigger and Psql composition remains required'},indent=2))
