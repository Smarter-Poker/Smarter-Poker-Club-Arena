-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419163750 "phase24n_fix_award_home_games_badges_array_syntax"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f38018ec20eaf1af6c93722cac73c779 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.award_home_games_badges(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_games_hosted    int;
    v_games_attended  int;
    v_groups_owned    int;
    v_avg_rating      numeric;
    v_new_badges      jsonb := '[]'::jsonb;
    v_keys            text[] := ARRAY[]::text[];
BEGIN
    SELECT COALESCE(SUM(games_hosted), 0) INTO v_games_hosted 
      FROM commander_home_groups WHERE owner_id = p_user_id;
    SELECT COUNT(*) INTO v_games_attended 
      FROM commander_home_rsvps r 
      WHERE r.user_id = p_user_id AND r.checked_in_at IS NOT NULL;
    SELECT COUNT(*) INTO v_groups_owned 
      FROM commander_home_groups WHERE owner_id = p_user_id;
    SELECT COALESCE(AVG(r.rating), 0) INTO v_avg_rating
      FROM commander_home_game_reviews r
      JOIN commander_home_games g ON g.id = r.game_id
      JOIN commander_home_groups grp ON grp.id = g.group_id
      WHERE grp.owner_id = p_user_id OR g.host_id = p_user_id;

    -- Host tier (use array_append; `||` on text[] || text ambiguous)
    IF v_games_hosted >= 1   AND public._award_home_badge_if_new(p_user_id, 'first_host',       jsonb_build_object('at', v_games_hosted)) THEN v_keys := array_append(v_keys, 'first_host'); END IF;
    IF v_games_hosted >= 5   AND public._award_home_badge_if_new(p_user_id, 'host_veteran_5',   jsonb_build_object('at', v_games_hosted)) THEN v_keys := array_append(v_keys, 'host_veteran_5'); END IF;
    IF v_games_hosted >= 10  AND public._award_home_badge_if_new(p_user_id, 'host_veteran_10',  jsonb_build_object('at', v_games_hosted)) THEN v_keys := array_append(v_keys, 'host_veteran_10'); END IF;
    IF v_games_hosted >= 25  AND public._award_home_badge_if_new(p_user_id, 'host_veteran_25',  jsonb_build_object('at', v_games_hosted)) THEN v_keys := array_append(v_keys, 'host_veteran_25'); END IF;
    IF v_games_hosted >= 50  AND public._award_home_badge_if_new(p_user_id, 'host_legend_50',   jsonb_build_object('at', v_games_hosted)) THEN v_keys := array_append(v_keys, 'host_legend_50'); END IF;
    IF v_games_hosted >= 100 AND public._award_home_badge_if_new(p_user_id, 'host_centurion',   jsonb_build_object('at', v_games_hosted)) THEN v_keys := array_append(v_keys, 'host_centurion'); END IF;

    -- Player tier
    IF v_games_attended >= 1   AND public._award_home_badge_if_new(p_user_id, 'first_game_played', jsonb_build_object('at', v_games_attended)) THEN v_keys := array_append(v_keys, 'first_game_played'); END IF;
    IF v_games_attended >= 5   AND public._award_home_badge_if_new(p_user_id, 'regular_5',         jsonb_build_object('at', v_games_attended)) THEN v_keys := array_append(v_keys, 'regular_5'); END IF;
    IF v_games_attended >= 10  AND public._award_home_badge_if_new(p_user_id, 'reliable_regular',  jsonb_build_object('at', v_games_attended)) THEN v_keys := array_append(v_keys, 'reliable_regular'); END IF;
    IF v_games_attended >= 25  AND public._award_home_badge_if_new(p_user_id, 'dedicated_25',      jsonb_build_object('at', v_games_attended)) THEN v_keys := array_append(v_keys, 'dedicated_25'); END IF;
    IF v_games_attended >= 50  AND public._award_home_badge_if_new(p_user_id, 'fixture_50',        jsonb_build_object('at', v_games_attended)) THEN v_keys := array_append(v_keys, 'fixture_50'); END IF;

    -- Special
    IF v_groups_owned >= 2 AND public._award_home_badge_if_new(p_user_id, 'multi_host', jsonb_build_object('groups', v_groups_owned)) THEN v_keys := array_append(v_keys, 'multi_host'); END IF;
    IF v_avg_rating >= 4.5 AND v_games_hosted >= 3 
       AND public._award_home_badge_if_new(p_user_id, 'five_star_host', jsonb_build_object('rating', v_avg_rating, 'games', v_games_hosted))
    THEN v_keys := array_append(v_keys, 'five_star_host'); END IF;

    v_new_badges := to_jsonb(v_keys);

    IF array_length(v_keys, 1) > 0 THEN
        PERFORM public.fn_emit_home_notification(
            p_user_id, 'home_badges_earned',
            'You earned ' || array_length(v_keys, 1) || ' badge' || 
                CASE WHEN array_length(v_keys, 1) > 1 THEN 's' ELSE '' END || '!',
            'Nice work. Check your profile to see them.',
            '/hub/profile/badges',
            jsonb_build_object('new_badges', v_new_badges),
            NULL
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'user_id', p_user_id,
        'new_badges', v_new_badges,
        'stats', jsonb_build_object(
            'games_hosted', v_games_hosted,
            'games_attended', v_games_attended,
            'groups_owned', v_groups_owned,
            'avg_rating', v_avg_rating
        )
    );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.award_home_games_badges(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_home_games_badges(uuid) TO service_role;
