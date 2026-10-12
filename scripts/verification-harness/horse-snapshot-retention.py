#!/usr/bin/env python3
"""Original crash recovery evidence survives every unqualified retention state."""
import json,sys,hashlib
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,lit
MIGRATION=Path('supabase/migrations/20261012171556_unresolved_snapshots_require_original_settled_horse_disposal.sql')
def qualify(e,template,keep_template=False):
 old=module(ROOT/'scripts/ci/test-hand-submission-retention-disposal.py','snapshot_original')
 checks=[]
 def yes(db,q,label):
  _,v,_=e.sql(db,q,label=label);assert v.strip()=='t',(label,v);checks.append(label)
 base=e.database(template)
 e.sql(base,file=ROOT/'scripts/verification-harness/horse-snapshot-prune-preimage.sql',label='snapshot-live-original-prune')
 e.sql(base,'REVOKE ALL ON FUNCTION public.sp_prune_hand_state_snapshots(integer) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.sp_prune_hand_state_snapshots(integer) TO service_role;',label='snapshot-live-original-acl')
 # Exact live get_active_hand_snapshot body captured read-only 2026-10-12.
 e.sql(base,"""CREATE OR REPLACE FUNCTION public.get_active_hand_snapshot(p_table_id uuid)
 RETURNS TABLE(hand_number integer,state_json jsonb,config_json jsonb,dealer_seat integer,players_json jsonb,stage text,updated_at timestamptz)
 LANGUAGE plpgsql SET search_path=public AS $function$
 BEGIN RETURN QUERY SELECT hss.hand_number,hss.state_json,hss.config_json,hss.dealer_seat,hss.players_json,hss.stage,hss.updated_at
 FROM hand_state_snapshots hss WHERE hss.table_id=p_table_id AND hss.is_complete=FALSE LIMIT 1; END;
 $function$;""",label='snapshot-real-recovery-reader')
 seed=old.SEED.replace("'{\"p_stacks\": []}'::jsonb", "jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+old.HORSE+"'))))")+"UPDATE public.hand_history SET has_human=false;"
 snapshot="INSERT INTO hand_state_snapshots(id,table_id,hand_number,state_json,config_json,dealer_seat,players_json,created_at,updated_at,is_complete) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','"+old.TABLE+"',"+str(old.HAND_NUMBER)+",'{\"cards\":[\"As\"],\"actions\":[{\"action\":\"call\"}]}','{}',1,jsonb_build_array(jsonb_build_object('user_id','"+old.HORSE+"','is_horse',true)),now()-interval '40 days',now()-interval '40 days',true);"
 before=e.database(base);e.sql(before,seed+snapshot+"UPDATE hand_state_snapshots SET is_complete=false; SELECT sp_prune_hand_state_snapshots(10);",label='snapshot-old-incomplete-prune')
 yes(before,'SELECT NOT EXISTS(SELECT 1 FROM hand_state_snapshots);','fail-before-unresolved-original-is-deleted-at-thirty-days');e.discard(before)
 e.sql(base,file=ROOT/MIGRATION,label='snapshot-exact-candidate')
 code,_,err=e.sql(base,file=ROOT/MIGRATION,label='snapshot-replay-refusal',check=False);assert code!=0 and 'HORSE_SNAPSHOT_RETENTION_PREIMAGE_CHANGED' in err;checks.append('snapshot-migration-replay-refused')
 qualified=e.database(base);e.sql(qualified,seed+snapshot+old.AUTHORITY+'SELECT sp_prune_hand_history(10);',label='snapshot-qualified-original-disposal')
 yes(qualified,"SELECT smarter_private.horse_snapshot_disposable(id) FROM hand_state_snapshots;",'snapshot-exact-original-boundary-matches')
 for name,change in [('human',"UPDATE hand_state_snapshots SET players_json=jsonb_build_array(jsonb_build_object('user_id','"+old.HORSE+"','is_horse',false));"),('unknown',"UPDATE hand_state_snapshots SET players_json='[{}]';"),('young','UPDATE hand_state_snapshots SET updated_at=now();'),('wrong-hand','UPDATE hand_state_snapshots SET hand_number=hand_number+1;'),('bbj',"INSERT INTO bbj_payouts VALUES('"+old.TABLE+"',"+str(old.HAND_NUMBER)+");"),('projection',"INSERT INTO hand_projection_outbox VALUES('"+old.HAND_ID+"');"),('knockout',"INSERT INTO tournament_knockout_candidates VALUES('"+old.HAND_ID+"','pending');"),('reserved',"INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state) VALUES(gen_random_uuid(),gen_random_uuid(),'"+old.TABLE+"',1,"+str(old.HAND_NUMBER)+",gen_random_uuid(),gen_random_uuid(),'reserved');")]:
  case=e.database(qualified);e.sql(case,change+"CREATE TABLE snapshot_before AS SELECT to_jsonb(s) v FROM hand_state_snapshots s; CREATE TABLE recovery_before AS SELECT to_jsonb(s) v FROM get_active_hand_snapshot('"+old.TABLE+"') s; SELECT sp_prune_hand_state_snapshots(10);",label='snapshot-'+name+'-prune')
  yes(case,'SELECT (SELECT v FROM snapshot_before)=(SELECT to_jsonb(s) FROM hand_state_snapshots s);','snapshot-'+name+'-all-original-bytes-preserved')
  e.discard(case)
 stale=e.database(qualified);e.sql(stale,'UPDATE hand_state_snapshots SET is_complete=false; SELECT sp_prune_hand_state_snapshots(10);',label='snapshot-stale-false-bit-after-proven-completion')
 yes(stale,'SELECT NOT EXISTS(SELECT 1 FROM hand_state_snapshots);','snapshot-authoritative-completion-outweighs-stale-false-bit');e.discard(stale)
 pending=e.database(base);e.sql(pending,seed+snapshot+"UPDATE hand_state_snapshots SET is_complete=false; CREATE TABLE recovery_before AS SELECT to_jsonb(s) v FROM get_active_hand_snapshot('"+old.TABLE+"') s; SELECT sp_prune_hand_state_snapshots(10);",label='snapshot-uncertified-incomplete-prune')
 yes(pending,"SELECT (SELECT v FROM recovery_before)=(SELECT to_jsonb(s) FROM get_active_hand_snapshot('"+old.TABLE+"') s);",'snapshot-original-unresolved-recovery-reader-byte-identical');e.discard(pending)
 unknown=e.database(base);e.sql(unknown,seed+snapshot+'SELECT sp_prune_hand_state_snapshots(10);',label='snapshot-completed-with-no-certificate')
 yes(unknown,'SELECT count(*)=1 FROM hand_state_snapshots;','snapshot-completion-bit-alone-never-authorizes-erasure');e.discard(unknown)
 e.sql(qualified,'BEGIN;SELECT sp_prune_hand_state_snapshots(10);ROLLBACK;',label='snapshot-owner-rollback')
 yes(qualified,'SELECT count(*)=1 FROM hand_state_snapshots;','snapshot-retention-rollback-restores-whole-witness')
 e.sql(qualified,'SELECT sp_prune_hand_state_snapshots(10); SELECT sp_prune_hand_state_snapshots(10);',label='snapshot-owner-qualified-repeat')
 yes(qualified,'SELECT NOT EXISTS(SELECT 1 FROM hand_state_snapshots);','snapshot-qualified-success-only-disposed-idempotently');e.discard(qualified)
 _,cat,_=e.sql(base,"SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'settings',p.proconfig,'security_definer',p.prosecdef,'acl',p.proacl::text)) FROM pg_proc p WHERE p.proname IN('horse_snapshot_disposable','sp_prune_hand_state_snapshots');",label='snapshot-exact-postimages')
 e.report['snapshot_qualified_postimages']=json.loads(cat);e.report['snapshot_retention']={'status':'passed','proven':checks,'migration':str(MIGRATION),'sha256':hashlib.sha256((ROOT/MIGRATION).read_bytes()).hexdigest()}
 if keep_template:return base
 e.discard(base);return checks
