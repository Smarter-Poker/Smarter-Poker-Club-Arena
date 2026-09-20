#!/usr/bin/env python3
"""Exact five-event successor; the separately qualified eight are unchanged."""
from pathlib import Path
import hashlib,json,sys
fix=Path(__file__).resolve().parent
root=fix.parents[2]
catalog={r['identity']:r for r in json.loads((fix/'predecessor-functions.json').read_text())}
manifest=json.loads((fix/'authority.json').read_text())['events']
parts=["-- Five explicitly authorized September 8 Spins. Existing payer and custody owner only.\nBEGIN;\nSET LOCAL lock_timeout='2s';\nSET LOCAL statement_timeout='30s';\n",(fix/'original-proof.sql').read_text()]
post={}
def patch(sig,replacements):
 r=catalog[sig];source=r['definition'];original=source
 block=["DO $patch$ DECLARE source text; BEGIN",f"SELECT pg_get_functiondef('public.{sig}'::regprocedure) INTO source;",f"IF md5(source) IS DISTINCT FROM '{r['definition_md5']}' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM '{r['acl']}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM '{r['owner']}' THEN RAISE EXCEPTION 'sep8 Spin predecessor changed: {sig}' USING ERRCODE='55000'; END IF;"]
 for i,(old,new) in enumerate(replacements):
  assert source.count(old)==1,(sig,old[:80],source.count(old))
  source=source.replace(old,new);block.append(f'source:=replace(source,$old{i}${old}$old{i}$,$new{i}${new}$new{i}$);')
 block.append('EXECUTE source; END $patch$;');parts.append('\n'.join(block));post[sig]=source
 assert source!=original
entries=',\n'.join(" ('%s'::uuid,%s::numeric,'%s',1)"%(r['tournament_id'],r['amount'],r['source_fingerprint']) for r in manifest)
patch('fn_ca_legacy_fee_custody_cohort(uuid)',[(" ) c(tournament_id,amount,source_fingerprint,source_count)",',\n'+entries+"\n ) c(tournament_id,amount,source_fingerprint,source_count)")])
scope="jsonb_build_object('club_id',t.club_id,'union_id',t.union_id,'is_private',t.is_private,'tournament_type',t.tournament_type)"
extra="CASE WHEN public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('spin_original',public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id)) END"
patch('fn_ca_hold_legacy_tournament_fee(uuid,text)',[
 ("OR lower(COALESCE(t.variant,'')) IN ('satellite','spin')","OR lower(COALESCE(t.variant,''))='satellite'\n  OR (lower(COALESCE(t.variant,''))='spin' AND public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL)"),
 (scope+',to_jsonb(e)',scope+'||'+extra+',to_jsonb(e)')])
