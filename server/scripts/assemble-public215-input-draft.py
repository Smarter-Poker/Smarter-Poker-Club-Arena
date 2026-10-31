#!/usr/bin/env python3
"""Finite public-only input DRAFT; never approves, captures, selects M2 or fits.

Uses the protected producer's validators. The only zero identities are the
documented prepare_bundle.py input-bundle draft placeholders. ROOT invokes
that existing preparer separately after inspecting the resulting draft.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

PROTOCOLS = {'training_recipe','source_partition','runtime_parity_protocol','dependency_lock','physics_protocol','feature_schema'}
PARTITION_SHA = '8440d9613fe3013b82f8a1d76150499fbbcb4bf87ee9af0bf4bc8a63430d5427'
SELECTION_SHA = '973a54525509685a3533e984f9a147087fd16e9620e6a4c2ba77d315728f3797'
R6_SHA = '3ce35b5cfa4297575ff37c9583091056cd52bfde832afc861741829f291f1269'
PRODUCER = '291a8e5658b6a706066b39fba6c75a714f578695'
RANKS = '23456789TJQKA'
DECK = {r+s for r in RANKS for s in 'cdhs'}
sha = lambda b: hashlib.sha256(b).hexdigest()

def need(value, label):
    if not value: raise ValueError('PUBLIC215_DRAFT_'+label)

def exact(value, keys):
    need(isinstance(value,dict) and set(value)==set(keys),'EXACT_KEYS')
    return value

def checked(receipt):
    exact(receipt, {'path','sha256'})
    p=Path(receipt['path'])
    need(p.is_absolute() and p.resolve(strict=True)==p and not any(x.startswith('.env') for x in p.parts),'CANONICAL_PUBLIC_FILE')
    data=p.read_bytes();need(sha(data)==receipt['sha256'],'ACTUAL_BYTES')
    return data

def parsed(receipt):
    def pairs(items):
        result={}
        for k,v in items:
            need(k not in result,'DUPLICATE_JSON_KEY');result[k]=v
        return result
    return json.loads(checked(receipt),object_pairs_hook=pairs,parse_constant=lambda _:need(False,'NONFINITE_JSON'))

def board_cards(board):
    need(isinstance(board,str) and len(board) in (6,8,10),'BOARD_SIZE')
    cards=[board[i:i+2] for i in range(0,len(board),2)]
    need(len(set(cards))==len(cards) and set(cards)<=DECK,'LEGAL_BOARD')
    return cards

def remap_scenario(source, board, namespace, ordinal):
    """Existing public author remap: chronological token substitution only.

    Mirrors materialize_full_public_domain.py/remap; ROOT flop and native
    turn/river tokens are distinct. Numeric action tokens never change.
    """
    s=copy.deepcopy(source);need(len(s['targets'])==1,'SINGLE_TARGET')
    t=s['targets'][0];old=board_cards(t['board']);new=board_cards(board)
    need(len(old)==len(new),'SAME_STREET')
    tokens=t['node'].split(':')
    need([v for v in tokens if v in DECK]==old[3:],'CHRONOLOGICAL_NODE_RUNOUT')
    mapping=dict(zip(old,new));t['node']=':'.join(mapping.get(v,v) for v in tokens)
    s['flop_board']=board[:6];t['board']=board;t['machine_id']='M2'
    sid='r7f.m2.'+uuid.UUID(namespace).hex+'.'+str(ordinal).zfill(5)
    s['scenario_id']=sid;t['target_id']=sid+'.target'
    if 'conditional_history' in s:s['conditional_history']['target_node']=t['node']
    need([v for v in t['node'].split(':') if v in DECK]==new[3:],'REMAPPED_RUNOUT')
    return s

def new_file(root, relative, data):
    p=Path(relative);need(not p.is_absolute() and '..' not in p.parts and p.parts and not any(x.startswith('.env') for x in p.parts),'SAFE_RELATIVE_FILE')
    dest=root/p;dest.parent.mkdir(parents=True,exist_ok=True)
    with dest.open('xb') as out:out.write(data);out.flush();os.fsync(out.fileno())
    need(sha(dest.read_bytes())==sha(data),'OUTPUT_READBACK')
    return {'path':p.as_posix(),'checksum':sha(data)}

def assemble(config, output, config_sha):
    exact(config,{'format','pipeline_root','pipeline_commit','original_manifest','original_input_root','target_plan','context_metadata','templates_root','protocol_files','source_namespace','dataset_key','manifest_version','bundle_key','bundle_version','approval_note'})
    need(config['format']=='public_hist215_official_input_draft_request_v1' and config['pipeline_commit']==PRODUCER,'PROTECTED_PRODUCER')
    pipeline=Path(config['pipeline_root']);need(pipeline.is_absolute() and pipeline.resolve(strict=True)==pipeline,'PIPELINE_PATH')
    need(subprocess.run(['git','rev-parse','HEAD'],cwd=pipeline,check=True,capture_output=True,text=True).stdout.strip()==PRODUCER,'ACTUAL_PRODUCER_HEAD')
    sys.path.insert(0,str(pipeline/'scripts/horse-solver-v31'))
    contract=importlib.import_module('contract');codec=importlib.import_module('public_hist215');pio=importlib.import_module('pio_upi');prepare=importlib.import_module('prepare_bundle')
    for m in (contract,codec,pio,prepare):need(Path(m.__file__).resolve().parent==pipeline/'scripts/horse-solver-v31','IMPORT_ORIGIN')
    original=parsed(config['original_manifest']);need(config['original_manifest']['sha256']==R6_SHA,'ORIGINAL_R6_IDENTITY')
    root=Path(config['original_input_root']);need(root.is_absolute() and root.resolve(strict=True)==root,'BASELINE_ROOT')
    # Complete public baseline dependencies are validated by maintained source.
    range_files=contract._range_bundle(root,original);models=contract._icm_models(root,original)
    plan=parsed(config['target_plan']);metadata=parsed(config['context_metadata']);contexts=metadata['public215_contexts'];codec.validate_context_metadata(contexts)
    need(plan['format']=='public_hist215_final_M1_public_target_plan_v1' and plan['source_namespace']==config['source_namespace'] and len(plan['entries'])==6099 and len(contexts)==107,'EXACT_PLAN_CENSUS')
    need(str(uuid.UUID(config['source_namespace']))==config['source_namespace'],'CANONICAL_NAMESPACE')
    exact(config['protocol_files'],PROTOCOLS);protocols={k:parsed(v) for k,v in config['protocol_files'].items()}
    for k,v in protocols.items():need(checked(config['protocol_files'][k])==codec.canonical_bytes(v),'CANONICAL_PROTOCOL_BYTES')
    codec.validate_protocols(protocols,contexts)
    partition=protocols['source_partition'];selection=partition['m2_selection']
    need(codec.digest(partition)==PARTITION_SHA==plan['source_partition_checksum'] and codec.digest(selection)==SELECTION_SHA,'FROZEN_PUBLIC_DOMAIN')
    need(protocols['runtime_parity_protocol']==metadata['runtime_parity_protocol'],'DECLARED_RUNTIME_CASES')
    declared={codec.digest(c['context']):c for c in contexts};sources={};m1=[];seen=set();counts={cid:0 for cid in declared}
    for e in plan['entries']:
        s=copy.deepcopy(e['scenario']);t=s['targets'][0];cid=e['context_id']
        need(cid in declared and t['machine_id']=='M1' and s.get('purpose')=='harvest' and len(s['targets'])==1,'M1_SCENARIO')
        need((s['scenario_id'],t['target_id'],t['board'],t['node'])==(e['scenario_id'],e['target_id'],e['board'],e['source_node']),'M1_EXACT_PLAN_IDENTITY')
        need(pio.target_context(s,t)==declared[cid]['context'] and t['expected_children']==declared[cid]['expected_children'],'M1_CONTEXT_ACTION_ORDER')
        contract._validate_scenario(s,len(m1),root,range_files,models,True)
        need(t['target_id'] not in seen,'UNIQUE_M1');seen.add(t['target_id']);sources.setdefault(cid,s);counts[cid]+=1;m1.append(s)
    need(all(n==57 for n in counts.values()) and len(seen)==6099,'EXACT57_EACH')
    groups=selection['contexts'];need(len(groups)==107 and {g['context_id'] for g in groups}==set(declared),'M2_CONTEXT_CENSUS')
    need([g['context_id'] for g in groups]==sorted(declared),'FROZEN_M2_CONTEXT_ORDER')
    m2=[];candidate_pairs=set()
    for g in groups:
        cid=g['context_id'];need(g['context']==declared[cid]['context'],'M2_CONTEXT')
        for candidate in g['candidates']:
            exact(candidate,{'board','rank_signature'});cards=board_cards(candidate['board'])
            signature=str(len(cards))+':'+''.join(sorted(candidate['board'][::2],key=RANKS.index))
            need(signature==candidate['rank_signature'] and (cid,signature) not in candidate_pairs,'UNIQUE_PUBLIC_RANK')
            candidate_pairs.add((cid,signature));s=remap_scenario(sources[cid],candidate['board'],config['source_namespace'],len(m2));t=s['targets'][0]
            need(pio.target_context(s,t)==g['context'] and t['expected_children']==declared[cid]['expected_children'],'M2_RENDERED_CONTEXT_ACTIONS')
            contract._validate_scenario(s,len(m1)+len(m2),root,range_files,models,True);m2.append(s)
    need(len(m2)==2147,'ALL2147_PUBLIC_CANDIDATES')
    tests=[copy.deepcopy(s) for s in original['scenarios'] if s['scenario_id']==original['self_test']['scenario_id']]
    need(len(tests)==1 and tests[0].get('purpose')=='self_test','ORIGINAL_ANALYTIC_SELFTEST')
    manifest=copy.deepcopy(original);manifest.update({'dataset_key':config['dataset_key'],'manifest_version':config['manifest_version'],'pipeline_commit':PRODUCER,'feature_contract_version':'holdem-public-hist215-v1','policy_export_schema':'smarter-poker.pio-policy.v4','pipeline_contract_version':contract.PUBLIC215_PIPELINE_CONTRACT,'policy_representation':'public_hist215_v1','public215_contexts':contexts,'public215_protocols':protocols,'scenarios':m1+m2+tests,'input_bundle_id':prepare.PLACEHOLDER_BUNDLE_ID,'input_bundle_checksum':prepare.ZERO_CHECKSUM})
    manifest['pipeline_files']=[{'path':p,'checksum':sha((pipeline/p).read_bytes())} for p in sorted(contract.PUBLIC215_PIPELINE_FILES)]
    manifest['pipeline_bundle_checksum']=contract.pipeline_bundle_checksum(pipeline,manifest['pipeline_files'],expected_files=contract.PUBLIC215_PIPELINE_FILES)
    out=Path(output);need(out.is_absolute() and out.parent.resolve(strict=True)==out.parent and not out.exists(),'NEW_CANONICAL_OUTPUT');out.mkdir()
    files={original[k+'_path']:original[k+'_checksum'] for k in ('range_bundle','source_combo_order','icm_model')};files.update(range_files)
    bundle=contract._json_bytes(contract._verify_file(root,original['icm_model_path'],original['icm_model_checksum']).read_bytes(),'ICM bundle')
    for model in bundle['models']:files[model['source_snapshot_path']]=model['source_snapshot_checksum']
    for path,checksum in sorted(files.items()):new_file(out,path,contract._verify_file(root,path,checksum).read_bytes())
    templates=Path(config['templates_root']);need(templates.is_absolute() and templates.resolve(strict=True)==templates,'TEMPLATE_ROOT')
    manifest['public215_template_files']=[]
    for cid,c in sorted(declared.items()):
        b=checked({'path':str(templates/(cid+'.json')),'sha256':c['template_checksum']});manifest['public215_template_files'].append(new_file(out,'public215/templates/'+cid+'.json',b))
    manifest['public215_protocol_files']={k:new_file(out,'public215/protocols/'+k+'.json',checked(config['protocol_files'][k])) for k in sorted(PROTOCOLS)}
    prepare.verify_published_pipeline(manifest,pipeline)
    payload=prepare.canonical_json(manifest);receipt=new_file(out,'drafts/public215-r7.DRAFT.json',payload)
    # Pure metadata size forecast only; never writes an approval or calls prepare.
    approval=prepare.base_approval_bundle(manifest,bundle_key=config['bundle_key'],bundle_version=config['bundle_version'],approval_note=config['approval_note'],manifest_path='manifests/public215-r7.json',manifest_checksum='1'*64)
    forecast=prepare.canonical_json(approval);need(len(forecast)<=1000000,'APPROVAL_PAYLOAD_ONE_MB')
    # Read-only full contract validation with a temporary in-memory identity;
    # no approved manifest or approval payload is persisted.
    audit=copy.deepcopy(manifest);audit['input_bundle_checksum']=contract.input_bundle_checksum(approval);audit['input_bundle_id']=contract.input_bundle_id(audit['input_bundle_checksum'])
    codec.validate_manifest_metadata(audit,out,contract.parse_source_combo_order((out/original['source_combo_order_path']).read_text()),verify_inputs=True)
    report={'format':'public_hist215_official_input_DRAFT_receipt_v1','status':'DRAFT_NOT_APPROVED_NOT_CAPTURED','config_sha256':config_sha,'assembler_sha256':sha(Path(__file__).read_bytes()),'manifest':receipt,'pipeline_commit':PRODUCER,'M1_harvest_scenarios':6099,'M2_candidate_scenarios':2147,'self_test_scenarios':1,'total_scenarios':8247,'approval_payload_forecast_bytes':len(forecast),'M2_seed_read':False,'M2_selection_performed':False,'solver_labels_read':False,'capture_authorized':False}
    new_file(out,'draft-assembly-receipt.json',codec.canonical_bytes(report));return report

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',required=True);p.add_argument('--config-sha256',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    print(json.dumps(assemble(parsed({'path':a.config,'sha256':a.config_sha256}),a.output,a.config_sha256),sort_keys=True))
if __name__=='__main__':main()
