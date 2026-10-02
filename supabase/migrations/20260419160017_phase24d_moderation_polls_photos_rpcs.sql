-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419160017 "phase24d_moderation_polls_photos_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e066c2f9d0ff368d7ce92b4208b4a9b8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART D — Moderation + polls + photos + reviews + reputation
-- =========================================================================

-- ────────────────────────────────────────────────────────────────────────
-- P1.11: report_home_content (unified report for posts/groups/games/etc)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.report_home_content(
    p_reported_type    text,
    p_reported_id      uuid,
    p_reason_category  text,
    p_reason_text      text,
    p_caller_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_new_id   uuid;
    v_valid_types text[] := ARRAY['post','comment','group','member','game','review'];
    v_valid_cats  text[] := ARRAY['spam','harassment','hate_speech','nudity','violence','illegal',
                                   'fake_game','self_harm','doxxing','other'];
    v_recent_count int;
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

    -- Rate limit: max 5 reports/hour/user to prevent spam
    SELECT COUNT(*) INTO v_recent_count
      FROM commander_home_content_reports
     WHERE reporter_id = p_caller_user_id
       AND created_at > NOW() - INTERVAL '1 hour';
    IF v_recent_count >= 5 THEN
        RAISE EXCEPTION 'RATE_LIMITED'
              USING HINT = 'max 5 reports per hour';
    END IF;

    -- Prevent duplicate: same reporter + same target + pending → no dup
    IF EXISTS (
        SELECT 1 FROM commander_home_content_reports
         WHERE reporter_id = p_caller_user_id
           AND reported_type = p_reported_type
           AND reported_id = p_reported_id
           AND status = 'pending'
    ) THEN
        RAISE EXCEPTION 'ALREADY_REPORTED';
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.report_home_content(text, uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.report_home_content(text, uuid, text, text, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.12: user-to-user block (supplements group-level ban)
-- Uses existing `user_blocks` table if it exists; otherwise creates one
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_blocks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    blocked_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    reason          text,
    UNIQUE (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY user_blocks_self ON user_blocks
      FOR ALL TO authenticated 
      USING (blocker_id = auth.uid()) 
      WITH CHECK (blocker_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.block_user(
    p_blocked_user_id  uuid,
    p_caller_user_id   uuid,
    p_reason           text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF p_caller_user_id = p_blocked_user_id THEN
        RAISE EXCEPTION 'CANNOT_BLOCK_SELF';
    END IF;

    INSERT INTO user_blocks (blocker_id, blocked_id, reason)
    VALUES (p_caller_user_id, p_blocked_user_id, p_reason)
    ON CONFLICT (blocker_id, blocked_id) DO UPDATE
        SET reason = EXCLUDED.reason;

    RETURN jsonb_build_object('success', true, 'blocked_user_id', p_blocked_user_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.block_user(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.block_user(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unblock_user(
    p_blocked_user_id  uuid,
    p_caller_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    DELETE FROM user_blocks 
     WHERE blocker_id = p_caller_user_id AND blocked_id = p_blocked_user_id;

    RETURN jsonb_build_object('success', true, 'unblocked_user_id', p_blocked_user_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.unblock_user(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unblock_user(uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P1.10: get_host_reputation — aggregate review stats for a host
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_host_reputation(
    p_host_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_stats jsonb;
BEGIN
    SELECT jsonb_build_object(
        'host_user_id', p_host_user_id,
        'groups_owned', (SELECT COUNT(*) FROM commander_home_groups WHERE owner_id = p_host_user_id),
        'total_games_hosted', COALESCE((
            SELECT SUM(games_hosted) FROM commander_home_groups WHERE owner_id = p_host_user_id
        ), 0),
        'review_count', (
            SELECT COUNT(*) FROM commander_home_game_reviews r
             JOIN commander_home_games g ON g.id = r.game_id
             JOIN commander_home_groups grp ON grp.id = g.group_id
             WHERE grp.owner_id = p_host_user_id OR g.host_id = p_host_user_id
        ),
        'avg_rating', COALESCE((
            SELECT ROUND(AVG(r.rating)::numeric, 2) FROM commander_home_game_reviews r
             JOIN commander_home_games g ON g.id = r.game_id
             JOIN commander_home_groups grp ON grp.id = g.group_id
             WHERE grp.owner_id = p_host_user_id OR g.host_id = p_host_user_id
        ), 0),
        'total_attendees', COALESCE((
            SELECT SUM(COALESCE(rsvp_yes, 0)) FROM commander_home_games g
             JOIN commander_home_groups grp ON grp.id = g.group_id
             WHERE (grp.owner_id = p_host_user_id OR g.host_id = p_host_user_id)
               AND g.status = 'completed'
        ), 0),
        'completion_rate_pct', COALESCE((
            SELECT CASE WHEN COUNT(*) = 0 THEN 0
                   ELSE ROUND(100.0 * SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END)::numeric / COUNT(*), 1) END
              FROM commander_home_games g
              JOIN commander_home_groups grp ON grp.id = g.group_id
             WHERE (grp.owner_id = p_host_user_id OR g.host_id = p_host_user_id)
               AND g.status IN ('completed','cancelled')
        ), 0)
    ) INTO v_stats;

    RETURN v_stats;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_host_reputation(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_host_reputation(uuid) TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P3.11: Poll RPCs — create + vote + close
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_home_group_poll(
    p_group_id         uuid,
    p_caller_user_id   uuid,
    p_question         text,
    p_options          jsonb,        -- [{id, label}, ...]
    p_poll_type        text DEFAULT 'single_choice',
    p_closes_at        timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group    RECORD;
    v_new_id   uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF p_question IS NULL OR length(trim(p_question)) = 0 THEN
        RAISE EXCEPTION 'EMPTY_QUESTION';
    END IF;
    IF jsonb_array_length(p_options) < 2 THEN
        RAISE EXCEPTION 'MIN_TWO_OPTIONS';
    END IF;
    IF jsonb_array_length(p_options) > 20 THEN
        RAISE EXCEPTION 'MAX_TWENTY_OPTIONS';
    END IF;
    IF p_poll_type NOT IN ('single_choice','multi_choice','date_picker') THEN
        RAISE EXCEPTION 'INVALID_POLL_TYPE';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    -- Any approved member can create polls
    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_A_MEMBER';
    END IF;

    INSERT INTO commander_home_polls 
        (group_id, created_by, question, poll_type, closes_at, options)
    VALUES 
        (p_group_id, p_caller_user_id, trim(p_question), p_poll_type, p_closes_at, p_options)
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'poll_id', v_new_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.create_home_group_poll(uuid, uuid, text, jsonb, text, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_home_group_poll(uuid, uuid, text, jsonb, text, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.vote_home_group_poll(
    p_poll_id         uuid,
    p_caller_user_id  uuid,
    p_option_ids      text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_poll   RECORD;
    v_group  RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_poll FROM commander_home_polls WHERE id = p_poll_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POLL_NOT_FOUND'; END IF;
    IF v_poll.is_closed OR (v_poll.closes_at IS NOT NULL AND v_poll.closes_at < NOW()) THEN
        RAISE EXCEPTION 'POLL_CLOSED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_poll.group_id;

    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_poll.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_A_MEMBER';
    END IF;

    IF array_length(p_option_ids, 1) IS NULL OR array_length(p_option_ids, 1) = 0 THEN
        RAISE EXCEPTION 'NO_OPTIONS_SELECTED';
    END IF;
    IF v_poll.poll_type = 'single_choice' AND array_length(p_option_ids, 1) > 1 THEN
        RAISE EXCEPTION 'SINGLE_CHOICE_ONE_ALLOWED';
    END IF;

    INSERT INTO commander_home_poll_votes (poll_id, user_id, option_ids)
    VALUES (p_poll_id, p_caller_user_id, p_option_ids)
    ON CONFLICT (poll_id, user_id) DO UPDATE
        SET option_ids = EXCLUDED.option_ids, updated_at = NOW();

    RETURN jsonb_build_object('success', true, 'poll_id', p_poll_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.vote_home_group_poll(uuid, uuid, text[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.vote_home_group_poll(uuid, uuid, text[]) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P3.15b: upload_home_game_photo RPC (metadata only; actual bytes via storage)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_home_game_photo(
    p_game_id         uuid,
    p_caller_user_id  uuid,
    p_photo_url       text,
    p_caption         text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_game  RECORD;
    v_group RECORD;
    v_new_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF p_photo_url IS NULL OR length(trim(p_photo_url)) = 0 THEN
        RAISE EXCEPTION 'MISSING_URL';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    -- Any approved member can upload
    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN
        RAISE EXCEPTION 'NOT_A_MEMBER';
    END IF;

    INSERT INTO commander_home_game_photos (game_id, uploader_id, photo_url, caption)
    VALUES (p_game_id, p_caller_user_id, p_photo_url, p_caption)
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'photo_id', v_new_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.record_home_game_photo(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_home_game_photo(uuid, uuid, text, text) TO authenticated, service_role;
