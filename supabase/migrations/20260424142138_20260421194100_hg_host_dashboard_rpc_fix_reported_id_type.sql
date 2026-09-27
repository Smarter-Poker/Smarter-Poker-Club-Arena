-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424142138 "20260421194100_hg_host_dashboard_rpc_fix_reported_id_type"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1786b6fbc910cdefb15fabfaee4394f6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_get_home_group_dashboard(
  p_group_id uuid, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_group RECORD;
  v_is_staff boolean;
  v_slug text;
  v_next_game_row RECORD;
  v_recent_game_row RECORD;
  v_pending_reports int;
  v_pending_join_reqs int;
  v_open_polls int;
  v_has_template boolean;
  v_has_first_game boolean;
  v_has_invite_link boolean;
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller_user_id THEN
      RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

  v_is_staff := (v_group.owner_id = p_caller_user_id)
    OR EXISTS (SELECT 1 FROM commander_home_members
                WHERE group_id = p_group_id AND user_id = p_caller_user_id
                  AND role IN ('admin','co_host') AND status = 'approved');
  IF NOT v_is_staff THEN RAISE EXCEPTION 'NOT_GROUP_STAFF' USING ERRCODE = '42501'; END IF;

  SELECT slug INTO v_slug FROM social_pages
   WHERE linked_entity_type='home_group' AND linked_entity_id = p_group_id::text LIMIT 1;

  SELECT gm.id, gm.title,
         (gm.scheduled_date || ' ' || COALESCE(gm.start_time, '19:00:00'::time))::timestamp
           AT TIME ZONE COALESCE(gm.timezone, 'UTC') AS starts_at,
         gm.rsvp_yes, gm.rsvp_maybe, gm.rsvp_no, gm.waitlist_count,
         gm.max_players, gm.stakes, gm.format, gm.address_visible_to,
         gm.status
    INTO v_next_game_row
    FROM commander_home_games gm
   WHERE gm.group_id = p_group_id
     AND gm.status IN ('scheduled','confirmed')
     AND gm.scheduled_date >= CURRENT_DATE
   ORDER BY gm.scheduled_date ASC, gm.start_time ASC NULLS LAST
   LIMIT 1;

  SELECT gm.id, gm.title, gm.scheduled_date, gm.status,
         (SELECT COUNT(*) FROM commander_home_game_reviews r
           WHERE r.game_id = gm.id) AS review_count
    INTO v_recent_game_row
    FROM commander_home_games gm
   WHERE gm.group_id = p_group_id
     AND gm.status IN ('completed','cancelled')
   ORDER BY gm.scheduled_date DESC, gm.start_time DESC NULLS LAST
   LIMIT 1;

  -- reported_id is uuid, so set up uuid IN clauses
  SELECT COUNT(*)::int INTO v_pending_reports
    FROM commander_home_content_reports r
   WHERE r.status IN ('pending','hidden_pending_review')
     AND (
       (r.reported_type IN ('post','comment')
         AND r.reported_id IN (SELECT p.id FROM commander_home_posts p WHERE p.group_id = p_group_id))
       OR (r.reported_type = 'game'
         AND r.reported_id IN (SELECT g.id FROM commander_home_games g WHERE g.group_id = p_group_id))
       OR (r.reported_type = 'review'
         AND r.reported_id IN (
           SELECT rv.id FROM commander_home_game_reviews rv
           JOIN commander_home_games g ON g.id = rv.game_id
           WHERE g.group_id = p_group_id))
       OR (r.reported_type = 'member'
         AND r.reported_id IN (SELECT m.id FROM commander_home_members m WHERE m.group_id = p_group_id))
     );

  SELECT COUNT(*)::int INTO v_pending_join_reqs
    FROM commander_home_members
   WHERE group_id = p_group_id AND status = 'pending';

  SELECT COUNT(*)::int INTO v_open_polls
    FROM commander_home_group_polls
   WHERE group_id = p_group_id
     AND (closes_at IS NULL OR closes_at > NOW());

  SELECT EXISTS (SELECT 1 FROM commander_home_game_templates
                  WHERE group_id = p_group_id) INTO v_has_template;
  SELECT EXISTS (SELECT 1 FROM commander_home_games
                  WHERE group_id = p_group_id) INTO v_has_first_game;
  SELECT EXISTS (SELECT 1 FROM commander_home_invite_tokens
                  WHERE group_id = p_group_id AND is_active = true
                    AND (expires_at IS NULL OR expires_at > NOW())) INTO v_has_invite_link;

  v_result := jsonb_build_object(
    'success', true,
    'group', jsonb_build_object(
      'id', v_group.id, 'name', v_group.name, 'slug', v_slug,
      'city', v_group.city, 'is_private', v_group.is_private,
      'is_21_plus', v_group.is_21_plus, 'member_count', v_group.member_count,
      'profile_photo_url', v_group.profile_photo_url,
      'created_at', v_group.created_at,
      'promotion_requested_at', v_group.promotion_requested_at,
      'promoted_to_club_id', v_group.promoted_to_club_id
    ),
    'next_game', CASE WHEN v_next_game_row.id IS NULL THEN NULL ELSE
      jsonb_build_object(
        'id', v_next_game_row.id, 'title', v_next_game_row.title,
        'starts_at', v_next_game_row.starts_at,
        'rsvp_yes', v_next_game_row.rsvp_yes, 'rsvp_maybe', v_next_game_row.rsvp_maybe,
        'rsvp_no', v_next_game_row.rsvp_no, 'waitlist_count', v_next_game_row.waitlist_count,
        'max_players', v_next_game_row.max_players,
        'stakes', v_next_game_row.stakes, 'format', v_next_game_row.format,
        'status', v_next_game_row.status,
        'address_visible_to', v_next_game_row.address_visible_to)
    END,
    'recent_game', CASE WHEN v_recent_game_row.id IS NULL THEN NULL ELSE
      jsonb_build_object(
        'id', v_recent_game_row.id, 'title', v_recent_game_row.title,
        'scheduled_date', v_recent_game_row.scheduled_date,
        'status', v_recent_game_row.status, 'review_count', v_recent_game_row.review_count)
    END,
    'counters', jsonb_build_object(
      'pending_reports', v_pending_reports,
      'pending_join_requests', v_pending_join_reqs,
      'open_polls', v_open_polls),
    'onboarding_checklist', jsonb_build_object(
      'has_game_template', v_has_template,
      'has_first_game', v_has_first_game,
      'has_invite_link', v_has_invite_link,
      'all_complete', (v_has_template AND v_has_first_game AND v_has_invite_link))
  );
  RETURN v_result;
END;
$fn$;
