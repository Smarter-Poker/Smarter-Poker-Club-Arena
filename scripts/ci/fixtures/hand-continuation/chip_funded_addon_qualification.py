"""Real canonical CHIPS purchase receipt and original delta settlement, isolated PG17."""
import re
from satellite_qualifier_fixture import module
MIGRATION='supabase/migrations/20261029092119_original_continuations_accept_proven_chip_funded_addons.sql'

def qualify(e,root,hand,db):
 b=module(root/'scripts/ci/fixtures/hand-continuation/build-chip-funded-addon-claim.py','chip_addon_builder')
 migration,pre,post,proof,body,full,old,new=b.render()
 if migration!=(root/MIGRATION).read_text():raise RuntimeError('CHIPS addon composition drift')
 case=e.database(db)
 def snapshot(label):return(e.snapshot(case,label+'-data'),e.catalog_snapshot(case,label+'-catalog'),hand.private_snapshot(e,case,label+'-private'))
 def extract(source,name):
  start=re.search(r'CREATE(?: OR REPLACE)? FUNCTION public\.'+re.escape(name)+r'\(',source).start()
  end=re.search(r'\$function\$\s*;',source[source.index('AS $function$',start)+len('AS $function$'):])
  return source[start:source.index('AS $function$',start)+len('AS $function$')+end.end()]
 try:
  e.sql(case,file=root/'supabase/migrations/20261029064404_continuation_waits_for_a_bounded_maintenance_lane.sql',label='chip-addon-bounded-owner')
  source=(root/'supabase/migrations/20260917233447_tournament_original_funding_and_obligation_receipts.sql').read_text()
  shape=source[source.index('CREATE TABLE public.tournament_participant_funding_receipts'):source.index('CREATE TABLE public.tournament_accounting_credit_receipts')]
  e.sql(case,shape+extract(source,'fn_ca_tournament_accounting_evidence_immutable')+extract(source,'fn_ca_record_tournament_participant_funding')+extract(source,'fn_ca_capture_tournament_charge_entitlement')+extract(source,'fn_ca_process_tournament_chip_purchase_money_v1')+"REVOKE ALL ON FUNCTION public.fn_ca_tournament_accounting_evidence_immutable(),public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;CREATE TRIGGER original_evidence_immutable BEFORE UPDATE OR DELETE ON public.tournament_participant_funding_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable();CREATE TRIGGER original_evidence_no_truncate BEFORE TRUNCATE ON public.tournament_participant_funding_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable();",label='chip-addon-actual-funding-owners')
  rebase=(root/'supabase/migrations/20260904104847_felt_erasure_delta_settlement.sql').read_text();rebase=rebase[rebase.index('CREATE TABLE IF NOT EXISTS public.ca_seat_stack_rebases'):rebase.index('-- 3. fn_ca_settle_hand_stacks_absolute')];e.sql(case,rebase,label='chip-addon-actual-rebase-shape')
  e.sql(case,file=root/'supabase/migrations/20261029081924_original_continuation_preserves_funded_addons.sql',label='chip-addon-installed-diamond-owner')
  native=(root/'scripts/ci/probes/hand-continuation-native.sql').read_text();prefix=native[:native.index('DO $boundaries$')]
  setup=(e.output/'opening.sql').read_text()+prefix+"SELECT pg_temp.retain_continuation(0);SELECT pg_temp.retain_continuation(1);"
  purchase="""
SET LOCAL session_replication_role=replica;
UPDATE public.club_members SET chip_balance=1000 WHERE user_id='10000000-0000-0000-0000-000000000001' AND club_id='20000000-0000-0000-0000-000000000001';
UPDATE public.tournament_players SET club_id='20000000-0000-0000-0000-000000000001' WHERE tournament_id='86000000-0000-0000-0000-000000000001';
UPDATE public.tournaments SET addon_chips=10000,addon_cost=100,add_on_available=true,addon_period_triggered=true,addon_period_started_at=clock_timestamp()-interval '10 seconds',addon_period_ends_at=clock_timestamp()+interval '50 seconds' WHERE id='86000000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;
SELECT public.fn_ca_process_tournament_chip_purchase_money_v1('86000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','addon',100,10000,1,'native-original-addon-receipt');
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts WHERE asset='chips' AND amount=100 AND custody_result IS NULL AND entitlement_id IS NOT NULL AND ledger_id IS NOT NULL AND wallet_transaction_id IS NOT NULL) OR (SELECT stack FROM public.table_seats WHERE id='86300000-0000-0000-0000-000000000001')<>10010 THEN RAISE EXCEPTION 'REAL_CHIPS_PURCHASE_NOT_PROVEN';END IF;END$$;
"""
  successor="UPDATE public.engine_tournament_leases SET lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp() WHERE tournament_id='86000000-0000-0000-0000-000000000001';SELECT set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);"
  call="public.fn_f06_claim_hand_continuation('86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001')"
  before=snapshot('chip-old-before');code,_,err=e.sql(case,'BEGIN;'+setup+purchase+successor+'SELECT '+call+';ROLLBACK;',label='chip-old-actual-funded-refusal',check=False)
  if not code or 'HAND_CONTINUATION_ROSTER_CHANGED' not in err or before!=snapshot('chip-old-after'):raise RuntimeError('old actualCHIPS failure not reproduced:'+err)
  e.sql(case,'DO $$BEGIN IF ('+proof+") IS DISTINCT FROM false THEN RAISE EXCEPTION 'CHIP_WITNESS_FALSE';END IF;END$$;",label='chip-live-proof-before')
  wrapper="BEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\n";inside=migration.replace(wrapper,"SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';",1)[:-len('COMMIT;\n')]
  e.sql(case,'BEGIN;'+inside+'ROLLBACK;',label='chip-install-full-rollback')
  if before!=snapshot('chip-install-after'):raise RuntimeError('CHIPS installation rollback differs')
  for label,change in [('acl',"GRANT EXECUTE ON FUNCTION public.fn_f06_claim_hand_continuation(uuid,uuid,uuid) TO anon;"),('config',"ALTER FUNCTION public.fn_f06_claim_hand_continuation(uuid,uuid,uuid) SET search_path=public;"),('funding-owner',"ALTER FUNCTION public.fn_ca_record_tournament_participant_funding(uuid,text,text,numeric,text,uuid,uuid,jsonb) SET search_path=public;")]:
   clone=e.database(case);e.sql(clone,change,label='chip-drift-'+label);baseline=(e.snapshot(clone,'drift-before-data'),e.catalog_snapshot(clone,'drift-before-catalog'),hand.private_snapshot(e,clone,'drift-before-private'))
   code,_,err=e.sql(clone,file=root/MIGRATION,label='chip-refusal-'+label,check=False)
   if not code or 'HAND_CONTINUATION_CHIP_FUNDING_' not in err or baseline!=(e.snapshot(clone,'drift-after-data'),e.catalog_snapshot(clone,'drift-after-catalog'),hand.private_snapshot(e,clone,'drift-after-private')):raise RuntimeError('CHIPS installation refusal failed:'+label)
   e.discard(clone)
  e.sql(case,file=root/MIGRATION,label='chip-exact-forward-install')
  e.sql(case,'DO $$BEGIN IF ('+proof+") IS DISTINCT FROM true THEN RAISE EXCEPTION 'CHIP_WITNESS_TRUE';END IF;END$$;",label='chip-live-proof-after')
  e.sql(case,"DO $$BEGIN IF replace(pg_get_functiondef('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure),$new$"+new+"$new$,$old$"+old+"$old$) IS DISTINCT FROM $pre$"+pre+"$pre$ THEN RAISE EXCEPTION 'CHIPS_UNRELATED_BYTES_CHANGED';END IF;END$$;",label='chip-reverse-exact-function')
  terminal=native[native.index('DO $terminal$'):native.index("SELECT 'HAND_CONTINUATION_NATIVE_PASS'")].replace('pg_temp.continuation_payload(2)::jsonb',"jsonb_set((SELECT hc.payload::jsonb FROM smarter_private.hand_continuations hc WHERE hc.hand_number=8600001),'{batch,sequence}','2'::jsonb)").replace('sum(stack)=20','sum(stack)=10020')
  checks="DO $$DECLARE prior text;r jsonb;BEGIN SELECT hc.payload INTO prior FROM smarter_private.hand_continuations hc;r:="+call+";IF r#>>'{continuation,payload}' IS DISTINCT FROM prior THEN RAISE EXCEPTION 'CHIPS_ORIGINAL_CHANGED';END IF;r:="+call+";IF r#>>'{continuation,payload}' IS DISTINCT FROM prior THEN RAISE EXCEPTION 'CHIPS_REPLAY_CHANGED';END IF;END$$;"
  final="DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM public.tournament_players tp JOIN public.table_seats s ON s.user_id=tp.user_id AND s.table_id=tp.table_id WHERE tp.tournament_id='86000000-0000-0000-0000-000000000001' AND tp.user_id='10000000-0000-0000-0000-000000000001' AND tp.chips=10000 AND tp.status='playing' AND s.stack=10000 AND s.left_at IS NULL) OR (SELECT count(*) FROM public.hand_atomic_commits)<>1 OR (SELECT count(*) FROM public.ca_seat_stack_rebases WHERE amount=10000 AND engine_after=0 AND written=10000)<>1 THEN RAISE EXCEPTION 'CHIPS_ADDON_LOST_OR_DUPLICATED';END IF;END$$;"
  before=snapshot('chip-positive-before');code,out,err=e.sql(case,'BEGIN;'+setup+purchase+successor+checks+terminal+final+'ROLLBACK;',label='chip-real-purchase-original-atomic-once',check=False)
  if code or err.count('CONTINUATION PASS:')!=8 or before!=snapshot('chip-positive-after'):raise RuntimeError('real CHIPS positive atomic proof failed:'+err)
  negatives=[('pending-ledger',"ledger_snapshot=jsonb_set(ledger_snapshot,'{status}','\"pending\"')"),('missing-entitlement-snapshot',"entitlement_snapshot=NULL"),('wrong-wallet-user',"wallet_snapshot=jsonb_set(wallet_snapshot,'{user_id}',to_jsonb(md5('wrong-buyer')::uuid::text))"),('wrong-ledger-amount',"ledger_snapshot=jsonb_set(ledger_snapshot,'{amount}','99')"),('failed-custody',"custody_result='{\"success\":false}'"),('empty-unfunded-snapshots',"entitlement_snapshot='{}',ledger_snapshot='{}',wallet_snapshot='{}'")]
  for label,mutation in negatives:
   # Corrupt only the isolated fixture's candidate evidence before reinstalling
   # the real immutable guards. No production evidence or balance is repaired.
   corrupt="SET LOCAL session_replication_role=replica;UPDATE public.tournament_participant_funding_receipts SET "+mutation+";SET LOCAL session_replication_role=origin;"
   before=snapshot(label+'-before');code,_,err=e.sql(case,'BEGIN;'+setup+purchase+corrupt+successor+'SELECT '+call+';ROLLBACK;',label='chip-negative-'+label,check=False)
   if not code or 'HAND_CONTINUATION_ROSTER_CHANGED' not in err or before!=snapshot(label+'-after'):raise RuntimeError('CHIPS negative not refused/rolledback:'+label+err)
  # Existing successful DIAMONDS evidence remains explicitly admitted.
  diamond="SET LOCAL session_replication_role=replica;UPDATE public.tournament_participant_funding_receipts SET asset='diamonds',entitlement_id=NULL,ledger_id=NULL,entitlement_snapshot=NULL,ledger_snapshot=NULL,wallet_snapshot=NULL,custody_result='{\"success\":true}';SET LOCAL session_replication_role=origin;"
  before=snapshot('diamond-before');e.sql(case,'BEGIN;'+setup+purchase+diamond+successor+checks+terminal+final+'ROLLBACK;',label='diamond-retained-original-atomic-once')
  if before!=snapshot('diamond-after'):raise RuntimeError('DIAMONDS composition rollback differs')
  e.report['chip_funded_addon']={'passed':True,'actual_chip_purchase_and_immutable_recorder':True,'old_diamond_only_refusal_reproduced':True,'same_original_payload':True,'buyer_original_stack_lost_but_funded_10000_seat_registration_live':True,'atomic_once_with_postcommit_and_rebase':True,'diamonds_success_preserved':True,'negative_cases':[x[0] for x in negatives],'installation_refusals':3,'full_data_catalog_private_rollback':True,'post_body_md5':body,'post_full_md5':full}
 finally:e.discard(case)
