"""Pure postabort adjunct, called only AFTER exact original-probe parsing.
No network/database execution. It does not replace fee/caller/financial validation.
"""
from decimal import Decimal
import hashlib
import importlib.util
import json
from pathlib import Path
import re
HERE=Path(__file__).resolve().parent
OBSERVER_SHA='a620e6c8e3c6db5a5d1d37ed2a2d84e5f3caab55aa52c92bdca87c9ec7bcfdd7'
QUERY_SHA='4791de1152451eec22324a962d3c3dae9bc7d45809a8008249dde246749d606d'
OPERATION='341f02a3-4655-420c-b43b-3930b6d9ad8f'
EVENT='2aa4cba1-506f-426b-a1ba-d8e22e018533'

def require(value,message):
    if not value:raise ValueError(message)

p=HERE/'spin-first-archived-bank-observer.py'
require(hashlib.sha256(p.read_bytes()).hexdigest()==OBSERVER_SHA,'observer source drift')
s=importlib.util.spec_from_file_location('postabort_bank_source',p);B=importlib.util.module_from_spec(s);s.loader.exec_module(B)
QUERY=(HERE/'fixtures/archived-spin/first-postabort-bank-readback.sql').read_text()
require(hashlib.sha256(QUERY.encode()).hexdigest()==QUERY_SHA,'query source drift')
SCOPED=frozenset(re.findall(r"^'((?:public|smarter_private)\.[^']+)',",QUERY,re.M))
AUTHORITY=frozenset(re.findall(r"'([^']+)',NOT EXISTS",QUERY)) - {'admission_empty','tournament_lease_absent'}
require(len(SCOPED)==23 and len(AUTHORITY)==18,'draft query inventory differs')

def equal(a,b):
    if isinstance(a,bool) or isinstance(b,bool):return type(a) is bool and type(b) is bool and a is b
    if type(a) in (int,Decimal) and type(b) in (int,Decimal):
        return Decimal(a).is_finite() and Decimal(b).is_finite() and a==b
    if type(a) is not type(b):return False
    if isinstance(a,dict):return set(a)==set(b) and all(equal(a[k],b[k]) for k in a)
    if isinstance(a,list):return len(a)==len(b) and all(equal(x,y) for x,y in zip(a,b))
    return a==b

def decode_json(raw):
    def unique(pairs):
        d={}
        for k,v in pairs:
            require(k not in d,'duplicate JSON key');d[k]=v
        return d
    def invalid(value):raise ValueError('nonfinite JSON token '+value)
    return json.loads(raw,parse_float=Decimal,object_pairs_hook=unique,parse_constant=invalid)

def original_xid(detail):
    require(detail['operation']==OPERATION and detail['event']==EVENT,'original operation differs')
    top=detail['fee_capture_diagnostic']['transaction_id'];require(B.number(top,2**64)>2,'original xid differs')
    admission=detail['inside']['smarter_private.spin_archived_first_admission']
    require(isinstance(admission,list) and len(admission)==1 and type(admission[0]['admitted_xid']) is int
        and str(admission[0]['admitted_xid'])==top,'original fee/admission xid differs')
    return top

def bind_query(validated_original_detail):
    top=original_xid(validated_original_detail)
    require(QUERY.count('__VERIFIED_ORIGINAL_T__')==1,'xid placeholder count differs')
    return QUERY.replace('__VERIFIED_ORIGINAL_T__',top)

