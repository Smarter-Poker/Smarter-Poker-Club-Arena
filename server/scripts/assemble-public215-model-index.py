#!/usr/bin/env python3
"""Finite post-training index assembly; never trains, captures, approves or freezes.
Prepare requires four actual successful terminal records. Finalize additionally
compares every Linux feature/head/output word to original sklearn references.
All model admission delegates to the pinned maintained nine-file Hub codec.
"""
from __future__ import annotations
import argparse,hashlib,importlib,json,os,sys,uuid
from pathlib import Path
SHA=lambda b:hashlib.sha256(b).hexdigest()
BASE={'format','dataset_id','pipeline_root','pipeline_source_lock','manifest','input_root','training_authority','training_terminal'}
FRAGMENT={'format','context_id','context','dataset_id','public_model','model_checksum','public_training_provenance','training_provenance_checksum','training_authority_checksum','sklearn_reference_cases','status'}
REFERENCE={'board','own','features_f64','raw_heads_f64','policy_ev_f64','Q_f64','frequency_f64'}
VECTOR_LENGTHS={'features_f64':215}
def need(value,why):
 if not value:raise ValueError('PUBLIC215_INDEX_'+why)
def exact(value,keys):need(isinstance(value,dict)and set(value)==set(keys),'EXACT_KEYS');return value
def valid_sha(v):return isinstance(v,str)and len(v)==64 and v!='0'*64 and all(c in'0123456789abcdef'for c in v)
def pinned(f,limit=512*1024*1024):
 exact(f,{'path','sha256'});p=Path(f['path']);need(p.is_absolute()and p.resolve(strict=True)==p and not any(x.startswith('.env')for x in p.parts)and valid_sha(f['sha256']),'CANONICAL_PINNED_FILE')
 with p.open('rb')as src:b=src.read(limit+1)
 need(len(b)<=limit and SHA(b)==f['sha256'],'FILE_BYTES');return b
def load(f,limit=512*1024*1024):
 def pairs(items):
  need(len({key for key,_ in items})==len(items),'DUPLICATE_JSON_KEY');return dict(items)
 def constant(value):raise ValueError('PUBLIC215_INDEX_NONFINITE_JSON')
 return json.loads(pinned(f,limit),object_pairs_hook=pairs,parse_constant=constant)
def actual_exit(value,index,output):
 need(isinstance(value,dict)and type(value.get('exit_code'))is int and value['exit_code']==0 and type(value.get('shard_index'))is int and value['shard_index']==index and value.get('output')==output,'ACTUAL_SHARD_TERMINAL0')
def validate_terminal(receipt,dataset,authority,contexts):
 exact(receipt,{'format','dataset_id','training_authority_checksum','workers'})
 need(receipt['format']=='public_hist215_final_M1_training_terminal_v1'and receipt['dataset_id']==dataset and receipt['training_authority_checksum']==authority and isinstance(receipt['workers'],list)and len(receipt['workers'])==4,'FOUR_ACTUAL_TERMINALS')
 workers={};owned=set()
 for worker in receipt['workers']:
  exact(worker,{'shard_index','exit_code','output','result','exit_receipt'});i=worker['shard_index']
  need(type(i)is int and i in range(4)and i not in workers and type(worker['exit_code'])is int and worker['exit_code']==0 and isinstance(worker['output'],str)and Path(worker['output']).is_absolute(),'TERMINAL_SHARD_IDENTITY')
  actual_exit(load(worker['exit_receipt'],1024*1024),i,worker['output'])
  need(Path(worker['result']['path'])==Path(worker['output'])/'result.json','ACTUAL_RESULT_PATH')
  result=load(worker['result'],4*1024*1024);exact(result,{'format','status','dataset_id','training_authority_checksum','shard_index','shard_count','context_ids','files','qualityCertified','M2_labels_read'})
  expected=sorted(contexts)[i::4]
  need(result['format']=='public_hist215_final_M1_training_v1'and result['status']=='finite_final_M1_model_fragments_UNQUALIFIED'and result['dataset_id']==dataset and result['training_authority_checksum']==authority and type(result['shard_index'])is int and result['shard_index']==i and type(result['shard_count'])is int and result['shard_count']==4 and result['context_ids']==expected and result['qualityCertified']is False and result['M2_labels_read']is False,'TRAINER_RESULT_IDENTITY')
  need(isinstance(result['files'],list)and len(result['files'])==len(expected),'SHARD_FRAGMENT_CENSUS')
  need([f.get('context_id')for f in result['files']]==expected,'EXACT_SHARD_CONTEXT_ORDER')
  for f in result['files']:
   exact(f,{'context_id','file','sha256'});cid=f['context_id'];need(f['file']==cid+'.json'and cid not in owned and valid_sha(f['sha256']),'FRAGMENT_PATH_OR_SHA');owned.add(cid)
  workers[i]=(worker,result)
 need(set(workers)==set(range(4))and owned==set(contexts),'COMPLETE_DISJOINT_CONTEXT_OWNERSHIP');return workers

