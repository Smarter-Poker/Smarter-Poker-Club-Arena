-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419163945 "phase24o_group_follows_game_templates_weekly_insights"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8a49fd42f174b8740eba59c83a7bdb96 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART O — Group follows + game templates + weekly insights
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- 1) GROUP FOLLOWS — non-member subscribe to a public group
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_home_group_follows (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id    uuid NOT NULL REFERENCES commander_home_groups(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT NOW(),
    notify_new_games boolean NOT NULL DEFAULT true,
    notify_announcements boolean NOT NULL DEFAULT false,
    UNIQUE (group_id, user_id)
);

CREATE INDEX idx_home_follows_user ON commander_home_group_follows(user_id, created_at DESC);
CREATE INDEX idx_home_follows_group ON commander_home_group_follows(group_id);

ALTER TABLE commander_home_group_follows ENABLE ROW LEVEL SECURITY;

-- Self-only management
CREATE POLICY home_follows_select_own ON commander_home_group_follows
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY home_follows_insert_own ON commander_home_group_follows
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY home_follows_update_own ON commander_home_group_follows
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY home_follows_delete_own ON commander_home_group_follows
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- RPC: follow/unfollow toggle
CREATE OR REPLACE FUNCTION public.toggle_home_group_follow(
    p_group_id         uuid,
    p_caller_user_id   uuid,
    p_follow           boolean DEFAULT NULL  -- NULL = toggle
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE 
    v_group      RECORD;
    v_existing   RECORD;
    v_new_state  boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.is_private THEN RAISE EXCEPTION 'CANNOT_FOLLOW_PRIVATE_GROUP'; END IF;

    -- Members don't need to follow; they already get notifications
    IF EXISTS (SELECT 1 FROM commander_home_members 
                WHERE group_id = p_group_id AND user_id = p_caller_user_id AND status='approved')
    THEN RAISE EXCEPTION 'ALREADY_MEMBER' USING HINT='members already receive notifications'; END IF;

    SELECT * INTO v_existing FROM commander_home_group_follows 
     WHERE group_id = p_group_id AND user_id = p_caller_user_id;

    v_new_state := CASE 
        WHEN p_follow IS NOT NULL THEN p_follow
        WHEN v_existing IS NULL THEN true
        ELSE false END;

    IF v_new_state THEN
        INSERT INTO commander_home_group_follows (group_id, user_id)
        VALUES (p_group_id, p_caller_user_id)
        ON CONFLICT (group_id, user_id) DO NOTHING;
    ELSE
        DELETE FROM commander_home_group_follows 
         WHERE group_id = p_group_id AND user_id = p_caller_user_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'following', v_new_state);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.toggle_home_group_follow(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.toggle_home_group_follow(uuid, uuid, boolean) TO authenticated, service_role;

-- RPC: user's followed groups
CREATE OR REPLACE FUNCTION public.get_my_followed_home_groups(p_caller_user_id uuid)
RETURNS TABLE (
    group_id uuid, name text, slug text,
    profile_photo_url text, city text, state text,
    member_count int, games_hosted int,
    followed_at timestamptz, notify_new_games boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    RETURN QUERY
    SELECT g.id, g.name, sp.slug, g.profile_photo_url, g.city, g.state, 
           g.member_count, g.games_hosted,
           f.created_at, f.notify_new_games
      FROM commander_home_group_follows f
      JOIN commander_home_groups g ON g.id = f.group_id
      LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE f.user_id = p_caller_user_id
     ORDER BY f.created_at DESC;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_my_followed_home_groups(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_followed_home_groups(uuid) TO authenticated, service_role;

-- Extend fn_notify_home_game_created to ALSO notify followers
-- (keep the existing trigger, rewrite the body)
CREATE OR REPLACE FUNCTION public.fn_notify_home_game_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE 
    v_group RECORD; v_recipient RECORD; v_slug text;
BEGIN
    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    SELECT sp.slug INTO v_slug FROM social_pages sp 
     WHERE sp.linked_entity_type='home_group' AND sp.linked_entity_id = NEW.group_id::text LIMIT 1;

    -- Notify approved members (respecting preference)
    FOR v_recipient IN 
        SELECT m.user_id 
          FROM commander_home_members m
         WHERE m.group_id = NEW.group_id
           AND m.status = 'approved'
           AND m.user_id <> NEW.host_id
           AND COALESCE(m.notify_new_games, true) = true
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient.user_id, 'home_game_new',
            'New game scheduled in ' || v_group.name,
            COALESCE(NEW.title, 'Home game') || ' on ' || to_char(NEW.scheduled_date, 'Dy Mon DD'),
            '/hub/home-games/' || COALESCE(v_slug, NEW.group_id::text) || '/games/' || NEW.id::text,
            jsonb_build_object('game_id', NEW.id, 'group_id', NEW.group_id),
            'home_game_notify_new_games'
        );
    END LOOP;

    -- Notify followers (non-members who opted in)
    FOR v_recipient IN 
        SELECT f.user_id 
          FROM commander_home_group_follows f
         WHERE f.group_id = NEW.group_id
           AND f.notify_new_games = true
           AND f.user_id <> NEW.host_id
           AND NOT EXISTS (SELECT 1 FROM commander_home_members m 
                            WHERE m.group_id = NEW.group_id AND m.user_id = f.user_id)
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient.user_id, 'home_game_new_followed',
            v_group.name || ' has a new game',
            COALESCE(NEW.title, 'Home game') || ' on ' || to_char(NEW.scheduled_date, 'Dy Mon DD'),
            '/hub/home-games/' || COALESCE(v_slug, NEW.group_id::text) || '/games/' || NEW.id::text,
            jsonb_build_object('game_id', NEW.id, 'group_id', NEW.group_id, 'via', 'follow'),
            NULL
        );
    END LOOP;

    RETURN NEW;
END; $fn$;

-- ════════════════════════════════════════════════════════════════════════
-- 2) GAME TEMPLATES — saved game configurations for fast re-use
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_home_game_templates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id            uuid NOT NULL REFERENCES commander_home_groups(id) ON DELETE CASCADE,
    created_by          uuid NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
    name                text NOT NULL,
    description         text,
    game_type           text,
    stakes              text,
    format              text CHECK (format IN ('cash','tournament')),
    buyin_min           numeric,
    buyin_max           numeric,
    default_start_time  time,
    max_players         int,
    min_players         int,
    allow_guests        boolean DEFAULT false,
    guest_limit         int,
    food_drinks         text,
    special_rules       text,
    is_default          boolean DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT NOW(),
    updated_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_home_templates_group ON commander_home_game_templates(group_id, is_default DESC, created_at DESC);

ALTER TABLE commander_home_game_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY home_templates_host_select ON commander_home_game_templates
  FOR SELECT TO authenticated USING (
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
    OR group_id IN (SELECT group_id FROM commander_home_members 
                     WHERE user_id = auth.uid() AND role IN ('owner','admin') AND status='approved')
  );
CREATE POLICY home_templates_host_insert ON commander_home_game_templates
  FOR INSERT TO authenticated WITH CHECK (
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
    OR group_id IN (SELECT group_id FROM commander_home_members 
                     WHERE user_id = auth.uid() AND role IN ('owner','admin') AND status='approved')
  );
CREATE POLICY home_templates_host_update ON commander_home_game_templates
  FOR UPDATE TO authenticated USING (
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
  );
CREATE POLICY home_templates_host_delete ON commander_home_game_templates
  FOR DELETE TO authenticated USING (
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.create_home_game_template(
    p_group_id            uuid,
    p_caller_user_id      uuid,
    p_name                text,
    p_description         text DEFAULT NULL,
    p_game_type           text DEFAULT NULL,
    p_stakes              text DEFAULT NULL,
    p_format              text DEFAULT 'cash',
    p_buyin_min           numeric DEFAULT NULL,
    p_buyin_max           numeric DEFAULT NULL,
    p_default_start_time  time DEFAULT NULL,
    p_max_players         int DEFAULT NULL,
    p_min_players         int DEFAULT NULL,
    p_allow_guests        boolean DEFAULT false,
    p_guest_limit         int DEFAULT NULL,
    p_food_drinks         text DEFAULT NULL,
    p_special_rules       text DEFAULT NULL,
    p_is_default          boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_name IS NULL OR length(trim(p_name)) = 0 THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM commander_home_groups WHERE id = p_group_id AND owner_id = p_caller_user_id
        UNION
        SELECT 1 FROM commander_home_members WHERE group_id = p_group_id AND user_id = p_caller_user_id 
          AND role IN ('admin','owner') AND status='approved'
    ) THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    -- If setting as default, unset others first
    IF p_is_default THEN
        UPDATE commander_home_game_templates SET is_default = false WHERE group_id = p_group_id;
    END IF;

    INSERT INTO commander_home_game_templates (
        group_id, created_by, name, description,
        game_type, stakes, format, buyin_min, buyin_max,
        default_start_time, max_players, min_players,
        allow_guests, guest_limit, food_drinks, special_rules, is_default
    ) VALUES (
        p_group_id, p_caller_user_id, p_name, p_description,
        p_game_type, p_stakes, p_format, p_buyin_min, p_buyin_max,
        p_default_start_time, p_max_players, p_min_players,
        p_allow_guests, p_guest_limit, p_food_drinks, p_special_rules, p_is_default
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'template_id', v_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.create_home_game_template(uuid, uuid, text, text, text, text, text, numeric, numeric, time, int, int, boolean, int, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_home_game_template(uuid, uuid, text, text, text, text, text, numeric, numeric, time, int, int, boolean, int, text, text, boolean) TO authenticated, service_role;

-- Instantiate a game from a template
CREATE OR REPLACE FUNCTION public.create_home_game_from_template(
    p_template_id         uuid,
    p_scheduled_date      date,
    p_caller_user_id      uuid,
    p_title               text DEFAULT NULL,
    p_address             text DEFAULT NULL,
    p_address_visible_to  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_template RECORD;
    v_group    RECORD;
    v_new_id   uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_scheduled_date <= CURRENT_DATE THEN RAISE EXCEPTION 'DATE_MUST_BE_FUTURE'; END IF;

    SELECT * INTO v_template FROM commander_home_game_templates WHERE id = p_template_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'TEMPLATE_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_template.group_id;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_template.group_id AND user_id = p_caller_user_id
                          AND role IN ('admin','owner') AND status='approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    IF EXISTS (SELECT 1 FROM commander_home_games 
                WHERE group_id = v_template.group_id 
                  AND scheduled_date = p_scheduled_date 
                  AND status NOT IN ('cancelled'))
    THEN RAISE EXCEPTION 'DATE_ALREADY_SCHEDULED'; END IF;

    INSERT INTO commander_home_games (
        group_id, host_id, title, description,
        game_type, stakes, format, buyin_min, buyin_max,
        scheduled_date, start_time,
        address, address_visible_to,
        max_players, min_players, allow_guests, guest_limit,
        food_drinks, special_rules, status
    ) VALUES (
        v_template.group_id, p_caller_user_id,
        COALESCE(p_title, v_template.name),
        v_template.description,
        v_template.game_type, v_template.stakes, v_template.format, 
        v_template.buyin_min, v_template.buyin_max,
        p_scheduled_date, v_template.default_start_time,
        COALESCE(p_address, v_group.address),
        COALESCE(p_address_visible_to, 
                 CASE WHEN v_group.is_private THEN 'members' ELSE 'rsvpd' END),
        v_template.max_players, v_template.min_players, 
        v_template.allow_guests, v_template.guest_limit,
        v_template.food_drinks, v_template.special_rules, 'scheduled'
    ) RETURNING id INTO v_new_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_template.group_id, p_caller_user_id, 'game', v_new_id, 'from_template',
            jsonb_build_object('template_id', p_template_id, 'date', p_scheduled_date));

    RETURN jsonb_build_object('success', true, 'game_id', v_new_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.create_home_game_from_template(uuid, date, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_home_game_from_template(uuid, date, uuid, text, text, text) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 3) WEEKLY INSIGHTS SNAPSHOTS — time-series analytics per group
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_home_group_weekly_snapshots (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id           uuid NOT NULL REFERENCES commander_home_groups(id) ON DELETE CASCADE,
    week_start         date NOT NULL,  -- Monday of the week
    member_count       int DEFAULT 0,
    new_members        int DEFAULT 0,
    games_scheduled    int DEFAULT 0,
    games_completed    int DEFAULT 0,
    games_cancelled    int DEFAULT 0,
    total_rsvp_yes     int DEFAULT 0,
    total_checked_in   int DEFAULT 0,
    flake_count        int DEFAULT 0,
    post_count         int DEFAULT 0,
    view_count_delta   int DEFAULT 0,
    share_count_delta  int DEFAULT 0,
    captured_at        timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, week_start)
);

CREATE INDEX idx_home_snapshots_group_week ON commander_home_group_weekly_snapshots(group_id, week_start DESC);

ALTER TABLE commander_home_group_weekly_snapshots ENABLE ROW LEVEL SECURITY;

-- Only hosts can read their group's snapshots
CREATE POLICY home_snapshots_host_select ON commander_home_group_weekly_snapshots
  FOR SELECT TO authenticated USING (
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
    OR group_id IN (SELECT group_id FROM commander_home_members 
                     WHERE user_id = auth.uid() AND role IN ('admin','owner') AND status='approved')
  );

-- Cron function: capture this week's stats for every active group
CREATE OR REPLACE FUNCTION public.fn_capture_home_weekly_snapshots()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_week_start date;
    v_captured   int := 0;
    v_group      RECORD;
    v_prev_snapshot RECORD;
BEGIN
    -- Monday of the current week
    v_week_start := date_trunc('week', CURRENT_DATE)::date;

    FOR v_group IN 
        SELECT * FROM commander_home_groups WHERE is_active = true
    LOOP
        SELECT * INTO v_prev_snapshot 
          FROM commander_home_group_weekly_snapshots
         WHERE group_id = v_group.id 
         ORDER BY week_start DESC LIMIT 1;

        INSERT INTO commander_home_group_weekly_snapshots (
            group_id, week_start,
            member_count, new_members,
            games_scheduled, games_completed, games_cancelled,
            total_rsvp_yes, total_checked_in, flake_count,
            post_count, view_count_delta, share_count_delta
        ) VALUES (
            v_group.id, v_week_start,
            COALESCE(v_group.member_count, 0),
            (SELECT COUNT(*) FROM commander_home_members 
              WHERE group_id = v_group.id AND created_at >= v_week_start - INTERVAL '7 days'),
            (SELECT COUNT(*) FROM commander_home_games 
              WHERE group_id = v_group.id AND created_at >= v_week_start - INTERVAL '7 days'),
            (SELECT COUNT(*) FROM commander_home_games 
              WHERE group_id = v_group.id AND status = 'completed' 
                AND updated_at >= v_week_start - INTERVAL '7 days'),
            (SELECT COUNT(*) FROM commander_home_games 
              WHERE group_id = v_group.id AND status = 'cancelled' 
                AND cancelled_at >= v_week_start - INTERVAL '7 days'),
            (SELECT COUNT(*) FROM commander_home_rsvps r 
              JOIN commander_home_games g ON g.id = r.game_id
              WHERE g.group_id = v_group.id AND r.response = 'yes'
                AND r.responded_at >= v_week_start - INTERVAL '7 days'),
            (SELECT COUNT(*) FROM commander_home_rsvps r 
              JOIN commander_home_games g ON g.id = r.game_id
              WHERE g.group_id = v_group.id AND r.checked_in_at >= v_week_start - INTERVAL '7 days'),
            (SELECT COUNT(*) FROM commander_home_rsvps r 
              JOIN commander_home_games g ON g.id = r.game_id
              WHERE g.group_id = v_group.id AND r.flaked = true
                AND r.updated_at >= v_week_start - INTERVAL '7 days'),
            (SELECT COUNT(*) FROM commander_home_posts 
              WHERE group_id = v_group.id AND created_at >= v_week_start - INTERVAL '7 days'),
            -- Deltas vs last snapshot
            GREATEST(0, COALESCE(v_group.view_count, 0) - COALESCE(v_prev_snapshot.view_count_delta, 0)),
            GREATEST(0, COALESCE(v_group.share_click_count, 0) - COALESCE(v_prev_snapshot.share_count_delta, 0))
        )
        ON CONFLICT (group_id, week_start) DO UPDATE SET
            member_count       = EXCLUDED.member_count,
            new_members        = EXCLUDED.new_members,
            games_scheduled    = EXCLUDED.games_scheduled,
            games_completed    = EXCLUDED.games_completed,
            games_cancelled    = EXCLUDED.games_cancelled,
            total_rsvp_yes     = EXCLUDED.total_rsvp_yes,
            total_checked_in   = EXCLUDED.total_checked_in,
            flake_count        = EXCLUDED.flake_count,
            post_count         = EXCLUDED.post_count,
            captured_at        = NOW();

        v_captured := v_captured + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'week_start', v_week_start, 'snapshots_captured', v_captured);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.fn_capture_home_weekly_snapshots() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_capture_home_weekly_snapshots() TO service_role;

-- Schedule: every Monday at 00:30 UTC
SELECT cron.schedule(
    'home-weekly-snapshots',
    '30 0 * * 1',
    $$SELECT public.fn_capture_home_weekly_snapshots();$$
);

-- RPC: retrieve trend series for a group
CREATE OR REPLACE FUNCTION public.get_home_group_weekly_trends(
    p_group_id        uuid,
    p_caller_user_id  uuid,
    p_weeks           int DEFAULT 12
) RETURNS TABLE (
    week_start date,
    member_count int, new_members int,
    games_scheduled int, games_completed int, games_cancelled int,
    total_rsvp_yes int, total_checked_in int, flake_count int,
    post_count int, view_count_delta int, share_count_delta int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id 
                          AND role IN ('admin','owner') AND status='approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    RETURN QUERY
    SELECT s.week_start, s.member_count, s.new_members,
           s.games_scheduled, s.games_completed, s.games_cancelled,
           s.total_rsvp_yes, s.total_checked_in, s.flake_count,
           s.post_count, s.view_count_delta, s.share_count_delta
      FROM commander_home_group_weekly_snapshots s
     WHERE s.group_id = p_group_id
       AND s.week_start >= CURRENT_DATE - (p_weeks * 7 || ' days')::interval
     ORDER BY s.week_start;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_group_weekly_trends(uuid, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_group_weekly_trends(uuid, uuid, int) TO authenticated, service_role;