def validate(detail,evidence,expected_preimage,expected_funding):
    top=original_xid(detail)
    required={'observed_at','transaction_id','scoped_rows','original_preimage','original_funding',
        'history_exists','atomic_commit_exists','operation_id','admission_empty','later_authority_absent',
        'tournament_lease_absent','postabort_bank_witness'}
    require(isinstance(evidence,dict) and set(evidence)==required,'single result inventory differs')
    require(evidence['operation_id']==OPERATION and evidence['history_exists'] is False
        and evidence['atomic_commit_exists'] is False and evidence['admission_empty'] is True
        and evidence['tournament_lease_absent'] is True,'postabort authority remains')
    absent=evidence['later_authority_absent']
    require(isinstance(absent,dict) and set(absent)==AUTHORITY and all(v is True for v in absent.values()),'exact18 authority absences not proved')
    require(equal(evidence['original_preimage'],expected_preimage),'original preimage changed')
    require(equal(evidence['original_funding'],expected_funding),'original funding changed')
    rows=evidence['scoped_rows']
    for item in (rows,detail['before'],detail['inside'],detail['replay_state']):
        require(isinstance(item,dict) and set(item)==SCOPED and all(isinstance(v,list) for v in item.values()),'exact23 scoped rowset inventory differs')
    witness=evidence['postabort_bank_witness']
    require(isinstance(witness,dict) and set(witness)=={'reference_transaction_id','reference_status','observer_transaction_id','snapshot','bank_observation'},'postabort witness inventory differs')
    require(witness['reference_transaction_id']==top and witness['reference_status']=='aborted','original transaction not observed aborted')
    observer=witness['observer_transaction_id']
    require(observer==evidence['transaction_id'],'observer identity not bound to same statement')
    if observer is not None:require(B.number(observer,2**64)>2 and observer!=top,'observer transaction invalid')
    require(isinstance(witness['snapshot'],str),'snapshot encoding differs')
    parts=witness['snapshot'].split(':');require(len(parts)==3,'snapshot shape differs')
    xmin=B.number(parts[0],2**64);xmax=B.number(parts[1],2**64)
    require(xmin<=xmax and int(top)<xmax,'postabort snapshot predates original transaction')
    active=[] if not parts[2] else [B.number(x,2**64) for x in parts[2].split(',')]
    require(active==sorted(set(active)) and all(xmin<=x<xmax for x in active) and int(top) not in active,'postabort snapshot still lists original transaction active')
    obs=witness['bank_observation'];require(obs['snapshot_xmax']==parts[1],'snapshot not bound to bank observation')
    history=detail['bank_observations']
    B.validate_history(history,top,detail['before'][B.RELATION],detail['inside'][B.RELATION],detail['replay_state'][B.RELATION])
    require(equal(B.observation(obs,top),rows[B.RELATION]),'bank rowset and version observation disagree')
    for observation in history+[obs]:
        for row in observation['rows']:require(row['full_xid']!=top,'original own version cannot be external')
    for row in obs['rows']:
        require(not(row['status']=='committed' and int(row['full_xid']) in active),'visible version claims an active writer committed')
    transition=B.pair(history[2],obs,top)
    for name in SCOPED-{B.RELATION}:
        require(equal(detail['before'][name],rows[name]),'nonbank durable rows changed: '+name)
    require(rows['smarter_private.spin_archived_first_admission']==[] and rows['public.engine_tournament_leases']==[],'durable operation rows remain')
    require(all(rows.get(name)==[] and detail[stage].get(name)==[] for stage in ('before','inside','replay_state') for name in ('public.accounting_tournament_fee_owner_bases', 'public.accounting_tournament_fee_owner_operations')),'fee owner basis must remain absent')
    return {'bank_transition':transition,'nonbank_rowsets_exact':22,'later_authority_absent':18,
        'original_probe_xid_observed_aborted':True,'single_statement_witness':True,
        'candidate_only':True,'production_qualified':False,'sequence_rollback_claimed':False}


WITNESS_PATH='supabase/components/spin-archived-first-witness.sql'
WITNESS_SHA='69a987d4e7a3808f37bb307d4c5c3aa9a1b1f5a3ad4fa04f8310ec4c64395c7d'

def expected_original(source_root):
    raw=(source_root/WITNESS_PATH).read_bytes()
    require(hashlib.sha256(raw).hexdigest()==WITNESS_SHA,'original manifest source drift')
    parts=raw.decode().split('$original$')
    require(len(parts)==3,'original manifest JSON delimiter differs')
    original=decode_json(parts[1])
    require(original['tournament_id']==EVENT,'original manifest event differs')
    # Match the checksum-pinned owner's returned attestation, not its internal rowset.
    attestation={'preimage_matched':True,'financial_authority':False,
        'evidence_kind':original['evidence_kind'],'source_sha256':original['source_sha256'],
        'tournament_id':original['tournament_id'],'original_atomic_commit':None,
        'first_history':original['original_first_history'],'last_history':original['original_last_history'],
        'original_result':original['original_result']}
    return attestation,original['reviewed_fee_proof']

def validate_receipt(detail,receipt,expected_preimage,expected_funding):
    require(isinstance(receipt,dict) and set(receipt)=={'query','query_sha256','original_output','evidence','validation'},'postabort receipt inventory differs')
    query=bind_query(detail)
    require(receipt['query']==query and receipt['query_sha256']==hashlib.sha256(query.encode()).hexdigest(),'postabort exact bound query differs')
    require(isinstance(receipt['original_output'],str),'postabort original output missing')
    evidence=decode_json(receipt['original_output'].strip())
    require(equal(evidence,receipt['evidence']),'postabort retained original row differs')
    result=validate(detail,evidence,expected_preimage,expected_funding)
    require(equal(result,receipt['validation']),'postabort retained validation differs')
    return result