patch('fn_ca_tournament_fee_custody_receipt(uuid)',[(scope+'\n  INTO scope',scope+'||'+extra+'\n  INTO scope')])
patch('fn_ca_begin_legacy_fee_resolution(uuid)',[("OR jsonb_array_length(plan->'active_source_ids')<1", "OR jsonb_array_length(plan->'active_source_ids')<1\n  OR (public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NOT NULL AND jsonb_array_length(plan->'active_source_ids')<>3)")])
patch('fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)',[
 (" IF p_operation='DELETE' OR t IS NULL THEN RETURN false; END IF;", """ -- The installed Union wallet autoledger identifies its source by the typed
 -- original prize liability and deliberately leaves tournament_id NULL.
 IF t IS NULL AND p_table='chip_ledger' AND p_operation='INSERT'
  AND p_new->>'from_type'='prize_liability'
  AND public.fn_ca_sep8_spin_original_fee_proof(NULLIF(p_new->>'from_entity_id','')::uuid) IS NOT NULL THEN
  t:=NULLIF(p_new->>'from_entity_id','')::uuid;
 END IF;
 IF p_operation='DELETE' OR t IS NULL THEN RETURN false; END IF;"""),
 (" ELSIF p_table='chip_ledger' THEN\n  RETURN", """ ELSIF p_table='chip_ledger' THEN
  IF p_operation='INSERT' AND r.original_plan->>'union_id' IS NOT NULL
   AND public.fn_ca_sep8_spin_original_fee_proof(t) IS NOT NULL THEN
   RETURN p_new->>'from_type'='prize_liability' AND p_new->>'from_entity_id'=t::text
    AND (p_new->>'tournament_id' IS NULL OR p_new->>'tournament_id'=t::text)
    AND p_new->>'to_type'='union_wallet' AND p_new->>'to_label'='union_wallets.rake_wallet'
    AND p_new->>'union_id'=r.original_plan->>'union_id' AND p_new->>'category'='rake'
    AND (p_new->>'amount')::numeric=r.amount
    AND p_new->>'description'='auto-ledgered union_wallets.rake_wallet delta '||round(r.amount,2)::text
    AND p_new->>'from_label' IS NULL AND p_new->>'club_id' IS NULL
    AND p_new->>'table_id' IS NULL AND p_new->>'hand_id' IS NULL
    AND p_new->>'idempotency_key' IS NULL AND p_new->>'metadata' IS NULL
    AND p_new->>'pre_from_balance' IS NULL AND p_new->>'post_from_balance' IS NULL
    AND p_new->>'status'='posted' AND (p_new->>'created_at')::timestamptz=r.resolved_at
    AND (p_new->>'performed_by')::uuid=COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid)
    AND (p_new->>'pre_to_balance')::numeric>=0
    AND (p_new->>'post_to_balance')::numeric-(p_new->>'pre_to_balance')::numeric=r.amount
    AND EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.id=(p_new->>'to_entity_id')::uuid
     AND w.union_id=(r.original_plan->>'union_id')::uuid
     AND w.rake_wallet=(p_new->>'post_to_balance')::numeric)
    AND EXISTS(SELECT 1 FROM public.tournament_rake_settlements s WHERE s.tournament_id=t
     AND s.destination='pending' AND s.amount=0 AND s.settled_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.from_type='prize_liability'
     AND l.from_entity_id=t AND l.to_type='union_wallet'
     AND (l.union_id=(r.original_plan->>'union_id')::uuid OR l.to_entity_id=(p_new->>'to_entity_id')::uuid));
  END IF;
  RETURN""")])
patch('fn_ca_tournament_terminal_receipt(uuid,uuid)',[
 ('v_original_witness jsonb;','v_original_witness jsonb;v_spin_witness jsonb;v_spin_original jsonb;'),
 ("  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric", """  v_spin_original:=public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id);
  IF to_regprocedure('smarter_private.spin_original_standings_witness(uuid,uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT smarter_private.spin_original_standings_witness($1,$2)' INTO v_spin_witness USING p_tournament_id,v_h.winner_id;
  END IF;
  IF (v_spin_original IS NOT NULL AND jsonb_typeof(v_spin_witness) IS DISTINCT FROM 'object')
    OR NULLIF(v_h.cash_receipt->'original_standings','null'::jsonb) IS DISTINCT FROM NULLIF(v_spin_witness,'null'::jsonb) THEN
    RAISE EXCEPTION 'terminal cash original Spin standings disagree with immutable authority' USING ERRCODE='P0404';
  END IF;
  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric""")])
parts.append('COMMIT;\n')
target=next((root/'supabase/migrations').glob('20260918095320*.sql'));candidate='\n'.join(parts)
if '--check' in sys.argv:
 assert target.read_text()==candidate,'September 8 Spin source differs from exact composition'
 print('PASS exact September 8 Spin successor composition')
else:target.write_text(candidate);print(target)
if '--postimages' in sys.argv:
 Path(sys.argv[sys.argv.index('--postimages')+1]).write_text(json.dumps({'kind':'source-only-postimages','migration':str(target.relative_to(root)),'migration_sha256':hashlib.sha256(candidate.encode()).hexdigest(),'functions':post},indent=2)+'\n')
