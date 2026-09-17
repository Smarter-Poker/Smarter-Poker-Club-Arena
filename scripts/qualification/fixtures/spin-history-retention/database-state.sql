-- Temporary, read-only disposable-state oracle. No replacement business writer.
-- Full rows of the restored auth/public/private authority estate, with explicit
-- bounds. Sequence counters are separately observable, never reset or compared
-- as transactional data: real nextval effects do not roll back.
CREATE FUNCTION pg_temp.retention_database_state(p_removed uuid[] DEFAULT '{}'::uuid[])
RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE r record; rows jsonb; answer jsonb:='{}'::jsonb; n integer:=0;
BEGIN
 IF p_removed IS NULL OR array_position(p_removed,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'retention oracle: unknown removed identities'; END IF;
 FOR r IN SELECT c.oid,c.relname,nsp.nspname FROM pg_class c
  JOIN pg_namespace nsp ON nsp.oid=c.relnamespace
  WHERE nsp.nspname IN('auth','public','smarter_private') AND c.relkind IN('r','p')
  ORDER BY nsp.nspname,c.relname LOOP
  n:=n+1; IF n>400 THEN RAISE EXCEPTION 'retention oracle: relation bound exceeded'; END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(value ORDER BY value::text),''[]''::jsonb)
    FROM (SELECT to_jsonb(x) value FROM %I.%I x LIMIT 1001) limited',r.nspname,r.relname) INTO rows;
  IF jsonb_array_length(rows)>1000 THEN RAISE EXCEPTION 'retention oracle: row bound exceeded %.%',r.nspname,r.relname; END IF;
  IF r.nspname='public' AND r.relname='hand_history' THEN
   SELECT COALESCE(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO rows
   FROM jsonb_array_elements(rows) x WHERE NOT COALESCE((x->>'id')::uuid=ANY(p_removed),false);
  ELSIF r.nspname='public' AND r.relname=ANY(ARRAY['rake_attributions','ca_hand_player_idx','hand_atomic_commits']) THEN
   SELECT COALESCE(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO rows
   FROM jsonb_array_elements(rows) x WHERE NOT COALESCE((x->>'hand_id')::uuid=ANY(p_removed),false);
  END IF;
  answer:=answer||jsonb_build_object(r.nspname||'.'||r.relname,rows);
  IF octet_length(answer::text)>4194304 THEN RAISE EXCEPTION 'retention oracle: selected estate exceeds 4 MiB'; END IF;
 END LOOP;
 RETURN answer;
END $state$;
CREATE FUNCTION pg_temp.retention_catalog_state() RETURNS jsonb LANGUAGE sql AS $catalog$
 SELECT jsonb_build_object(
  'pruner',(SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid='public.sp_prune_hand_history(integer)'::regprocedure),
  'user_triggers',(SELECT jsonb_agg(jsonb_build_object('relation',t.tgrelid::regclass::text,
    'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true))
    ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal))
$catalog$;
CREATE FUNCTION pg_temp.retention_sequence_state() RETURNS jsonb LANGUAGE plpgsql AS $sequences$
DECLARE n text; value jsonb; answer jsonb:='{}'::jsonb;
BEGIN
 FOREACH n IN ARRAY ARRAY['public.content_authors_id_seq','public.managed_game_contract_versions_id_seq','smarter_private.f06_lifecycle_seq'] LOOP
  EXECUTE format('SELECT jsonb_build_object(''last_value'',last_value::text,''is_called'',is_called) FROM %s',n::regclass) INTO value;
  answer:=answer||jsonb_build_object(n,value);
 END LOOP;
 RETURN answer;
END $sequences$;
