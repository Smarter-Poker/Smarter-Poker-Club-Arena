"""Actual claim and atomic finalization preserve separately funded add-on chips."""
from satellite_qualifier_fixture import module
MIGRATION='supabase/migrations/20261029081924_original_continuation_preserves_funded_addons.sql'
RECEIPT='supabase/migrations/20260917233447_tournament_original_funding_and_obligation_receipts.sql'

def qualify(e,root,hand,db):
 b=module(root/'scripts/ci/fixtures/hand-continuation/build-funded-addon-claim.py','addon_claim_builder')
 migration,pre,post,proof,body,full=b.render()
 if migration!=(root/MIGRATION).read_text():raise RuntimeError('funded addon source drift')
 case=e.database(db)
 def snap(label):return (e.snapshot(case,label+'-data'),e.catalog_snapshot(case,label+'-catalog'),hand.private_snapshot(e,case,label+'-private'))
 try:
  e.sql(case,file=root/'supabase/migrations/20261029064404_continuation_waits_for_a_bounded_maintenance_lane.sql',label='addon-current-bounded-owner')
  source=(root/RECEIPT).read_text();shape=source[source.index('CREATE TABLE public.tournament_participant_funding_receipts'):source.index('CREATE TABLE public.tournament_accounting_credit_receipts')]
  immutable=source[source.index('CREATE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable()'):];immutable=immutable[:immutable.index('$function$;',immutable.index('AS $function$')+len('AS $function$'))+len('$function$;')]
  e.sql(case,shape+immutable+"REVOKE ALL ON FUNCTION public.fn_ca_tournament_accounting_evidence_immutable() FROM PUBLIC,anon,authenticated,service_role;ALTER TABLE public.tournament_participant_funding_receipts ENABLE ROW LEVEL SECURITY;REVOKE ALL ON public.tournament_participant_funding_receipts FROM PUBLIC,anon,authenticated,service_role;GRANT SELECT ON public.tournament_participant_funding_receipts TO service_role;CREATE TRIGGER original_evidence_immutable BEFORE UPDATE OR DELETE ON public.tournament_participant_funding_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable();CREATE TRIGGER original_evidence_no_truncate BEFORE TRUNCATE ON public.tournament_participant_funding_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable();",label='addon-maintained-immutable-receipt-shape')
  rebase=(root/'supabase/migrations/20260904104847_felt_erasure_delta_settlement.sql').read_text()
  rebase=rebase[rebase.index('CREATE TABLE IF NOT EXISTS public.ca_seat_stack_rebases'):rebase.index('-- 3. fn_ca_settle_hand_stacks_absolute')]
  e.sql(case,rebase,label='addon-actual-delta-rebase-audit-shape')
  e.sql(case,'DO $$BEGIN IF ('+proof+") IS DISTINCT FROM false THEN RAISE EXCEPTION 'ADDON_FALSE_BEFORE';END IF;END$$;",label='addon-live-proof-before')
  native=(root/'scripts/ci/probes/hand-continuation-native.sql').read_text();prefix=native[:native.index('DO $boundaries$')]
  setup=(e.output/'opening.sql').read_text()+prefix+"SELECT pg_temp.retain_continuation(0);SELECT pg_temp.retain_continuation(1);"
  credit="""
UPDATE public.table_seats SET stack=stack+10000 WHERE id='86300000-0000-0000-0000-000000000001';
UPDATE public.tournament_players SET chips=chips+10000,add_on=true WHERE tournament_id='86000000-0000-0000-0000-000000000001' AND user_id='10000000-0000-0000-0000-000000000001';
UPDATE public.tournaments SET addon_chips=10000,addon_cost=100 WHERE id='86000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_participant_funding_receipts(id,registration_id,tournament_id,user_id,operation,purchase_key,asset,amount,registration_snapshot,tournament_snapshot,custody_result)
SELECT md5('native-funded-addon')::uuid,tp.id,tp.tournament_id,tp.user_id,'addon',
 'tourney:'||tp.tournament_id::text||':addon:'||tp.user_id::text,'diamonds',100,
 to_jsonb(tp),to_jsonb(t),'{"success":true,"amount":100}'::jsonb
FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
WHERE tp.tournament_id='86000000-0000-0000-0000-000000000001' AND tp.user_id='10000000-0000-0000-0000-000000000001';
"""
  successor="""UPDATE public.engine_tournament_leases SET lease_generation='86500000-0000-0000-0000-000000000002',heartbeat_at=clock_timestamp() WHERE tournament_id='86000000-0000-0000-0000-000000000001';SELECT set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000002',true);"""
  call="public.fn_f06_claim_hand_continuation('86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000002','86100000-0000-0000-0000-000000000001')"
  baseline=snap('addon-old-before');code,_,err=e.sql(case,'BEGIN;'+setup+credit+successor+'SELECT '+call+';ROLLBACK;',label='addon-old-real-roster-refusal',check=False)
  if not code or 'HAND_CONTINUATION_ROSTER_CHANGED' not in err or baseline!=snap('addon-old-after'):raise RuntimeError('old funded-addon failure not reproduced/rolledback:'+err)
  wrapper="BEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\n"
  if migration.count(wrapper)!=1 or not migration.endswith('COMMIT;\n'):raise RuntimeError('wrong addon transaction')
  inside=migration.replace(wrapper,"SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';",1)[:-len('COMMIT;\n')]
  e.sql(case,'BEGIN;'+inside+'ROLLBACK;',label='addon-install-full-rollback')
  if baseline!=snap('addon-install-after'):raise RuntimeError('addon installation rollback differs')
  for kind,mutation in [('acl',"GRANT EXECUTE ON FUNCTION public.fn_f06_claim_hand_continuation(uuid,uuid,uuid) TO anon;"),('config',"ALTER FUNCTION public.fn_f06_claim_hand_continuation(uuid,uuid,uuid) SET search_path=public;"),('evidence',"ALTER TABLE public.tournament_participant_funding_receipts DISABLE TRIGGER original_evidence_immutable;")]:
   clone=e.database(case);e.sql(clone,mutation,label='addon-install-drift-'+kind)
   before=(e.snapshot(clone,'drift-data-before'),e.catalog_snapshot(clone,'drift-catalog-before'),hand.private_snapshot(e,clone,'drift-private-before'))
   code,_,err=e.sql(clone,file=root/MIGRATION,label='addon-install-refusal-'+kind,check=False)
   if not code or ('HAND_CONTINUATION_ADDON_PREIMAGE_CHANGED' not in err and 'HAND_CONTINUATION_ADDON_EVIDENCE_CHANGED' not in err):raise RuntimeError('addon installation drift accepted')
   if before!=(e.snapshot(clone,'drift-data-after'),e.catalog_snapshot(clone,'drift-catalog-after'),hand.private_snapshot(e,clone,'drift-private-after')):raise RuntimeError('addon refusal leaked')
   e.discard(clone)
  e.sql(case,file=root/MIGRATION,label='addon-exact-candidate-install')
  e.sql(case,'DO $$BEGIN IF ('+proof+") IS DISTINCT FROM true THEN RAISE EXCEPTION 'ADDON_TRUE_AFTER';END IF;END$$;",label='addon-live-proof-after')
  # Only the roster predicate differs, preserving helper/lease/freeze/order/identity.
  old="AND s.stack = (x->>'stack_before')::numeric)) THEN";new=post[post.index('AND (s.stack ='):post.index("\n    RAISE EXCEPTION 'HAND_CONTINUATION_ROSTER_CHANGED'")]
  e.sql(case,"DO $$BEGIN IF replace(pg_get_functiondef('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure),$new$"+new+"$new$,$old$"+old+"$old$) IS DISTINCT FROM $pre$"+pre+"$pre$ THEN RAISE EXCEPTION 'UNRELATED_CLAIM_BYTES_CHANGED';END IF;END$$;",label='addon-reverse-exact-original-owner')
  negatives=[('unfunded',credit[:credit.index('INSERT INTO')]),('no-addon',credit.replace('add_on=true','add_on=false')),('wrong-amount',credit.replace('stack=stack+10000','stack=stack+9999')),('earlier-receipt',credit.replace('asset,amount,registration_snapshot','asset,amount,observed_at,registration_snapshot').replace("'diamonds',100,","'diamonds',100,clock_timestamp()-interval '1 day',")),('wrong-user-receipt',credit.replace('to_jsonb(tp),to_jsonb(t)',"jsonb_set(to_jsonb(tp),'{user_id}',to_jsonb(md5('other-user')::uuid::text)),to_jsonb(t)")),('failed-funding',credit.replace('"success":true','"success":false')),('changed-chair',credit+"UPDATE public.table_seats SET joined_at=joined_at+interval '1 second' WHERE id='86300000-0000-0000-0000-000000000001';")]
  for label,bad in negatives:
   before=snap(label+'-before');code,_,err=e.sql(case,'BEGIN;'+setup+bad+successor+'SELECT '+call+';ROLLBACK;',label='addon-boundary-'+label,check=False)
   if not code or 'HAND_CONTINUATION_ROSTER_CHANGED' not in err or before!=snap(label+'-after'):raise RuntimeError('addon boundary not refused/rolledback:'+label+err)
  terminal=native[native.index('DO $terminal$'):native.index("SELECT 'HAND_CONTINUATION_NATIVE_PASS'")]
  terminal=terminal.replace('pg_temp.continuation_payload(2)::jsonb',"jsonb_set((SELECT hc.payload::jsonb FROM smarter_private.hand_continuations hc WHERE hc.hand_number=8600001),'{batch,sequence}','2'::jsonb)").replace('sum(stack)=20','sum(stack)=10020')
  checks="""DO $$DECLARE before text;sha text;r jsonb;BEGIN SELECT payload,payload_sha256 INTO before,sha FROM smarter_private.hand_continuations; r:="""+call+";IF r#>>'{continuation,payload}' IS DISTINCT FROM before OR r#>>'{continuation,sha256}' IS DISTINCT FROM sha THEN RAISE EXCEPTION 'ADDON_CHANGED_ORIGINAL';END IF;r:="+call+";IF r#>>'{continuation,payload}' IS DISTINCT FROM before THEN RAISE EXCEPTION 'ADDON_REPLAY_CHANGED_ORIGINAL';END IF;IF (SELECT sum(stack) FROM public.table_seats WHERE table_id='86100000-0000-0000-0000-000000000001')<>10020 THEN RAISE EXCEPTION 'ADDON_CLAIM_MOVED_CHIPS';END IF;END$$;"
  before=snap('addon-finish-before');code,out,err=e.sql(case,'BEGIN;'+setup+credit+successor+checks+terminal+"DO $$BEGIN IF (SELECT stack FROM public.table_seats WHERE id='86300000-0000-0000-0000-000000000001')<>10000 OR (SELECT count(*) FROM public.hand_atomic_commits)<>1 OR NOT EXISTS(SELECT 1 FROM public.ca_seat_stack_rebases WHERE user_id='10000000-0000-0000-0000-000000000001' AND engine_before=10 AND db_before=10010 AND engine_after=0 AND written=10000 AND amount=10000) OR (SELECT count(*) FROM public.ca_seat_stack_rebases)<>1 OR NOT EXISTS(SELECT 1 FROM public.tournament_players tp JOIN public.table_seats seat ON seat.user_id=tp.user_id AND seat.table_id=tp.table_id WHERE tp.tournament_id='86000000-0000-0000-0000-000000000001' AND tp.user_id='10000000-0000-0000-0000-000000000001' AND tp.chips=10000 AND tp.status='playing' AND seat.stack=10000 AND seat.left_at IS NULL) THEN RAISE EXCEPTION 'ADDON_LOST_OR_DUPLICATED';END IF;END$$;ROLLBACK;",label='addon-real-original-atomic-finish-once',check=False)
  if code or err.count('CONTINUATION PASS:')!=8:raise RuntimeError('actual addon original atomic finish failed:'+err)
  if before!=snap('addon-finish-after'):raise RuntimeError('addon full financial rollback differs')
  e.report['funded_addon_claim']={'passed':True,'old_roster_refusal_reproduced':True,'original_payload_and_hash_unchanged':True,'add_on_chips_preserved':10000,'original_total':20,'settled_total':10020,'actual_atomic_commit_once':True,'buyer_loses_original_stack_but_remains_seated_playing_with_10000':True,'terminal_assertions':8,'negative_cases':[x[0] for x in negatives],'installation_refusals':3,'catalog_and_public_private_data_rollback':True,'post_body_md5':body,'post_full_md5':full}
 finally:e.discard(case)
