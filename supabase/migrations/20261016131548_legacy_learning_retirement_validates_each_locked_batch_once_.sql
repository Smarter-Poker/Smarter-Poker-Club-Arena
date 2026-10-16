-- Reserved through scripts/new-migration.mjs. The original one-time exception
-- repeatedly parsed every shared batch for every member hand. A local PG17.11
-- 250-hand/three-batch fixture measured 0.537s repeated parsing within a 0.574s
-- original call. Validate requested hands in each locked batch once per call.
-- No qualification, lock, deadline, count/byte budget, ledger, financial or
-- human-retention change. No persistent cache, job, trigger or new authority.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $patch$
DECLARE p pg_proc; src text; original text; replacement text;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='smarter_private.purge_legacy_horse_learning(uuid[])'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM 'dcce64d000c3d5e45cc8faf1f6e83e92'
 OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
 OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private','lock_timeout=2s']
 THEN RAISE EXCEPTION 'LEGACY_BATCH_CACHE_PREIMAGE_CHANGED'; END IF;
 src:=pg_get_functiondef(p.oid);
 original:=$old_loop$  FOR b IN SELECT batch_key,canonical_payload FROM public.horse_adaptive_observation_batches
   WHERE batch_key=ANY(candidate_keys) ORDER BY batch_key FOR UPDATE LOOP
   IF EXISTS(SELECT 1 FROM public.horse_adaptive_journal_work WHERE batch_key=b.batch_key AND state<>'completed') THEN bad:=true; EXIT; END IF;
   FOR v IN SELECT value FROM jsonb_array_elements(b.canonical_payload::jsonb->7) LOOP
    IF (v#>>'{}')::jsonb->>2=v_hand::text THEN
     exists_raw:=true; touched:=touched+1;
     IF jsonb_typeof((v#>>'{}')::jsonb->5) IS DISTINCT FROM 'number'
      OR ((v#>>'{}')::jsonb->>5)!~'^[0-9]{1,16}$'
      OR ((v#>>'{}')::jsonb->>5)::bigint>1791158399999 THEN bad:=true; EXIT; END IF;
    END IF;
   END LOOP;
   IF bad THEN EXIT; END IF;
  END LOOP;
  IF bad OR NOT exists_raw THEN protected:=protected||v_hand; CONTINUE; END IF;
$old_loop$;
 replacement:=$new_loop$  -- Each entry is derived only after taking the original batch row lock.
  -- Keep only requested hands' presence/age flags, not raw payload copies.
  FOREACH cache_key IN ARRAY candidate_keys LOOP
   IF EXISTS(SELECT 1 FROM public.horse_adaptive_journal_work WHERE batch_key=cache_key AND state<>'completed') THEN bad:=true; EXIT; END IF;
   IF NOT batch_cache ? cache_key THEN
    SELECT batch_key,canonical_payload INTO b FROM public.horse_adaptive_observation_batches
     WHERE batch_key=cache_key FOR UPDATE;
    cache_flags:='{}'::jsonb;
    IF FOUND AND b.canonical_payload IS NOT NULL THEN
     FOR v IN SELECT value FROM jsonb_array_elements(b.canonical_payload::jsonb->7) LOOP
      cache_tuple:=(v#>>'{}')::jsonb;
      cache_hand:=cache_tuple->>2;
      IF cache_hand=ANY(p_hand_ids::text[]) THEN
       cache_bad:=jsonb_typeof(cache_tuple->5) IS DISTINCT FROM 'number'
        OR (cache_tuple->>5)!~'^[0-9]{1,16}$';
       IF NOT cache_bad THEN cache_bad:=(cache_tuple->>5)::bigint>1791158399999; END IF;
       cache_flags:=jsonb_set(cache_flags,ARRAY[cache_hand],to_jsonb(
        COALESCE((cache_flags->>cache_hand)::boolean,false) OR cache_bad));
      END IF;
     END LOOP;
    END IF;
    batch_cache:=jsonb_set(batch_cache,ARRAY[cache_key],cache_flags);
   END IF;
   IF batch_cache->cache_key ? v_hand::text THEN
    exists_raw:=true;
    IF (batch_cache->cache_key->>v_hand::text)::boolean THEN bad:=true; EXIT; END IF;
   END IF;
  END LOOP;
  IF bad OR NOT exists_raw THEN
   -- A refused candidate must not accumulate arbitrarily many disjoint raw
   -- byte windows in the cache. Retain only already-admitted keys, whose union
   -- is bounded by the unchanged original 16 MiB admission check above.
   SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO batch_cache
    FROM jsonb_each(batch_cache) WHERE key=ANY(keys);
   protected:=protected||v_hand; CONTINUE;
  END IF;
$new_loop$;
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'LEGACY_BATCH_CACHE_LOOP_ANCHOR_CHANGED'; END IF;
 src:=replace(src,original,replacement);
 original:=' exists_raw boolean; bad boolean; touched integer;';
 replacement:=E' exists_raw boolean; bad boolean; touched integer;\n batch_cache jsonb:=''{}''; cache_flags jsonb; cache_tuple jsonb; cache_key text; cache_hand text; cache_bad boolean;';
 IF (length(src)-length(replace(src,original,'')))/length(original)<>1
 THEN RAISE EXCEPTION 'LEGACY_BATCH_CACHE_DECLARATION_CHANGED'; END IF;
 EXECUTE replace(src,original,replacement);
END $patch$;
COMMIT;
