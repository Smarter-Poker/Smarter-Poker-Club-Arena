-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419191508 "phase27c_fix_follower_count_doublecounting"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 da84c14c273cf7c52a71f8969bf2a878 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Remove manual follower_count UPDATEs — the trigger_venue_follower_count trigger handles it
CREATE OR REPLACE FUNCTION public.follow_venue(
    p_venue_id         integer,
    p_caller_user_id   uuid,
    p_notify_posts     boolean DEFAULT true,
    p_notify_events    boolean DEFAULT true,
    p_notify_promotions boolean DEFAULT false,
    p_notify_tournaments boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_venue RECORD; v_existing uuid; v_id uuid;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT id, name, is_active, is_suppressed INTO v_venue FROM poker_venues WHERE id = p_venue_id;
    IF NOT FOUND OR COALESCE(v_venue.is_suppressed, false) OR NOT COALESCE(v_venue.is_active, true) 
    THEN RAISE EXCEPTION 'VENUE_NOT_FOUND_OR_INACTIVE'; END IF;

    SELECT id INTO v_existing FROM commander_venue_followers 
     WHERE venue_id = p_venue_id AND user_id = p_caller_user_id;

    IF v_existing IS NOT NULL THEN
        UPDATE commander_venue_followers 
           SET notify_posts=p_notify_posts, notify_events=p_notify_events,
               notify_promotions=p_notify_promotions, notify_tournaments=p_notify_tournaments
         WHERE id = v_existing;
        RETURN jsonb_build_object('success', true, 'already_following', true, 'follow_id', v_existing);
    END IF;

    INSERT INTO commander_venue_followers (venue_id, user_id, notify_posts, notify_events, notify_promotions, notify_tournaments)
    VALUES (p_venue_id, p_caller_user_id, p_notify_posts, p_notify_events, p_notify_promotions, p_notify_tournaments)
    RETURNING id INTO v_id;

    -- NO manual counter update — trigger_venue_follower_count handles it
    RETURN jsonb_build_object('success', true, 'follow_id', v_id, 'venue_id', p_venue_id, 'venue_name', v_venue.name);
END; $fn$;

CREATE OR REPLACE FUNCTION public.unfollow_venue(p_venue_id integer, p_caller_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_deleted int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    WITH d AS (
      DELETE FROM commander_venue_followers 
       WHERE venue_id = p_venue_id AND user_id = p_caller_user_id RETURNING 1
    ) SELECT COUNT(*) INTO v_deleted FROM d;
    -- Trigger handles the counter decrement
    RETURN jsonb_build_object('success', true, 'unfollowed', v_deleted > 0);
END; $fn$;

-- Reconcile current drift: sync every venue's follower_count to actual row count
UPDATE poker_venues v
   SET follower_count = COALESCE((SELECT COUNT(*) FROM commander_venue_followers f WHERE f.venue_id = v.id), 0)
 WHERE follower_count IS DISTINCT FROM COALESCE((SELECT COUNT(*) FROM commander_venue_followers f WHERE f.venue_id = v.id), 0);
