-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511215920 "phantom_rpcs_real_impls_r5_remainder"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3e9e6179b4560d976621211bdefa0856 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Now the report_live_game + fn_complete_media_upload + DROPs
CREATE OR REPLACE FUNCTION public.report_live_game(
  p_venue_id integer DEFAULT NULL, p_user_id uuid DEFAULT NULL, p_game_type text DEFAULT NULL,
  p_stakes text DEFAULT NULL, p_seats_open integer DEFAULT NULL, p_waitlist_size integer DEFAULT NULL,
  p_table_count integer DEFAULT 1, p_notes text DEFAULT NULL, p_game_quality text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_caller_role text; v_caller_uid uuid; v_game_id uuid; v_wait_time integer;
BEGIN
  v_caller_role := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_caller_uid := auth.uid();
  IF v_caller_role = 'authenticated' THEN
    IF v_caller_uid IS NULL OR p_user_id <> v_caller_uid THEN
      RAISE WARNING 'report_live_game: spoof attempt by % targeting %', v_caller_uid, p_user_id;
      RETURN NULL;
    END IF;
  ELSIF v_caller_role = 'anon' OR v_caller_role = '' THEN RETURN NULL; END IF;
  IF p_venue_id IS NULL OR p_user_id IS NULL OR p_game_type IS NULL OR p_stakes IS NULL THEN
    RETURN NULL;
  END IF;
  v_wait_time := CASE
    WHEN COALESCE(p_waitlist_size, 0) <= 0 THEN 0
    WHEN COALESCE(p_table_count, 1) <= 0 THEN 60
    ELSE LEAST(180, (COALESCE(p_waitlist_size, 0) * 10) / GREATEST(1, COALESCE(p_table_count, 1)))
  END;
  INSERT INTO public.live_games (
    venue_id, user_id, game_type, stakes, table_count, wait_time, notes, game_quality,
    is_active, confirmation_count, created_at, expires_at
  ) VALUES (
    p_venue_id, p_user_id, p_game_type, p_stakes,
    GREATEST(1, COALESCE(p_table_count, 1)), v_wait_time, p_notes, p_game_quality,
    true, 1, now(), now() + interval '4 hours'
  ) RETURNING id INTO v_game_id;
  RETURN v_game_id;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'report_live_game failed for user % venue %: % %', p_user_id, p_venue_id, SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.report_live_game(integer, uuid, text, text, integer, integer, integer, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.report_live_game(integer, uuid, text, text, integer, integer, integer, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.report_live_game(integer, uuid, text, text, integer, integer, integer, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_complete_media_upload(
  p_media_id uuid, p_width integer DEFAULT NULL, p_height integer DEFAULT NULL, p_duration_seconds numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_caller_role text; v_caller_uid uuid; v_owner uuid; v_rowcount integer := 0;
BEGIN
  IF p_media_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'media_id required'); END IF;
  v_caller_role := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_caller_uid := auth.uid();
  SELECT uploader_id INTO v_owner FROM public.social_media WHERE id = p_media_id;
  IF v_owner IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'media not found'); END IF;
  IF v_caller_role = 'authenticated' THEN
    IF v_caller_uid IS NULL OR v_owner <> v_caller_uid THEN
      RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
  ELSIF v_caller_role = 'anon' OR v_caller_role = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthorized');
  END IF;
  UPDATE public.social_media SET width = COALESCE(p_width, width), height = COALESCE(p_height, height), duration_seconds = COALESCE(p_duration_seconds, duration_seconds) WHERE id = p_media_id;
  GET DIAGNOSTICS v_rowcount = ROW_COUNT;
  RETURN jsonb_build_object('success', v_rowcount > 0, 'media_id', p_media_id);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_complete_media_upload failed for media %: % %', p_media_id, SQLERRM, SQLSTATE;
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_complete_media_upload(uuid, integer, integer, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_complete_media_upload(uuid, integer, integer, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_complete_media_upload(uuid, integer, integer, numeric) TO authenticated;

-- Drop dead-overload stubs and unused stubs
DROP FUNCTION IF EXISTS public.geeves_upsert_missed_question(text, text, jsonb);
DROP FUNCTION IF EXISTS public.increment_share_view(text);
DROP FUNCTION IF EXISTS public.set_topic_cooldown(text, text, integer);
DROP FUNCTION IF EXISTS public.fn_complete_media_upload(uuid, text);
DROP FUNCTION IF EXISTS public.update_leaderboard_rankings(uuid);
DROP FUNCTION IF EXISTS public.increment_cache_served(text);
DROP FUNCTION IF EXISTS public.fn_increment_agent_player_count(uuid, uuid);
DROP FUNCTION IF EXISTS public.record_health_metric(text, numeric, jsonb);
DROP FUNCTION IF EXISTS public.issue_manual_comp(uuid, uuid, numeric, text, uuid);
DROP FUNCTION IF EXISTS public.redeem_comps(uuid, uuid, numeric, text, text);
