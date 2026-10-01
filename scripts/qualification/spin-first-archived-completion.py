"""E-only unqualified pure completion witness validator. No execution/allocator.
Never feeds completion observations to the PZ002 parser or claims an abort.
"""
from pathlib import Path
import importlib.util,json,hashlib,datetime,re
from decimal import Decimal
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
READBACK=(HERE/'fixtures/archived-spin/first-postcompletion-readback.sql').read_text()
CHECKS=frozenset(re.findall(r"^'([a-z0-9_]+)',",READBACK[READBACK.index("'checks',jsonb_build_object(")+len("'checks',jsonb_build_object("):READBACK.index("),'qualification_limit'")],re.M))
def require(x,msg):
 if not x:raise ValueError(msg)
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def modules():
 return load('completion_accounts',HERE/'spin-first-archived.py'),load('completion_protocol',HERE/'spin-first-archived-production-probe.py'),load('completion_post_reference',HERE/'spin-first-archived-postabort.py')
def stamp(value):
 require(isinstance(value,str),'timestamp absent')
 m=re.fullmatch(r'([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}(?::?[0-9]{2})?)',value)
 require(m is not None,'timestamp encoding malformed')
 date,clock,fraction,zone=m.groups()
 if zone=='Z':zone='+00:00'
 elif len(zone)==3:zone+=':00'
 elif len(zone)==5:zone=zone[:3]+':'+zone[3:]
 require(int(zone[1:3])<24 and int(zone[4:6])<60,'timestamp timezone offset malformed')
 normalized=date+'T'+clock+('.'+fraction.ljust(6,'0') if fraction else '')+zone
 d=datetime.datetime.fromisoformat(normalized);require(d.tzinfo is not None,'timestamp zone absent');return d
def validate(envelope,after):
 A,P,Q=modules();B=P.BANK
 fields={'kind','operation','event','source_sha256','transaction_id','transaction_started_at','inside_observed_at','final_observed_at','response','before','inside','fee_capture_diagnostic','bank_observations','replay_state','same_operation_response_and_nonbank_replay_unchanged','transaction_will_commit','commit_observed','sequence_rollback_claimed','production_settlement_complete'}
 require(isinstance(envelope,dict) and set(envelope)==fields,'completion envelope inventory differs')
 require(envelope['kind']=='first_archived_completion_before_commit_v1' and envelope['operation']==P.OPERATION and envelope['event']==P.C.EVENT and envelope['source_sha256']==P.C.SOURCE,'completion source/operation identity differs')
 require(envelope['transaction_will_commit'] is True and envelope['commit_observed'] is False and envelope['sequence_rollback_claimed'] is False and envelope['production_settlement_complete'] is False and envelope['same_operation_response_and_nonbank_replay_unchanged'] is True,'completion scope differs')
 top=envelope['transaction_id'];require(B.number(top,2**64)>2,'completion xid malformed')
 fee=P.validate_fee_capture(envelope['fee_capture_diagnostic']);require(fee['transaction_id']==top,'actual fee/complete transaction differs')
 for key in ('before','inside','replay_state'):
  r=envelope[key];require(isinstance(r,dict) and set(r)==Q.SCOPED and all(isinstance(v,list) for v in r.values()),'21 completion rowsets required')
 before,inside,replay=(envelope[k] for k in ('before','inside','replay_state'))
 require(Q.equal({k:v for k,v in inside.items() if k!=B.RELATION},{k:v for k,v in replay.items() if k!=B.RELATION}),'nonbank precommit replay differs')
 B.validate_history(envelope['bank_observations'],top,before[B.RELATION],inside[B.RELATION],replay[B.RELATION])
 admit=inside['smarter_private.spin_archived_first_admission'];leases=inside['public.engine_tournament_leases']
 require(len(admit)==len(leases)==1 and type(admit[0]['admitted_xid']) is int and str(admit[0]['admitted_xid'])==top,'completion admission xid differs')
 a,l=admit[0],leases[0]
 require(a['operation_id']==a['lease_generation']==l['lease_generation']==P.OPERATION and a['tournament_id']==l['tournament_id']==P.C.EVENT and a['source_sha256']==P.C.SOURCE and a['owner_instance']==l['instance_id']=='service:archived-spin-first:'+P.OPERATION and l['engine_version']=='archived-database-projection-v1' and type(l['protocol_version']) is int and l['protocol_version']==2,'completion lease identity differs')
 started,observed,final=(stamp(envelope[k]) for k in ('transaction_started_at','inside_observed_at','final_observed_at'))
 require(stamp(a['admitted_at'])==started and started<=stamp(l['acquired_at'])<=stamp(l['heartbeat_at'])<=observed<=final,'completion lease interval differs')
 require(after['operation_id']==P.OPERATION and Q.equal(after['completion_envelope'],envelope),'durable read bound to other original envelope')
 checks=after['checks'];require(isinstance(checks,dict) and set(checks)==CHECKS and all(v is True for v in checks.values()) and after['all_sql_checks_literal_true'] is True,'durable SQL checks not all literal true')
 require(checks.get('no_fabricated_history') is True and checks.get('actual_completion_committed') is True,'actual history/committed proof absent')
 account_keys=('public.club_members','public.clubs','public.unions','public.union_wallets','public.spin_bonus_pools')
 A.validate_account_delta({k:before[k] for k in account_keys},{k:inside[k] for k in account_keys},bank_observations=envelope['bank_observations'])
 require(len(before['public.club_members'])==len(inside['public.club_members'])==4 and len(inside['public.tables'])==len(inside['public.tournament_terminal_settlements'])==1,'financial cardinality differs')
 A.validate_journal_and_chairs({'reserve_before':before['public.spin_reserve_ledger'],'reserve_after':inside['public.spin_reserve_ledger'],'ledger_before':before['public.chip_ledger'],'ledger_after':inside['public.chip_ledger'],'seats_before':before['public.table_seats'],'seats_after':inside['public.table_seats'],'history_count':0,'atomic_commit_count':0,'terminal':inside['public.tournament_terminal_settlements'][0],'primary_table':inside['public.tables'][0]})
 rows=after['committed_scoped_rows'];require(set(rows)==Q.SCOPED and all(isinstance(v,list) for v in rows.values()),'durable scope differs')
 require(Q.equal(envelope['response'],after['canonical_receipt']),'durable canonical receipt differs')
 for name in Q.SCOPED-{B.RELATION}:require(Q.equal(replay[name],rows[name]),'durable nonbank differs: '+name)
 w=after['committed_bank_witness'];require(set(w)=={'reference_transaction_id','reference_status','observer_transaction_id','snapshot','bank_observation'} and w['reference_transaction_id']==top and w['reference_status']=='committed','actual original completion not committed')
 require(w['observer_transaction_id']==after['observer_transaction_id'],'observer xid differs')
 if w['observer_transaction_id'] is not None:require(B.number(w['observer_transaction_id'],2**64)>2 and w['observer_transaction_id']!=top,'observer is completion writer')
 parts=w['snapshot'].split(':');require(len(parts)==3,'snapshot malformed');xmin=B.number(parts[0],2**64);xmax=B.number(parts[1],2**64);active=[] if not parts[2] else [B.number(x,2**64) for x in parts[2].split(',')]
 require(xmin<=xmax and int(top)<xmax and active==sorted(set(active)) and all(xmin<=x<xmax for x in active) and int(top) not in active,'completion snapshot contradictory')
 obs=w['bank_observation'];require(obs['snapshot_xmax']==parts[1] and Q.equal(B.observation(obs,top),rows[B.RELATION]),'bank projection/version not same statement')
 for r in obs['rows']:require(r['full_xid']!=top and not(r['status']=='committed' and int(r['full_xid']) in active),'own/active writer cannot be external')
 transition=B.pair(envelope['bank_observations'][2],obs,top)
 return {'candidate_only':True,'production_qualified':False,'completion_xid_observed_committed':True,'bank_transition':transition,'durable_nonbank_rowsets_exact':20,'fee_accounting_complete':False,'oldest_alert_complete':False,'sequence_rollback_claimed':False}