def compare_reference_cases(reference,receipt_cases,actions,approved,decode):
 need(isinstance(reference,list)and isinstance(receipt_cases,list)and len(reference)==len(receipt_cases)==len(approved)and 2<=len(reference)<=32,'REFERENCE_CASE_CENSUS')
 for ref,actual,case in zip(reference,receipt_cases,approved):
  exact(ref,REFERENCE);need(isinstance(actual,dict)and {'board','own'}<=set(actual),'ACTUAL_CASE')
  need({'board':ref['board'],'own':ref['own']}==case=={'board':actual['board'],'own':actual['own']},'REFERENCE_CASE_IDENTITY')
  for key,size in [('features_f64',215),('raw_heads_f64',1+2*actions),('Q_f64',actions),('frequency_f64',actions)]:
   need(isinstance(ref[key],list)and len(ref[key])==size and isinstance(actual.get(key),list)and len(actual[key])==size,'REFERENCE_VECTOR_SHAPE')
   for word in ref[key]:decode(word)
  decode(ref['policy_ev_f64'])
  # Exact IEEE words, including -0 and subnormals. No tolerance or head mixing.
  need(all(ref[key]==actual.get(key)for key in REFERENCE),'ORIGINAL_SKLEARN_PUBLIC_FEATURE_AND_ALL_HEAD_PARITY')

def import_pipeline(config):
 root=Path(config['pipeline_root']);need(root.is_absolute()and root.resolve(strict=True)==root,'PIPELINE_ROOT');lock=load(config['pipeline_source_lock'],16*1024*1024);exact(lock,{'format','files'});need(lock['format']=='public_hist215_encoder_source_graph_v1'and isinstance(lock['files'],list)and lock['files'],'PIPELINE_SOURCE_GRAPH')
 files={}
 for f in lock['files']:pinned(f,16*1024*1024);need(f['path']not in files,'DUPLICATE_SOURCE_PIN');files[f['path']]=f['sha256']
 for name in ['contract.py','public_hist215.py']:need(str(root/name)in files,'PROTECTED_CODEC_SOURCE_PIN')
 sys.path.insert(0,str(root));contract=importlib.import_module('contract');codec=importlib.import_module('public_hist215')
 for module in [contract,codec]:need(Path(module.__file__).resolve().parent==root,'CODEC_IMPORT_ORIGIN')
 return contract,codec

