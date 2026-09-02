-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827224315; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Video Library Phase 5: atomic watch sessions and the real preference column.

CREATE OR REPLACE FUNCTION public.update_page_preferences(
  p_user_id uuid, p_column_name text, p_preferences jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_preferences jsonb;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Unauthorized: User ID mismatch';
  END IF;
  IF p_column_name NOT IN ('bankroll_preferences','trivia_preferences','video_preferences',
    'video_library_preferences','news_preferences','memory_games_preferences',
    'diamond_arcade_preferences','diamond_arena_preferences','poker_near_me_preferences') THEN
    RAISE EXCEPTION 'Invalid preference column: %', p_column_name;
  END IF;
  EXECUTE format(
    'UPDATE profiles SET %I = $1, updated_at = now() WHERE id = $2 RETURNING %I',
    p_column_name, p_column_name
  ) INTO v_preferences USING p_preferences, p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  RETURN v_preferences;
END; $$;

CREATE OR REPLACE FUNCTION public.record_video_watch_session(
  p_video_id text,
  p_additional_seconds integer,
  p_video_title text DEFAULT NULL,
  p_thumbnail_url text DEFAULT NULL,
  p_duration_seconds integer DEFAULT NULL
) RETURNS TABLE (
  previous_watch_duration_seconds integer,
  watch_duration_seconds integer,
  progress_seconds integer,
  watched_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_additional integer := LEAST(GREATEST(COALESCE(p_additional_seconds, 0), 0), 3600);
  v_previous integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_video_id IS NULL OR btrim(p_video_id) = '' THEN
    RAISE EXCEPTION 'Video ID is required';
  END IF;
  IF v_additional = 0 THEN
    RETURN;
  END IF;

  SELECT COALESCE(h.watch_duration_seconds, 0)
    INTO v_previous
    FROM public.video_watch_history h
   WHERE h.user_id = v_user_id AND h.video_id = p_video_id;

  INSERT INTO public.video_watch_history (
    user_id, video_id, video_title, thumbnail_url,
    watch_duration_seconds, progress_seconds, duration_seconds, watched_at
  ) VALUES (
    v_user_id, p_video_id, p_video_title, p_thumbnail_url,
    v_additional,
    CASE WHEN COALESCE(p_duration_seconds, 0) > 0
      THEN LEAST(p_duration_seconds, v_additional) ELSE v_additional END,
    NULLIF(p_duration_seconds, 0), now()
  )
  ON CONFLICT (user_id, video_id) DO UPDATE SET
    video_title = COALESCE(EXCLUDED.video_title, video_watch_history.video_title),
    thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, video_watch_history.thumbnail_url),
    watch_duration_seconds = COALESCE(video_watch_history.watch_duration_seconds, 0) + v_additional,
    progress_seconds = CASE
      WHEN COALESCE(EXCLUDED.duration_seconds, video_watch_history.duration_seconds, 0) > 0
        THEN LEAST(
          COALESCE(EXCLUDED.duration_seconds, video_watch_history.duration_seconds),
          COALESCE(video_watch_history.progress_seconds, 0) + v_additional
        )
      ELSE COALESCE(video_watch_history.progress_seconds, 0) + v_additional
    END,
    duration_seconds = COALESCE(EXCLUDED.duration_seconds, video_watch_history.duration_seconds),
    watched_at = now();

  RETURN QUERY
  SELECT v_previous,
         COALESCE(h.watch_duration_seconds, 0),
         COALESCE(h.progress_seconds, 0),
         h.watched_at
    FROM public.video_watch_history h
   WHERE h.user_id = v_user_id AND h.video_id = p_video_id;
END; $$;

REVOKE ALL ON FUNCTION public.record_video_watch_session(text, integer, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_video_watch_session(text, integer, text, text, integer) TO authenticated;
-- Video Library Phase 6: server-timed watch proof and atomic preference patches.

ALTER TABLE public.video_watch_history
  ADD COLUMN IF NOT EXISTS watch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

-- Preferences are patched inside one statement so two rapid toggles cannot
-- overwrite each other with stale full-object snapshots.
CREATE OR REPLACE FUNCTION public.patch_video_library_preferences(
  p_expected_user_id uuid,
  p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_preferences jsonb;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_expected_user_id THEN
    RAISE EXCEPTION 'Unauthorized: User ID mismatch';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Preference patch must be a JSON object';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_patch) AS keys(key)
    WHERE key NOT IN ('autoplay', 'captions')
  ) THEN
    RAISE EXCEPTION 'Invalid video-library preference key';
  END IF;

  UPDATE public.profiles
     SET video_library_preferences =
           COALESCE(video_library_preferences, '{}'::jsonb) || p_patch,
         updated_at = now()
   WHERE id = p_expected_user_id
   RETURNING video_library_preferences INTO v_preferences;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  RETURN v_preferences;
END;
$$;

REVOKE ALL ON FUNCTION public.patch_video_library_preferences(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.patch_video_library_preferences(uuid, jsonb) TO authenticated;

-- Replace the Phase 5 overload so PostgREST has exactly one callable signature.
DROP FUNCTION IF EXISTS public.record_video_watch_session(text, integer, text, text, integer);

CREATE OR REPLACE FUNCTION public.record_video_watch_session(
  p_expected_user_id uuid,
  p_video_id text,
  p_additional_seconds integer,
  p_progress_seconds integer DEFAULT NULL,
  p_video_title text DEFAULT NULL,
  p_thumbnail_url text DEFAULT NULL,
  p_duration_seconds integer DEFAULT NULL
) RETURNS TABLE (
  canonical_video_id text,
  previous_watch_duration_seconds integer,
  watch_duration_seconds integer,
  progress_seconds integer,
  credited_seconds integer,
  watch_started_at timestamptz,
  last_heartbeat_at timestamptz,
  watched_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_requested integer := LEAST(GREATEST(COALESCE(p_additional_seconds, 0), 0), 20);
  v_credited integer := 0;
  v_previous integer := 0;
  v_last_heartbeat timestamptz;
  v_started_at timestamptz;
  v_catalog_title text;
  v_catalog_thumbnail text;
  v_existing boolean := false;
BEGIN
  IF v_user_id IS NULL OR v_user_id <> p_expected_user_id THEN
    RAISE EXCEPTION 'Unauthorized: User ID mismatch';
  END IF;
  IF p_video_id IS NULL OR btrim(p_video_id) = '' THEN
    RAISE EXCEPTION 'Video ID is required';
  END IF;

  SELECT v.title, v.thumbnail_url
    INTO v_catalog_title, v_catalog_thumbnail
    FROM public.video_library_videos v
   WHERE v.youtube_video_id = btrim(p_video_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown video ID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || btrim(p_video_id), 0));

  SELECT COALESCE(h.watch_duration_seconds, 0), h.last_heartbeat_at, h.watch_started_at, true
    INTO v_previous, v_last_heartbeat, v_started_at, v_existing
    FROM public.video_watch_history h
   WHERE h.user_id = v_user_id AND h.video_id = btrim(p_video_id)
   FOR UPDATE;

  -- A fresh proof window starts for legacy rows because their existing totals
  -- may have come from the retired direct-write path.
  IF NOT v_existing OR v_started_at IS NULL THEN
    v_previous := 0;
    v_started_at := v_now;
    v_credited := v_requested;
  ELSIF v_last_heartbeat IS NOT NULL
        AND v_now - v_last_heartbeat >= interval '5 seconds' THEN
    v_credited := LEAST(
      v_requested,
      GREATEST(0, floor(extract(epoch FROM (v_now - v_last_heartbeat)))::integer + 2)
    );
  END IF;

  INSERT INTO public.video_watch_history (
    user_id, video_id, video_title, thumbnail_url,
    watch_duration_seconds, progress_seconds, duration_seconds,
    watch_started_at, last_heartbeat_at, watched_at
  ) VALUES (
    v_user_id, btrim(p_video_id), COALESCE(v_catalog_title, p_video_title),
    COALESCE(v_catalog_thumbnail, p_thumbnail_url), v_credited,
    GREATEST(0, COALESCE(p_progress_seconds, 0)),
    NULLIF(LEAST(GREATEST(COALESCE(p_duration_seconds, 0), 0), 86400), 0),
    v_started_at, v_now, v_now
  )
  ON CONFLICT (user_id, video_id) DO UPDATE SET
    video_title = COALESCE(v_catalog_title, video_watch_history.video_title),
    thumbnail_url = COALESCE(v_catalog_thumbnail, video_watch_history.thumbnail_url),
    watch_duration_seconds = CASE
      WHEN video_watch_history.watch_started_at IS NULL THEN v_credited
      ELSE COALESCE(video_watch_history.watch_duration_seconds, 0) + v_credited
    END,
    progress_seconds = CASE
      WHEN COALESCE(EXCLUDED.duration_seconds, video_watch_history.duration_seconds, 0) > 0
        THEN LEAST(
          COALESCE(EXCLUDED.duration_seconds, video_watch_history.duration_seconds),
          GREATEST(0, COALESCE(p_progress_seconds, video_watch_history.progress_seconds, 0))
        )
      ELSE GREATEST(0, COALESCE(p_progress_seconds, video_watch_history.progress_seconds, 0))
    END,
    duration_seconds = COALESCE(EXCLUDED.duration_seconds, video_watch_history.duration_seconds),
    watch_started_at = COALESCE(video_watch_history.watch_started_at, v_started_at),
    last_heartbeat_at = v_now,
    watched_at = v_now;

  RETURN QUERY
  SELECT btrim(p_video_id), v_previous,
         COALESCE(h.watch_duration_seconds, 0), COALESCE(h.progress_seconds, 0),
         v_credited, h.watch_started_at, h.last_heartbeat_at, h.watched_at
    FROM public.video_watch_history h
   WHERE h.user_id = v_user_id AND h.video_id = btrim(p_video_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_video_watch_session(uuid, text, integer, integer, text, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_video_watch_session(uuid, text, integer, integer, text, text, integer)
  TO authenticated;

-- All watch-credit writes now flow through the server-timed function. Users
-- retain SELECT and DELETE access for history/resume and "mark unwatched".
DROP POLICY IF EXISTS "Users can add to watch history" ON public.video_watch_history;
DROP POLICY IF EXISTS "Users can update watch history" ON public.video_watch_history;

NOTIFY pgrst, 'reload schema';

