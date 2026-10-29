#!/usr/bin/env python3
"""Public planning ONLY: prepare templates/request/immutable fresh target plan.
No matrices, teacher artifacts, M2 seed/selection, solver, approval or fitting.
Imports the pinned maintained producer parser instead of duplicating ROOT rules.
"""
from __future__ import annotations
import argparse,copy,hashlib,importlib,json,os,sys,uuid
from decimal import Decimal
from pathlib import Path

SHA=lambda b:hashlib.sha256(b).hexdigest()
NAMESPACE='6b4ec729-fd3a-43d7-a75b-15fd3bced986'
def need(v,m):
 if not v:raise ValueError('PUBLIC215_REQUEST_'+m)
def exact(v,k):need(isinstance(v,dict)and set(v)==set(k),'EXACT_KEYS');return v
def checked(f):
 exact(f,{'path','sha256'});p=Path(f['path']);need(p.is_absolute()and p.resolve(strict=True)==p and not any(x.startswith('.env')for x in p.parts),'CANONICAL_PUBLIC_PATH');b=p.read_bytes();need(SHA(b)==f['sha256'],'ACTUAL_FILE_SHA');return b
def public_json(f):return json.loads(checked(f))
def fresh_ids(namespace,ordinal):
 u=uuid.UUID(namespace);need(str(u)==namespace and type(ordinal)is int and 0<=ordinal<6099,'SOURCE_NAMESPACE_ORDINAL');s='r7f.m1.'+u.hex+'.'+str(ordinal).zfill(5);return s,s+'.target'
def canonical_context_order(groups,canonical):
 return sorted(groups,key=lambda group:canonical(group['context']))
def range_units(raw):
 text=raw.decode('ascii').strip();values=json.loads(text,parse_float=Decimal,parse_int=Decimal)if text.startswith('[')else[Decimal(v)for v in text.split()]
 scaled=[v*Decimal(10**12)for v in values];need(len(scaled)==1326 and all(v.is_finite()and 0<=v<=10**12 and v==v.to_integral_value()for v in scaled)and any(scaled),'EXACT_ROOT_UNITS');return[int(v)for v in scaled]
def cache_header_and_first(f):
 """Read only metadata and first PUBLIC row; never parse remaining vectors."""
 p=Path(f['path']);need(p.resolve(strict=True)==p,'CACHE_CANONICAL')
 # Full-file SHA is independently checked by the actual matrix consumer. Here
 # hash bytes while retaining only the bounded header/first-row/tail windows.
 h=hashlib.sha256();head=bytearray();tail=b''
 with p.open('rb')as src:
  while b:=src.read(1024*1024):
   h.update(b)
   if len(head)<256*1024:head.extend(b[:256*1024-len(head)])
   tail=(tail+b)[-16384:]
 need(h.hexdigest()==f['sha256'],'CACHE_BYTES')
 marker=b'"rows":[';need(marker in head,'CACHE_ROWS_POSITION');prefix,rowtext=bytes(head).split(marker,1)
 first,_=json.JSONDecoder().raw_decode(rowtext.decode('ascii'))
 anchor=b'],"schema_sha256":';i=tail.rfind(anchor);need(i>=0,'CACHE_CANONICAL_SUFFIX')
 header=json.loads(prefix+tail[i+2:]);return header,{k:v for k,v in first.items()if k!='features'}
