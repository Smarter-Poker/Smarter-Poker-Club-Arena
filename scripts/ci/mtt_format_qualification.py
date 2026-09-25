"""Render one finite, explicit historical-format metadata transaction.

No transport, discovery, scheduler, retry, or release operation lives here.
The database's origin trigger owns provenance and whole-row preservation.
"""
from uuid import UUID


def qualification_sql(ids):
    if not 1 <= len(ids) <= 128:
        raise ValueError("format qualification requires 1..128 explicit event IDs")
    canonical = [str(UUID(value)) for value in ids]
    if len(set(canonical)) != len(canonical):
        raise ValueError("format qualification event IDs must be unique")
    literals = ",".join("'" + value + "'::uuid" for value in canonical)
    return """BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='5s';
DO $qualification$
DECLARE v_id uuid; v_before jsonb; v_after jsonb; v_format text;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
   AND relation='public.tournaments'::regclass AND mode='AccessExclusiveLock' AND granted) THEN
   RAISE EXCEPTION 'MTT_FORMAT_QUALIFICATION_MUST_FOLLOW_SCHEMA_COMMIT';
 END IF;
 IF current_user<>'postgres' OR current_setting('session_replication_role')<>'origin'
    OR COALESCE(auth.role(),'')<>''
    OR public.fn_ca_lock_mtt_admission_contract()<>'legacy-capacity-v1' THEN
   RAISE EXCEPTION 'MTT_FORMAT_QUALIFICATION_REQUIRES_ORIGINAL_LEGACY_AUTHORITY';
 END IF;
 FOREACH v_id IN ARRAY ARRAY[""" + literals + """] LOOP
  BEGIN
   SELECT to_jsonb(t) INTO v_before FROM public.tournaments t WHERE t.id=v_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'MTT_FORMAT_QUALIFICATION_PARENT_MISSING: %',v_id; END IF;
   IF v_before->>'format_contract' IS NOT NULL THEN CONTINUE; END IF;
   v_format:=public.fn_ca_proven_legacy_tournament_format(v_before);
   IF v_format IS NULL THEN CONTINUE; END IF;
   UPDATE public.tournaments t SET format_contract=v_format WHERE t.id=v_id
     RETURNING to_jsonb(t) INTO STRICT v_after;
   IF (v_before-'format_contract') IS DISTINCT FROM (v_after-'format_contract') THEN
     RAISE EXCEPTION 'MTT_FORMAT_METADATA_BACKFILL_CHANGED_BUSINESS_ROW' USING ERRCODE='55000';
   END IF;
  EXCEPTION WHEN check_violation OR object_not_in_prerequisite_state THEN
   RAISE WARNING 'MTT format unqualified for event %: % (%)',v_id,SQLERRM,SQLSTATE;
  END;
 END LOOP;
END $qualification$;
COMMIT;
"""
