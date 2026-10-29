-- @live-proof: (SELECT to_regprocedure('smarter_private.progress_superseded_action_retention()') IS NOT NULL)
-- New receipts previously tried compaction at thirty minutes, before the
-- eight-day qualifier could admit them. Record their future due time in the
-- original disposal transaction. Existing job117 owns bounded aged work.
-- Neither the qualifier nor immutable financial/replay evidence changes.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $guard$ BEGIN
 IF current_setting('cron.use_background_workers',true) IS DISTINCT FROM 'off' THEN
  RAISE EXCEPTION 'SUPERSEDED_RETENTION_REQUIRES_CRON_LIBPQ_MODE'; END IF;
 IF to_regclass('smarter_private.superseded_action_retention_due') IS NOT NULL THEN
  RAISE EXCEPTION 'SUPERSEDED_RETENTION_PROGRESS_ALREADY_INSTALLED'; END IF;
 IF md5(pg_get_functiondef('smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'::regprocedure))<>'5d91656a1c3df0bed718ad96a70153c8'
 OR md5(pg_get_functiondef('public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)'::regprocedure))<>'90c17ade7408c633be6dd71fa266ce9e' THEN
  RAISE EXCEPTION 'SUPERSEDED_RETENTION_PROGRESS_PREIMAGE_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN (
  'smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'::regprocedure,
  'public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)'::regprocedure)
  AND (pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef
   OR has_function_privilege('anon',p.oid,'execute') OR has_function_privilege('authenticated',p.oid,'execute')))
 OR has_function_privilege('service_role','smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)','execute')
 OR NOT has_function_privilege('service_role','public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)','execute') THEN
  RAISE EXCEPTION 'SUPERSEDED_RETENTION_PROGRESS_AUTHORITY_PREIMAGE_CHANGED'; END IF;
END $guard$;
CREATE TABLE smarter_private.superseded_action_retention_due(
 submission_id uuid PRIMARY KEY,
 due_at timestamptz NOT NULL CHECK(isfinite(due_at)),
 next_at timestamptz NOT NULL CHECK(isfinite(next_at))
);
CREATE INDEX superseded_action_retention_due_next_idx ON smarter_private.superseded_action_retention_due(next_at,submission_id);
ALTER TABLE smarter_private.superseded_action_retention_due ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.superseded_action_retention_due FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE smarter_private.superseded_action_retention_cursor(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 last_table_id uuid,last_hand_number bigint,
 completed boolean NOT NULL DEFAULT false,
 discovery_cutoff timestamptz,
 discovery_quiesced boolean NOT NULL DEFAULT false,
 CHECK((last_table_id IS NULL)=(last_hand_number IS NULL))
);
INSERT INTO smarter_private.superseded_action_retention_cursor(singleton) VALUES(true);
ALTER TABLE smarter_private.superseded_action_retention_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.superseded_action_retention_cursor FROM PUBLIC,anon,authenticated,service_role;

-- Receipt timestamps are data, not authority to dispose. Malformed or infinite
-- values cannot introduce a new cast failure in either original producer.
CREATE FUNCTION smarter_private.superseded_action_retention_due_at(p_expected jsonb)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path=pg_catalog AS $function$
 SELECT CASE WHEN p_expected->>'kind' IN ('superseded_retained_submission','superseded_by_later_commit')
  AND pg_input_is_valid(p_expected->>'retained_at','timestamptz') THEN
   CASE WHEN isfinite((p_expected->>'retained_at')::timestamptz)
    AND (p_expected->>'retained_at')::timestamptz<'9999-01-01'::timestamptz
    THEN (p_expected->>'retained_at')::timestamptz+make_interval(days=>policy.horse_retention_days) END END
 FROM (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) policy
 WHERE policy.horse_retention_days BETWEEN 1 AND 36500
