#!/usr/bin/env python3
"""Render the one transactional source migration from maintained SQL and pins."""
import argparse,hashlib,json,difflib
from pathlib import Path
R=Path(__file__).resolve().parents[3];D=Path(__file__).resolve().parent;H=R/'supabase/accounting/own-agent-v1'
P=argparse.ArgumentParser();P.add_argument('--bootstrap-postimages',type=Path);P.add_argument('--check',action='store_true');A=P.parse_args()
files=['earning-contract','destination-contract','unpaid-interpretation','effective-views','typed-receipts','fn_accounting_tournament_commission_source_guard','fn_accounting_union_earned_plan_sets','fn_accounting_union_earned_plan_window','fn_calculate_cash_rakeback_periods','fn_rakeback_split_check','fn_rakeback_split_write','fn_prepare_accounting_week','fn_settle_accounting_commission_stage','fn_settle_accounting_commission_stage_v3','fn_settle_accounting_rakeback_stage','deferred-proof','ca_player_stats_financial_report','fn_ca_settlement_correctness_check','weekly_payout_prepare_due']
changed={'fn_accounting_earning_contract','fn_calculate_cash_rakeback_periods','fn_rakeback_split_check','fn_rakeback_split_write','fn_prepare_accounting_week','fn_settle_accounting_commission_stage','fn_settle_accounting_commission_stage_v3','fn_settle_accounting_rakeback_stage','fn_accounting_tournament_commission_source_guard','fn_accounting_union_earned_plan_sets','fn_accounting_union_earned_plan_window','fn_ca_rakeback_payout_leg_is_documented','ca_player_stats_financial_report','fn_ca_settlement_correctness_check'}
original=json.loads((D/'original-owners.json').read_text());patches=json.loads((D/'pause-owner-patches.json').read_text());by_name={x['signature'].split('(')[0].split('.')[-1]:x for x in patches}
pre=[]
for row in original:
 name=row['signature'].split('(')[0].split('.')[-1]
 if name not in changed:continue
 pre.append({'signature':row['signature'],'md5':by_name[name]['postimage']if name in by_name else row['md5'],'acl':row['acl'],'config':row['config']})
assert len(pre)==14
phase=json.loads((D/'phase-preparation-owner.json').read_text())
pre.append({k:phase[k]for k in ['signature','md5','acl','config']})
for name,patch in by_name.items():
 s=(H/(name+'.sql')).read_text()
 for pair in patch['replacements']:assert s.count(pair['new'])==1,('lost original owned-pause seam',name,pair['new'])
if A.bootstrap_postimages:
 # Compiler output supplies body identities only. It is not a financial or
 # document qualification certificate; the whole native suite runs separately.
 post=[{'signature':x['signature'],'md5':x['md5']}for x in json.loads(A.bootstrap_postimages.read_text())['postimages']]
 assert len(post)==24
 binding={'version':1,'original_catalog_observed_at':'2026-10-28T18:52:58.54895Z','source_only':True,'phase_dependency':'20261028162126','preimages':pre,'postimages':post,'source_sha256':{n+'.sql':hashlib.sha256((H/(n+'.sql')).read_bytes()).hexdigest()for n in files}}
 (D/'source-binding.json').write_text(json.dumps(binding,indent=2)+'\n')