SQL='scripts/qualification/fixtures/archived-spin/first-canonical-completion.sql'
SQL_SHA='24318112458ac4dba4f6a8a45f3682954eae5b9c0ff26cb520a5d98175426b66'
READBACK_SHA='c38cfec5e1cceabdb61a24a0f2869c84e367f72e3dfffa4ce461d2f4f9e418e9'

def encode(value):
 if isinstance(value,Decimal):require(value.is_finite(),'nonfinite binding');return str(value)
 if isinstance(value,dict):return '{'+','.join(json.dumps(k)+':'+encode(v) for k,v in value.items())+'}'
 if isinstance(value,list):return '['+','.join(encode(v) for v in value)+']'
 return json.dumps(value,allow_nan=False)

def parse_original(raw,*,native=False):
 A,P,Q=modules()
 require(isinstance(raw,str) and not re.search(r'(?:ERROR|WARNING|FATAL|PANIC):',raw),'completion unexpected failure')
 if native:A.validate_fee_notice('\n'.join(x for x in raw.splitlines() if 'NOTICE:' in x))
 else:require('NOTICE:' not in raw,'management NOTICE handling must remain explicit')
 lines=[x for x in raw.splitlines() if x.startswith('{')]
 require(len(lines)==1,'completion result missing or duplicated')
 d=Q.decode_json(lines[0]);require(isinstance(d,dict) and d.get('kind')=='first_archived_completion_before_commit_v1','not a genuine completion envelope')
 return d

def bind(envelope):
 require(hashlib.sha256(READBACK.encode()).hexdigest()==READBACK_SHA,'readback source drift')
 require(READBACK.count('__VERIFIED_COMPLETION_ENVELOPE_JSON__')==1,'completion binding placeholder differs')
 payload=encode(envelope);require('$completion$' not in payload,'completion dollar delimiter collision')
 return READBACK.replace('__VERIFIED_COMPLETION_ENVELOPE_JSON__',payload)

def validate_native(c):
 A,P,Q=modules();R=P.C.load('completion_session_types',ROOT/P.C.SESSION)
 cases=load('completion_case_validator',HERE/'spin-first-archived-completion-cases.py')
 return cases.validate(c,type('CompletionAPI',(),dict(globals())),P,A,R)

def run(e,worker,observer,snapshot,external=None,kind='original',deadline=None):
 A,P,Q=modules();R=P.C.load('completion_session_types_runtime',ROOT/P.C.SESSION)
 cases=load('completion_case_runtime',HERE/'spin-first-archived-completion-cases.py')
 return cases.run(e,worker,observer,external,snapshot,type('CompletionAPI',(),dict(globals())),P,A,R,kind,deadline)