$function$;
REVOKE ALL ON FUNCTION smarter_private.superseded_action_retention_due_at(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- No second receipt scan. RETURNING is the exact set just disposed by the
-- unchanged INSERT qualification; count remains the original disposed count.
DO $patch$
DECLARE sig text; source text; old_source text; metadata jsonb; actual jsonb; start_anchor text;
 end_anchor text; replacement text;
BEGIN
 FOR sig IN SELECT unnest(ARRAY[
 'smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)',
 'public.fn_ca_dispose_superseded_hand_submissions(uuid,uuid,text,integer)']) LOOP
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile)
 INTO source,metadata FROM pg_proc WHERE oid=sig::regprocedure;
 old_source:=source;
 start_anchor:='  INSERT INTO smarter_private.hand_submission_disposals';
 IF sig LIKE 'smarter_private.%' THEN
  end_anchor:='  ON CONFLICT DO NOTHING;'||chr(10)||'  GET DIAGNOSTICS v_disposed = ROW_COUNT;';
  replacement:='  ON CONFLICT DO NOTHING';
 ELSE
  end_anchor:='   WHERE b.blocked IS NULL AND b.basis IS NOT NULL;'||chr(10)||'  GET DIAGNOSTICS v_disposed = ROW_COUNT;';
  replacement:='   WHERE b.blocked IS NULL AND b.basis IS NOT NULL';
 END IF;
 IF (length(source)-length(replace(source,start_anchor,'')))/length(start_anchor)<>1
 OR (length(source)-length(replace(source,end_anchor,'')))/length(end_anchor)<>1 THEN
  RAISE EXCEPTION 'SUPERSEDED_RETENTION_PROGRESS_ANCHOR_CHANGED: %',sig; END IF;
 source:=replace(source,start_anchor,'  WITH disposed AS ('||chr(10)||start_anchor);
 source:=replace(source,end_anchor,replacement||$tail$
  RETURNING submission_id,expected
 ), queued AS (
  INSERT INTO smarter_private.superseded_action_retention_due(submission_id,due_at,next_at)
  SELECT submission_id,due_at,due_at FROM (
   SELECT submission_id,smarter_private.superseded_action_retention_due_at(expected) due_at FROM disposed
  ) own_new_receipts WHERE due_at IS NOT NULL
  ON CONFLICT DO NOTHING
 ) SELECT count(*) INTO v_disposed FROM disposed;$tail$);
 EXECUTE source;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile)
 INTO actual FROM pg_proc WHERE oid=sig::regprocedure;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'SUPERSEDED_RETENTION_PROGRESS_AUTHORITY_CHANGED: %',sig; END IF;
 END LOOP;
END $patch$;

CREATE FUNCTION smarter_private.progress_superseded_action_retention()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET lock_timeout='100ms' AS $function$
DECLARE r record;
 deadline timestamptz:=clock_timestamp()+interval '900 milliseconds'; n integer:=0;
BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM false
 OR NOT pg_try_advisory_xact_lock(hashtext('sp-prune-hand-history'))
 OR NOT pg_try_advisory_xact_lock_shared(530090,2)
 OR NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RETURN 0; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;

 FOR r IN SELECT submission_id FROM smarter_private.superseded_action_retention_due
  WHERE next_at<=clock_timestamp() ORDER BY next_at,submission_id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
  EXIT WHEN clock_timestamp()>=deadline;
  n:=n+smarter_private.compact_superseded_horse_actions(ARRAY[r.submission_id]);
  IF EXISTS(SELECT 1 FROM smarter_private.superseded_horse_action_certificates WHERE submission_id=r.submission_id)
  OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions s WHERE s.submission_id=r.submission_id
   AND (s.request#>'{p_hand_row,has_human}'='true'::jsonb
    OR (s.request#>'{p_hand_row,tournament_id}' IS NOT NULL AND s.request#>'{p_hand_row,tournament_id}'<>'null'::jsonb)
    OR s.request#>'{p_hand_row,reported}'='true'::jsonb
    OR s.request#>'{p_hand_row,actions}' IS NULL
    OR pg_column_size(s.request#>'{p_hand_row,actions}')<=4096)) THEN
   DELETE FROM smarter_private.superseded_action_retention_due WHERE submission_id=r.submission_id;
  ELSE
   -- Locked, refused and net-negative rows keep all original evidence and get
   -- another bounded turn without starving other due IDs.
   UPDATE smarter_private.superseded_action_retention_due SET next_at=clock_timestamp()+interval '1 day' WHERE submission_id=r.submission_id;
  END IF;
 END LOOP;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 RETURN n;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.progress_superseded_action_retention() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.discover_superseded_action_retention()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET lock_timeout='100ms' AS $function$
DECLARE c smarter_private.superseded_action_retention_cursor; page_count integer:=0;
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
  EXECUTE $page$
  WITH page AS MATERIALIZED (
   SELECT table_id,hand_number,submission_id,expected FROM smarter_private.hand_submission_disposals
   $page$||CASE WHEN c.last_table_id IS NULL THEN '' ELSE ' WHERE (table_id,hand_number)>($1,$2)' END||$page$
   ORDER BY table_id,hand_number LIMIT 5000
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
 END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 RETURN page_count;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.discover_superseded_action_retention() FROM PUBLIC,anon,authenticated,service_role;

DO $pins$
DECLARE source text; old_text text; old_pins jsonb; item jsonb; result jsonb:='[]'; changed integer:=0;
BEGIN
 SELECT pg_get_functiondef('smarter_private.original_hand_correction_sources_match()'::regprocedure) INTO source;
 old_text:=split_part(source,'$sourcepins$',2); old_pins:=old_text::jsonb;
 IF jsonb_array_length(old_pins)<>26 THEN RAISE EXCEPTION 'SUPERSEDED_RETENTION_PIN_COUNT_CHANGED'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(old_pins) LOOP
  IF item->>'signature'='smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)' THEN
   IF item->>'full_md5'<>'5d91656a1c3df0bed718ad96a70153c8' THEN RAISE EXCEPTION 'SUPERSEDED_RETENTION_PIN_PREIMAGE_CHANGED'; END IF;
   item:=item||jsonb_build_object('full_md5',md5(pg_get_functiondef('smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'::regprocedure)),
    'body_md5',(SELECT md5(prosrc) FROM pg_proc WHERE oid='smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)'::regprocedure)); changed:=changed+1;
  END IF;
  result:=result||jsonb_build_array(item);
 END LOOP;
 IF changed<>1 THEN RAISE EXCEPTION 'SUPERSEDED_RETENTION_PIN_COUNT_CHANGED'; END IF;
 EXECUTE replace(source,'$sourcepins$'||old_text||'$sourcepins$','$sourcepins$'||result::text||'$sourcepins$');
END $pins$;
DO $cron$
DECLARE original text; expected text:=$original$
select case
         when pg_try_advisory_lock(hashtext('sp-prune-hand-history'))
           then (select set_config('statement_timeout','30s',true) is not null
                    and public.sp_prune_hand_history(5000) >=0)::text
         else 'skipped: previous run still in progress'
       end;
$original$;
BEGIN
 SELECT command INTO original FROM cron.job WHERE jobid=117 AND jobname='sp_prune_hand_history_10m' AND schedule='30 seconds' AND active AND username='postgres';
 IF original IS DISTINCT FROM expected THEN RAISE EXCEPTION 'SUPERSEDED_RETENTION_CRON_PREIMAGE_CHANGED'; END IF;
 -- pg_cron1.6.4 libpq mode sends the whole command with PQsendQuery.
 -- Same job/owner/schedule. A simple-query COMMIT seals original pruning
 -- before a separately bounded phase. Original failure stops subsequent work;
 -- late phase failure remains a failed cron run and cannot undo pruning.
 PERFORM cron.alter_job(117,command:='BEGIN;'||original||'COMMIT; BEGIN; SET LOCAL statement_timeout=''2s''; SET LOCAL lock_timeout=''100ms''; SELECT smarter_private.progress_superseded_action_retention(); COMMIT; BEGIN; SET LOCAL statement_timeout=''2s''; SET LOCAL lock_timeout=''100ms''; SELECT smarter_private.discover_superseded_action_retention(); COMMIT;');
END $cron$;
COMMIT;
