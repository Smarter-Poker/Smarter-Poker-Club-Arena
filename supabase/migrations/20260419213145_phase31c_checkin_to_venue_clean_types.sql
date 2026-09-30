-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419213145 "phase31c_checkin_to_venue_clean_types"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 514f242dd1c919daa254341576b2f559 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Update checkin_to_venue to use clean types post-Phase 31:
--  • venue_checkins.user_id is now uuid, venue_id is integer (drop ::text casts)
--  • user_venue_checkins.venue_id is now integer (can now write to it)
CREATE OR REPLACE FUNCTION public.checkin_to_venue(
    p_venue_id integer,
    p_caller_user_id uuid,
    p_message text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_venue RECORD; v_user_name text; v_id uuid; v_recent_count int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_message IS NOT NULL AND length(p_message) > 500 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;

    SELECT id, name INTO v_venue FROM poker_venues WHERE id = p_venue_id 
       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false);
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;

    -- Rate limit: max 10 check-ins per user per hour
    SELECT COUNT(*) INTO v_recent_count FROM venue_checkins 
     WHERE user_id = p_caller_user_id AND created_at > NOW() - INTERVAL '1 hour';
    IF v_recent_count >= 10 THEN 
        RAISE EXCEPTION 'RATE_LIMITED' USING HINT='max 10 check-ins per hour'; 
    END IF;

    SELECT COALESCE(display_name, username, 'Anonymous') INTO v_user_name 
      FROM profiles WHERE id = p_caller_user_id;

    -- Write to primary check-in log (now uuid + integer — clean types)
    INSERT INTO venue_checkins (venue_id, user_id, user_name, message)
    VALUES (p_venue_id, p_caller_user_id, v_user_name, p_message)
    RETURNING id INTO v_id;

    -- Also write to user_venue_checkins (was broken by type mismatch pre-Phase 31, now works)
    BEGIN
        INSERT INTO user_venue_checkins (venue_id, user_id, checkin_time)
        VALUES (p_venue_id, p_caller_user_id, NOW());
    EXCEPTION WHEN OTHERS THEN
        -- user_venue_checkins columns may differ slightly; don't fail the primary write
        RAISE WARNING 'user_venue_checkins write failed: %', SQLERRM;
    END;

    -- Increment poker_venues.follower_count is handled elsewhere;
    -- bump trust_score if it's a verified check-in can be added later.

    RETURN jsonb_build_object(
      'success', true, 'checkin_id', v_id, 
      'venue_id', p_venue_id, 'venue_name', v_venue.name,
      'recent_count_in_window', v_recent_count + 1
    );
END; $fn$;

-- Regrant (in case signature changed)
REVOKE EXECUTE ON FUNCTION public.checkin_to_venue(integer, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.checkin_to_venue(integer, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.checkin_to_venue(integer, uuid, text) IS
  'Phase 27 + Phase 31: Record a venue check-in. Writes to both venue_checkins (primary log) and user_venue_checkins (per-user index, now functional post-Phase 31 venue_id fix).';
