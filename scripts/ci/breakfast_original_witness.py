"""Generate the one finite original-witness continuation from retained inputs.
No database connection. Native execution belongs to the existing PG17 owner.
"""
from pathlib import Path
import hashlib
import json
import re

DATA=Path('scripts/ci/fixtures/breakfast-original-witness')
MIGRATION=Path('supabase/migrations/20260918085646_breakfast_retains_its_original_rank_and_paid_contract.sql')
AUTHORITY=Path('scripts/ci/probes/breakfast-original-witness/authority.sql')
ROSTER_KEYS='id user_id club_id tournament_id status position chips chip_count prize table_id seat_number registered_at eliminated_at elimination_sequence rebuys add_on rebuy_prompt_until current_bounty bounty_winnings bounties_collected source_satellite_id is_satellite_qualifier'.split()
def literal(s): return "'"+s.replace("'","''")+"'"
def js(v): return literal(json.dumps(v,separators=(',',':')))+'::jsonb'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def retained(root):
 c=json.loads((root/DATA/'case.json').read_text());physical=json.loads((root/DATA/'physical.json').read_text())['evidence'];conflicts=json.loads((root/DATA/'conflicts.json').read_text())['evidence']
 return {'roster':sorted([{k:p[k] for k in ROSTER_KEYS} for p in c['players']],key=lambda p:p['id']),
 'entry':c['entry_receipt'],'payouts':sorted(c['payouts'],key=lambda p:p['id']),
 'obligations':sorted(c['obligations'],key=lambda p:p['id']),
 'wallet_keys':sorted(c['wallet_credit_idempotency'],key=lambda p:p['key']),
 'fee_charges':sorted(c['fee_charges'],key=lambda p:p['id']),
 'seats':sorted(physical['seats'],key=lambda p:p['id']),
 'historical_snapshots':sorted(conflicts['active_snapshots'],key=lambda p:p['id']),
 'original_structure':json.loads(c['payouts'][0]['payout_structure']['payout_structure'])}
def patch(old,seam,new):
 if old.count(seam)!=1: raise ValueError('exact installed seam differs: '+seam[:100])
 return old.replace(seam,new,1)
def terminal_postimages(root):
 # Preserve the original observed catalog. This separate source-only overlay
 # binds the exact Union dependency; it does not assert it is installed live.
 capture=json.loads((Path(root)/DATA/'installed-terminal.json').read_text())
 frozen=json.loads((Path(root)/DATA/'qualified-fee-custody-postimages.json').read_text())
 source=Path(root)/DATA/'qualified-fee-custody-source.sql'
 if sha(source)!=frozen['migration_sha256']:raise ValueError('frozen custody source changed')
 for r in capture['evidence']['functions']:
  if r['signature'] in frozen['functions']:r['definition']=frozen['functions'][r['signature']]
 for r in capture['evidence']['guards']:
  name=re.search(r'FUNCTION\s+(?:public\.)?([^\s(]+)\(',r['function']).group(1)+'()'
  if name in frozen['functions']:r['function']=frozen['functions'][name]
 return capture
