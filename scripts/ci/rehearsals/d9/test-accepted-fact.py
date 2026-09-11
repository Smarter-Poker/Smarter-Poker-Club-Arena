"""Native qualification probes over real accepted D10 receipts and hostile JSON."""
from pathlib import Path
import copy,json,subprocess

base=Path(__file__).resolve().parent
state=json.loads((base/'cluster.json').read_text())
assert state['cluster'].startswith('/tmp/ca-e2-owned-')
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database'],'-Atc']
def query(sql):return json.loads(subprocess.check_output(psql+[sql],text=True))
source=json.loads((base/'d10-accepted-validator-source.json').read_text())
def qualify(value):
    encoded=json.dumps(value,separators=(',',':')).replace("'","''")
    return query("SELECT fn_ca_accepted_tournament_settlement_fact('"+encoded+"'::jsonb)")
valid=qualify(source);assert valid['ok'] and valid['chip_total']==480000 and valid['player_count']==2
cases={}
def change(name,mutate):
    value=copy.deepcopy(source);mutate(value);result=qualify(value)
    assert result['ok'] is False and result['reason'],(name,result)
    cases[name]=result['reason']
change('failed_receipt',lambda v:v.update(status='failed'))
change('failed_result',lambda v:v['result'].update(success=False))
change('unverified_conservation',lambda v:v['result'].update(conservation_checked=False))
change('foreign_table_identity',lambda v:v['result'].update(table_id='00000000-0000-0000-0000-000000000001'))
change('foreign_hand_identity',lambda v:v['result'].update(hand_id='00000000-0000-0000-0000-000000000001'))
change('duplicate_user',lambda v:v['result']['request']['stacks'][1].update(user_id=v['result']['request']['stacks'][0]['user_id']))
change('missing_written_user',lambda v:v['result']['written'].pop(next(iter(v['result']['written']))))
change('extra_written_user',lambda v:v['result']['written'].update({'00000000-0000-0000-0000-000000000001':0}))
change('string_nan_stack',lambda v:v['result']['request']['stacks'][0].update(stack_before='NaN'))
change('negative_stack',lambda v:v['result']['request']['stacks'][0].update(stack_before=-1))
change('nonconserved_request',lambda v:v['result']['request']['stacks'][0].update(stack_before=62945))
change('written_disagrees',lambda v:v['result']['written'].update({v['result']['request']['stacks'][0]['user_id']:1}))
change('nonzero_tournament_rake',lambda v:v['result']['request'].update(rake=1))
change('nonzero_outside_inflow',lambda v:v['result'].update(inflow=1))
change('nonzero_net_delta',lambda v:v['result'].update(net_deltas=1))
change('relative_timestamp',lambda v:v.update(completed_at='today'))
change('missing_timestamp',lambda v:v.update(completed_at=None))
change('fractional_hand_number',lambda v:v['result'].update(hand_number=1.5))
change('wrong_player_count',lambda v:v['result'].update(players=3))
change('no_request_players',lambda v:v['result']['request'].update(stacks=[]))
def zero(value):
    for stack in value['result']['request']['stacks']:
        stack.update(stack=0,stack_before=0);value['result']['written'][stack['user_id']]=0
change('zero_total_hand',zero)
all_receipts=query("SELECT jsonb_build_object('accepted',count(*) FILTER(WHERE (fn_ca_accepted_tournament_settlement_fact(to_jsonb(s))->>'ok')::boolean),'refused',count(*) FILTER(WHERE NOT (fn_ca_accepted_tournament_settlement_fact(to_jsonb(s))->>'ok')::boolean)) FROM settlement_idempotency_keys s")
assert all_receipts=={'accepted':440,'refused':0},all_receipts
acl=query("SELECT jsonb_object_agg(role,has_function_privilege(role,'public.fn_ca_accepted_tournament_settlement_fact(jsonb)','EXECUTE')) FROM unnest(ARRAY['anon','authenticated','service_role']) role")
assert not any(acl.values())
pin=query("SELECT jsonb_build_object('body_md5',md5(prosrc),'definition_sha256',encode(extensions.digest(convert_to(pg_get_functiondef(oid),'UTF8'),'sha256'),'hex')) FROM pg_proc WHERE oid='public.fn_ca_accepted_tournament_settlement_fact(jsonb)'::regprocedure")
receipt={'sourceCase':'D10 exact accepted hand8215053','sourceFact':valid,'originalReceiptCounts':all_receipts,'negativeCases':cases,'negativeCaseCount':len(cases),'ordinaryExecute':acl,'sourcePin':pin,'noDataMutations':True}
(base/'accepted-fact-test-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'negativeCases':len(cases),'originalReceiptCounts':all_receipts,'sourcePin':pin}))
