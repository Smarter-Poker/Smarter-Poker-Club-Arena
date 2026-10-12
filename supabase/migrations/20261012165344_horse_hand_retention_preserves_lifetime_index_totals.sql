-- Lifetime statistics read an index that horse history retention deletes.
-- Archive only exact deleted index count/time, then combine it with live rows.
-- Historical deleted rows are unknown; no financial/history replay or guessing.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $absent$ BEGIN
 IF to_regclass('smarter_private.hand_index_retention_totals') IS NOT NULL THEN
  RAISE EXCEPTION 'HAND_INDEX_LIFETIME_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
END $absent$;
CREATE TABLE smarter_private.hand_index_retention_totals (
 user_id uuid NOT NULL, asset text NOT NULL, hands bigint NOT NULL CHECK(hands>0),
 first_hand_at timestamptz NOT NULL, last_hand_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,asset), CHECK(first_hand_at<=last_hand_at)
);
CREATE TABLE smarter_private.hand_index_retention_coverage (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 historical_complete boolean NOT NULL DEFAULT false CHECK(NOT historical_complete)
);
INSERT INTO smarter_private.hand_index_retention_coverage(singleton) VALUES(true);
ALTER TABLE smarter_private.hand_index_retention_totals OWNER TO postgres;
ALTER TABLE smarter_private.hand_index_retention_coverage OWNER TO postgres;
REVOKE ALL ON smarter_private.hand_index_retention_totals,smarter_private.hand_index_retention_coverage FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_index_coverage_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_index_retention_coverage
 FOR EACH ROW EXECUTE FUNCTION smarter_private.horse_settlement_certificate_immutable();
CREATE TRIGGER hand_index_coverage_no_truncate BEFORE TRUNCATE ON smarter_private.hand_index_retention_coverage
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.horse_settlement_certificate_immutable();

-- Deletion and increment share one statement: duplicate/concurrent callers can
-- archive a physical index row only once. User/asset order preserves lock order.
CREATE FUNCTION smarter_private.archive_pruned_hand_index(p_hands uuid[])
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_hands IS NULL OR cardinality(p_hands)>250 THEN RAISE EXCEPTION 'HAND_INDEX_ARCHIVE_BATCH_INVALID' USING ERRCODE='22023'; END IF;
 -- Same history boundary that the owning prune locks before any side effects.
 PERFORM 1 FROM public.hand_history WHERE id=ANY(p_hands) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=ANY(p_hands)
  AND (h.has_human IS DISTINCT FROM FALSE OR h.reported IS TRUE OR h.created_at IS NULL
   OR NOT isfinite(h.created_at) OR h.created_at>=now()-interval '8 days'))
 OR EXISTS(SELECT 1 FROM public.ca_hand_player_idx i WHERE i.hand_id=ANY(p_hands)
  AND NOT EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=i.hand_id)) THEN
  RAISE EXCEPTION 'HAND_INDEX_ARCHIVE_RETENTION_BOUNDARY_REQUIRED' USING ERRCODE='55000'; END IF;
 WITH removed AS (
  DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(p_hands) RETURNING user_id,asset,created_at
 ), grouped AS (
  SELECT user_id,asset,count(*)::bigint hands,min(created_at) first_hand_at,max(created_at) last_hand_at
  FROM removed GROUP BY user_id,asset
 ), written AS (
  INSERT INTO smarter_private.hand_index_retention_totals(user_id,asset,hands,first_hand_at,last_hand_at)
  SELECT user_id,asset,hands,first_hand_at,last_hand_at FROM grouped ORDER BY user_id,asset
  ON CONFLICT(user_id,asset) DO UPDATE SET hands=hand_index_retention_totals.hands+EXCLUDED.hands,
   first_hand_at=LEAST(hand_index_retention_totals.first_hand_at,EXCLUDED.first_hand_at),
   last_hand_at=GREATEST(hand_index_retention_totals.last_hand_at,EXCLUDED.last_hand_at)
  RETURNING 1
 ) SELECT coalesce(sum(hands),0)::integer INTO n FROM grouped WHERE (SELECT count(*) FROM written)>=0;
 RETURN n;
END $$;
ALTER FUNCTION smarter_private.archive_pruned_hand_index(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.archive_pruned_hand_index(uuid[]) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE target oid:='public.fn_ca_hand_player_row_takes_its_hands_asset()'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef=true AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF md5(source) IS DISTINCT FROM '258c715e21a5a99cb99c51e46ff6a022' THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'BEGIN
','')))/length('BEGIN
')<>1 THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'BEGIN
','BEGIN
  -- The index must not resurrect a retained hand after its count was archived.
  -- Keep the shared asset function unchanged for every other relation.
  IF TG_TABLE_SCHEMA=''public'' AND TG_TABLE_NAME=''ca_hand_player_idx'' THEN
    PERFORM 1 FROM public.hand_history WHERE id=NEW.hand_id FOR KEY SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.ca_player_stats_full(uuid,integer,text,text)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef=true AND proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF md5(source) IS DISTINCT FROM '25b9c0ae9b22b9f36a29d9bbfe80e819' THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user AND asset = p_asset;','')))/length('  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user AND asset = p_asset;')<>1 THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user AND asset = p_asset;','  SELECT coalesce(sum(hands),0)::bigint,min(first_hand_at),max(last_hand_at)
  INTO v_life_hands,v_life_first,v_life_last FROM (
   SELECT count(*)::bigint hands,min(created_at) first_hand_at,max(created_at) last_hand_at
   FROM public.ca_hand_player_idx WHERE user_id=p_user AND asset=p_asset
   UNION ALL
   SELECT hands,first_hand_at,last_hand_at FROM smarter_private.hand_index_retention_totals
   WHERE user_id=p_user AND asset=p_asset
  ) recorded_lifetime;');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.ca_player_stats_full(uuid,integer,text,text)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef=true AND proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'  v_life_hands int := 0;','')))/length('  v_life_hands int := 0;')<>1 THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'  v_life_hands int := 0;','  v_life_hands bigint := 0;');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.ca_player_stats_full(uuid,integer,text,text)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef=true AND proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'    ''indexed_complete'', (SELECT backfill_complete FROM ca_hand_player_idx_state WHERE id)','')))/length('    ''indexed_complete'', (SELECT backfill_complete FROM ca_hand_player_idx_state WHERE id)')<>1 THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'    ''indexed_complete'', (SELECT backfill_complete FROM ca_hand_player_idx_state WHERE id)','    ''indexed_complete'', (SELECT backfill_complete FROM ca_hand_player_idx_state WHERE id),
    ''source'', ''active_index_and_retention_totals'',
    ''historical_complete'', false,
    ''retention_capture_started_at'', (SELECT started_at FROM smarter_private.hand_index_retention_coverage WHERE singleton)');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;

DO $patch$
DECLARE target oid:='public.sp_prune_hand_history(integer)'::regprocedure; source text; metadata jsonb; actual jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO source,metadata FROM pg_proc WHERE oid=target;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}' AND prosecdef=false AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
 IF md5(source) IS DISTINCT FROM '278219bbf58cb30cfad6aa63017a407c' THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_SOURCE_CHANGED: %',target::regprocedure USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,'      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);','')))/length('      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);')<>1 THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,'      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);','      PERFORM smarter_private.archive_pruned_hand_index(v_doomed);');
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'secdef',prosecdef,'settings',proconfig) INTO actual FROM pg_proc WHERE oid=target;
 IF actual IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'HAND_INDEX_LIFETIME_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $patch$;
COMMIT;