def build(root):
 root=Path(root);capture=terminal_postimages(root);rows=capture['evidence']['functions'];functions={r['signature']:r for r in rows}
 cash=functions['fn_settle_tournament_places(uuid,uuid)']['definition']
 cash=patch(cash,'  v_misplaced_busts integer;','  v_misplaced_busts integer;\n  v_original_witness jsonb;')
 start='    -- Final numeric positions are derived from the transition witness, not'
 finish='  -- Derive the single pool-funded bubble promise after standings are final.'
 a=cash.index(start);b=cash.index(finish)
 original=cash[a:b]
 if not original.endswith('  END IF;\n\n'): raise ValueError('cash sequence boundary changed')
 inner=original[:-len('  END IF;\n\n')]
 cash=cash[:a]+'''    v_original_witness:=smarter_private.breakfast_standings_witness(p_tournament_id,p_observed_winner_id);
    IF v_original_witness IS NULL THEN
'''+inner+'''    END IF;
  END IF;

'''+cash[b:]
 cash=patch(cash,"    -- Re-lock/prove the complete set immediately before any raw payer runs.","    -- Re-lock/prove the complete set immediately before any raw payer runs.")
 seam="""      UPDATE public.tournament_obligations o
         SET amount_owed = v_row.amount,"""
 cash=patch(cash,seam,"""      IF v_original_witness IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id=p_tournament_id AND o.kind='place' AND o.place=v_row.place
        AND o.amount_owed=v_row.amount AND o.amount_paid=v_row.amount AND o.settled_at IS NOT NULL) THEN
        v_rows:=1; -- Preserve already-paid original obligation metadata.
      ELSE
"""+seam)
 cash=patch(cash,"""      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN""","""      GET DIAGNOSTICS v_rows = ROW_COUNT;
      END IF;
      IF v_rows = 0 THEN""")

 cash=patch(cash,"  RETURN jsonb_build_object(\n    'ok',true,\n    'fully_settled',true,","  v_original_witness:=smarter_private.breakfast_standings_witness(p_tournament_id,p_observed_winner_id);\n  RETURN jsonb_build_object(\n    'ok',true,\n    'fully_settled',true,")
 cash=patch(cash,"    'winner_amount',v_winner_amount);","    'winner_amount',v_winner_amount) || CASE WHEN v_original_witness IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('original_witness',v_original_witness) END;")
 expected=[]
 for r in rows:
  if r['signature'] in ['fn_settle_tournament_places(uuid,uuid)','fn_ca_tournament_terminal_receipt(uuid,uuid)','fn_complete_tournament_terminal(uuid,uuid,text)','fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)','fn_complete_tournament_entry_reprice(uuid)','fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)','fn_ca_close_tournament_seat_exit_authority(uuid,boolean)']:
   expected.append({'signature':'public.'+r['signature'],'md5':hashlib.md5(r['definition'].encode()).hexdigest(),'owner':r['owner'],'acl':sorted(r['acl'] or []),'config':r['config']})
 for r in capture['evidence']['guards']:
  sig=re.search(r'FUNCTION\s+([^\s(]+)\(',r['function']).group(1)+'()'
  entry={'signature':sig,'md5':hashlib.md5(r['function'].encode()).hexdigest(),'owner':r['owner'],'acl':sorted(r['acl'] or []),'config':r['config']}
  if not any(x['signature']==sig for x in expected):expected.append(entry)
 guards=[{'table':r['table'],'name':r['name'],'enabled':r['enabled'],'definition':r['definition']} for r in capture['evidence']['guards']]
 header='''-- The original Breakfast engine requested rank 21 and zero prize on September 8.
-- Its live-seat roster rejection rolled that attempt back. Later retries must not
-- replace that witness or the 32 already-recorded ranks. Four immutable payouts
-- agree on the original five-place contract; only the later PENDING entry-close
-- snapshot has four places. This explicit transaction restores that pending
-- contract and invokes the existing terminal payer. It creates no old hand,
-- knockout candidate, historical sequence, fee terms or chip adjustment.
-- The unexplained 22,255 chip excess remains unchanged, recorded, not legitimized.
-- The prerequisite v3 terminal keeps the original 17 fee chips in custody;
-- final player results do not certify unknown historical earning terms.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
'''
 pre='DO $installed$ DECLARE r jsonb; BEGIN\n FOR r IN SELECT value FROM jsonb_array_elements('+js(expected)+''') LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(r->>'signature')
 AND md5(pg_get_functiondef(p.oid))=r->>'md5' AND pg_get_userbyid(p.proowner)=r->>'owner'
 AND to_jsonb(p.proconfig) IS NOT DISTINCT FROM r->'config'
 AND (SELECT jsonb_agg(x::text ORDER BY x::text) FROM unnest(p.proacl) x) IS NOT DISTINCT FROM r->'acl') THEN
 RAISE EXCEPTION 'BREAKFAST_INSTALLED_AUTHORITY_CHANGED: %',r->>'signature' USING ERRCODE='55000'; END IF; END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements('''+js(guards)+''') LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=to_regclass('public.'||(r->>'table'))
 AND g.tgname=r->>'name' AND g.tgenabled::text=r->>'enabled' AND pg_get_triggerdef(g.oid)=r->>'definition') THEN
 RAISE EXCEPTION 'BREAKFAST_INSTALLED_GUARD_CHANGED: %',r->>'name' USING ERRCODE='55000'; END IF; END LOOP;
END $installed$;
'''
 casefn='CREATE FUNCTION smarter_private.breakfast_retained_case() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $case$ SELECT '+js(retained(root))+' $case$;\nREVOKE ALL ON FUNCTION smarter_private.breakfast_retained_case() FROM PUBLIC,anon,authenticated,service_role;\n'
 registry="INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES('fn_complete_breakfast_original_witness','approved','Exact original Breakfast witness; unchanged terminal payers and immutable receipt; no generic adjudication') ON CONFLICT(proname) DO NOTHING;\n"
 # These CREATE TRIGGER strings are read-only catalog comparison operands,
 # never executed DDL. Declare that fact using the maintained scanner contract.
 catalog_notes=''.join('-- money-trigger-ok: '+r['table']+'.'+r['name']+' because This retained catalog string is compared for equality only; no trigger is created or altered here.\n' for r in guards)
 # CREATE OR REPLACE retains the existing ACL, but make the original service-only
 # boundary explicit for the migration authorization checker and future installs.
 cash_acl='\nREVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM PUBLIC,anon,authenticated;\nGRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO service_role;\n'
 candidate=header+catalog_notes+pre+casefn+registry+(root/AUTHORITY).read_text()+'\n'+cash+';\n'+cash_acl+'COMMIT;\n'
 return candidate
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[2]);p.add_argument('--check',action='store_true');a=p.parse_args();s=build(a.root)
 if a.check:
  if (a.root/MIGRATION).read_text()!=s: raise SystemExit('Breakfast generated migration differs')
  print('Breakfast exact installed-preimage generation PASS')
 else: (a.root/MIGRATION).write_text(s)
