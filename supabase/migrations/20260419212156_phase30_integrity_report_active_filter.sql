-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419212156 "phase30_integrity_report_active_filter"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e601a9382db9b22c4d6cc2e2983e320e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: integrity report should only count active (non-archived) rows
CREATE OR REPLACE FUNCTION public.get_platform_integrity_report(p_admin_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_admin_role text; 
    v_total_groups int; v_groups_with_sp int;
    v_total_claimed int; v_claimed_with_sp int; v_claimed_with_cmd int;
    v_total_clubs int; v_clubs_with_sp int;
    v_archived_claimed int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_admin_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;
    SELECT role INTO v_admin_role FROM profiles WHERE id = p_admin_user_id;
    IF v_admin_role NOT IN ('admin','superadmin','moderator') THEN
        RAISE EXCEPTION 'NOT_ADMIN';
    END IF;

    SELECT COUNT(*) INTO v_total_groups FROM commander_home_groups;
    SELECT COUNT(*) INTO v_groups_with_sp FROM commander_home_groups g
       WHERE EXISTS(SELECT 1 FROM social_pages sp 
                    WHERE sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text);

    -- Active claimed venues only
    SELECT COUNT(*) INTO v_total_claimed FROM poker_venues 
     WHERE is_claimed = true 
       AND COALESCE(is_active, true) 
       AND NOT COALESCE(is_suppressed, false);
    SELECT COUNT(*) INTO v_claimed_with_sp FROM poker_venues v 
     WHERE v.is_claimed = true
       AND COALESCE(v.is_active, true) 
       AND NOT COALESCE(v.is_suppressed, false)
       AND EXISTS(SELECT 1 FROM social_pages sp 
                   WHERE sp.linked_entity_type='venue' AND sp.linked_entity_id = v.id::text);
    SELECT COUNT(*) INTO v_claimed_with_cmd FROM poker_venues 
     WHERE is_claimed = true AND commander_enabled = true
       AND COALESCE(is_active, true) 
       AND NOT COALESCE(is_suppressed, false);
    SELECT COUNT(*) INTO v_archived_claimed FROM poker_venues 
     WHERE is_claimed = true AND (COALESCE(is_active, true) = false OR COALESCE(is_suppressed, false) = true);
    
    SELECT COUNT(*) INTO v_total_clubs FROM clubs;
    SELECT COUNT(*) INTO v_clubs_with_sp FROM clubs c
     WHERE EXISTS(SELECT 1 FROM social_pages sp 
                   WHERE sp.linked_entity_type='club' AND sp.linked_entity_id = c.id::text);

    RETURN jsonb_build_object(
        'generated_at', now(),
        'identity', jsonb_build_object(
            'real_users', (SELECT COUNT(*) FROM auth.users WHERE email NOT LIKE '%@hydra.bot'),
            'profiles_for_real_users', (SELECT COUNT(*) FROM profiles p
                                WHERE EXISTS(SELECT 1 FROM auth.users u 
                                              WHERE u.id = p.id 
                                                AND u.email NOT LIKE '%@hydra.bot')),
            'real_users_without_profile', (
                SELECT COUNT(*) FROM auth.users u 
                 WHERE NOT EXISTS(SELECT 1 FROM profiles p WHERE p.id = u.id)
                   AND u.email NOT LIKE '%@hydra.bot')
        ),
        'wiring_coverage', jsonb_build_object(
            'home_groups', jsonb_build_object(
                'total', v_total_groups, 
                'with_social_page', v_groups_with_sp,
                'coverage_pct', CASE WHEN v_total_groups > 0 
                  THEN ROUND(v_groups_with_sp::numeric / v_total_groups * 100, 1) ELSE 100 END),
            'claimed_venues_active', jsonb_build_object(
                'total', v_total_claimed,
                'with_social_page', v_claimed_with_sp,
                'with_commander_enabled', v_claimed_with_cmd,
                'social_coverage_pct', CASE WHEN v_total_claimed > 0 
                  THEN ROUND(v_claimed_with_sp::numeric / v_total_claimed * 100, 1) ELSE 100 END,
                'commander_coverage_pct', CASE WHEN v_total_claimed > 0 
                  THEN ROUND(v_claimed_with_cmd::numeric / v_total_claimed * 100, 1) ELSE 100 END,
                'archived_or_suppressed', v_archived_claimed),
            'clubs', jsonb_build_object(
                'total', v_total_clubs,
                'with_social_page', v_clubs_with_sp,
                'coverage_pct', CASE WHEN v_total_clubs > 0 
                  THEN ROUND(v_clubs_with_sp::numeric / v_total_clubs * 100, 1) ELSE 100 END)
        ),
        'triggers_installed', (SELECT jsonb_agg(tgname ORDER BY tgname)
          FROM pg_trigger 
         WHERE NOT tgisinternal 
           AND tgname IN ('trg_autocreate_home_group_social_page',
                          'trg_venue_claim_wiring',
                          'trg_autocreate_club_social_page',
                          'trg_emit_claim_notification')),
        'foreign_keys_established', jsonb_build_object(
            'fk_commander_home_groups_owner_profile', 
                EXISTS(SELECT 1 FROM pg_constraint WHERE conname = 'fk_commander_home_groups_owner_profile'),
            'fk_venue_managers_user_profile',
                EXISTS(SELECT 1 FROM pg_constraint WHERE conname = 'fk_venue_managers_user_profile'),
            'fk_social_pages_owner_profile',
                EXISTS(SELECT 1 FROM pg_constraint WHERE conname = 'fk_social_pages_owner_profile'),
            'fk_venue_claims_user_profile',
                EXISTS(SELECT 1 FROM pg_constraint WHERE conname = 'fk_venue_claims_user_profile')
        ),
        'operational', jsonb_build_object(
            'pending_claims_queue_depth', 
                (SELECT COUNT(*) FROM venue_claims WHERE status IN ('pending','under_review')),
            'active_venue_managers', (SELECT COUNT(*) FROM venue_managers WHERE is_active = true),
            'unread_notifications_system_wide', (SELECT COUNT(*) FROM notifications 
                                                  WHERE COALESCE(read, false) = false)
        ),
        'verdict', CASE 
            WHEN (v_total_groups = 0 OR v_total_groups = v_groups_with_sp) 
             AND (v_total_claimed = 0 OR v_total_claimed = v_claimed_with_sp)
             AND (v_total_claimed = 0 OR v_total_claimed = v_claimed_with_cmd)
             AND (v_total_clubs = 0 OR v_total_clubs = v_clubs_with_sp)
            THEN 'FULLY_WIRED'
            ELSE 'GAPS_EXIST'
        END
    );
END; $fn$;
