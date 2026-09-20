"""Bounded cross-club regression within the existing funded satellite qualifier."""
import json
import re
from satellite_qualifier_fixture import sha

MIGRATION='supabase/migrations/20260918021924_satellite_seat_fee_uses_exact_registration_club.sql'
PROBE='scripts/ci/probes/satellite-entry-club-native.sql'

UNION_OPENING="""
-- Explicit synthetic union/member identity; registration and all money writes
-- below still use the genuine public owners with normal triggers enabled.
INSERT INTO public.unions(id,name,owner_id,slug) VALUES(
 'd2000000-0000-4000-8000-000000000002','Native Seat Union','d1000000-0000-4000-8000-000000000001','native-seat-union');
INSERT INTO public.union_clubs(union_id,club_id) VALUES
 ('d2000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001'),
 ('d2000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000002');
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at) VALUES(
 'd2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002',
 'player','active',0,clock_timestamp()-interval '3 days');
UPDATE public.clubs SET is_union=true WHERE id='d2000000-0000-4000-8000-000000000002';
UPDATE public.club_members SET joined_at=now()-interval '4 days'
 WHERE club_id='d2000000-0000-4000-8000-000000000002'
 AND user_id='d1000000-0000-4000-8000-000000000001';
UPDATE public.tournaments SET union_id='d2000000-0000-4000-8000-000000000002'
 WHERE id='d3000000-0000-4000-8000-000000000002';
"""

PROOF="""
DO $entry_club_proof$
BEGIN
 IF (SELECT count(*) FROM public.tournament_refund_entitlements e
      JOIN public.tournament_players tp ON tp.id=e.registration_id
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      WHERE e.source_satellite_id='d3000000-0000-4000-8000-000000000001'
        AND e.entitlement_kind='satellite_seat'
        AND e.refund_wallet_club_id=tp.club_id
        AND tp.club_id='d2000000-0000-4000-8000-000000000001'
        AND l.club_id=tp.club_id
        AND e.gross=100 AND e.refund_prize=90 AND e.refund_fee=10)<>1 THEN
  RAISE EXCEPTION 'exact member registration, funding and refund club not proven';
 END IF;
END $entry_club_proof$;
DO $refund$
DECLARE result jsonb; first_state jsonb;
BEGIN
 -- Start the next public transaction with its normal deferred-constraint mode;
 -- the preceding settlement proof forced validation at its own boundary.
 SET CONSTRAINTS ALL DEFERRED;
 result:=public.atomic_cancel_tournament('d3000000-0000-4000-8000-000000000002',NULL);
 SET CONSTRAINTS ALL IMMEDIATE;
 IF result->>'ok' IS DISTINCT FROM 'true' OR (result->>'total_refunded')::numeric<>200
  OR (result->>'fees_reversed')::numeric<>20
  OR (SELECT chip_balance FROM public.club_members WHERE club_id='d2000000-0000-4000-8000-000000000001'
      AND user_id='d1000000-0000-4000-8000-000000000002') IS DISTINCT FROM 100::numeric
  OR (SELECT chip_balance FROM public.club_members WHERE club_id='d2000000-0000-4000-8000-000000000002'
      AND user_id='d1000000-0000-4000-8000-000000000002') IS DISTINCT FROM 200::numeric
  OR (SELECT count(*) FROM public.tournament_refund_tranches tr
       JOIN public.wallet_transactions w ON w.id=tr.wallet_transaction_id
       JOIN public.chip_ledger l ON l.id=tr.credit_ledger_id
       WHERE tr.tournament_id='d3000000-0000-4000-8000-000000000002'
       AND tr.user_id='d1000000-0000-4000-8000-000000000002'
       AND tr.source_wallet_club_id='d2000000-0000-4000-8000-000000000001'
       AND tr.refund_prize=90 AND tr.refund_fee=10 AND w.amount=100 AND l.amount=100)<>1
  OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='d3000000-0000-4000-8000-000000000002'
       AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND closed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'cross-club target cancellation did not refund the exact admitted wallet';
 END IF;
 first_state:=pg_temp.satellite_full_financial_state();
 IF public.atomic_cancel_tournament('d3000000-0000-4000-8000-000000000002',NULL) IS DISTINCT FROM result
   OR first_state IS DISTINCT FROM pg_temp.satellite_full_financial_state() THEN
  RAISE EXCEPTION 'cross-club target cancellation replay moved money';
 END IF;
END $refund$;
SELECT 'SATELLITE_ENTRY_CLUB_NATIVE_PASS';
"""

