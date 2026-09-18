#!/usr/bin/env python3
"""Render guarded original-body extensions; no alternate payer or function rename."""
from pathlib import Path
import json,sys
root=Path(__file__).resolve().parents[3]
fixtures=Path(__file__).resolve().parent
rows=json.loads((fixtures/'captured-preimages.json').read_text())+json.loads((fixtures/'captured-hand-preimages.json').read_text())
out=['-- Prospective original cash participant funding and dealt-hand provenance.\n-- No historical rewrite, new payer, inference from membership, or financial gate removal.\nBEGIN;\nSET LOCAL lock_timeout=\'3s\';\nSET LOCAL search_path=public,pg_temp;\n', (fixtures/'new-authority.sql').read_text()]
def replace_once(text,old,new):
 assert text.count(old)==1,(old,text.count(old)); return text.replace(old,new)
for r in rows:
 sig=r['signature']; text=r['definition']; original=text
 if sig.startswith('fn_club_members_ledger_writer('):
  text=replace_once(text,'  d     numeric;','  v_original_ledger uuid;\n  d     numeric;')
  text=replace_once(text,"'auto-audited club_members.chip_balance delta ' || d::text);", "'auto-audited club_members.chip_balance delta ' || d::text)\n    RETURNING id INTO v_original_ledger;\n    -- Private original-debit callers read this immediately after their UPDATE.\n    PERFORM set_config('app.cash_original_debit_ledger',v_original_ledger::text,true);")
 elif sig.startswith('atomic_table_'):
  kind=sig.split('atomic_table_')[1].split('_before')[0]
  text=replace_once(text,'AS $function$\nDECLARE','AS $function$\nDECLARE\n  v_original_ledger uuid; v_original_wallet uuid; v_original_pending uuid;')
  text=replace_once(text,'  UPDATE club_members\n',"  PERFORM set_config('app.cash_original_debit_ledger','',true);\n  UPDATE club_members\n")
  text=replace_once(text,'   RETURNING chip_balance INTO v_new_balance;',"   RETURNING chip_balance INTO v_new_balance;\n  v_original_ledger:=NULLIF(current_setting('app.cash_original_debit_ledger',true),'')::uuid;")
  label={'buyin':'Cash game buy-in (club wallet)','rebuy':'Cash game rebuy (club wallet)','addon':'Table add-on (club wallet)'}[kind]
  pending='v_pending' if kind=='rebuy' else 'v_original_pending'
  if kind=='addon':
   text=replace_once(text,'VALUES (p_table_id, p_user_id, p_amount);','VALUES (p_table_id, p_user_id, p_amount) RETURNING id INTO v_original_pending;')
  anchor=f"'{label}', p_table_id, v_new_balance);"
  addition=f"'{label}', p_table_id, v_new_balance) RETURNING id INTO v_original_wallet;\n\n  PERFORM public.fn_cash_record_original_funding('{kind}',p_idempotency_key::text,p_user_id,p_table_id,\n    v_original_ledger,v_original_wallet,v_seat_club,p_amount,v_new_balance,{pending});"
  text=replace_once(text,anchor,addition)
 elif sig.startswith('fn_horse_fund_from_treasury_before'):
  text=replace_once(text,'DECLARE','DECLARE\n  v_original_ledger uuid;')
  anchor="        'treasury_after', v_treasury - p_amount\n      )\n    );"
  text=replace_once(text,anchor,"        'treasury_after', v_treasury - p_amount\n      )\n    ) RETURNING id INTO v_original_ledger;\n    PERFORM public.fn_cash_record_original_funding('horse_funding',p_op_id::text,p_user_id,p_table_id,\n      v_original_ledger,NULL,v_fund_club,p_amount,v_treasury-p_amount,NULL);")
 elif sig.startswith('fn_ca_commit_hand_settlement_before_lease_generation'):
  anchor='    VALUES (p_table_id,p_hand_number,v_hand_id,v_commit_hash,v_stack_result);'
  text=replace_once(text,anchor,anchor+"\n\n    PERFORM public.fn_cash_accept_hand_provenance(p_table_id,p_hand_number,v_hand_id,\n      v_normalized_stacks,p_rake,p_bbj,p_inflow,v_commit_hash,\n      jsonb_build_object(\n        'table_id',p_table_id,'hand_number',p_hand_number,\n        'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,\n        'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,\n        'units',v_normalized_units));")
 elif sig.startswith('resolve_pending_addon('):
  text=replace_once(text,'DECLARE','DECLARE\n  v_original_occupancy uuid;')
  anchor='         AND left_at IS NULL;'
  text=replace_once(text,anchor,'         AND left_at IS NULL RETURNING occupancy_id INTO v_original_occupancy;')
  anchor='   WHERE id = v_row.id;'
  text=replace_once(text,anchor,anchor+'\n  PERFORM public.fn_cash_record_funding_application(v_row.id,v_applied,v_refunded,v_original_occupancy);')
 else: continue
 assert text!=original
 # Check the installed function's exact body/config/ACL/owner before any replacement.
 pre=f"""DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.{sig}'::regprocedure)) IS DISTINCT FROM '{r['md5']}'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM '{r['owner']}'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM '{r['acl']}' THEN
  RAISE EXCEPTION 'Original funding prerequisite changed: {sig}';
 END IF;
END $precondition$;
"""
 out += [pre,text+';\n']
out.append('COMMIT;\n')
path=root/'supabase/migrations/20260917230925_cash_funding_retains_original_participant_custody.sql'
rendered='\n'.join(out)
if '--check' in sys.argv:
 assert path.read_text()==rendered,'Retained original-body candidate differs from reviewed generator/source fixtures'
 print('PASS original funding candidate/source binding')
else:
 path.write_text(rendered)
 print(path)