b=json.loads((D/'source-binding.json').read_text());assert b['preimages']==pre
assert b['source_sha256']=={n+'.sql':hashlib.sha256((H/(n+'.sql')).read_bytes()).hexdigest()for n in files},'changed maintained source requires fresh native compiler identities'
compact=lambda x:json.dumps(x,separators=(',',':'))
views=json.loads((D/'original-views.json').read_text());view_pins=[{'name':x['name'],'md5':hashlib.md5(x['definition'].encode()).hexdigest()}for x in views]
GEN='original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'
sql="""-- @install-window: daily-maintenance
-- Own playing earnings use their observed historical AGENT agreement.
-- Original v3 paid receipts/ABI remain authoritative; only unpaid R0 admits
-- versioned interpretations. New typed destination receipts are cold sidecars.
-- Trigger DDL uses the original daily-window applier. No money runs at install.
BEGIN;
CREATE TEMP TABLE _own_agent_install_metadata(signature text PRIMARY KEY,metadata jsonb NOT NULL)ON COMMIT DROP;
CREATE TEMP TABLE _own_agent_install_views(name text PRIMARY KEY,metadata jsonb NOT NULL)ON COMMIT DROP;
DO $pre$
DECLARE r record;p pg_proc%ROWTYPE;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'THEN RAISE EXCEPTION 'own_agent_installer_postgres_required';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028162126')THEN RAISE EXCEPTION 'own_agent_owned_phase_dependency_missing';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true
 OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM '"""+GEN+"""'THEN RAISE EXCEPTION 'own_agent_original_inventory_authority_changed';END IF;
 FOR r IN SELECT*FROM jsonb_to_recordset($owners$"""+compact(pre)+"""$owners$::jsonb)AS x(signature text,md5 text,acl jsonb,config jsonb)LOOP
  SELECT*INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(r.signature);
  IF md5(pg_get_functiondef(p.oid))IS DISTINCT FROM r.md5 OR pg_get_userbyid(p.proowner)<>'postgres'
  OR to_jsonb(p.proacl)IS DISTINCT FROM r.acl OR to_jsonb(p.proconfig)IS DISTINCT FROM r.config THEN RAISE EXCEPTION 'own_agent_owner_preimage_changed:%',r.signature;END IF;
  INSERT INTO pg_temp._own_agent_install_metadata VALUES(r.signature,to_jsonb(p)-'prosrc');
 END LOOP;
 FOR r IN SELECT*FROM jsonb_to_recordset($views$"""+compact(view_pins)+"""$views$::jsonb)AS x(name text,md5 text)LOOP
  IF md5(pg_get_viewdef(('public.'||r.name)::regclass,true))IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'own_agent_effective_view_preimage_changed:%',r.name;END IF;
  INSERT INTO pg_temp._own_agent_install_views SELECT r.name,to_jsonb(c)FROM pg_class c WHERE c.oid=('public.'||r.name)::regclass;
 END LOOP;
END $pre$;
"""
# Preserve the two original runtime locking contracts. Their existing lock
# calls do not execute during installation and are not newly introduced here.
# Install only the exact reviewed deltas, never an encoded or masked body.
owner_patches=[]
for name in files:
 source=(H/(name+'.sql')).read_text().rstrip().rstrip(';')+'\n'
 if name in('fn_prepare_accounting_week','fn_calculate_cash_rakeback_periods'):
  original_owner=next(row for row in original if row['signature'].split('(')[0].split('.')[-1]==name)
  before=original_owner['definition'].rstrip().rstrip(';')+'\n';after=source
  replacements=[]
  old_lines=before.splitlines(keepends=True);new_lines=after.splitlines(keepends=True)
  for group in difflib.SequenceMatcher(None,old_lines,new_lines,autojunk=False).get_grouped_opcodes(3):
   old=''.join(old_lines[group[0][1]:group[-1][2]]);new=''.join(new_lines[group[0][3]:group[-1][4]])
   assert old and before.count(old)==1,('nonunique owner delta',name,old)
   assert 'pg_advisory_xact_lock'not in old+new,('a delta must not alter the original runtime lock',name)
   replacements.append({'old':old,'new':new})
  derived=before
  for pair in replacements:derived=derived.replace(pair['old'],pair['new'])
  assert derived==after,('owner delta did not reproduce maintained complete source',name)
  owner_patches.append({'signature':original_owner['signature'],'preimage':original_owner['md5'],'replacements':replacements})
 else:sql+='\n-- Maintained owner: supabase/accounting/own-agent-v1/'+name+'.sql\n'+source.rstrip()+';\n'
delta_path=D/'original-owner-deltas.json';delta_text=json.dumps(owner_patches,indent=2)+'\n'
if A.check:assert delta_path.read_text()==delta_text,'original owner delta drift'
else:delta_path.write_text(delta_text)
sql+='\n-- Exact deltas to the complete maintained owners; original runtime locks remain unchanged.\n'
sql+="DO $original_owners$ DECLARE r record;x jsonb;d text;BEGIN FOR r IN SELECT*FROM jsonb_to_recordset($deltas$"+compact(owner_patches)+"$deltas$::jsonb)AS p(signature text,preimage text,replacements jsonb)LOOP d:=pg_get_functiondef(to_regprocedure(r.signature));IF md5(d)IS DISTINCT FROM r.preimage THEN RAISE EXCEPTION 'own_agent_original_delta_preimage_changed:%',r.signature;END IF;FOR x IN SELECT value FROM jsonb_array_elements(r.replacements)LOOP IF(length(d)-length(replace(d,x->>'old','')))/length(x->>'old')<>1 THEN RAISE EXCEPTION 'own_agent_original_delta_not_exact:%',r.signature;END IF;d:=replace(d,x->>'old',x->>'new');END LOOP;EXECUTE d;END LOOP;END $original_owners$;\n"

