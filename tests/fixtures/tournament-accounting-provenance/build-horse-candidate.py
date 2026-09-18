#!/usr/bin/env python3
"""One omitted original horse debit owner; no replacement payer or history seed."""
from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parents[3]
directory=Path(__file__).resolve().parent
rows=json.loads((directory/'captured-horse-preimages.json').read_text())
original=next(r for r in rows if r['signature']=='fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)')
def once(s,a,b):
 assert s.count(a)==1,(a,s.count(a))
 return s.replace(a,b)
def candidate():
 s=original['definition']
 s=once(s,'\nDECLARE\n','\nDECLARE\n  v_original_entitlement uuid; v_original_wallet uuid;\n')
 s=once(s,'    v_ok := public.atomic_deduct_wallet_and_log(',"    PERFORM set_config('app.pnl_tournament_entitlement','',true);\n    v_ok := public.atomic_deduct_wallet_and_log(")
 a="      NULL, NULL, p_tournament_id);"
 assert s.count(a)==2
 s=s.replace(a,a+"\n    v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;",1)
 a='    PERFORM public.log_wallet_transaction('
 s=once(s,a,"    PERFORM set_config('app.pnl_tournament_wallet_tx','',true);\n"+a)
 a="      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),\n      NULL, NULL, p_tournament_id);"
 assert s.count(a)==2
 at=s.index(a,s.index('    PERFORM public.log_wallet_transaction('))+len(a)
 s=s[:at]+"\n    v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;"+s[at:]
 a="  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,"
 s=once(s,a,"  -- This original owner charged chips; the public Diamond refusal and ticket\n  -- owner remain unchanged. Bind only this transaction's actual debit IDs.\n  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,\n    v_split.charge,'chips',v_original_entitlement,v_original_wallet,NULL);\n\n"+a)
 return s
path=root/'supabase/migrations/20260918002654_horse_tournament_entry_retains_original_funding.sql'
def render():
 sig=original['signature']; fingerprint=hashlib.md5(original['definition'].encode()).hexdigest()
 contracts=json.loads((directory/'captured-horse-contracts.json').read_text())
 prerequisites=' OR\n'.join(" md5(pg_get_functiondef('public."+r['signature']+"'::regprocedure)) IS DISTINCT FROM '"+r['definition_md5']+"'" for r in contracts)
 return f'''-- Live entry evidence showed the separate original horse registration owner
-- bypassed the human registration producer installed by20260917233447.
-- Both recurring MTT and seat-first horse callers reach this same chip debit
-- owner. Retain its actual entitlement/wallet/registration IDs prospectively.
-- Preserve all entry, ticket, lease, capacity and financial policy; no backfill.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $precondition$
BEGIN
 IF md5(pg_get_functiondef('public.{sig}'::regprocedure)) IS DISTINCT FROM '{fingerprint}'
 OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM 'postgres'
 OR (SELECT proacl::text FROM pg_proc WHERE oid='public.{sig}'::regprocedure) IS DISTINCT FROM '{{postgres=X/postgres}}' THEN
  RAISE EXCEPTION 'Original horse tournament funding owner changed';
 END IF;
 IF to_regclass('public.tournament_participant_funding_receipts') IS NULL
 OR to_regprocedure('public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb)') IS NULL
 OR {prerequisites} THEN
  RAISE EXCEPTION 'Original tournament provenance33447 prerequisite is missing';
 END IF;
END $precondition$;
{candidate()};
REVOKE ALL ON FUNCTION public.{sig} FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.{sig} TO postgres;
COMMIT;
'''
if __name__=='__main__':
 if '--check' in sys.argv:
  assert path.read_text()==render(),'Original horse funding successor differs from retained source'
  print('PASS original horse funding source binding')
 else:path.write_text(render());print(path)