def replace_once(source, old, new):
    if source.count(old)!=1:
        raise ValueError('cross-club fixture seam changed: '+old[:80])
    return source.replace(old,new,1)

def qualify(e,root,db,output,probe):
    dependency='scripts/ci/fixtures/satellite-qualifiers/entry-club-cancellation-cash-read.sql'
    e.sql(db,file=root/dependency,label='captured-cancellation-cash-read',seconds=60)
    paths=[MIGRATION,PROBE,dependency,'scripts/ci/satellite_entry_club_native.py',
           'scripts/ci/fixtures/satellite-qualifiers/satellite-entry-club-producer-preimages-20260918.json',
           'scripts/ci/classify-ci-changes.mjs','tests/unit/fixtureNativeCi.test.ts',
           'tests/operations/satellite-qualifier-results.test.py']
    e.report['source_sha256'].update({p:sha(root/p) for p in paths})
    seam='SET LOCAL session_replication_role=origin;\n\n-- The public production registration door'
    cross=replace_once(probe,seam,UNION_OPENING+"SET LOCAL session_replication_role=origin;\n"+
        "INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,event_type,after_terms,observed_at) SELECT 'union_clubs',uc.id::text,uc.club_id,'INSERT',public.fn_accounting_agreement_terms('union_clubs',to_jsonb(uc)),transaction_timestamp() FROM public.union_clubs uc WHERE union_id='d2000000-0000-4000-8000-000000000002';\n\n-- The public production registration door")
    # Before-control runs the same funded opening and exact public caller.
    # The existing injected late failure must remain unreachable at the actual
    # earlier fee capture refusal. The outer BEGIN rolls back on connection end.
    before=e.snapshot(db,'entry-club-before-data')
    catalog=e.catalog_snapshot(db,'entry-club-before-catalog')
    old=output/'entry-club-before.sql';old.write_text(cross)
    code,out,err=e.sql(db,file=old,label='entry-club-original-refusal',seconds=180,check=False)
    errors=[x.split('ERROR:',1)[1].strip() for x in err.splitlines() if 'ERROR:' in x]
    if code!=3 or errors!=['tournament_fee_charge_evidence_mismatch']:
        raise RuntimeError('original cross-club fee refusal not reproduced: '+repr(errors))
    if before!=e.snapshot(db,'entry-club-original-after-data') or catalog!=e.catalog_snapshot(db,'entry-club-original-after-catalog'):
        raise RuntimeError('original cross-club refusal did not roll back')
    catalog_before=dict(catalog)
    e.sql(db,file=root/MIGRATION,label='satellite-entry-club-migration',seconds=60)
    catalog=e.catalog_snapshot(db,'entry-club-successor-catalog')
    before_functions=catalog_before.pop('functions'); after_functions=dict(catalog).pop('functions')
    allowed={'fn_ca_settle_satellite_cohort(uuid,uuid[])','fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'}
    if ({k:v for k,v in catalog.items() if k!='functions'} != catalog_before
        or [r for r in before_functions if r[1] not in allowed] != [r for r in after_functions if r[1] not in allowed]):
        raise RuntimeError('satellite producer repair changed a consumer or other authority')
    cross=replace_once(cross,"INSERT INTO satellite_full_probe_results VALUES('first_settlement',",(root/PROBE).read_text()+"\nINSERT INTO satellite_full_probe_results VALUES('first_settlement',")
    cross=replace_once(cross,"SELECT 'L04_CURRENT_V2_PRESERVATION_PASS';",PROOF+"\nSELECT 'L04_CURRENT_V2_PRESERVATION_PASS';")
    new=output/'entry-club-after.sql';new.write_text(cross)
    code,out,err=e.sql(db,file=new,label='entry-club-successor-proof',seconds=180,check=False)
    if code or any(x in err for x in ['ERROR:','FATAL:','PANIC:','WARNING:']) or out.splitlines().count('SATELLITE_ENTRY_CLUB_NATIVE_PASS')!=1:
        raise RuntimeError('cross-club successor failed; inspect original transcript')
    if re.findall(r'NOTICE:  ENTRY_CLUB_REFUSAL_PASS: ([a-z_]+)',err)!=['user','target','source','qualifier','club','host','entitlement_club']:
        raise RuntimeError('cross-club forged registration/source/club controls missing')
    if before!=e.snapshot(db,'entry-club-successor-after-data') or catalog!=e.catalog_snapshot(db,'entry-club-successor-after-catalog'):
        raise RuntimeError('cross-club successor proof did not roll back')
    e.report['entry_club']={'original_refusal':'tournament_fee_charge_evidence_mismatch',
       'original_atomic_rollback':True,'successor_funded_v2':True,'forged_controls':7,
       'successor_atomic_rollback':True,'transfer_club_matches_registration':True,'registration_club_exact':True,
       'target_cancellation_member_refund':100,'target_cancellation_total_refund':200,'target_cancellation_replay_exact':True}
    cohort=(root/'scripts/ci/probes/satellite-qualifiers-native.sql').read_text()
    seam=" -- Synthetic accepted final-hand scene: survivors retain positive chips;"
    opening="""
 INSERT INTO public.clubs(id,name) VALUES(md5('entry-club-member:'||case_name)::uuid,'Native Union Member');
 INSERT INTO public.unions(id,name,owner_id,slug) VALUES(club,'Native Cohort Union',md5('l04:'||case_name||':user:1')::uuid,'entry-club-'||case_name);
 INSERT INTO public.union_clubs(union_id,club_id) VALUES(club,club),(club,md5('entry-club-member:'||case_name)::uuid);
 INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at)
  SELECT md5('entry-club-member:'||case_name)::uuid,md5('l04:'||case_name||':user:'||n)::uuid,'player','active',0,now()-interval '3 days' FROM generate_series(1,4)n;
 UPDATE public.clubs SET is_union=true WHERE id=club;
 UPDATE public.tournaments SET union_id=club WHERE id=target_id;
"""
    cohort=replace_once(cohort,seam," PERFORM set_config('session_replication_role','replica',true);\n"+opening+
        " PERFORM set_config('session_replication_role','origin',true);\n"+
        " INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,event_type,after_terms,observed_at) SELECT 'union_clubs',uc.id::text,uc.club_id,'INSERT',public.fn_accounting_agreement_terms('union_clubs',to_jsonb(uc)),transaction_timestamp() FROM public.union_clubs uc WHERE union_id=club;\n"+seam)
    seam="SELECT 'SATELLITE_QUALIFIER_NATIVE_EVIDENCE='"
    cohort=cohort.split(seam)[0]+"""
SELECT pg_temp.qualifier_case('entryclub',2);
DO $cohort_club$ BEGIN
 IF (SELECT count(*) FROM public.tournament_refund_entitlements e
      JOIN public.tournament_players tp ON tp.id=e.registration_id
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      WHERE e.source_satellite_id=md5('l04:entryclub:source')::uuid
       AND e.entitlement_kind='satellite_seat' AND e.refund_wallet_club_id=tp.club_id
       AND tp.club_id=md5('entry-club-member:entryclub')::uuid
       AND l.club_id=tp.club_id
       AND e.gross=50 AND e.refund_prize=45 AND e.refund_fee=5)<>2 THEN
  RAISE EXCEPTION 'cohort exact registration and funding club not proven';
 END IF;
END $cohort_club$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'SATELLITE_ENTRY_CLUB_COHORT_PASS';
ROLLBACK;
"""
    cross_v3=output/'entry-club-cohort.sql';cross_v3.write_text(cohort)
    code,out,err=e.sql(db,file=cross_v3,label='entry-club-cohort-proof',seconds=180,check=False)
    if code or any(x in err for x in ['ERROR:','FATAL:','PANIC:','WARNING:']) or out.splitlines().count('SATELLITE_ENTRY_CLUB_COHORT_PASS')!=1:
        raise RuntimeError('cross-club cohort failed; inspect original transcript')
    if before!=e.snapshot(db,'entry-club-cohort-after-data') or catalog!=e.catalog_snapshot(db,'entry-club-cohort-after-catalog'):
        raise RuntimeError('cross-club cohort proof did not roll back')
    e.report['entry_club']['successor_funded_v3']=True
    e.report['entry_club']['exact_postimage_owner_acl_triggers']=True
    return {p:sha(root/p) for p in paths}
