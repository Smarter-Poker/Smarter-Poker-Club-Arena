-- A settled horse hand's original payload ages out with its history.
-- Keep immutable identity, original digest and disposal fence forever. No money
-- table is written, and no scheduler is added. Historical disposals alone are
-- insufficient: qualification also proves horse roster, age and no live hold.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $preimage$
BEGIN
 IF to_regprocedure('smarter_private.horse_request_payload_disposable(uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'HORSE_REQUEST_RETENTION_ALREADY_INSTALLED' USING ERRCODE='55000';
 END IF;
 IF md5(pg_get_functiondef('smarter_private.hand_submission_immutable()'::regprocedure)) IS DISTINCT FROM 'a22d5bdb6d4400dcf911e1bd28e3b354' THEN
  RAISE EXCEPTION 'HORSE_REQUEST_IMMUTABILITY_SOURCE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF md5(pg_get_functiondef('smarter_private.hand_submission_retention_disposal(uuid[],text)'::regprocedure)) IS DISTINCT FROM 'b30df5d8cfc7ac1eb9c9dff69d29a0a4' THEN
  RAISE EXCEPTION 'HORSE_REQUEST_DISPOSAL_SOURCE_CHANGED' USING ERRCODE='55000';
 END IF;
END $preimage$;

CREATE FUNCTION smarter_private.horse_request_payload_disposable(p_submission_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE s smarter_private.hand_submissions; d smarter_private.hand_submission_disposals;
 players jsonb; days integer; item jsonb; player_id text; tournament_text text; tournament uuid;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF NOT FOUND OR s.request='{}'::jsonb THEN RETURN false; END IF;
 SELECT * INTO d FROM smarter_private.hand_submission_disposals
  WHERE table_id=s.table_id AND hand_number=s.hand_number AND submission_id=s.submission_id;
 SELECT horse_retention_days INTO days FROM public.hand_history_retention_policy LIMIT 1;
 -- This assignment is the eight-day policy. Never silently accept a shorter
 -- configured age, or fabricate qualification from malformed historical data.
 IF days IS DISTINCT FROM 8 OR d.submission_id IS NULL
 OR d.expected->>'kind' IS DISTINCT FROM 'retention_pruned_settled_hand'
 OR d.expected->>'settled' IS DISTINCT FROM 'true'
 OR d.expected->>'settlement_completed' IS DISTINCT FROM 'true'
 OR d.expected->>'request_hash' IS DISTINCT FROM s.request_hash
 OR d.expected->>'submission_id' IS DISTINCT FROM s.submission_id::text
 OR d.expected->>'table_id' IS DISTINCT FROM s.table_id::text
 OR d.expected->>'hand_number' IS DISTINCT FROM s.hand_number::text
 OR d.expected->>'pruned_hand_id' IS DISTINCT FROM s.submission_id::text
 OR NOT isfinite(s.retained_at)
 OR s.retained_at>=now()-make_interval(days=>days) THEN RETURN false; END IF;
 BEGIN
  IF (d.expected->>'hand_created_at')::timestamptz IS NULL
   OR NOT isfinite((d.expected->>'hand_created_at')::timestamptz)
   OR (d.expected->>'hand_created_at')::timestamptz>=now()-make_interval(days=>days)
   OR (d.expected->>'settlement_completed_at')::timestamptz IS NULL
   OR NOT isfinite((d.expected->>'settlement_completed_at')::timestamptz)
   OR (d.expected->>'settlement_completed_at')::timestamptz>=now()-make_interval(days=>days) THEN RETURN false; END IF;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
 END;
 IF s.request#>>'{p_hand_row,has_human}'='true'
 OR s.request#>>'{p_hand_row,reported}'='true'
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=s.submission_id
   AND (h.has_human IS true OR h.reported IS true))
 OR smarter_private.f06_hand_cards_unresolved(s.table_id,s.hand_number)
 OR smarter_private.f06_movement_boundary_retained(s.table_id,s.hand_number)
 OR EXISTS(SELECT 1 FROM public.bbj_payouts b WHERE b.table_id=s.table_id AND b.hand_number=s.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=s.submission_id)
 OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k WHERE k.hand_id=s.submission_id AND k.state='pending')
 THEN RETURN false; END IF;
 tournament_text:=s.request#>>'{p_hand_row,tournament_id}';
 IF tournament_text IS NOT NULL THEN
  IF tournament_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RETURN false; END IF;
  tournament:=tournament_text::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.table_id AND t.tournament_id=tournament)
  OR NOT EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=tournament
    AND upper(COALESCE(t.status::text,'')) IN('COMPLETED','CANCELLED','CANCELED')
    AND COALESCE(t.bounty_pool,0)<=COALESCE(t.bounty_pool_paid,0))
  OR EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=tournament AND e.closed_at IS NULL)
  THEN RETURN false; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.table_id AND t.tournament_id IS NULL) THEN RETURN false;
 END IF;
 players:=s.request#>'{p_hand_row,players}';
 IF jsonb_typeof(players) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(players)=0 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(players) LOOP
  player_id:=item->>'userId';
  IF player_id IS NULL OR player_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=player_id::uuid AND p.is_horse IS true)
   THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.horse_request_payload_disposable(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.hand_submission_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_SCHEMA='smarter_private' AND TG_TABLE_NAME='hand_submissions' THEN
  IF NEW.request='{}'::jsonb AND OLD.request<>'{}'::jsonb
  AND (to_jsonb(NEW)-'request') IS NOT DISTINCT FROM (to_jsonb(OLD)-'request')
  AND smarter_private.horse_request_payload_disposable(OLD.submission_id) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'HAND_SUBMISSION_IMMUTABLE' USING ERRCODE='55000';
END $function$;

CREATE FUNCTION smarter_private.compact_settled_horse_requests(p_submission_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE n integer;
BEGIN
 IF cardinality(p_submission_ids)>10000 THEN RAISE EXCEPTION 'HORSE_REQUEST_BATCH_TOO_LARGE' USING ERRCODE='22023'; END IF;
 UPDATE smarter_private.hand_submissions s SET request='{}'::jsonb
 WHERE submission_id=ANY(p_submission_ids) AND smarter_private.horse_request_payload_disposable(s.submission_id);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.compact_settled_horse_requests(uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION smarter_private.compact_settled_horse_requests(uuid[]) FROM service_role;

-- Append one compaction call to the existing disposal transaction. Its original
-- return is receipt count. Prune supplies actual hand IDs, also submission IDs.
DO $patch$
DECLARE src text; anchor text:=E'  RETURN v_rows;\n'; completed_anchor text:=E'           ''disposed_at'', clock_timestamp())';
BEGIN
 src:=pg_get_functiondef('smarter_private.hand_submission_retention_disposal(uuid[],text)'::regprocedure);
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1
 OR (length(src)-length(replace(src,completed_anchor,'')))/length(completed_anchor)<>1 THEN
  RAISE EXCEPTION 'HORSE_REQUEST_DISPOSAL_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 src:=replace(src,completed_anchor,E'           ''settlement_completed_at'', (SELECT a.post_commit_completed_at FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND a.hand_id=s.submission_id),\n           ''settlement_completed'', EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND a.hand_id=s.submission_id AND a.post_commit_completed_at IS NOT NULL AND a.post_commit_result->>''ok''=''true''),\n' || completed_anchor);
 EXECUTE replace(src,anchor,E'  PERFORM smarter_private.compact_settled_horse_requests(p_hand_ids);\n  RETURN v_rows;\n');
END $patch$;
DO $prune_patch$
DECLARE src text; anchor text:=E'         AND hh.reported IS NOT true\n';
BEGIN
 src:=pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
 IF md5(src) IS DISTINCT FROM '931d0ad53e8d65536a0d5558b704a42f' THEN
  RAISE EXCEPTION 'HORSE_REQUEST_PRUNE_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
 IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'HORSE_REQUEST_PRUNE_SETTLED_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 src:=replace(src,anchor,anchor || E'         AND (hh.table_id IS NULL OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=hh.id AND a.table_id=hh.table_id AND a.hand_number=hh.hand_number AND isfinite(a.post_commit_completed_at) AND a.post_commit_completed_at<now()-v_window AND a.post_commit_result->>''ok''=''true''))\n');
 EXECUTE src;
END $prune_patch$;
COMMIT;
