#!/usr/bin/env python3
"""Compose the bounded successor from exact installed financial preimages."""
from pathlib import Path
import json,sys
root=Path(__file__).resolve().parents[3]
evidence=Path(__file__).resolve().parent
access=json.loads((evidence/'captured-access.json').read_text())
parts=[(evidence/'custody-core.sql').read_text(),(evidence/'custody-resolution.sql').read_text()]
postimages={}
def patch(name,replacements):
 original=(evidence/(name+'.sql')).read_text()
 updated=original
 for old,new in replacements:
  assert updated.count(old)==1,(name,old[:90],updated.count(old))
  updated=updated.replace(old,new)
 # Exact existing preimage protects changes owned by concurrent tasks. The
 # maintained replacement remains reviewable SQL, not a replacement function copy.
 import hashlib
 digest=hashlib.md5(original.rstrip('\n').encode()).hexdigest()
 # pg_get_functiondef includes trailing newline in captured definition.
 digest=hashlib.md5(original.encode()).hexdigest()
 identity=original.split('FUNCTION public.')[1].split('\n')[0]
 # Supplied signature avoids SQL argument names/defaults.
 signatures={'fn_complete_tournament_terminal_pre_seat_guard':'uuid,uuid,text','fn_ca_tournament_terminal_receipt':'uuid,uuid','fn_tournament_finish_readiness':'uuid,uuid','fn_accounting_tournament_terminal_fee_receipt':'uuid','fn_settle_tournament_rake':'uuid,text','fn_terminal_tournament_evidence_is_immutable':'','fn_terminal_tournament_escrow_is_immutable':'','fn_ca_capture_tournament_fee_from_recorded_evidence':'uuid','fn_satellite_transfer_ledger_is_immutable':''}
 sig=name+'('+signatures[name]+')'
 postimages[sig]=updated
 contract=next(r for r in access if r['identity']==sig)
 chunks=[f"DO $patch$\nDECLARE source text;\nBEGIN\n SELECT pg_get_functiondef('public.{sig}'::regprocedure) INTO source;\n IF md5(source)<>'{digest}' OR (SELECT proacl::text FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM '{contract['acl']}' OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM '{contract['owner']}' THEN RAISE EXCEPTION '{name} preimage changed' USING ERRCODE='55000'; END IF;"]
 for i,(old,new) in enumerate(replacements):
  chunks.append(f' source:=replace(source,$old{i}${old}$old{i}$,$new{i}${new}$new{i}$);')
 chunks.append(' EXECUTE source;\nEND $patch$;\n')
 parts.append('\n'.join(chunks))


patch('fn_accounting_tournament_terminal_fee_receipt',[(
 'IF NOT FOUND THEN RETURN NULL; END IF;',
 'IF NOT FOUND THEN RETURN public.fn_ca_tournament_fee_custody_receipt(p_tournament_id); END IF;')])
