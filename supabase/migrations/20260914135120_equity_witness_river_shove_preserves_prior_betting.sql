-- Keep the EV witness anchored to the last all-in with cards still to come.
-- A later river shove must not hide betting after an earlier all-in.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $patch$
DECLARE
  v_oid oid := 'public.ca_stats_witness_audit(integer,integer)'::regprocedure;
  v_source text;
  v_hash text;
  v_old text := $old$                WHERE b.act->>'action' IN ('all_in', 'allin')$old$;
  v_new text := $new$                WHERE b.act->>'action' IN ('all_in', 'allin')
                  -- A river shove cannot erase earlier continued side-pot betting.
                  -- Unknown legacy stages retain their existing treatment.
                  AND b.act->>'stage' IS DISTINCT FROM 'river'$new$;
BEGIN
  SELECT pg_get_functiondef(v_oid) INTO v_source;
  v_hash := md5(v_source);
  IF v_hash NOT IN ('3b3b9610697ea648ee94808ff7ca91b7','94b0da0dd3428b42595186266d75ff8b') THEN
    RAISE EXCEPTION 'EV witness definition drift: %',v_hash;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid=v_oid AND prosecdef
      AND pg_get_userbyid(proowner)='postgres'
      AND proconfig=ARRAY['search_path=public']
      AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
      AND pg_get_function_arguments(oid)='p_minutes integer DEFAULT 10, p_grace_seconds integer DEFAULT 90'
  ) THEN
    RAISE EXCEPTION 'EV witness ownership, settings, arguments or ACL drift';
  END IF;
  IF v_hash='3b3b9610697ea648ee94808ff7ca91b7' THEN
    IF (length(v_source)-length(replace(v_source,v_old,''))) <> length(v_old) THEN
      RAISE EXCEPTION 'EV witness boundary must occur exactly once';
    END IF;
    v_source := replace(v_source,v_old,v_new);
    IF md5(v_source) <> '94b0da0dd3428b42595186266d75ff8b' THEN
      RAISE EXCEPTION 'EV witness candidate mismatch';
    END IF;
    EXECUTE v_source;
  END IF;
  IF md5(pg_get_functiondef(v_oid)) <> '94b0da0dd3428b42595186266d75ff8b' THEN
    RAISE EXCEPTION 'EV witness installed definition mismatch';
  END IF;
END;
$patch$;
REVOKE ALL ON FUNCTION public.ca_stats_witness_audit(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_witness_audit(integer,integer) TO service_role;
COMMIT;