def new_bytes(path,payload):
 temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.partial')
 with temporary.open('xb')as dst:dst.write(payload);dst.flush();os.fsync(dst.fileno())
 try:os.link(temporary,path)
 finally:temporary.unlink()
 fd=os.open(path.parent,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
 return SHA(payload)
def validate_then_publish(path,index,manifest,dataset,codec,prepare):
 payload=codec.canonical_bytes(index);checksum=SHA(payload);temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.validation-partial')
 with temporary.open('xb')as dst:dst.write(payload);dst.flush();os.fsync(dst.fileno())
 try:
  codec.load_model_build_index(temporary,expected_checksum=checksum,dataset_id=dataset,manifest=manifest,prepare_only=prepare)
  os.link(temporary,path)
 finally:temporary.unlink()
 fd=os.open(path.parent,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
 return checksum

def assemble(mode,config,config_sha,output):
 exact(config,BASE|({'prepared','linux_results'}if mode=='finalize'else set()))
 need(config['format']=='public_hist215_model_index_assembly_v1'and mode in['prepare','finalize'],'CONFIG_MODE')
 contract,codec=import_pipeline(config);need(codec.UUID.fullmatch(config['dataset_id']),'DATASET_UUID')
 pinned(config['manifest'],16*1024*1024)
 manifest=contract.load_manifest(config['manifest']['path'],expected_checksum=config['manifest']['sha256'],input_root=config['input_root'],pipeline_root=config['pipeline_root'])
 raw={**manifest.raw,'_actual_manifest_checksum':manifest.checksum};need(raw.get('policy_representation')=='public_hist215_v1','APPROVED_PUBLIC215_MANIFEST')
 authority=load(config['training_authority'],4*1024*1024);exact(authority,{'format','status','dataset_id','manifest_checksum','input_bundle_checksum','capture_index_checksum','public_feature_index_checksum','trainer_source_checksum','encoder_source_lock_path','encoder_source_lock_checksum','dependency_lock_checksum','whole_variant','python_version','numpy_version','sklearn_version','allow_final_M1_fit','shard_count'});pinned({'path':str(Path(config['pipeline_root'])/'final_public215_training.py'),'sha256':authority['trainer_source_checksum']},1024*1024);need(authority.get('dataset_id')==config['dataset_id']and authority.get('manifest_checksum')==manifest.checksum and authority.get('input_bundle_checksum')==raw['input_bundle_checksum']and authority.get('format')=='public_hist215_final_M1_training_v1'and authority.get('status')=='FROZEN_BEFORE_FIRST_FINAL_M1_FIT'and authority.get('allow_final_M1_fit')is True and authority.get('shard_count')==4,'ACTUAL_TRAINING_AUTHORITY')
 recipe=raw['public215_protocols']['training_recipe'];need(authority['public_feature_index_checksum']==recipe.get('public_feature_index_checksum')and authority['dependency_lock_checksum']==codec.digest(raw['public215_protocols']['dependency_lock']),'APPROVED_FEATURE_INDEX_AND_DEPENDENCY_AUTHORITY')
 encoder_lock=load({'path':authority['encoder_source_lock_path'],'sha256':authority['encoder_source_lock_checksum']},16*1024*1024);exact(encoder_lock,{'format','files'});need(encoder_lock['format']=='public_hist215_encoder_source_graph_v1','ACTUAL_ENCODER_SOURCE_GRAPH')
 for source in encoder_lock['files']:pinned(source,16*1024*1024)
 metadata={codec.digest(g['context']):g for g in raw['public215_contexts']};need(len(metadata)==107,'EXACT107');terminal=load(config['training_terminal'],4*1024*1024);workers=validate_terminal(terminal,config['dataset_id'],config['training_authority']['sha256'],metadata)
 templates={}
 for f in raw['public215_template_files']:
  path=Path(config['input_root'])/f['path'];templates[f['checksum']]=load({'path':str(path),'sha256':f['checksum']},1024*1024)
 cases={codec.digest(g['context']):g['cases']for g in raw['public215_protocols']['runtime_parity_protocol']['contexts']};models={};references={};requests={};fragment_pins={};global_authority=None;global_sources=[];source_keys=set();artifact_shas={}
 for worker,result in workers.values():
  for file in result['files']:
   cid=file['context_id'];fragment_file={'path':str(Path(worker['output'])/file['file']),'sha256':file['sha256']};fragment=load(fragment_file,12*1024*1024);exact(fragment,FRAGMENT)
   need(fragment['format']=='public_hist215_final_M1_fragment_v1'and fragment['context_id']==cid and codec.digest(fragment['context'])==cid and fragment['context']==metadata[cid]['context']and fragment['dataset_id']==config['dataset_id']and fragment['training_authority_checksum']==config['training_authority']['sha256']and fragment['status']=='UNQUALIFIED_REQUIRES_ACTUAL_LINUX_BUILD_PARITY_AND_SQL','ACTUAL_FRAGMENT_IDENTITY')
   model=fragment['public_model'];provenance=fragment['public_training_provenance'];codec.serialize_training_provenance(provenance,expected_sha256=fragment['training_provenance_checksum'])
   need(provenance['encoder_checksum']==codec.digest(encoder_lock),'ACTUAL_ENCODER_GRAPH_PROVENANCE')
   need(provenance['parameters']==codec.FROZEN_PARAMETERS and provenance['source_count']==57 and provenance['board_count']==57 and provenance['whole_variant']==authority['whole_variant']==raw['public215_protocols']['training_recipe']['whole_variant'],'FROZEN_PARAMETERS_AND_WHOLE_VARIANT')
   for source in provenance['sources']:
    source_key=(source['source_row_id'],source['source_node']);need(source_key not in source_keys,'DUPLICATE_GLOBAL_CAPTURE_NODE');source_keys.add(source_key)
    previous=artifact_shas.setdefault(source['source_row_id'],source['artifact_checksum']);need(previous==source['artifact_checksum'],'GLOBAL_SOURCE_ARTIFACT_IDENTITY');global_sources.append(source)
   shared={k:provenance[k]for k in['approved_input_bundle_id','input_bundle_checksum','manifest_checksum','capture_receipt_checksum','training_recipe_checksum','source_partition_checksum','feature_schema_checksum','encoder_checksum','physics_checksum','dependency_lock_checksum','runtime_parity_protocol_checksum','whole_variant']}
   need(global_authority is None or shared==global_authority,'ONE_GLOBAL_CAPTURE_RECIPE_VARIANT');global_authority=shared
   entry={'context':fragment['context'],'policy_representation':'public_hist215_v1','public_model':model,'public_template':templates[metadata[cid]['template_checksum']],'public_training_provenance':provenance,'model_checksum':fragment['model_checksum'],'template_checksum':metadata[cid]['template_checksum'],'feature_schema_checksum':metadata[cid]['feature_schema_checksum'],'training_provenance_checksum':fragment['training_provenance_checksum']}
   ref=fragment['sklearn_reference_cases'];compare_reference_cases(ref,ref,len(model['action_ids']),cases[cid],codec.decode_f64)
   models[cid]=entry;references[cid]=ref;fragment_pins[cid]=fragment_file
   requests[cid]={'format':'public_hist215_preflight_request_v1','dataset_id':config['dataset_id'],'program':entry,'cases':cases[cid]}
   need(len(codec.canonical_bytes(requests[cid]))<=4*1024*1024,'ACTUAL_PREFLIGHT_REQUEST_4MIB')
 need(len(global_sources)==6099 and len(source_keys)==6099 and codec.digest(sorted(global_sources,key=lambda source:(source['source_row_id'],source['source_node'])))==global_authority['capture_receipt_checksum'],'COMPLETE6099_GLOBAL_SQL_CAPTURE_RECEIPT')
 order=sorted(metadata,key=lambda cid:codec.canonical_bytes(metadata[cid]['context']))
 index={'format':'public_hist215_prepare_index_v1','dataset_id':config['dataset_id'],'models':[models[c]for c in order]}
 ref_index={'format':'public_hist215_original_sklearn_reference_index_v1','dataset_id':config['dataset_id'],'training_authority_checksum':config['training_authority']['sha256'],'training_terminal_sha256':config['training_terminal']['sha256'],'contexts':[{'context_id':cid,'fragment':fragment_pins[cid],'references':references[cid],'request_sha256':codec.digest(requests[cid])}for cid in order]}
 if mode=='finalize':
  exact(config['prepared'],{'index','references','receipt'});prepared=load(config['prepared']['index']);need(prepared==index,'PREPARED_MODELS_UNCHANGED');need(load(config['prepared']['references'])==ref_index,'ORIGINAL_SKLEARN_REFERENCES_UNCHANGED')
  prior=load(config['prepared']['receipt'],4*1024*1024);need(prior.get('format')=='public_hist215_model_index_assembly_receipt_v1'and prior.get('mode')=='prepare'and prior.get('dataset_id')==config['dataset_id']and prior.get('source_sha256')==SHA(Path(__file__).read_bytes())and prior.get('manifest_sha256')==manifest.checksum and prior.get('pipeline_source_lock_sha256')==config['pipeline_source_lock']['sha256']and prior.get('index_sha256')==config['prepared']['index']['sha256']and prior.get('references_sha256')==config['prepared']['references']['sha256']and prior.get('training_terminal_sha256')==config['training_terminal']['sha256']and prior.get('training_authority_sha256')==config['training_authority']['sha256'],'PREPARED_RECEIPT_BINDINGS')
  need(isinstance(config['linux_results'],list)and len(config['linux_results'])==107,'EXACT107_LINUX_RESULTS');seen=set()
  for item in config['linux_results']:
   exact(item,{'context_id','request_sha256','result','exit_receipt'});cid=item['context_id'];need(cid in models and cid not in seen and item['request_sha256']==codec.digest(requests[cid]),'ACTUAL_LINUX_REQUEST');seen.add(cid)
   terminal=load(item['exit_receipt'],1024*1024);need(isinstance(terminal,dict)and type(terminal.get('exit_code'))is int and terminal['exit_code']==0 and terminal.get('context_id')==cid and terminal.get('request_sha256')==item['request_sha256'],'ACTUAL_LINUX_TERMINAL0')
   result=load(item['result'],4*1024*1024);exact(result,{'format','receipt','receipt_checksum','execution_ms_f64','peak_rss_bytes'});need(result['format']=='public_hist215_preflight_result_v1'and codec.decode_f64(result['execution_ms_f64'])>0 and type(result['peak_rss_bytes'])is int and 0<result['peak_rss_bytes']<2**53,'ACTUAL_LINUX_RESULT')
   entry=models[cid];receipt=result['receipt'];codec.serialize_build_receipt(receipt,expected_sha256=result['receipt_checksum'],model=entry['public_model'],provenance=entry['public_training_provenance'],dataset_id=config['dataset_id'],approved_cases=cases[cid])
   compare_reference_cases(references[cid],receipt['cases'],len(entry['public_model']['action_ids']),cases[cid],codec.decode_f64)
   entry['public_model_build_receipt']=receipt;entry['model_build_receipt_checksum']=result['receipt_checksum']
  need(seen==set(metadata),'ALL107_LINUX_TERMINAL_PARITY');index['format']='public_hist215_build_index_v1'
 output=Path(output);need(output.is_absolute()and output.parent.resolve(strict=True)==output.parent and not output.exists(),'NEW_EXCLUSIVE_OUTPUT');output.mkdir()
 checksum=validate_then_publish(output/'model-index.json',index,raw,config['dataset_id'],codec,mode=='prepare')
 references_sha=new_bytes(output/'original-sklearn-references.json',codec.canonical_bytes(ref_index))
 if mode=='prepare':
  (output/'linux-requests').mkdir()
  for cid in order:new_bytes(output/'linux-requests'/(cid+'.json'),codec.canonical_bytes(requests[cid]))
 receipt={'format':'public_hist215_model_index_assembly_receipt_v1','mode':mode,'dataset_id':config['dataset_id'],'config_sha256':config_sha,'source_sha256':SHA(Path(__file__).read_bytes()),'pipeline_source_lock_sha256':config['pipeline_source_lock']['sha256'],'manifest_sha256':manifest.checksum,'training_authority_sha256':config['training_authority']['sha256'],'training_terminal_sha256':config['training_terminal']['sha256'],'index_sha256':checksum,'references_sha256':references_sha,'contexts':107,'status':'PRIVATE_PREPARE_ONLY_NOT_MODEL_FREEZE'if mode=='prepare'else'ALL107_ORIGINAL_SKLEARN_PARITY_CHECKED_NOT_SQL_CERTIFICATION_OR_FREEZE','qualityCertified':False,'M2_labels_read':False}
 new_bytes(output/'assembly-receipt.json',codec.canonical_bytes(receipt));return receipt

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['prepare','finalize']);p.add_argument('--config',required=True);p.add_argument('--config-sha256',required=True);p.add_argument('--output',required=True);a=p.parse_args();print(json.dumps(assemble(a.mode,load({'path':a.config,'sha256':a.config_sha256}),a.config_sha256,a.output),sort_keys=True))
if __name__=='__main__':main()