terminal=(evidence/'fn_complete_tournament_terminal_pre_seat_guard.sql').read_text()
fee_start=terminal.index('  v_rake_result := public.fn_settle_tournament_rake(')
fee_end=terminal.index('\n  -- Explicitly release every live seat',fee_start)
old=terminal[fee_start:fee_end]
ordinary=old[old.index('  SELECT rs.* INTO v_rake'):]
ordinary=ordinary.replace('  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());\n','')
new="""  BEGIN
    v_rake_result := public.fn_settle_tournament_rake(
      p_tournament_id,'engine.fn_complete_tournament_terminal');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_fee_error:=SQLERRM;
    v_fee_reason:=substring(v_fee_error FROM length('tournament '||p_tournament_id::text||' rake attribution incomplete: ')+1);
    IF v_fee_error IS DISTINCT FROM 'tournament '||p_tournament_id::text||' rake attribution incomplete: '||v_fee_reason
      OR v_fee_reason NOT IN ('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
    -- The failed fee subtransaction has rolled back its provisional claim.
    -- The exact bounded proof retains fees; all existing player checks above remain.
    v_accounting:=public.fn_ca_hold_legacy_tournament_fee(p_tournament_id,v_fee_reason);
    v_custody:=true;
  END;
  IF NOT v_custody AND COALESCE((v_rake_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % rake authority refused: %',p_tournament_id,v_rake_result USING ERRCODE='P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());
  IF v_custody THEN
    SELECT v_rake_total AS amount,'tournament_escrow'::text AS destination,
     NULL::timestamptz AS settled_at,NULL::timestamptz AS attributed_at,0 AS attributed_users INTO v_rake;
  ELSE
"""+ordinary+"\n  END IF;\n"
patch('fn_complete_tournament_terminal_pre_seat_guard',[
 ('  v_accounting jsonb; v_deferred boolean := false;','  v_accounting jsonb; v_deferred boolean := false;\n  v_custody boolean:=false;v_fee_error text;v_fee_reason text;'),
 (old,new),
 ("     v_rake.attributed_users,v_completed_at,'terminal receipt: exact zero',\n     v_completed_at,transaction_timestamp(),CASE WHEN v_accounting IS NULL THEN 1 ELSE 2 END,COALESCE(v_accounting->>'status','legacy'));",
 "     v_rake.attributed_users,CASE WHEN v_custody THEN NULL ELSE v_completed_at END,\n     CASE WHEN v_custody THEN NULL ELSE 'terminal receipt: exact zero' END,\n     v_completed_at,transaction_timestamp(),CASE WHEN v_custody THEN 3 WHEN v_accounting IS NULL THEN 1 ELSE 2 END,COALESCE(v_accounting->>'status','legacy'));")])

reader=(evidence/'fn_ca_tournament_terminal_receipt.sql').read_text()
rake_start=reader.index('  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs')
rake_end=reader.index('\n  v_bubble :=',rake_start)
rake=reader[rake_start:rake_end]
patch('fn_ca_tournament_terminal_receipt',[
 ('  v_accounting jsonb; v_deferred boolean := false;', '  v_accounting jsonb; v_deferred boolean := false;v_custody boolean:=false;v_resolved boolean:=false;v_original_witness jsonb;'),
 ("  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);",
  "  v_accounting:=CASE WHEN v_h.accounting_state='fee_custody_unresolved' THEN public.fn_ca_tournament_fee_custody_receipt(p_tournament_id) ELSE public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id) END;"),
 ("  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);",
 "  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);\n  v_custody:=v_h.accounting_state='fee_custody_unresolved';\n  v_resolved:=v_custody AND COALESCE((v_accounting->>'accounting_complete')::boolean,false);"),
 ('     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>2)',
  '     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>CASE WHEN v_custody THEN 3 ELSE 2 END)'),
 ('     OR v_e.fee_balance IS DISTINCT FROM 0::numeric',
  '     OR v_e.fee_balance IS DISTINCT FROM (CASE WHEN v_custody AND NOT v_resolved THEN v_h.rake_amount ELSE 0::numeric END)'),
 (rake,"""  IF v_custody THEN
    IF v_accounting->>'status' IS DISTINCT FROM 'fee_custody_unresolved'
      OR (v_accounting->>'held_amount')::numeric IS DISTINCT FROM v_h.rake_amount
      OR v_h.rake_amount IS DISTINCT FROM v_rake_total
      OR v_h.rake_destination IS DISTINCT FROM 'tournament_escrow'
      OR v_h.rake_settled_at IS NOT NULL OR v_h.rake_attributed_at IS NOT NULL
      OR v_h.rake_attributed_users IS DISTINCT FROM 0 OR v_h.escrow_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'terminal unresolved fee proof disagrees with original custody' USING ERRCODE='P0404';
    END IF;
  ELSE
"""+rake+'\n  END IF;\n'),
 ("    'fully_settled',true,", "    'fully_settled',NOT v_custody OR v_resolved,\n    'player_result','final',\n    'accounting_complete',(NOT v_custody AND NOT v_deferred) OR v_resolved,\n    'accounting_state',CASE WHEN v_resolved THEN 'recognized' ELSE v_h.accounting_state END,"),
 ("      'attributed',NOT v_deferred,", "      'attributed',NOT (v_deferred OR v_custody),"),
 ("  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric","""  IF to_regprocedure('smarter_private.breakfast_standings_witness(uuid,uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT smarter_private.breakfast_standings_witness($1,$2)' INTO v_original_witness USING p_tournament_id,v_h.winner_id;
  END IF;
  IF NULLIF(v_h.cash_receipt->'original_witness','null'::jsonb) IS DISTINCT FROM NULLIF(v_original_witness,'null'::jsonb) THEN
    RAISE EXCEPTION 'terminal cash original witness disagrees with immutable standings' USING ERRCODE='P0404';
  END IF;
  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric""")])

