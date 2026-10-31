-- Reserved by scripts/reserve-migration-version.sh.
-- The detector reports 43 refused requests although all 43 exact original hands
-- have authoritative accepted-hand and completed required-obligation receipts.
-- Preserve every original alert and unknown outcome; exclude only the maintained
-- CLASS 4 exact-original acceptance predicate, not resolved flags or later hands.
-- Existing floor, reasons, rolling window and correction watermark are unchanged.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_hand_commit_refusals(integer)'::regprocedure)) = '9867d39a47029f0851bb5520d5afa586'
BEGIN;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s';
DO $migration$
DECLARE src text; changed text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_hand_commit_refusals(integer)'::regprocedure
 AND md5(pg_get_functiondef(oid))='4d7b2654ded88f3e2556dbeeac017778'
 AND pg_get_userbyid(proowner)='postgres' AND prosecdef
 AND proconfig=ARRAY['search_path=public, pg_temp']::text[]
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'HAND_REFUSAL_DETECTOR_PREIMAGE_OR_AUTHORITY_CHANGED';END IF;
 SELECT pg_get_functiondef('public.fn_ca_hand_commit_refusals(integer)'::regprocedure) INTO src;
 IF array_length(string_to_array(src,$anchor$       /* A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR (2026-09-10).$anchor$),1)<>2 THEN RAISE EXCEPTION 'HAND_REFUSAL_DETECTOR_ANCHOR_CHANGED';END IF;
 changed:=replace(src,$anchor$       /* A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR (2026-09-10).$anchor$,$replacement$       -- A refused request is no longer an unresolved hand outcome when THIS
       -- exact original was durably accepted and every required post-commit
       -- obligation completed. A resolved flag, note or later hand is not proof.
       AND NOT EXISTS (
         SELECT 1 FROM public.hand_atomic_commits c
         WHERE c.hand_id=CASE WHEN (a.context->'hand_request_identity_v1'->>'hand_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN (a.context->'hand_request_identity_v1'->>'hand_id')::uuid END
         AND jsonb_typeof(a.context)='object' AND a.context->>'channel'='server_rpc'
         AND jsonb_typeof(a.context->'hand_request_identity_v1')='object'
         AND a.context->'hand_request_identity_v1'->'version'='1'::jsonb
         AND a.context->'hand_request_identity_v1'->'post_commit_required'='true'::jsonb
         AND jsonb_typeof(a.context->'hand_request_identity_v1'->'table_id')='string'
         AND jsonb_typeof(a.context->'hand_request_identity_v1'->'hand_id')='string'
         AND jsonb_typeof(a.context->'hand_request_identity_v1'->'hand_number')='number'
         AND lower(a.context->>'table_id')=lower(a.context->'hand_request_identity_v1'->>'table_id')
         AND a.context->'hand_number'=a.context->'hand_request_identity_v1'->'hand_number'
         AND c.table_id=CASE WHEN (a.context->'hand_request_identity_v1'->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN (a.context->'hand_request_identity_v1'->>'table_id')::uuid END
         AND c.hand_number=CASE WHEN (a.context->'hand_request_identity_v1'->>'hand_number') ~ '^[1-9][0-9]{6,15}$'
           THEN CASE WHEN (a.context->'hand_request_identity_v1'->>'hand_number')::bigint<=9007199254740991
           THEN (a.context->'hand_request_identity_v1'->>'hand_number')::bigint END END
         AND c.payload_hash ~ '^[0-9a-f]{64}$'
         AND c.post_commit_request_hash ~ '^[0-9a-f]{64}$'
         AND c.post_commit_payload_hash ~ '^[0-9a-f]{64}$'
         AND jsonb_typeof(c.post_commit_payload)='object'
         AND c.post_commit_completed_at IS NOT NULL
         AND jsonb_typeof(c.post_commit_result)='object'
         AND c.post_commit_result->'ok'='true'::jsonb
         AND c.post_commit_result->>'hand_id'=c.hand_id::text
         AND c.post_commit_result->'hand_number'=to_jsonb(c.hand_number))
       /* A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR (2026-09-10).$replacement$);
 IF 'fn_ca_hand_commit_refusals' = ANY (public.fn_ca_guard_watchlist()) THEN
 PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_hand_commit_refusals','migration 20261029205730_hand_commit_detector_requires_exact_original_outcome');
 END IF;
 EXECUTE changed;
 IF 'fn_ca_hand_commit_refusals' = ANY (public.fn_ca_guard_watchlist()) THEN
 PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_hand_commit_refusals','migration 20261029205730_hand_commit_detector_requires_exact_original_outcome');
 END IF;
END $migration$;
COMMIT;
