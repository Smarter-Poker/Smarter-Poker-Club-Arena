\set ON_ERROR_STOP on
-- Exact read-only catalog overlay captured 2026-09-17T05:54:17.091488+00:00.
-- Disposable PG17 full-catalog baseline only, BEFORE complete activation.
-- The retained schema lacks this live legacy function. Do not rewrite it or
-- replace the scalar helper already present in the original captured schema.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR current_database()<>'postgres'
  OR inet_server_addr() IS NOT NULL OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'stats batch overlay requires isolated PG17 owner baseline';END IF;
 IF to_regprocedure('public.fn_apply_rakeback_player_stats_batch(jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION 'captured stats batch already present';END IF;
 IF md5(pg_get_functiondef('public.apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric)'::regprocedure))
  IS DISTINCT FROM '7f2b71a539db1b9c5cf6dbf6a489d40e' THEN
  RAISE EXCEPTION 'captured scalar stats dependency changed';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_apply_rakeback_player_stats_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  it jsonb;
  v_ok integer := 0;
  v_failed integer := 0;
  v_first_error text := NULL;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', 0, 'failed', 0, 'error', 'p_items must be a jsonb array');
  END IF;

  -- ---------------------------------------------------------------- fast path
  BEGIN
    WITH src AS (
      SELECT DISTINCT ON (rake_record_id, user_id)
             rake_record_id, user_id, club_id, hands, rake
        FROM (
          SELECT (e->>'rake_record_id')::uuid        AS rake_record_id,
                 (e->>'user_id')::uuid               AS user_id,
                 (e->>'club_id')::uuid               AS club_id,
                 COALESCE((e->>'hands')::integer, 1) AS hands,
                 COALESCE((e->>'rake')::numeric, 0)  AS rake
            FROM jsonb_array_elements(p_items) AS e
        ) parsed
       WHERE rake_record_id IS NOT NULL
         AND user_id        IS NOT NULL
         AND club_id        IS NOT NULL
    ),
    ins AS (
      INSERT INTO public.rakeback_stats_applied (rake_record_id, user_id, hands, rake)
      SELECT rake_record_id, user_id, hands, rake FROM src
      ON CONFLICT (rake_record_id, user_id) DO NOTHING
      RETURNING rake_record_id, user_id, hands, rake
    ),
    agg AS (
      SELECT i.user_id,
             s.club_id,
             SUM(COALESCE(i.hands, 0))::integer AS hands,
             SUM(COALESCE(i.rake, 0))::numeric  AS rake
        FROM ins i
        JOIN src s
          ON s.rake_record_id = i.rake_record_id
         AND s.user_id        = i.user_id
       GROUP BY i.user_id, s.club_id
    ),
    upserted AS (
      INSERT INTO public.player_stats (
        user_id, club_id, hands_played, total_rake,
        total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won
      )
      SELECT user_id, club_id, hands, rake, 0, 0, 0, 0, 0, 0 FROM agg
      ON CONFLICT (user_id, club_id) DO UPDATE SET
        hands_played = public.player_stats.hands_played + EXCLUDED.hands_played,
        total_rake   = ROUND((public.player_stats.total_rake + EXCLUDED.total_rake) * 100) / 100,
        updated_at   = NOW()
      RETURNING 1
    )
    SELECT count(*)::integer INTO v_ok FROM ins;

    RETURN jsonb_build_object('ok', v_ok, 'failed', 0, 'first_error', NULL);

  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_apply_rakeback_player_stats_batch: set-based path failed (%), falling back to per-item', SQLERRM;
    v_ok := 0; v_failed := 0; v_first_error := NULL;
  END;

  -- ------------------------------------------------- fallback: original loop
  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      PERFORM public.apply_rakeback_player_stats(
        (it->>'rake_record_id')::uuid,
        (it->>'user_id')::uuid,
        (it->>'club_id')::uuid,
        COALESCE((it->>'hands')::integer, 1),
        COALESCE((it->>'rake')::numeric, 0)
      );
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF v_first_error IS NULL THEN v_first_error := SQLERRM; END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', v_ok, 'failed', v_failed, 'first_error', v_first_error);
END;
$function$;
ALTER FUNCTION public.fn_apply_rakeback_player_stats_batch(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_apply_rakeback_player_stats_batch(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_rakeback_player_stats_batch(jsonb) TO postgres,service_role;
DO $exact$
DECLARE actual_acl text[];
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_apply_rakeback_player_stats_batch(jsonb)'::regprocedure
  AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
  AND p.proconfig=ARRAY['search_path=public']::text[]
  AND md5(pg_get_functiondef(p.oid))='ac2b4515198a0fe4bd327dfc030f506a'
  AND md5(p.prosrc)='fb371b86bd34d8417d87bbe706b275ea') THEN
  RAISE EXCEPTION 'captured stats batch definition mismatch';END IF;
 SELECT array_agg(a::text ORDER BY a::text) INTO actual_acl
  FROM pg_proc p,LATERAL unnest(p.proacl)a WHERE p.oid='public.fn_apply_rakeback_player_stats_batch(jsonb)'::regprocedure;
 IF actual_acl IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
  OR has_function_privilege('anon','public.fn_apply_rakeback_player_stats_batch(jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_apply_rakeback_player_stats_batch(jsonb)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.fn_apply_rakeback_player_stats_batch(jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'captured stats batch access mismatch';END IF;
END $exact$;
COMMIT;

