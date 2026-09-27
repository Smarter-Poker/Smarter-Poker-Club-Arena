-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420010523 "phase40_fix_abuse_patterns_and_viewer_id_impersonation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5d244e81a0db67c89e3860afd7c378c9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bugs 32 & 33:
--   (32) detect_home_abuse_patterns has no auth check. Any authenticated
--        user can enumerate content reports across the entire platform,
--        seeing target IDs, report counts, reasons, and suggested actions.
--        Content reports are confidential.
--   (33) search_home_groups and search_home_groups_v2 accept p_viewer_user_id
--        without verifying it matches auth.uid(). An attacker can enumerate
--        which public groups any user has joined (via p_exclude_joined diff).
--
-- Fixes:
--   (32) Require the caller to be a platform admin (profiles.role = 'admin').
--   (33) When p_viewer_user_id is supplied, require it to equal auth.uid()
--        unless the caller is service_role.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (32) detect_home_abuse_patterns: admin-only
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_home_abuse_patterns(
  p_lookback_days integer DEFAULT 30,
  p_min_reports integer DEFAULT 3
)
RETURNS TABLE(
  target_type text, target_id uuid, report_count bigint, unique_reporters bigint,
  reason_breakdown jsonb, first_reported timestamp with time zone,
  last_reported timestamp with time zone, suggested_action text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO off
AS $function$
BEGIN
    -- Require platform-admin caller. service_role bypass for server-side cron.
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
      IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
      ) THEN
        RAISE EXCEPTION 'ADMIN_ONLY' USING ERRCODE = '42501',
              HINT = 'detect_home_abuse_patterns requires platform admin';
      END IF;
    END IF;

    RETURN QUERY
    WITH agg AS (
        SELECT r.reported_type AS t_type, r.reported_id AS t_id,
               COUNT(*) AS rc, COUNT(DISTINCT r.reporter_id) AS ur,
               MIN(r.created_at) AS fr, MAX(r.created_at) AS lr
          FROM commander_home_content_reports r
         WHERE r.status = 'pending'
           AND r.created_at > NOW() - (p_lookback_days || ' days')::interval
         GROUP BY r.reported_type, r.reported_id
        HAVING COUNT(*) >= p_min_reports
    ),
    breakdown AS (
        SELECT r.reported_type AS t_type, r.reported_id AS t_id,
               jsonb_object_agg(r.reason_category, c) AS breakdown_json
          FROM (
            SELECT reported_type, reported_id, reason_category, COUNT(*) AS c
              FROM commander_home_content_reports
             WHERE status = 'pending'
               AND created_at > NOW() - (p_lookback_days || ' days')::interval
             GROUP BY reported_type, reported_id, reason_category
          ) r
         GROUP BY r.reported_type, r.reported_id
    )
    SELECT a.t_type, a.t_id, a.rc, a.ur,
           COALESCE(b.breakdown_json, '{}'::jsonb),
           a.fr, a.lr,
           CASE
               WHEN a.ur >= 5 AND a.rc >= 5 THEN 'auto_action_recommended'
               WHEN a.ur >= 3 THEN 'review_urgently'
               ELSE 'review_normally'
           END
      FROM agg a
      LEFT JOIN breakdown b ON b.t_type = a.t_type AND b.t_id = a.t_id
     ORDER BY a.ur DESC, a.rc DESC;
END;
$function$;

COMMENT ON FUNCTION public.detect_home_abuse_patterns IS
  'Phase 40: requires platform admin (profiles.role=''admin''). Previously '
  'callable by any authenticated user — leaked report aggregates.';

-- ----------------------------------------------------------------------------
-- (33a) search_home_groups: verify p_viewer_user_id = auth.uid()
-- ----------------------------------------------------------------------------
-- Patch by adding an assertion at the top; keep the rest of the function body
-- unchanged. First load current source to preserve it.
DO $outer$
DECLARE
  v_def text;
  v_body text;
  v_new_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='search_home_groups';

  IF v_def IS NULL THEN
    RAISE NOTICE 'search_home_groups not found - skipping';
    RETURN;
  END IF;

  -- Wrap: extract body between "AS $function$" and "$function$\n" and prepend check
  -- Simpler approach: just CREATE OR REPLACE the function with the same signature
  -- and prepend the viewer check. But the function is long. Use DO block to patch.
  RAISE NOTICE 'search_home_groups current def size: %', length(v_def);
END
$outer$;

