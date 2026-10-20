"""Exact production delivery/readers: private provenance exclusion and unchanged access."""
from pathlib import Path
import argparse,json,os,subprocess,tempfile,re
ROOT=Path(__file__).resolve().parents[2]; FX=ROOT/'scripts/ci/fixtures/statement-provenance-delivery'
MIG=ROOT/'supabase/migrations/20261020184651_statement_provenance_stays_out_of_messenger.sql'
p=argparse.ArgumentParser();p.add_argument('--pg-bin',default='/opt/homebrew/opt/postgresql@17/bin');p.add_argument('--scratch',type=Path,required=True);p.add_argument('--derive',action='store_true');a=p.parse_args();a.scratch.mkdir(parents=True,exist_ok=True);pg=Path(a.pg_bin)
old=json.loads((FX/'actual-preimages.json').read_text());new=json.loads((FX/'new-definitions.json').read_text());cases=[]
def lit(s):return "'"+s.replace("'","''")+"'"
with tempfile.TemporaryDirectory(prefix='sd-',dir=a.scratch) as tmp:
 r=Path(tmp);d=r/'d';s=r/'s';s.mkdir();env=dict(os.environ,PGHOST=str(s),PGUSER='postgres',PGDATABASE='postgres',PGSSLMODE='disable')
 def run(cmd,sql=None,fail=None):
  x=subprocess.run(list(map(str,cmd)),input=sql,text=True,capture_output=True,env=env,timeout=45)
  if fail:assert x.returncode and fail in x.stderr,(fail,x.stderr)
  else:assert x.returncode==0,(x.stdout,x.stderr)
  return x.stdout.strip()
 def q(sql,fail=None):return run([pg/'psql','-X','-Atq','-v','ON_ERROR_STOP=1'],sql,fail)
 def hashes():return [q('SELECT md5(pg_get_functiondef('+lit('public.'+o['signature'])+'::regprocedure))') for o in old]
 run([pg/'initdb','-D',d,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with (d/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(s)+"'\n")
 run([pg/'pg_ctl','-D',d,'-l',r/'log','-w','start'])
 try:
  q((FX/'setup.sql').read_text());q((ROOT/'tests/fixtures/accounting-delivery/diamond-games/invoice-schema.sql').read_text())
  q("ALTER TABLE settlement_invoices ADD COLUMN IF NOT EXISTS source_credit_reduction_operation_id uuid; ALTER TABLE accounting_invoice_deliveries ADD COLUMN IF NOT EXISTS delivery_mode text DEFAULT 'immediate';")
  for o in old:q(o['definition']+';');q('REVOKE ALL ON FUNCTION public.'+o['signature']+' FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.'+o['signature']+' TO service_role'+('' if o['signature'].startswith('fn_deliver') else ',authenticated')+';')
  assert hashes()==[o['md5'] for o in old]
  for o in new:q(o['definition']+';')
  post=hashes()
  if a.derive:print(json.dumps({'postimages':post}));raise SystemExit
  raw=MIG.read_text();assert all(x in raw for x in post)
  for o in old:q(o['definition']+';')
  # Real cashout delivery exercises actual metadata -> message + both notification copies.
  q("INSERT INTO settlement_invoices(id,club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,net_amount,breakdown,status) VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','cashier_cashout','club','00000000-0000-0000-0000-000000000002','player','00000000-0000-0000-0000-000000000004',20,'{\"cashier\":{\"event\":\"fixture\"},\"standalone_bank_ledger_ids\":[\"ledger\"],\"standalone_bank_mint_ids\":[\"mint\"],\"source_ledger_ids\":[\"source\"],\"private_bank_ledger_ids\":[\"private\"],\"total_rake_funding\":4078.94}','generated'); INSERT INTO accounting_cashier_events(id,club_id,amount,audience_user_ids,issuer_representative_id,issuer_name,player_name,event_kind,invoice_id) VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000002',20,ARRAY['00000000-0000-0000-0000-000000000004'::uuid],'00000000-0000-0000-0000-000000000003','Club','Player','approval','00000000-0000-0000-0000-000000000001');")
  call="SET request.jwt.claim.role='service_role';SELECT fn_deliver_accounting_invoice('00000000-0000-0000-0000-000000000001');"
  q('BEGIN;'+call+"DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM social_messages WHERE media_metadata->'lines' ? 'standalone_bank_ledger_ids') THEN RAISE EXCEPTION 'old leak not reproduced'; END IF;END$$;ROLLBACK;")
  cases.append('actual_original_writer_reproduces_new_provenance_leak')
  q(raw.replace(post[2],'0'*32),'statement_delivery_postimage_required');assert hashes()==[o['md5'] for o in old];cases.append('postimage_fault_rolls_back_all_three_owners')
  q('BEGIN;GRANT EXECUTE ON FUNCTION public.fn_messenger_search_messages(uuid,uuid[],text,integer) TO anon;'+raw,'statement_delivery_authority_changed');assert hashes()==[o['md5'] for o in old];cases.append('authority_fault_rolls_back_earlier_owner_patch')
  q(raw);assert hashes()==post
  q(raw,'statement_delivery_preimage_changed');cases.append('exact_guard_install_and_replay_refusal')
  q(call);q(call)
  assert q("SELECT count(*) FROM social_messages")=='1';assert q("SELECT count(*) FROM notifications")=='1';cases.append('actual_writer_duplicate_delivery_no_new_message_or_notification')
  assert q("SELECT bool_and(NOT(media_metadata->'lines' ?| ARRAY['standalone_bank_ledger_ids','standalone_bank_mint_ids','source_ledger_ids','private_bank_ledger_ids'])) FROM social_messages")=='t'
  assert q("SELECT bool_and(NOT(data->'lines' ?| ARRAY['standalone_bank_ledger_ids','standalone_bank_mint_ids']) AND NOT(metadata->'lines' ?| ARRAY['standalone_bank_ledger_ids','standalone_bank_mint_ids'])) FROM notifications")=='t'
  assert q("SELECT breakdown->>'total_rake_funding'||':'||(breakdown ? 'standalone_bank_ledger_ids')::text||':'||(breakdown ? 'standalone_bank_mint_ids')::text FROM settlement_invoices")=='4078.94:true:true';cases.append('writer_preserves_original_invoice_and_amounts_sanitizes_all_delivery_copies')
  # Restore issued legacy message shape; reader projection must not mutate history.
  q("UPDATE social_messages SET media_metadata=jsonb_set(media_metadata,'{lines}',(SELECT breakdown FROM settlement_invoices));")
  user='00000000-0000-0000-0000-000000000004';conv=q('SELECT conversation_id FROM social_messages');reader=["SELECT media_metadata FROM fn_messenger_message_page('"+user+"','"+conv+"')","SELECT media_metadata FROM fn_messenger_search_messages('"+user+"',ARRAY['"+conv+"'::uuid],'Fixture')"]
  for o in old[1:]:q(o['definition']+';')
  for sql in reader:
   val=json.loads(q("SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='"+user+"';"+sql));assert 'standalone_bank_ledger_ids' in val['lines'] and 'standalone_bank_mint_ids' in val['lines']
  cases.append('both_actual_original_readers_reproduce_legacy_provenance_leak')
  for o in new[1:]:q(o['definition']+';')
  for idx,sql in enumerate(reader):
   val=json.loads(q("SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='"+user+"';"+sql));assert all(k not in val['lines'] for k in ['standalone_bank_ledger_ids','standalone_bank_mint_ids','private_bank_ledger_ids','source_ledger_ids']);assert str(val['lines']['total_rake_funding'])=='4078.94';cases.append('actual_private_reader_'+str(idx)+'_sanitizes_without_losing_amount')
   q("SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000099';"+sql,'not_authorised');cases.append('actual_private_reader_'+str(idx)+'_refuses_other_user')
  assert q("SELECT media_metadata->'lines' ? 'standalone_bank_ledger_ids' FROM social_messages")=='t';cases.append('immutable_issued_message_keeps_original_provenance')
  for o in old:
   sig=lit('public.'+o['signature']);assert q('SELECT has_function_privilege(\'anon\','+sig+',\'EXECUTE\')')=='f'
   assert q('SELECT has_function_privilege(\'authenticated\','+sig+',\'EXECUTE\')')==('f' if o['signature'].startswith('fn_deliver') else 't')
  cases.append('writer_service_only_readers_authenticated_original_acl_preserved')
  print(json.dumps({'cases':cases,'postimages':post,'passed':len(cases)}))
 finally:run([pg/'pg_ctl','-D',d,'-m','immediate','-w','stop'])
