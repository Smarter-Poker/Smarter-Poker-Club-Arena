from pathlib import Path
import json,subprocess
import os,shutil
p=Path(__file__).resolve().parent
b=p/'fixtures'
socket=Path(os.environ['ORB_NATIVE_SOCKET'])
pg=Path(os.environ.get('PG_BIN',str(Path(shutil.which('psql') or '/opt/homebrew/opt/postgresql@17/bin/psql').parent)))
args=[str(pg/'psql'),'-X','-q','-h',str(socket),'-p',os.environ.get('ORB_NATIVE_PORT','55931'),'-U','postgres','-v','ON_ERROR_STOP=1']
items=json.loads((b/'source-rows-1578.jsonb').read_text());assert len(items)==1578
maps={'inventory_event':'public.union_pnl_inventory_events','original_hand_qualification':'smarter_private.retirement_original_hand_qualification','original_hand_restoration':'smarter_private.retirement_original_hand_restorations','cancellation_receipt':'public.tournament_cancellation_receipts','chip_ledger':'public.chip_ledger','wallet_transaction':'public.wallet_transactions','tournament_funding':'public.tournament_participant_funding_receipts','terminal_settlement':'public.tournament_terminal_settlements','tournament_payout':'public.tournament_payouts','tournament_credit':'public.tournament_accounting_credit_receipts','undealt_qualification':'smarter_private.retirement_undealt_paid_entry_qualification','undealt_restoration':'smarter_private.retirement_undealt_paid_entry_restorations','chip_transaction':'public.chip_transactions','cash_manifest':'public.cash_hand_participant_manifests','mint_ledger':'public.ca_mint_ledger','wallet_credit_idempotency':'public.wallet_credit_idempotency','cash_qualification':'smarter_private.retired_cash_hand_qualification','cash_funding':'public.cash_participant_funding_receipts','cash_custody':'smarter_private.retired_cash_hand_custody','satellite_settlement':'public.tournament_satellite_settlements','satellite_award':'public.tournament_satellite_awards','tournament_ticket':'public.tournament_tickets','atomic_economics':'public.hand_atomic_commits'}
r=subprocess.run(args+['-d','postgres'],input='DROP DATABASE IF EXISTS original_source_refs;CREATE DATABASE original_source_refs OWNER postgres;',text=True,capture_output=True);assert r.returncode==0,r.stderr
s=(p/'finite-source-actual-schema.sql').read_text()
for x in items:
 kind=x['ref']['kind'];raw=x['economic_raw'];assert raw
 if kind=='signed_economics':
  s+="WITH f AS(SELECT $original$"+raw+"$original$::jsonb j) INSERT INTO smarter_private.hand_submissions(submission_id,request_hash,table_id,hand_number,lease_generation,request) SELECT(j->>'submission_id')::uuid,j->>'request_hash',(j->>'table_id')::uuid,(j->>'hand_number')::bigint,(j->>'lease_generation')::uuid,jsonb_build_object('p_stacks',j->'stacks','p_hand_row',jsonb_build_object('started_at',j->'started_at')) FROM f;\n"
 else:
  table=maps[kind];s+='INSERT INTO '+table+' SELECT(jsonb_populate_record(NULL::'+table+',$original$'+raw+'$original$::jsonb)).*;\n'
for version in ['20261007024455','20261007132839']:
 paths=list(p.parents[2].joinpath('supabase/migrations').glob(version+'*'));assert len(paths)==1
 raw=paths[0].read_text();s+="INSERT INTO supabase_migrations.schema_migrations(version,statements) VALUES('"+version+"',ARRAY[$migration$"+raw+"$migration$]);\n"
s+=(p/'source-ref-reader-proposal.sql').read_text()
s+='DO $test$DECLARE actual text;BEGIN\n'
for x in items:
 ref=x['ref'];s+="actual:=smarter_private.original_inventory_source_ref_md5($ref$%s$ref$::jsonb);IF actual IS DISTINCT FROM '%s' THEN RAISE EXCEPTION 'source ref %s %s mismatch %%',actual;END IF;\n"%(json.dumps(ref,separators=(',',':')),x['md5'],ref['kind'],ref['id'])
s+="RAISE NOTICE 'PASS1578 actualoriginal typedsource refs/digests';END $test$;"
r=subprocess.run(args+['-d','original_source_refs'],input=s,text=True,capture_output=True);(socket/'finite1578-source-native.log').write_text(r.stdout+r.stderr);print(r.returncode,(r.stdout+r.stderr)[-2000:]);raise SystemExit(r.returncode)
