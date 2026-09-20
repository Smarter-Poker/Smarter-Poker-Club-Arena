"""Deterministic source composition from frozen installed definitions and additive authority."""
import hashlib, json, re, sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
rows=json.loads((HERE/'unsettled-preimages.json').read_text())['functions']
changed=[]
for row in rows:
    old=row['definition']
    new=old
    if row.get('proname') in {
        'fn_f06_begin_hand','fn_f06_discover_breaks','fn_f06_hand_number_state','fn_f06_table_state',
        'f06_hand_dispatch_guard','f06_move_guard','f06_source_guard','f06_table_guard','f06_validate_destination'}:
        new=re.sub(r"(\b(?:\w+\.)?state)\s*<>\s*'acknowledged'",r"\1 NOT IN ('acknowledged','withdrawn_before_manifest')",new)
        assert new != old,row['signature']
    if row.get('proname')=='f06_hand_dispatch_guard':
        new=new.replace("h.state='never_started'","h.state IN ('never_started','aborted_unsettled')")
    if row.get('proname')=='f06_immutable_identity':
        insertion=""" IF TG_TABLE_NAME='f06_operations' AND OLD.state='withdrawn_before_manifest' THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND NEW.state='aborted_unsettled' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=NEW.evidence_id
 AND a.permit_id=NEW.permit_id AND a.tournament_id=NEW.tournament_id AND a.table_id=NEW.table_id
 AND a.generation=NEW.generation AND a.hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND NEW.state='withdrawn_before_manifest' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=NEW.abort_receipt_id
 AND a.break_id=NEW.break_id AND a.tournament_id=NEW.tournament_id
 AND a.table_id=NEW.source_table_id AND a.generation=NEW.origin_generation) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
"""
        # Shared generic trigger: use JSON access so other relation records never
        # require a field they do not own during PL/pgSQL expression preparation.
        insertion=insertion.replace("OLD.state","(to_jsonb(OLD)->>'state')").replace("NEW.state","(to_jsonb(NEW)->>'state')")
        for key in ['evidence_id','permit_id','tournament_id','table_id','generation','abort_receipt_id','break_id','source_table_id','origin_generation']:
            insertion=insertion.replace('NEW.'+key,"(to_jsonb(NEW)->>'"+key+"')::uuid")
        insertion=insertion.replace('NEW.hand_number',"(to_jsonb(NEW)->>'hand_number')::bigint")
        new=new.replace(" IF TG_TABLE_NAME='f06_hand_permits'",insertion+" IF TG_TABLE_NAME='f06_hand_permits'",1)
        new=new.replace("-'cleanup_kind'-'close_receipt'","-'cleanup_kind'-'close_receipt'-'abort_receipt_id'")
        # This trigger now checks an inaccessible private receipt; retain caller
        # privileges for existing rows through its established SECURITY DEFINER owner.
        new=new.replace(" LANGUAGE plpgsql\n SET search_path"," LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path")
    if row.get('proname')=='claim_tournament_lease_v2':
        needle='   FOR UPDATE;\n'
        assert new.count(needle)==1
        new=new.replace(needle,needle+"""
  IF smarter_private.f06_generation_aborted(p_tournament_id,p_requested_generation) THEN
    RETURN QUERY SELECT false,NULL::text,NULL::numeric,NULL::uuid,2;
    RETURN;
  END IF;
""")
    if row.get('proname') in {'heartbeat_tournament_leases_v3','heartbeat_tournament_leases_v4'}:
        needle='AND l.lease_generation = a.requested_generation'
        new=new.replace(needle,needle+"""
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)""")
    if row.get('proname')=='fn_smarter_data_api_pre_request':
        needle='AND l.lease_generation = v_lease_generation'
        new=new.replace(needle,needle+"""
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)""")
    if new!=old:
        changed.append((row,new))
assert len(changed)==14,len(changed)
header="""-- Interrupted heads-up SNG originals retain their last committed stacks.
-- A reserved permit and pre-manifest park previously had no truthful outcome
-- after an already dealt hand stopped. Never call that hand never_started.
-- This explicit transaction drains original-generation writes, permanently
-- fences the generation/hand, records aborted_unsettled, and withdraws only
-- that pre-manifest reservation. No wallet/escrow/stack/history credit.
-- Runtime dependency: 2bbc/2ad preserve protocol-2 async actor provenance.
-- The serving process retains old in-memory custody until its normal certified
-- replacement; a fresh process consumes the unchanged active-state contract.
-- Qualified by the existing native F06 shared-hand-lane runner.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
-- BEGIN installer relation admission
-- One bounded admission, before DDL or business writes. Every partial lock set
-- rolls back in its exception subtransaction before yielding to live readers.
-- Waiting while retaining any subset would reintroduce the observed deadlock.
DO $admission$
DECLARE v_deadline timestamptz := clock_timestamp()+interval '3 seconds';
BEGIN
 LOOP
  IF clock_timestamp()>=v_deadline THEN
   RAISE EXCEPTION 'F06_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
  END IF;
  BEGIN
   LOCK TABLE smarter_private.f06_hand_permits IN ACCESS EXCLUSIVE MODE NOWAIT;
   LOCK TABLE public.engine_tournament_leases IN SHARE ROW EXCLUSIVE MODE NOWAIT;
   LOCK TABLE smarter_private.f06_operations IN ACCESS EXCLUSIVE MODE NOWAIT;
   LOCK TABLE public.hand_atomic_commits IN SHARE ROW EXCLUSIVE MODE NOWAIT;
   LOCK TABLE public.hand_history IN SHARE ROW EXCLUSIVE MODE NOWAIT;
   LOCK TABLE public.ca_declared_money_triggers IN ROW EXCLUSIVE MODE NOWAIT;
   IF clock_timestamp()>=v_deadline THEN
    RAISE EXCEPTION 'F06_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
   END IF;
   EXIT;
  EXCEPTION WHEN lock_not_available THEN
   -- All six transaction-level relation locks acquired above are now released.
   -- Yield only the remaining part of the original admission budget.
   PERFORM pg_sleep(least(0.01,greatest(0,extract(epoch FROM v_deadline-clock_timestamp()))));
  END;
 END LOOP;
END $admission$;
-- END installer relation admission
DO $preimages$ BEGIN
"""
for row,new in changed:
    sig=row['signature'];sig=sig if '.' in sig.split('(')[0] else 'public.'+sig
    digest=hashlib.md5(row['definition'].encode()).hexdigest()
    header+=f" IF md5(pg_get_functiondef('{sig}'::regprocedure))<>'{digest}' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{row['acl']}' FROM pg_proc WHERE oid='{sig}'::regprocedure) THEN RAISE EXCEPTION 'F06_ABORT_PREIMAGE_CHANGED {sig}'; END IF;\n"