# State each original ACL explicitly for the existing static admission gate.
# Restore grants in the captured order so full pg_proc metadata stays exact.
for owner in pre:
 signature=owner['signature']if '.'in owner['signature'].split('(')[0]else'public.'+owner['signature']
 sql+='REVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC,anon,authenticated,service_role;\n'
 for acl in owner['acl']or[]:
  role=acl.split('=')[0]
  if role!='postgres':
   assert role in('service_role','authenticated')and acl.split('=')[1]=='X/postgres',('unrecognized original grant',signature,acl)
   sql+='GRANT EXECUTE ON FUNCTION '+signature+' TO '+role+';\n'
sql+="""
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check','migration 20261028184531 own-agent typed wallet receipts');
DO $post$
DECLARE r record;
BEGIN
 FOR r IN SELECT*FROM jsonb_to_recordset($postimages$"""+compact(b['postimages'])+"""$postimages$::jsonb)AS x(signature text,md5 text)LOOP
  IF md5(pg_get_functiondef(to_regprocedure(r.signature)))IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'own_agent_owner_postimage_changed:%',r.signature;END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_temp._own_agent_install_metadata m LEFT JOIN pg_proc p ON p.oid=to_regprocedure(m.signature)WHERE(to_jsonb(p)-'prosrc')IS DISTINCT FROM m.metadata)THEN RAISE EXCEPTION 'own_agent_original_owner_metadata_changed';END IF;
 IF EXISTS(SELECT FROM pg_temp._own_agent_install_views m LEFT JOIN pg_class c ON c.oid=('public.'||m.name)::regclass WHERE to_jsonb(c)IS DISTINCT FROM m.metadata)THEN RAISE EXCEPTION 'own_agent_original_view_metadata_changed';END IF;
 IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private'AND p.proname IN('own_agent_destination_contract','rakeback_wallet_plan','record_rakeback_wallet_contracts','rakeback_certificate_wallets','rakeback_wallet_payout_complete','own_agent_interpreted_contract','admit_own_agent_source','prepare_own_agent_interpretation','assert_own_agent_scope_interpreted')AND(pg_get_userbyid(p.proowner)<>'postgres'OR NOT p.prosecdef OR p.proacl::text IS DISTINCT FROM'{postgres=X/postgres}'))THEN RAISE EXCEPTION 'own_agent_private_owner_or_acl_changed';END IF;
 IF NOT EXISTS(SELECT FROM ca_guard_defs WHERE proname='fn_ca_settlement_correctness_check'AND def_hash=md5(pg_get_functiondef('fn_ca_settlement_correctness_check()'::regprocedure)))THEN RAISE EXCEPTION 'own_agent_correctness_declaration_missing';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM '"""+GEN+"""'THEN RAISE EXCEPTION 'own_agent_original_inventory_authority_changed';END IF;
END $post$;
COMMIT;
"""
proof=' AND '.join("md5(pg_get_functiondef('"+x['signature']+"'::regprocedure))='"+x['md5']+"'"for x in b['postimages'])
proof+=" AND EXISTS(SELECT FROM pg_trigger WHERE tgname='zz_ca_own_agent_rakeback_leg_documented'AND tgrelid='public.chip_ledger'::regclass AND tgenabled='O')"
sql='-- @live-proof: '+proof+'\n'+sql
path=R/'supabase/migrations/20261028184531_own_playing_agent_earnings_keep_typed_wallet_receipts.sql'
if A.check:assert path.read_text()==sql,'generated migration drift'
else:path.write_text(sql)
print(json.dumps({'migration':path.name,'sha256':hashlib.sha256(sql.encode()).hexdigest(),'existing_owners':15,'new_private_owners':9,'financial_execution_at_install':False}))
