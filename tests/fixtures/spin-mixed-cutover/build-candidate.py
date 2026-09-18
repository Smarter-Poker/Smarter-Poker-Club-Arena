#!/usr/bin/env python3
"""Exact installed settlement and net-plan successor; original bodies preserved."""
from pathlib import Path
import json,sys
fix=Path(__file__).resolve().parent;root=fix.parents[2]
rows=json.loads((fix/'captured-preimages.json').read_text())['functions']
path=root/'supabase/migrations/20260918085836_original_mixed_cutover_spin_fee_proof.sql'
def once(s,a,b):
 assert s.count(a)==1,(a,s.count(a));return s.replace(a,b)
def candidate(r):
 s=r['definition'];name=r['identity'].split('(')[0]
 if name=='fn_accounting_tournament_fee_net_plan':
  return once(s,"b.status IS DISTINCT FROM 'captured'", "(b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(b.rake_record_id))")
 if name=='fn_settle_tournament_rake':
  return once(s,'  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);', '''  -- Qualify only this owning close's complete original mixed-cutover Spin
  -- receipts. The original batch remains unchanged; any failure below rolls
  -- proof, source rows, claim, bank transfer and recognition back together.
  FOR v_raw IN SELECT r.id FROM public.rake_records r
   JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament AND r.rake_amount>0
    AND r.source='fn_spin_book_entry' AND r.created_at>=c.starts_at
    AND b.status='legacy_unverified' AND b.source_manifest IS NULL ORDER BY r.id LOOP
   PERFORM public.fn_accounting_qualify_mixed_cutover_spin_fee(v_raw.id);
  END LOOP;
  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);''')
 return None
changed=[r for r in rows if candidate(r)]
header='''-- Original mixed-cutover Spins retain their legacy batch unchanged. Their
-- existing close can qualify exact original paid entries and historical terms,
-- then use the same canonical recognition and bank transaction once.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preconditions$
BEGIN
 IF to_regclass('public.accounting_mixed_cutover_spin_fee_proofs') IS NOT NULL THEN
  RAISE EXCEPTION 'mixed_spin_proof_contract_already_exists'; END IF;
'''
for r in rows:
 if r['identity'].split('(')[0] not in ['fn_settle_tournament_rake','fn_accounting_tournament_fee_net_plan','fn_accounting_earning_contract','fn_stamp_accounting_tournament_fee','fn_accounting_tournament_fee_receipt_immutable']:continue
 acl='{'+','.join(r['acl'])+'}'
 header+=f" IF md5(pg_get_functiondef('public.{r['identity']}'::regprocedure)) IS DISTINCT FROM '{r['md5']}' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.{r['identity']}'::regprocedure) IS DISTINCT FROM '{acl}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{r['identity']}'::regprocedure) IS DISTINCT FROM '{r['owner']}' THEN RAISE EXCEPTION 'mixed_spin_proof_preimage_changed:{r['identity']}'; END IF;\n"
header+=''' IF md5(pg_get_functiondef('public.fn_managed_game_contract_hash(jsonb)'::regprocedure)) IS DISTINCT FROM '1aa2f356d6d3b17135cf5505ec4166f5'
  OR md5(pg_get_functiondef('public.fn_guard_managed_game_contract_version()'::regprocedure)) IS DISTINCT FROM '95b0c11437e95b3862558a4d27434ccf'
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.managed_game_contract_versions'::regclass
   AND tgname='trg_managed_game_contract_version_immutable' AND tgenabled IN('O','A')
   AND tgfoid='public.fn_guard_managed_game_contract_version()'::regprocedure) THEN
  RAISE EXCEPTION 'mixed_spin_original_scope_authority_changed'; END IF;
END $preconditions$;
'''

parts=[header,(fix/'proof-authority.sql').read_text()]
for r in changed:
 parts.append(candidate(r)+';\nREVOKE ALL ON FUNCTION public.'+r['identity']+' FROM PUBLIC,anon,authenticated,service_role;\n')
 if any(a.startswith('service_role=') for a in r['acl']):parts.append('GRANT EXECUTE ON FUNCTION public.'+r['identity']+' TO service_role;\n')
parts.append('COMMIT;\n');result='\n'.join(parts)
if '--check' in sys.argv:
 assert path.read_text()==result,'Mixed Spin candidate differs from exact source composition';print('PASS exact original mixed Spin source composition')
else:path.write_text(result);print(path)
