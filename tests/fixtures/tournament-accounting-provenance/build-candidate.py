#!/usr/bin/env python3
"""Extend exact installed original owners, preserving function identity and ACL."""
from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parents[3]
fixtures=Path(__file__).resolve().parent
rows=json.loads((fixtures/'captured-preimages.json').read_text())
assert all(hashlib.md5(r['definition'].encode()).hexdigest()==r['md5'] for r in rows)
def once(s,a,b):
 assert s.count(a)==1,(a,s.count(a))
 return s.replace(a,b)
def candidate(r):
 s=r['definition'];name=r['signature'].split('(')[0]
 if name=='fn_ca_capture_tournament_charge_entitlement':
  s=once(s,'  v_split record;','  v_split record;\n  v_original_entitlement uuid;')
  s=once(s,"'wallet_gross','atomic_wallet_charge',transaction_timestamp());","'wallet_gross','atomic_wallet_charge',transaction_timestamp()) RETURNING id INTO v_original_entitlement;\n  PERFORM set_config('app.pnl_tournament_entitlement',v_original_entitlement::text,true);")
 elif name=='log_wallet_transaction':
  s=once(s,'DECLARE v_bal NUMERIC;','DECLARE v_original_wallet uuid; v_bal NUMERIC;')
  s=once(s,'COALESCE(v_bal, 0), NOW());',"COALESCE(v_bal, 0), NOW()) RETURNING id INTO v_original_wallet;\n  PERFORM set_config('app.pnl_tournament_wallet_tx',v_original_wallet::text,true);")
 elif name=='fn_register_for_tournament_before_atomic_capacity_20260907':
  s=once(s,'DECLARE','DECLARE\n  v_original_entitlement uuid; v_original_wallet uuid;')
  s=once(s,'    v_ok := public.atomic_deduct_wallet_and_log(',"    PERFORM set_config('app.pnl_tournament_entitlement','',true);\n    v_ok := public.atomic_deduct_wallet_and_log(")
  a="      NULL, NULL, p_tournament_id);"
  assert s.count(a)==2
  s=s.replace(a,a+"\n    v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;",1)
  a="      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),\n      NULL, NULL, p_tournament_id);"
  s=once(s,a,a+"\n    v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;")
  a="  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,"
  s=once(s,a,"  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,\n    v_split.charge,CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END,\n    v_original_entitlement,v_original_wallet,v_dia);\n\n"+a)
 elif name=='fn_ca_process_tournament_chip_purchase_money_v1':
  s=once(s,'DECLARE','DECLARE\n  v_original_entitlement uuid; v_original_wallet uuid;')
  a='  UPDATE public.club_members\n'
  s=once(s,a,"  PERFORM set_config('app.pnl_tournament_entitlement','',true);\n"+a)
  a='  GET DIAGNOSTICS v_rows=ROW_COUNT;'
  assert s.count(a)==2
  s=s.replace(a,a+"\n  v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;",1)
  s=once(s,'    p_tournament_id,v_balance-v_total);','    p_tournament_id,v_balance-v_total) RETURNING id INTO v_original_wallet;')
  a="  RETURN jsonb_build_object(\n    'success',true,'new_stack',v_new_chips"
  s=once(s,a,"  PERFORM public.fn_ca_record_tournament_participant_funding(v_p.id,p_rebuy_type,v_key,\n    v_total,CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END,\n    v_original_entitlement,v_original_wallet,v_dia);\n\n"+a)
 elif name=='fn_credit_and_log':
  s=once(s,'DECLARE','DECLARE\n  v_original_ledger uuid; v_original_wallet uuid;')
  a='  v_credited := public.fn_credit_player_wallet_once('
  s=once(s,a,"  PERFORM set_config('app.pnl_tournament_credit_ledger','',true);\n"+a)
  a='    p_user_id, p_amount, p_idempotency_key);'
  s=once(s,a,a+"\n  v_original_ledger:=NULLIF(current_setting('app.pnl_tournament_credit_ledger',true),'')::uuid;")
  a='    p_table_id, p_hand_id, p_related_entity_id);'
  s=once(s,a,a+"\n  v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;")
  a='  RETURN true;'
  s=once(s,a,"  IF NOT v_diamond AND p_related_entity_id IS NOT NULL\n     AND v_ledger_cat IN ('tournament_prize','bounty','refund','tournament_refund') THEN\n    PERFORM public.fn_ca_record_tournament_accounting_credit(p_idempotency_key,\n      p_related_entity_id,p_user_id,p_amount,v_original_ledger,v_original_wallet,v_payout_id);\n  END IF;\n"+a)
 elif name=='fn_settle_tournament_obligation_before_atomic_batch_gate':
  a='  UPDATE public.tournament_obligations\n     SET amount_paid = amount_paid + v_pay,'
  s=once(s,a,"  PERFORM set_config('app.pnl_tournament_obligation_credit_key',v_key,true);\n"+a)
  a='   WHERE id = v_ob.id;\n  IF v_adj.id IS NOT NULL THEN'
  s=once(s,a,"   WHERE id = v_ob.id;\n  PERFORM set_config('app.pnl_tournament_obligation_credit_key','',true);\n  IF v_adj.id IS NOT NULL THEN")
 else: raise AssertionError(name)
 return s
def original_acl_sql():
 out=[]
 for r in rows:
  acl=r['acl'] if isinstance(r['acl'],list) else r['acl'].strip('{}').split(',')
  assert set(acl).issubset({'postgres=X/postgres','service_role=X/postgres'})
  roles=','.join(a.split('=')[0] for a in acl)
  out.append(f"REVOKE ALL ON FUNCTION public.{r['signature']} FROM PUBLIC,anon,authenticated,service_role;\nGRANT EXECUTE ON FUNCTION public.{r['signature']} TO {roles};")
 return '\n'.join(out)
def render():
 out=["-- Original tournament financial identities and liability transitions, prospectively captured.\n-- No historical seed, new payer, commercial ownership assumption or gameplay policy.\nBEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL search_path=public,pg_temp;\n"]
 # Every original owner/config/ACL is checked before any changes.
 for r in rows:
  acl=r['acl']
  if isinstance(acl,list):acl='{'+','.join(acl)+'}'
  out.append(f"""DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.{r['signature']}'::regprocedure)) IS DISTINCT FROM '{r['md5']}'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{r['signature']}'::regprocedure) IS DISTINCT FROM '{r['owner']}'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.{r['signature']}'::regprocedure) IS DISTINCT FROM '{acl}' THEN
  RAISE EXCEPTION 'Original tournament prerequisite changed: {r['signature']}';
 END IF;
END $precondition$;
""")
 out.append((fixtures/'new-authority.sql').read_text())
 out.extend(candidate(r)+';\n' for r in rows)
 out.append(original_acl_sql())
 out.append('COMMIT;\n')
 return '\n'.join(out)
if __name__=='__main__':
 path=root/'supabase/migrations/20260917233447_tournament_original_funding_and_obligation_receipts.sql'
 rendered=render()
 if '--check' in sys.argv:
  assert path.read_text()==rendered,'Tournament candidate differs from retained exact source'
  print('PASS tournament original-source binding')
 else:path.write_text(rendered);print(path)