# Readiness keeps all player/outcome/bounty checks. Only the exactly verified
# custody receipt distinguishes terminal player readiness from accounting close.
patch('fn_tournament_finish_readiness',[
 ('  v_accounting jsonb; v_deferred boolean := false;', '  v_accounting jsonb; v_deferred boolean := false;v_custody boolean:=false;'),
 ('  SELECT * INTO v_escrow FROM public.tournament_escrow',
  "  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);\n  v_custody:=COALESCE(v_accounting->>'status'='fee_custody_unresolved',false);\n  SELECT * INTO v_escrow FROM public.tournament_escrow"),
 ('     OR abs(round(v_escrow.fee_balance,2)) > 0.005 THEN',
  '     OR (NOT v_custody AND abs(round(v_escrow.fee_balance,2)) > 0.005) THEN'),
 ('  IF NOT v_rake_found OR v_rake_settled_at IS NULL','  IF NOT v_custody AND (NOT v_rake_found OR v_rake_settled_at IS NULL'),
 ('     OR abs(round(COALESCE(v_rake_recorded,0),2) - v_rake_expected) > 0.005 THEN',
  '     OR abs(round(COALESCE(v_rake_recorded,0),2) - v_rake_expected) > 0.005) THEN'),
 ("    'finish_kind',v_kind,'failures',v_failures,", "    'finish_kind',v_kind,'failures',v_failures,\n    'player_result',CASE WHEN jsonb_array_length(v_failures)=0 THEN 'final' ELSE 'unresolved' END,\n    'accounting_complete',NOT v_custody AND NOT v_deferred,'accounting',v_accounting,")])
# Continue only from the original owner after its existing lane/tournament locks.
patch('fn_settle_tournament_rake',[
 (' INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)',
  ' PERFORM public.fn_ca_begin_legacy_fee_resolution(p_tournament_id);\n INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)'),
 (" RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',true,",
  " IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=p_tournament_id AND transaction_id=txid_current()) THEN\n  UPDATE public.tournament_rake_settlements SET terminal_closed_at=(SELECT completed_at FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament_id) WHERE tournament_id=p_tournament_id AND terminal_closed_at IS NULL;\n END IF;\n RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',true,")])
for name,file in [('fn_terminal_tournament_evidence_is_immutable','terminal_tournament_evidence_is_immutable'),('fn_terminal_tournament_escrow_is_immutable','terminal_tournament_escrow_is_immutable'),('fn_satellite_transfer_ledger_is_immutable','satellite_transfer_ledger_is_immutable')]:
 patch(name,[('BEGIN\n',"BEGIN\n  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;\n")])
patch('fn_ca_capture_tournament_fee_from_recorded_evidence',[(
  "  IF upper(COALESCE(t.status::text,'')) NOT IN ('RUNNING','BREAK','REGISTERING','COMPLETING') THEN",
  "  IF upper(COALESCE(t.status::text,'')) NOT IN ('RUNNING','BREAK','REGISTERING','COMPLETING')\n   AND NOT public.fn_ca_legacy_fee_capture_admitted(r.tournament_id) THEN")])
parts.append('COMMIT;\n')
migration=next((root/'supabase/migrations').glob('20260918090848*.sql'))
candidate='\n'.join(parts)
if '--check' in sys.argv:
 assert migration.read_text()==candidate,'Legacy fee custody candidate differs from reviewed composition'
 print('PASS legacy fee custody exact source composition')
else:
 migration.write_text(candidate)
 print(migration)

if '--postimages' in sys.argv:
 target=Path(sys.argv[sys.argv.index('--postimages')+1])
 target.write_text(json.dumps({'kind':'source-generated-postimages-not-installed-proof','migration':str(migration.relative_to(root)),'migration_sha256':__import__('hashlib').sha256(candidate.encode()).hexdigest(),'functions':postimages},indent=2)+'\n')
