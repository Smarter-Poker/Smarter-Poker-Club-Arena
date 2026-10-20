"""Finite reviewed pending DDL; never replay historical business data."""
import copy,hashlib,json
from pathlib import Path
# Only these exact two reviewed sources have a maintained semantic delta runner.
APPROVED={
 'supabase/migrations/20261020182843_native_weekly_hand_outcomes_use_original_bounded_parts.sql':'0ec1002c063f2f18c664cefd944c1993287e71607b00f252ac465c67128e7031',
 'supabase/migrations/20261020184651_statement_provenance_stays_out_of_messenger.sql':'540577870c6ae11d73548d20b4cc97625671623b12208ca8a2e016c46eeee1c0',
}
def validate(root,entries):
 if len(entries)!=2 or {x['path'] for x in entries}!=set(APPROVED):raise ValueError('Only the two reviewed pending DDL inputs are supported')
 for entry in entries:
  if entry.get('state')!='pending-at-capture' or entry['sha256']!=APPROVED[entry['path']]:raise ValueError('Unreviewed forward schema contract')
  if hashlib.sha256((Path(root)/entry['path']).read_bytes()).hexdigest()!=entry['sha256']:raise ValueError('Forward source bytes differ')
 return sorted(entries,key=lambda x:x['path'])
def expected_catalog(reference):
 result=copy.deepcopy(reference)
 changes={
 ('public','fn_union_pnl_evidence_report'):('7b465b7055e80234bd8c40ed5899f4dd','cab1019f5055b42be8f25d1b2fad1736'),
 ('public','fn_accounting_union_earned_plan_advance'):('06a789f7d4d680e7bc71ddf72b8216b9','ade5ac42d2662fc193fd7672bfcd2d09'),
 ('smarter_private','original_inventory_proof_sources_match'):('b87c67498a800464fb3d8f3558b8eefa','28e9764671be0796c7c284a2500c3d75'),
 ('public','fn_deliver_accounting_invoice'):('8419aac1cd0ed1e30ac68621fb95823d','24cffb644a4ccad0daf4de38cbc20887'),
 ('public','fn_messenger_message_page'):('fa1d6d8d1f40d51d3ff023b9b9a60879','dbf4643e5bf076d4a8923fa7c167658e'),
 ('public','fn_messenger_search_messages'):('2a72b3863c46f8b7d5e0c3b6a7585e29','18a3e870828691932112ebb24539994d')}
 for key,(before,after) in changes.items():
  matches=[r for r in result['routines'] if (r['schema'],r['name'])==key]
  if len(matches)!=1 or matches[0]['definition_md5']!=before:raise ValueError('Pending routine preimage differs: '+'.'.join(key))
  matches[0]['definition_md5']=after
 args='p_union uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean'
 for name,language,body,identity in [('weekly_hand_parts_witness','plpgsql','64731b2855b4ea526d831ca8ab2bc589',args),('weekly_hand_parts_reduce','sql','97fc255997a2faeac593b5b1f5420d4c',args),('weekly_hand_parts_read','plpgsql','5e474b2f2faebba54d1d4676e80b82e6',args.replace('p_projected boolean','p_generation text, p_projected boolean'))]:
  if any(r['schema']=='smarter_private' and r['name']==name for r in result['routines']):raise ValueError('Pending routine already exists')
  result['routines'].append(dict(schema='smarter_private',name=name,args=identity,result='jsonb',kind='f',owner='postgres',acl=[dict(grantor='postgres',grantee='postgres',privilege='EXECUTE',grantable=False)],language=language,definer=False,settings=['search_path=pg_catalog, public, smarter_private'],volatility='s',parallel='u',strict=False,leakproof=False,cost=100,rows=0,support=None,definition_md5=body,aggregate=None))
 result['routines'].sort(key=lambda r:(r['schema'],r['name'],r['args']))
 relation=next(r for r in result['relations'] if r['schema']=='public' and r['name']=='accounting_close_partials')
 constraint=next(c for c in relation['constraints'] if c['name']=='accounting_close_partials_kind_check')
 old="'pnl_flows_window'::text])))"
 if not constraint['definition'].endswith(old):raise ValueError('Pending constraint preimage differs')
 constraint['definition']=constraint['definition'][:-len(old)]+"'pnl_flows_window'::text, 'pnl_hands_window'::text])))"
 return result