for binding in json.loads((HERE/'unsettled-bindings.json').read_text()):
    relation=binding['relation']
    if '.' not in relation: relation='public.'+relation
    definition=binding['definition'].replace("'","''")
    header+=f" IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='{relation}'::regclass AND tgname='{binding['tgname']}' AND tgenabled='O' AND pg_get_triggerdef(oid)='{definition}') THEN RAISE EXCEPTION 'F06_ABORT_BINDING_CHANGED {binding['tgname']}'; END IF;\n"
for row in rows:
    if row.get('proname') in {'f06_try_lane','release_tournament_leases_v2','fn_ca_share_settlement_lane_for_table'}:
        sig=row['signature']
        if '.' not in sig.split('(')[0]: sig='public.'+sig
        digest=hashlib.md5(row['definition'].encode()).hexdigest()
        header+=f" IF md5(pg_get_functiondef('{sig}'::regprocedure))<>'{digest}' THEN RAISE EXCEPTION 'F06_ABORT_DEPENDENCY_CHANGED {sig}'; END IF;\n"
freeze_definitions=re.findall(r'CREATE OR REPLACE FUNCTION[\s\S]*?AS \$function\$[\s\S]*?\$function\$\n', (HERE/'unsettled-freeze-preimages.sql').read_text().replace('$function$;','$function$\n'))
assert len(freeze_definitions)==2
for definition in freeze_definitions:
    sig=re.search(r'FUNCTION (public\.\w+\(\))',definition).group(1)
    digest=hashlib.md5(definition.encode()).hexdigest()
    header+=f" IF md5(pg_get_functiondef('{sig}'::regprocedure))<>'{digest}' THEN RAISE EXCEPTION 'F06_ABORT_FREEZE_DEPENDENCY_CHANGED {sig}'; END IF;\n"
header+=""" IF md5(pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure))<>'8c0acda3b19e958ecd5bbbc07c845afe' THEN RAISE EXCEPTION 'F06_ABORT_OUTER_SETTLEMENT_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticator' AND 'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'=ANY(rolconfig)) THEN RAISE EXCEPTION 'F06_ABORT_PRE_REQUEST_NOT_INSTALLED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_state_snapshots'::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_BINDINGS_CHANGED'; END IF;
END $preimages$;
"""
sql=header+(HERE/'unsettled-schema.sql').read_text()+"\n"
for row,new in changed:
    sig=row['signature']
    if '.' not in sig.split('(')[0]: sig='public.'+sig
    sql+=new.rstrip()+";\n"
    # Restate the independently checked installed ACL in maintained source;
    # CREATE OR REPLACE preserves it, but static migration checks must see it.
    sql+=f"REVOKE ALL ON FUNCTION {sig} FROM PUBLIC,anon,authenticated,service_role;\n"
    for role in ['anon','authenticated','service_role']:
        if role+'=X/' in row['acl']:
            sql+=f"GRANT EXECUTE ON FUNCTION {sig} TO {role};\n"
sql+=(HERE/'unsettled-authority.sql').read_text()
sql+="""
REVOKE ALL ON FUNCTION public.fn_f06_abort_unsettled_hand(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_unsettled_hand(uuid,jsonb) TO service_role;
COMMIT;
"""
outputs={
 ROOT/'supabase/migrations/20260918053310_interrupted_sng_hands_keep_stacks_and_fence_their_original_writers.sql':sql,
 HERE/'unsettled-changed-functions.json':json.dumps([{'signature':r['signature'],'before_md5':hashlib.md5(r['definition'].encode()).hexdigest(),'after_md5':hashlib.md5(n.encode()).hexdigest()} for r,n in changed],indent=2)+'\n'
}
for path,content in outputs.items():
    if '--check' in sys.argv:
        if path.read_text()!=content: raise SystemExit('Unsettled authority composition changed: '+str(path))
    else: path.write_text(content)
