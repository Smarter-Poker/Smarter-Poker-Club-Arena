-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420045109 "phase40_harden_report_home_content"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4ce8a47c4e46fd93ba9c54d5cc67033f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 51: report_home_content harden.
-- 
-- (a) Missing existence check on reported_id — bad actors can file reports
--     against random UUIDs that don't exist, filling the mod queue with noise.
-- (b) No self-report block — users can report their own content, potentially
--     to manipulate moderation metrics or harass moderators.
-- (c) After 'resolved' status, duplicate check doesn't fire — same reporter
--     can re-report same target indefinitely once prior report is closed.
--     Legitimate re-reports should go through the original ticket's appeal
--     flow, not spawn a new ticket.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.report_home_content(
  p_reported_type text, p_reported_id uuid, p_reason_category text,
  p_reason_text text, p_caller_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_new_id       uuid;
    v_valid_types  text[] := ARRAY['post','comment','group','member','game','review'];
    v_valid_cats   text[] := ARRAY['spam','harassment','hate_speech','nudity','violence','illegal',
                                   'fake_game','self_harm','doxxing','other'];
    v_recent_count int;
    v_target_exists boolean;
    v_target_author uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF NOT (p_reported_type = ANY (v_valid_types)) THEN
        RAISE EXCEPTION 'INVALID_REPORT_TYPE';
    END IF;
    IF NOT (p_reason_category = ANY (v_valid_cats)) THEN
        RAISE EXCEPTION 'INVALID_REASON';
    END IF;
    IF p_reason_text IS NOT NULL AND length(p_reason_text) > 2000 THEN
        RAISE EXCEPTION 'REASON_TOO_LONG';
    END IF;

    -- (a) Existence check + (b) capture author for self-report detection
    CASE p_reported_type
      WHEN 'post' THEN
        SELECT true, author_id INTO v_target_exists, v_target_author
          FROM commander_home_posts WHERE id = p_reported_id;
      WHEN 'comment' THEN
        SELECT true, author_id INTO v_target_exists, v_target_author
          FROM commander_home_post_comments WHERE id = p_reported_id;
      WHEN 'group' THEN
        SELECT true, owner_id INTO v_target_exists, v_target_author
          FROM commander_home_groups WHERE id = p_reported_id;
      WHEN 'member' THEN
        -- For member reports, target_id is the profile id being reported
        SELECT true, p_reported_id INTO v_target_exists, v_target_author
          FROM profiles WHERE id = p_reported_id;
      WHEN 'game' THEN
        SELECT true, host_id INTO v_target_exists, v_target_author
          FROM commander_home_games WHERE id = p_reported_id;
      WHEN 'review' THEN
        SELECT true, reviewer_id INTO v_target_exists, v_target_author
          FROM commander_home_game_reviews WHERE id = p_reported_id;
    END CASE;

    IF NOT COALESCE(v_target_exists, false) THEN
        RAISE EXCEPTION 'REPORTED_TARGET_NOT_FOUND'
              USING HINT = 'the reported ' || p_reported_type || ' does not exist';
    END IF;

    -- (b) Block self-reports
    IF v_target_author = p_caller_user_id THEN
        RAISE EXCEPTION 'CANNOT_SELF_REPORT'
              USING HINT = 'you cannot report your own content';
    END IF;

    -- Rate limit: max 5 reports/hour/user to prevent spam
    SELECT COUNT(*) INTO v_recent_count
      FROM commander_home_content_reports
     WHERE reporter_id = p_caller_user_id
       AND created_at > NOW() - INTERVAL '1 hour';
    IF v_recent_count >= 5 THEN
        RAISE EXCEPTION 'RATE_LIMITED'
              USING HINT = 'max 5 reports per hour';
    END IF;

    -- (c) Block duplicates regardless of status. Rationale: once a moderator
    -- has reviewed a target and either dismissed or acted on it, reopening
    -- the case should go through moderator channels, not a fresh report
    -- ticket from the same user. Legitimate second-offense reports on the
    -- same target can come from different users.
    IF EXISTS (
        SELECT 1 FROM commander_home_content_reports
         WHERE reporter_id = p_caller_user_id
           AND reported_type = p_reported_type
           AND reported_id = p_reported_id
    ) THEN
        RAISE EXCEPTION 'ALREADY_REPORTED'
              USING HINT = 'you have already reported this target';
    END IF;

    INSERT INTO commander_home_content_reports
        (reporter_id, reported_type, reported_id, reason_category, reason_text)
    VALUES
        (p_caller_user_id, p_reported_type, p_reported_id, p_reason_category, p_reason_text)
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true,
        'report_id', v_new_id,
        'status', 'pending'
    );
END;
$function$;

COMMENT ON FUNCTION public.report_home_content IS
  'Phase 40 Bug 51: added existence check on reported_id, self-report block, '
  'and dedupe across all statuses (was only blocking within status=pending).';
