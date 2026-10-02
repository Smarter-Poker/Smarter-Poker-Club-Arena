-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419184247 "phase26redux_b_fix_slug_from_social_pages"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cb6eb0f9112957140f4f4a91d152fec6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: slug is on social_pages, not commander_home_groups
CREATE OR REPLACE FUNCTION public.get_host_weekly_digest_payload(
    p_host_id         uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_week_start timestamptz;
    v_week_prev_start timestamptz;
    v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_caller_user_id <> p_host_id THEN RAISE EXCEPTION 'CAN_ONLY_REQUEST_OWN_DIGEST'; END IF;

    v_week_start := date_trunc('week', NOW());
    v_week_prev_start := v_week_start - INTERVAL '7 days';

    WITH my_groups AS (
        SELECT g.id, g.name,
               (SELECT sp.slug FROM social_pages sp 
                 WHERE sp.linked_entity_type='home_group' 
                   AND sp.linked_entity_id = g.id::text LIMIT 1) AS slug
          FROM commander_home_groups g
         WHERE g.owner_id = p_host_id AND g.is_active = true
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'host_id', p_host_id,
        'week_start', v_week_start,
        'prev_week_start', v_week_prev_start,
        'groups', (SELECT jsonb_agg(jsonb_build_object(
            'group_id', mg.id, 'group_name', mg.name, 'group_slug', mg.slug,
            'this_week', jsonb_build_object(
                'games_completed', (SELECT COUNT(*) FROM commander_home_games 
                                      WHERE group_id = mg.id AND status='completed' 
                                        AND scheduled_date >= v_week_start),
                'games_upcoming', (SELECT COUNT(*) FROM commander_home_games 
                                     WHERE group_id = mg.id AND status IN ('scheduled','confirmed') 
                                       AND scheduled_date >= NOW()),
                'new_members', (SELECT COUNT(*) FROM commander_home_members 
                                  WHERE group_id = mg.id AND created_at >= v_week_start),
                'rsvps_received', (SELECT COUNT(*) FROM commander_home_rsvps r 
                                     JOIN commander_home_games g ON g.id = r.game_id
                                    WHERE g.group_id = mg.id AND r.responded_at >= v_week_start),
                'checkins', (SELECT COUNT(*) FROM commander_home_rsvps r 
                               JOIN commander_home_games g ON g.id = r.game_id
                              WHERE g.group_id = mg.id AND r.checked_in_at >= v_week_start),
                'posts', (SELECT COUNT(*) FROM commander_home_posts 
                           WHERE group_id = mg.id AND created_at >= v_week_start)
            ),
            'last_week', jsonb_build_object(
                'games_completed', (SELECT COUNT(*) FROM commander_home_games 
                                      WHERE group_id = mg.id AND status='completed' 
                                        AND scheduled_date BETWEEN v_week_prev_start AND v_week_start),
                'new_members', (SELECT COUNT(*) FROM commander_home_members 
                                  WHERE group_id = mg.id 
                                    AND created_at BETWEEN v_week_prev_start AND v_week_start),
                'rsvps_received', (SELECT COUNT(*) FROM commander_home_rsvps r 
                                     JOIN commander_home_games g ON g.id = r.game_id
                                    WHERE g.group_id = mg.id 
                                      AND r.responded_at BETWEEN v_week_prev_start AND v_week_start),
                'checkins', (SELECT COUNT(*) FROM commander_home_rsvps r 
                               JOIN commander_home_games g ON g.id = r.game_id
                              WHERE g.group_id = mg.id 
                                AND r.checked_in_at BETWEEN v_week_prev_start AND v_week_start)
            ),
            'scores', jsonb_build_object(
                'quality', (SELECT quality_score FROM commander_home_groups WHERE id = mg.id),
                'vitality', (SELECT vitality_score FROM commander_home_groups WHERE id = mg.id)
            ),
            'pending_approvals', (SELECT COUNT(*) FROM commander_home_members 
                                    WHERE group_id = mg.id AND status='pending'),
            'dormant_member_count', (SELECT COUNT(*) FROM commander_home_members m
                                       WHERE m.group_id = mg.id AND m.status='approved'
                                         AND (m.last_attended IS NULL 
                                              OR m.last_attended < NOW() - INTERVAL '60 days'))
        )) FROM my_groups mg)
    ) INTO v_result;

    RETURN v_result;
END; $fn$;
