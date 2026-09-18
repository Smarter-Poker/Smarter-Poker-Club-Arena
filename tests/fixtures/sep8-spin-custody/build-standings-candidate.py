#!/usr/bin/env python3
"""Compose the exact five original standings with the qualified Breakfast payer."""
from pathlib import Path
import argparse, hashlib, json

ROOT=Path(__file__).resolve().parents[3]
FIX=ROOT/'tests/fixtures/sep8-spin-custody'
INPUT=FIX/'standings-inputs'
MIGRATION=ROOT/'supabase/migrations/20260918122532_five_original_spin_standings_retain_their_recorded_cash_outc.sql'
def literal(text): return "'"+text.replace("'","''")+"'"
def patch(text,old,new):
 if text.count(old)!=1: raise ValueError('Original cash seam changed: '+old[:100])
 return text.replace(old,new,1)
def build():
 binding=json.loads((INPUT/'binding.json').read_text())
 for name,sha in binding['original_files'].items():
  if hashlib.sha256((INPUT/name).read_bytes()).hexdigest()!=sha: raise ValueError('Original packet changed: '+name)
 cash=(INPUT/'breakfast-cash-predecessor.sql').read_text()
 if hashlib.sha256(cash.encode()).hexdigest()!=binding['breakfast_cash_sha256']:raise ValueError('Original Breakfast cash changed')
 cash=patch(cash,'  v_original_witness jsonb;','  v_original_witness jsonb;\n  v_original_standings jsonb;')
 cash=patch(cash,'    IF v_original_witness IS NULL THEN',
  '    v_original_standings:=smarter_private.spin_original_standings_witness(p_tournament_id,p_observed_winner_id);\n    IF v_original_witness IS NULL AND v_original_standings IS NULL THEN')
 cash=patch(cash,"  RETURN jsonb_build_object(\n    'ok',true,\n    'fully_settled',true,",
  "  v_original_standings:=smarter_private.spin_original_standings_witness(p_tournament_id,p_observed_winner_id);\n  RETURN jsonb_build_object(\n    'ok',true,\n    'fully_settled',true,")
 cash=patch(cash,"jsonb_build_object('original_witness',v_original_witness) END;",
  "jsonb_build_object('original_witness',v_original_witness) END || CASE WHEN v_original_standings IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('original_standings',v_original_standings) END;")
 raw={name:(INPUT/name).read_text().strip() for name in binding['original_files']}
 retained='''CREATE FUNCTION smarter_private.spin_original_retained_case(p_tournament uuid) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $retained$
 WITH c AS(SELECT v FROM jsonb_array_elements(CASE_PACKET::jsonb) v WHERE v->>'id'=p_tournament::text),
 p AS(SELECT v FROM jsonb_array_elements(PHYSICAL_PACKET::jsonb) v WHERE v->>'id'=p_tournament::text),
 f AS(SELECT v FROM jsonb_array_elements(FINANCIAL_PACKET::jsonb) v WHERE v->>'id'=p_tournament::text),
 h AS(SELECT v FROM jsonb_array_elements(LATER_PACKET::jsonb) v WHERE v->>'id'=p_tournament::text)
 SELECT jsonb_build_object(
 'tournament',(c.v->'tournament')-ARRAY['updated_at','current_level'],
 'roster',smarter_private.spin_original_sorted(c.v->'roster','id'),
 'candidates',smarter_private.spin_original_sorted(c.v->'candidates','id'),
 'escrow',c.v->'escrow','entry_close',c.v->'entry_close',
 'payouts',smarter_private.spin_original_sorted(c.v->'payouts','id'),
 'obligations',smarter_private.spin_original_sorted(c.v->'obligations','id'),
 'wallet_keys',smarter_private.spin_original_sorted(c.v->'wallet_keys','key'),
 'rake_records',smarter_private.spin_original_sorted(c.v->'rake_records','id'),
 'rake_settlement',c.v->'rake_settlement','terminal',c.v->'terminal',
 'tables',(SELECT jsonb_agg(e.value-'updated_at' ORDER BY e.value->>'id') FROM jsonb_array_elements(p.v->'tables') e(value)),
 'seats',smarter_private.spin_original_sorted(p.v->'seats','id'),
 'atomic',smarter_private.spin_original_sorted(h.v->'latest_atomic_inventory','hand_id'),
 'history',smarter_private.spin_original_sorted(h.v->'latest_history_inventory','id'),
 'settlement_keys',smarter_private.spin_original_sorted(h.v->'settlement_keys','hand_id'),
 'ledger',smarter_private.spin_original_sorted(f.v->'ledger','id')) FROM c,p,f,h
$retained$;
REVOKE ALL ON FUNCTION smarter_private.spin_original_retained_case(uuid) FROM PUBLIC,anon,authenticated,service_role;
'''
 for seam,name in [('CASE_PACKET','original-cases.json'),('PHYSICAL_PACKET','physical.json'),('FINANCIAL_PACKET','financial.json'),('LATER_PACKET','later-hand-inventory.json')]:retained=retained.replace(seam,literal(raw[name]))
 helper="""CREATE FUNCTION smarter_private.spin_original_sorted(p_array jsonb,p_key text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT coalesce(jsonb_agg(v ORDER BY v->>p_key),'[]') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_array)='array' THEN p_array ELSE '[]'::jsonb END) v
$fn$;
REVOKE ALL ON FUNCTION smarter_private.spin_original_sorted(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
"""
 pre="""-- Five original September 8 Spin standings; one unchanged canonical payer.
-- Prerequisites: eight-event custody, exact Breakfast cash, five-Spin custody.
-- This migration creates no historical hand, rank, candidate, sequence or payout.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $installed$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_settle_tournament_places(uuid,uuid)'::regprocedure
 AND md5(pg_get_functiondef(p.oid))=CASH_MD5 AND pg_get_userbyid(p.proowner)='postgres'
 AND p.proconfig=ARRAY['search_path=public','statement_timeout=30s']
 AND (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)='["postgres=X/postgres","service_role=X/postgres"]'::jsonb)
 OR to_regprocedure('smarter_private.breakfast_standings_witness(uuid,uuid)') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_sep8_spin_original_fee_proof(uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='3224402eb784a60fbbc129135df632fb')
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_terminal_receipt(uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='7e3c5da7f79762ec5197febb2f46019f') THEN
 RAISE EXCEPTION 'SPIN_ORIGINAL_STANDINGS_PREDECESSOR_CHANGED' USING ERRCODE='55000'; END IF;
END $installed$;
""".replace('CASH_MD5',literal(binding['breakfast_cash_definition_md5']))
 return pre+helper+retained+(FIX/'g8-original-standings-authority.sql').read_text()+ '\n'+cash+''';
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO service_role;
COMMIT;
'''
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');a=p.parse_args();text=build()
 if a.check:
  if MIGRATION.read_text()!=text:raise SystemExit('Five Spin standings candidate differs')
  print('PASS exact five Spin standings source composition')
 else:MIGRATION.write_text(text)