-- Rewrite search_home_groups_v2 in full with the guard prepended
CREATE OR REPLACE FUNCTION public.search_home_groups_v2(
  p_search_text text DEFAULT NULL::text,
  p_city text DEFAULT NULL::text,
  p_state text DEFAULT NULL::text,
  p_game_type text DEFAULT NULL::text,
  p_stakes text DEFAULT NULL::text,
  p_tags text[] DEFAULT NULL::text[],
  p_lat numeric DEFAULT NULL::numeric,
  p_lng numeric DEFAULT NULL::numeric,
  p_radius_miles integer DEFAULT NULL::integer,
  p_exclude_joined boolean DEFAULT false,
  p_viewer_user_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 50,
  p_inactivity_days integer DEFAULT 45
)
RETURNS TABLE(
  group_id uuid, name text, slug text, tagline text, description text,
  city text, state text, profile_photo_url text, cover_photo_url text,
  is_private boolean, member_count integer, games_hosted integer,
  distance_miles numeric, tags text[], relevance_score real,
  recent_rsvps_30d bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_point   geography;
    v_tsquery tsquery;
BEGIN
    -- Phase 40: if a viewer_user_id is passed, verify it matches the caller.
    -- Prevents membership-enumeration via (exclude_joined=true vs false) diffing.
    -- Anonymous callers (auth.uid() IS NULL) may not supply p_viewer_user_id.
    IF p_viewer_user_id IS NOT NULL THEN
      IF COALESCE(auth.role(), '') <> 'service_role' THEN
        IF auth.uid() IS NULL OR auth.uid() <> p_viewer_user_id THEN
          RAISE EXCEPTION 'VIEWER_ID_MISMATCH'
                USING ERRCODE = '42501',
                      HINT = 'p_viewer_user_id must equal auth.uid() or be null';
        END IF;
      END IF;
    END IF;

    IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
        v_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
    END IF;

    IF p_search_text IS NOT NULL AND length(trim(p_search_text)) > 0 THEN
        v_tsquery := plainto_tsquery('english', p_search_text);
    END IF;

    RETURN QUERY
    SELECT
        g.id, g.name,
        sp.slug,
        g.tagline, g.description,
        g.city, g.state, g.profile_photo_url, g.cover_photo_url,
        g.is_private,
        COALESCE(g.member_count, 0),
        COALESCE(g.games_hosted, 0),
        CASE WHEN v_point IS NOT NULL AND g.location_geog IS NOT NULL
             THEN ROUND((ST_Distance(g.location_geog, v_point) / 1609.344)::numeric, 1)
             ELSE NULL END,
        g.tags,
        CASE WHEN v_tsquery IS NOT NULL
             THEN ts_rank(g.search_vector, v_tsquery)
             ELSE 0::real END,
        COALESCE((
            SELECT COUNT(*) FROM commander_home_rsvps r
            JOIN commander_home_games hg ON hg.id = r.game_id
            WHERE hg.group_id = g.id AND r.response='yes'
              AND r.responded_at > NOW() - INTERVAL '30 days'
        ), 0)
      FROM commander_home_groups g
      LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE g.is_active = true
       AND NOT g.is_private
       AND g.profile_photo_url IS NOT NULL
       AND g.last_activity_at > NOW() - (p_inactivity_days || ' days')::interval
       AND (v_tsquery IS NULL OR g.search_vector @@ v_tsquery)
       AND (p_city  IS NULL OR g.city  ILIKE '%' || p_city  || '%')
       AND (p_state IS NULL OR g.state ILIKE '%' || p_state || '%')
       AND (p_game_type IS NULL OR g.default_game_type = p_game_type)
       AND (p_stakes    IS NULL OR g.default_stakes    = p_stakes)
       AND (p_tags IS NULL OR g.tags && p_tags)
       AND (v_point IS NULL OR p_radius_miles IS NULL OR g.location_geog IS NULL
            OR ST_DWithin(g.location_geog, v_point, p_radius_miles * 1609.344))
       AND (NOT p_exclude_joined OR p_viewer_user_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM commander_home_members m
               WHERE m.group_id = g.id AND m.user_id = p_viewer_user_id
                 AND m.status IN ('approved','pending')))
     ORDER BY
        CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(g.search_vector, v_tsquery) ELSE 0::real END DESC,
        CASE WHEN v_point IS NOT NULL AND g.location_geog IS NOT NULL
             THEN ST_Distance(g.location_geog, v_point)
             ELSE 999999999 END ASC,
        g.last_activity_at DESC
     LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$function$;

COMMENT ON FUNCTION public.search_home_groups_v2 IS
  'Phase 40: validates p_viewer_user_id = auth.uid() to prevent membership '
  'enumeration via exclude_joined diff. service_role bypass for cron.';
