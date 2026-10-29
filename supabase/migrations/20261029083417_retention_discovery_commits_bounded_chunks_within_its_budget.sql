-- Existing discovery owns bounded historical progress; no new timer or index.
-- @live-proof: (SELECT position('longest_chunk' IN pg_get_functiondef('smarter_private.discover_superseded_action_retention()'::regprocedure))>0 AND position('LIMIT 250' IN pg_get_functiondef('smarter_private.discover_superseded_action_retention()'::regprocedure))>0)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TEMP TABLE retention_discovery_authority ON COMMIT DROP AS SELECT proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid='smarter_private.discover_superseded_action_retention()'::regprocedure;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('smarter_private.discover_superseded_action_retention()'::regprocedure))<>'b7eae030b437b830695a3bac6f78f821' THEN RAISE EXCEPTION 'RETENTION_DISCOVERY_BUDGET_PREIMAGE_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.discover_superseded_action_retention()'::regprocedure AND (pg_get_userbyid(proowner)<>'postgres' OR NOT prosecdef OR has_function_privilege('anon',p.oid,'execute') OR has_function_privilege('authenticated',p.oid,'execute') OR has_function_privilege('service_role',p.oid,'execute') OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE'))) THEN RAISE EXCEPTION 'RETENTION_DISCOVERY_BUDGET_AUTHORITY_CHANGED'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION smarter_private.discover_superseded_action_retention()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET lock_timeout='100ms' AS $function$
DECLARE c smarter_private.superseded_action_retention_cursor; page_count integer:=0; total_count integer:=0;
 deadline timestamptz:=clock_timestamp()+interval '900 milliseconds';
 chunk_started timestamptz; longest_chunk interval:=interval '0';
BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM false
 OR NOT pg_try_advisory_xact_lock(hashtext('sp-prune-hand-history'))
 OR NOT pg_try_advisory_xact_lock_shared(530090,2)
 OR NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RETURN 0; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;
 SELECT * INTO c FROM smarter_private.superseded_action_retention_cursor WHERE singleton FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN 0; END IF;
 -- Establish the barrier only in a post-install invocation. Every transaction
 -- capable of finishing an already executing pre-install producer began by
 -- this cutoff. Long old transactions postpone only historical discovery.
 IF c.discovery_cutoff IS NULL THEN
  UPDATE smarter_private.superseded_action_retention_cursor SET discovery_cutoff=clock_timestamp() WHERE singleton;
  RETURN page_count;
 END IF;
 IF NOT c.discovery_quiesced THEN
  IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid()
   AND datname=current_database() AND xact_start<=c.discovery_cutoff) THEN RETURN page_count; END IF;
  UPDATE smarter_private.superseded_action_retention_cursor SET discovery_quiesced=true WHERE singleton;
 END IF;
 IF NOT c.completed THEN
  -- Bound raw PK keys before filtering. One finite pass covers history;
  -- transactionally captured new receipts do not depend on a future wrap.
  LOOP
  EXIT WHEN total_count>=5000 OR clock_timestamp()+longest_chunk>=deadline;
  chunk_started:=clock_timestamp();
  EXECUTE $page$
  WITH page AS MATERIALIZED (
   SELECT table_id,hand_number,submission_id,expected FROM smarter_private.hand_submission_disposals
   $page$||CASE WHEN c.last_table_id IS NULL THEN '' ELSE ' WHERE (table_id,hand_number)>($1,$2)' END||$page$
   ORDER BY table_id,hand_number LIMIT 250
  ), queued AS (
   INSERT INTO smarter_private.superseded_action_retention_due(submission_id,due_at,next_at)
   SELECT submission_id,due_at,due_at FROM (
    SELECT submission_id,smarter_private.superseded_action_retention_due_at(expected) due_at FROM page
   ) historical_receipts WHERE due_at IS NOT NULL ON CONFLICT DO NOTHING
  ) SELECT count(*),(array_agg(table_id ORDER BY table_id DESC,hand_number DESC))[1],
   (array_agg(hand_number ORDER BY table_id DESC,hand_number DESC))[1] FROM page
  $page$ INTO page_count,c.last_table_id,c.last_hand_number USING c.last_table_id,c.last_hand_number;
  IF page_count=0 THEN
   UPDATE smarter_private.superseded_action_retention_cursor SET completed=true WHERE singleton;
  ELSE
   UPDATE smarter_private.superseded_action_retention_cursor
   SET last_table_id=c.last_table_id,last_hand_number=c.last_hand_number WHERE singleton;
  END IF;
  total_count:=total_count+page_count;
  longest_chunk:=greatest(longest_chunk,clock_timestamp()-chunk_started);
  EXIT WHEN page_count<250;
  END LOOP;
 END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 RETURN total_count;
END $function$;
DO $authority$ BEGIN
 IF (SELECT row(proowner,proacl,proconfig,prosecdef) FROM pg_proc WHERE oid='smarter_private.discover_superseded_action_retention()'::regprocedure) IS DISTINCT FROM (SELECT row(proowner,proacl,proconfig,prosecdef) FROM retention_discovery_authority) THEN RAISE EXCEPTION 'RETENTION_DISCOVERY_BUDGET_AUTHORITY_CHANGED'; END IF;
END $authority$;
COMMIT;