def write_new(path,payload):
 temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.partial')
 with temporary.open('xb')as f:f.write(payload);f.flush();os.fsync(f.fileno())
 try:os.link(temporary,path)
 finally:temporary.unlink()
 fd=os.open(path.parent,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
 return SHA(payload)
def assemble(config,output,config_sha256):
 exact(config,{'format','source_namespace','inventory','execution_order','source_partition','original_manifest','input_root','pipeline_root','pipeline_source_lock','encoder_source_lock','physics_protocol','cache_schema','current','terminal'})
 need(config['format']=='public_hist215_feature_request_assembly_v1'and config['source_namespace']==NAMESPACE,'PLANNED_SOURCE_IDENTITY')
 pipeline=Path(config['pipeline_root']).resolve(strict=True);lock=public_json(config['pipeline_source_lock']);exact(lock,{'format','files'});need(lock['format']=='public_hist215_encoder_source_graph_v1','PIPELINE_GRAPH')
 pins={}
 for f in lock['files']:checked(f);pins[Path(f['path']).resolve()]=f['sha256']
 for name in ['contract.py','pio_upi.py','public_hist215.py']:need(pipeline/name in pins,'MAINTAINED_PRODUCER_SOURCE_PIN')
 sys.path.insert(0,str(pipeline));contract=importlib.import_module('contract');pio=importlib.import_module('pio_upi');codec=importlib.import_module('public_hist215')
 for module in [contract,pio,codec]:need(Path(module.__file__).resolve().parent==pipeline,'PRODUCER_IMPORT_ORIGIN')
 canonical=codec.canonical_bytes;digest=codec.digest
 encoder_lock=public_json(config['encoder_source_lock']);exact(encoder_lock,{'format','files'});need(encoder_lock['format']=='public_hist215_encoder_source_graph_v1'and encoder_lock['files'],'ENCODER_SOURCE_GRAPH')
 for file in encoder_lock['files']:checked(file)
 inventory=public_json(config['inventory']);order=public_json(config['execution_order']);partition=public_json(config['source_partition']);original=public_json(config['original_manifest']);physics=public_json(config['physics_protocol']);schema=public_json(config['cache_schema'])
 need(inventory['contract']=='smarter-poker.r7-global-public-fold-inventory.DRAFT.v57'and inventory['planned_targets']==6099 and len(inventory['contexts'])==107 and inventory['solver_labels_read']is False and inventory['M2_labels_read']is False,'PUBLIC6099_INVENTORY')
 need(isinstance(order,list)and len(order)==6099 and partition['format']=='public_hist215_source_partition_protocol_v1','PUBLIC_ORDER_PARTITION')
 groups={c['context_id']:c for c in inventory['contexts']};records={}
 for cid,c in groups.items():
  need(cid==digest(c['context'])and len(c['selected'])==57,'EXACT_CONTEXT57')
  for r in c['selected']:
   s=r['draft_scenario'];need(len(s['targets'])==1,'SINGLE_PUBLIC_TARGET');t=s['targets'][0];need(t['machine_id']=='M1'and t['target_id']not in records,'PUBLIC_M1_UNIQUE');records[t['target_id']]=(cid,r)
 need(len(records)==6099 and {r['target_id']for r in order}==set(records),'EXACT6099_ORDER_SET')
 partition_groups={g['context_id']:g for g in partition['training_contexts']};need(set(partition_groups)==set(groups),'FROZEN_PARTITION_CONTEXTS')
 for cid,c in groups.items():need(partition_groups[cid]['context']==c['context']and partition_groups[cid]['rank_signatures']==sorted(r['global_rank_multiset']for r in c['selected']),'FROZEN_PUBLIC_RANKS')
 # Original manifest authorizes every ROOT range file; no new range authority.
 authorized={(s[k+'_range_path'],s[k+'_range_checksum'])for s in original['scenarios']for k in ['ip','oop']}
 root=Path(config['input_root']);need(root.is_absolute()and root.resolve(strict=True)==root,'PUBLIC_INPUT_ROOT');ranges={}
 for path,checksum in authorized:
  q=root/path;need(q.resolve(strict=True).is_relative_to(root),'ROOT_RANGE_PATH');ranges[checksum]={'path':str(q),'sha256':checksum,'units':range_units(checked({'path':str(q),'sha256':checksum}))}
 current_header,_=cache_header_and_first(config['current']);terminal_header,_=cache_header_and_first(config['terminal'])
 need(set(current_header)==set(schema['current_header_fields'])-{'rows'}and set(terminal_header)==set(schema['terminal_header_fields'])-{'rows'},'ACTUAL_CACHE_HEADERS')
 need(current_header['inventory_sha256']==config['inventory']['sha256']and terminal_header['base_current_feature_batch_sha256']==config['current']['sha256'],'PUBLIC_PHYSICS_ANCESTRY')
 output=Path(output);need(output.is_absolute()and output.parent.resolve(strict=True)==output.parent and not output.exists(),'UNIQUE_OUTPUT');output.mkdir();(output/'templates').mkdir()
 plan=[];compiled={};metadata={};ordered={cid:[]for cid in groups}
 for ordinal,item in enumerate(order):
  cid,r=records[item['target_id']];need(item['context_id']==cid and item['global_rank_multiset']==r['global_rank_multiset'],'ORDER_CONTEXT_RANK')
  s=copy.deepcopy(r['draft_scenario']);t=s['targets'][0];old=t['target_id'];s['scenario_id'],t['target_id']=fresh_ids(config['source_namespace'],ordinal)
  context=pio.target_context(s,t);need(context==groups[cid]['context'],'MAINTAINED_CONTEXT13')
  actor=pio.analyze_node(t['node'],root_pot_chips=s['pot_chips'],effective_stack_chips=s['effective_stack_chips'],preflop_aggressor=s['preflop_aggressor_solver_player']).actor
  own='ip'if actor==1 else'oop';opp='oop'if actor==1 else'ip'
  for side in [own,opp]:need((s[side+'_range_path'],s[side+'_range_checksum'])in authorized,'ORIGINAL_APPROVED_ROOT_RANGE')
  template={'format':'public_hist215_template_v1','context':context,'root_actor':'IP'if actor==1 else'OOP','scenario':{'pot_chips_f64':codec.encode_f64(s['pot_chips']),'effective_stack_chips_f64':codec.encode_f64(s['effective_stack_chips']),'chips_per_bb_f64':codec.encode_f64(s['chips_per_bb']),'rake_f64':[codec.encode_f64(v)for v in(s['rake']or[0,0])],'ip_range_checksum':s['ip_range_checksum'],'oop_range_checksum':s['oop_range_checksum']},'opponent_weights':[str(v)for v in ranges[s[opp+'_range_checksum']]['units']]}
  if cid in compiled:need(compiled[cid]==template and metadata[cid]['expected_children']==t['expected_children'],'ROOT_TEMPLATE_ACTIONS_STABLE')
  else:
   compiled[cid]=template;checksum=write_new(output/'templates'/ (cid+'.json'),canonical(template));metadata[cid]={'context':context,'expected_children':t['expected_children'],'model_action_order':sorted(t['expected_children']),'template_checksum':checksum,'feature_schema_checksum':codec.FEATURE_DESCRIPTOR_SHA256}
  planned={'cache_target_id':old,'target_id':t['target_id'],'scenario_id':s['scenario_id'],'context_id':cid,'board':t['board'],'source_node':t['node'],'scenario':s,'full_icm_table_identity':item['full_icm_table_identity']};plan.append(planned)
  ordered[cid].append({'target_id':t['target_id'],'board':t['board'],'source_node':t['node'],'cache_target_id':old})
 target_plan={'format':'public_hist215_final_M1_public_target_plan_v1','source_namespace':config['source_namespace'],'inventory_sha256':config['inventory']['sha256'],'execution_order_sha256':config['execution_order']['sha256'],'source_partition_checksum':digest(partition),'entries':plan}
 # Public target-plan retains original scenario numeric grammar (e.g. .005 solve accuracy), not model-f64 wire grammar.
 plan_sha=write_new(output/'public-target-plan.json',json.dumps(target_plan,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode('ascii'));request_groups=[];runtime_groups=[]
 deck=[r+s for r in'23456789TJQKA'for s in'cdhs'];combos=[(deck[lo],deck[hi])for hi in range(1,52)for lo in range(hi)]
 for cid in sorted(groups):
  template=compiled[cid];first=next(p for p in plan if p['context_id']==cid);s=first['scenario'];own='ip'if template['root_actor']=='IP'else'oop';opp='oop'if own=='ip'else'ip';ow=ranges[s[own+'_range_checksum']];op=ranges[s[opp+'_range_checksum']];cases=[]
  for target in ordered[cid][:2]:
   board=target['board'];blocked={board[i:i+2]for i in range(0,len(board),2)};opponents=[set(h)for h,w in zip(combos,op['units'])if w and not blocked.intersection(h)]
   hole=next((h for h,w in zip(combos,ow['units'])if w and not blocked.intersection(h)and any(not p.intersection(h)for p in opponents)),None);need(hole is not None,'PUBLIC_CASE_ROOT_SUPPORT');cases.append({'board':board,'own':list(hole)})
  request_groups.append({'context_id':cid,'context':template['context'],'template':{'path':str(output/'templates'/(cid+'.json')),'sha256':metadata[cid]['template_checksum']},'own_range':{k:ow[k]for k in['path','sha256']},'opponent_range':{k:op[k]for k in['path','sha256']},'targets':ordered[cid],'cases':cases});runtime_groups.append({'context':template['context'],'cases':cases})
 request={'format':'public_hist215_public_feature_batch_request_v1','feature_schema_checksum':codec.FEATURE_DESCRIPTOR_SHA256,'encoder_source_lock':config['encoder_source_lock'],'physics_checksum':digest(physics),'cache_schema':config['cache_schema'],'current':{**config['current'],'header':current_header},'terminal':{**config['terminal'],'header':terminal_header},'contexts':request_groups}
 # Cache ancestry contains compiler multiline metadata, pinned by file SHA.
 request_sha=write_new(output/'public-feature-request.json',json.dumps(request,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode('ascii'));runtime={'format':'public_hist215_runtime_parity_protocol_v1','method':'cold_public215_features_and_all_heads_v1','clock':'process.hrtime.bigint','platform':'linux','node_major':22,'napi_version':8,'native_source_checksum':codec.NATIVE_SOURCE_SHA256,'execution_limit_ms':8000,'contexts':runtime_groups}
 approved_metadata=canonical_context_order(list(metadata.values()),canonical);runtime['contexts']=canonical_context_order(runtime_groups,canonical)
 codec.validate_context_metadata(approved_metadata)
 need([canonical(g['context'])for g in runtime['contexts']]==[canonical(g['context'])for g in approved_metadata],'CANONICAL_RUNTIME_CONTEXT_ORDER')
 write_new(output/'public-context-metadata.json',canonical({'public215_contexts':approved_metadata,'runtime_parity_protocol':runtime}))
 receipt={'format':'public_hist215_feature_request_assembly_receipt_v1','status':'PUBLIC_PLANNING_ONLY_NOT_APPROVAL_CAPTURE_OR_TRAINING','source_namespace':config['source_namespace'],'assembly_config_sha256':config_sha256,'original_manifest_sha256':config['original_manifest']['sha256'],'physics_protocol_sha256':config['physics_protocol']['sha256'],'current_public_cache_sha256':config['current']['sha256'],'terminal_public_cache_sha256':config['terminal']['sha256'],'target_plan_sha256':plan_sha,'request_sha256':request_sha,'assembler_source_sha256':SHA(Path(__file__).read_bytes()),'pipeline_source_lock_sha256':config['pipeline_source_lock']['sha256'],'encoder_source_lock_sha256':config['encoder_source_lock']['sha256'],'encoder_checksum':digest(encoder_lock),'source_partition_sha256':config['source_partition']['sha256'],'contexts':107,'planned_targets':6099,'M2_seed_read':False,'solver_labels_read':False,'fit_authorized':False}
 write_new(output/'request-assembly-receipt.json',canonical(receipt));return receipt
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',required=True);p.add_argument('--config-sha256',required=True);p.add_argument('--output',required=True);a=p.parse_args();print(json.dumps(assemble(public_json({'path':a.config,'sha256':a.config_sha256}),a.output,a.config_sha256),sort_keys=True))
if __name__=='__main__':main()
