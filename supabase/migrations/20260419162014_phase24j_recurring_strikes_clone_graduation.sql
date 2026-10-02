-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419162014 "phase24j_recurring_strikes_clone_graduation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d434b767ed6309e95197b3fdbe247429 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART J — Recurring games + strikes + RSVP reasons + clone 
--                    + club graduation scaffold
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- New columns
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE commander_home_groups
    ADD COLUMN IF NOT EXISTS auto_generate_games boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS auto_generate_weeks_ahead int DEFAULT 4 
        CHECK (auto_generate_weeks_ahead BETWEEN 1 AND 12),
    ADD COLUMN IF NOT EXISTS auto_ban_after_flakes int  -- NULL = no auto-ban
        CHECK (auto_ban_after_flakes IS NULL OR auto_ban_after_flakes BETWEEN 1 AND 20);

ALTER TABLE commander_home_members
    ADD COLUMN IF NOT EXISTS is_regular boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS flake_strikes int DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS host_private_note text,  -- host-only note on member
    ADD COLUMN IF NOT EXISTS probation_until timestamptz;  -- temp ban expiry

ALTER TABLE commander_home_rsvps
    ADD COLUMN IF NOT EXISTS rsvp_reason text CHECK (
        rsvp_reason IS NULL OR length(rsvp_reason) <= 500
    );

COMMENT ON COLUMN commander_home_groups.auto_generate_games IS
  'Phase 24/P9.9: when true + frequency + typical_day + typical_time set, nightly cron generates upcoming games.';
COMMENT ON COLUMN commander_home_members.is_regular IS
  'Phase 24: host-flagged "regular" status. Used for host dashboard sorting.';
COMMENT ON COLUMN commander_home_members.flake_strikes IS
  'Phase 24: auto-incremented each time the member flakes. Host may auto-ban after N strikes.';
COMMENT ON COLUMN commander_home_members.host_private_note IS
  'Phase 24: private note visible only to group owner/admins (e.g. "great vibes", "slow player").';

-- ════════════════════════════════════════════════════════════════════════
-- P9.9 — Recurring game auto-generator
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_generate_recurring_home_games()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_group       RECORD;
    v_generated   int := 0;
    v_skipped     int := 0;
    v_target_date date;
    v_week        int;
    v_interval    interval;
    v_day_number  int;  -- 0=Sun..6=Sat
    v_weeks_max   int;
    v_new_game_id uuid;
BEGIN
    FOR v_group IN
        SELECT g.*, grp_sp.slug
          FROM commander_home_groups g
          LEFT JOIN social_pages grp_sp ON grp_sp.linked_entity_type='home_group' AND grp_sp.linked_entity_id=g.id::text
         WHERE g.is_active = true
           AND g.auto_generate_games = true
           AND g.frequency IN ('weekly','biweekly','monthly')
           AND g.typical_day IS NOT NULL
           AND g.typical_time IS NOT NULL
           AND g.last_activity_at > NOW() - INTERVAL '60 days'  -- skip dead groups
    LOOP
        -- Map typical_day text to day-number (0=Sunday..6=Saturday)
        v_day_number := CASE lower(v_group.typical_day)
            WHEN 'sunday' THEN 0 WHEN 'sun' THEN 0
            WHEN 'monday' THEN 1 WHEN 'mon' THEN 1
            WHEN 'tuesday' THEN 2 WHEN 'tue' THEN 2 WHEN 'tues' THEN 2
            WHEN 'wednesday' THEN 3 WHEN 'wed' THEN 3
            WHEN 'thursday' THEN 4 WHEN 'thu' THEN 4 WHEN 'thurs' THEN 4
            WHEN 'friday' THEN 5 WHEN 'fri' THEN 5
            WHEN 'saturday' THEN 6 WHEN 'sat' THEN 6
            ELSE NULL END;
        
        IF v_day_number IS NULL THEN 
            v_skipped := v_skipped + 1; 
            CONTINUE; 
        END IF;

        v_interval := CASE v_group.frequency
            WHEN 'weekly'   THEN INTERVAL '7 days'
            WHEN 'biweekly' THEN INTERVAL '14 days'
            WHEN 'monthly'  THEN INTERVAL '28 days'
            ELSE INTERVAL '7 days' END;

        v_weeks_max := COALESCE(v_group.auto_generate_weeks_ahead, 4);

        -- Find first target date: next occurrence of day_number starting tomorrow
        v_target_date := CURRENT_DATE + 1;
        WHILE EXTRACT(DOW FROM v_target_date)::int <> v_day_number LOOP
            v_target_date := v_target_date + 1;
        END LOOP;

        -- Generate for each cycle up to weeks_ahead
        FOR v_week IN 1..v_weeks_max LOOP
            -- Skip if a game already exists for this group on this date
            IF EXISTS (
                SELECT 1 FROM commander_home_games 
                 WHERE group_id = v_group.id 
                   AND scheduled_date = v_target_date
                   AND status NOT IN ('cancelled')
            ) THEN
                v_skipped := v_skipped + 1;
            ELSE
                INSERT INTO commander_home_games (
                    group_id, host_id, title, 
                    game_type, stakes, format,
                    buyin_min, buyin_max,
                    scheduled_date, start_time, 
                    max_players, 
                    status,
                    address_visible_to
                ) VALUES (
                    v_group.id, v_group.owner_id,
                    v_group.name || ' — ' || to_char(v_target_date, 'Mon DD'),
                    v_group.default_game_type, v_group.default_stakes, 'cash',
                    v_group.typical_buyin_min, v_group.typical_buyin_max,
                    v_target_date, v_group.typical_time,
                    COALESCE(v_group.max_players, 9),
                    'scheduled',
                    CASE WHEN v_group.is_private THEN 'members' ELSE 'rsvpd' END
                ) RETURNING id INTO v_new_game_id;

                INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
                VALUES (v_group.id, NULL, 'game', v_new_game_id, 'auto_generated',
                        jsonb_build_object('source','recurring_cron','scheduled_date', v_target_date,'week', v_week));

                v_generated := v_generated + 1;
            END IF;

            v_target_date := v_target_date + v_interval;
        END LOOP;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'generated', v_generated,
        'skipped', v_skipped,
        'run_at', NOW()
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_generate_recurring_home_games() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_generate_recurring_home_games() TO service_role;

-- Schedule the generator — daily at 5AM UTC
SELECT cron.schedule(
    'home-games-recurring-generate',
    '0 5 * * *',
    $$SELECT public.fn_generate_recurring_home_games();$$
);

-- ════════════════════════════════════════════════════════════════════════
-- No-show strike system — increment flake_strikes on flaked=true UPDATE
-- and auto-ban when threshold reached
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_track_flake_strike()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_game        RECORD;
    v_group       RECORD;
    v_strikes     int;
    v_threshold   int;
BEGIN
    -- Only fire on transitions TO flaked=true
    IF NOT (NEW.flaked = true AND (OLD.flaked IS DISTINCT FROM true)) THEN 
        RETURN NEW; 
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = NEW.game_id;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    -- Increment the member's strike count for this group
    UPDATE commander_home_members 
       SET flake_strikes = flake_strikes + 1
     WHERE group_id = v_game.group_id AND user_id = NEW.user_id
    RETURNING flake_strikes INTO v_strikes;

    v_threshold := v_group.auto_ban_after_flakes;
    IF v_threshold IS NOT NULL AND v_strikes IS NOT NULL AND v_strikes >= v_threshold THEN
        -- Auto-ban
        UPDATE commander_home_members
           SET status = 'banned'
         WHERE group_id = v_game.group_id AND user_id = NEW.user_id
           AND status <> 'banned';

        INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
        VALUES (v_game.group_id, NULL, 'member', NEW.user_id, 'auto_banned_flakes',
                jsonb_build_object('strikes', v_strikes, 'threshold', v_threshold, 
                                    'source_game_id', v_game.id));
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_track_flake_strike
    AFTER UPDATE OF flaked ON commander_home_rsvps
    FOR EACH ROW EXECUTE FUNCTION public.fn_track_flake_strike();

-- ════════════════════════════════════════════════════════════════════════
-- RPC: reset_member_flake_strikes (host forgiveness)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.reset_home_member_strikes(
    p_group_id         uuid,
    p_member_user_id   uuid,
    p_caller_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    UPDATE commander_home_members 
       SET flake_strikes = 0
     WHERE group_id = p_group_id AND user_id = p_member_user_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'member', p_member_user_id, 'strikes_reset', '{}'::jsonb);

    RETURN jsonb_build_object('success', true);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.reset_home_member_strikes(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_home_member_strikes(uuid, uuid, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- RPC: set_member_regular_flag + host_private_note
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.set_home_member_regular(
    p_group_id         uuid,
    p_member_user_id   uuid,
    p_is_regular       boolean,
    p_caller_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members WHERE group_id=p_group_id AND user_id=p_caller_user_id AND role='admin' AND status='approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    UPDATE commander_home_members SET is_regular = p_is_regular 
     WHERE group_id = p_group_id AND user_id = p_member_user_id;

    RETURN jsonb_build_object('success', true, 'is_regular', p_is_regular);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.set_home_member_regular(uuid, uuid, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_home_member_regular(uuid, uuid, boolean, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_home_member_private_note(
    p_group_id         uuid,
    p_member_user_id   uuid,
    p_note             text,
    p_caller_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_note IS NOT NULL AND length(p_note) > 1000 THEN RAISE EXCEPTION 'NOTE_TOO_LONG'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members WHERE group_id=p_group_id AND user_id=p_caller_user_id AND role='admin' AND status='approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    UPDATE commander_home_members SET host_private_note = p_note 
     WHERE group_id = p_group_id AND user_id = p_member_user_id;

    RETURN jsonb_build_object('success', true);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.set_home_member_private_note(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_home_member_private_note(uuid, uuid, text, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- RPC: clone_home_game — duplicate forward with new date
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.clone_home_game(
    p_source_game_id    uuid,
    p_new_scheduled_date date,
    p_caller_user_id    uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_source  RECORD;
    v_group   RECORD;
    v_new_id  uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_new_scheduled_date <= CURRENT_DATE THEN RAISE EXCEPTION 'DATE_MUST_BE_FUTURE'; END IF;

    SELECT * INTO v_source FROM commander_home_games WHERE id = p_source_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_GAME_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_source.group_id;

    IF v_source.host_id <> p_caller_user_id 
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_source.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    -- Check dup on target date
    IF EXISTS (SELECT 1 FROM commander_home_games 
                WHERE group_id = v_source.group_id 
                  AND scheduled_date = p_new_scheduled_date 
                  AND status NOT IN ('cancelled'))
    THEN RAISE EXCEPTION 'DATE_ALREADY_SCHEDULED'; END IF;

    INSERT INTO commander_home_games (
        group_id, host_id, title, description, 
        game_type, stakes, format, 
        buyin_min, buyin_max,
        scheduled_date, start_time, end_time,
        address, address_visible_to, location_notes, neighborhood,
        max_players, min_players, allow_guests, guest_limit,
        food_drinks, special_rules, status
    ) VALUES (
        v_source.group_id, p_caller_user_id, v_source.title, v_source.description,
        v_source.game_type, v_source.stakes, v_source.format,
        v_source.buyin_min, v_source.buyin_max,
        p_new_scheduled_date, v_source.start_time, v_source.end_time,
        v_source.address, v_source.address_visible_to, v_source.location_notes, v_source.neighborhood,
        v_source.max_players, v_source.min_players, v_source.allow_guests, v_source.guest_limit,
        v_source.food_drinks, v_source.special_rules, 'scheduled'
    ) RETURNING id INTO v_new_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_source.group_id, p_caller_user_id, 'game', v_new_id, 'cloned',
            jsonb_build_object('source_game_id', p_source_game_id, 'new_date', p_new_scheduled_date));

    RETURN jsonb_build_object('success', true, 'new_game_id', v_new_id);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.clone_home_game(uuid, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clone_home_game(uuid, date, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- P6.5 — Club graduation scaffold
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_home_group_promotion_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id        uuid NOT NULL REFERENCES commander_home_groups(id) ON DELETE CASCADE,
    requested_by    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    reason          text CHECK (reason IS NULL OR length(reason) <= 2000),
    status          text NOT NULL DEFAULT 'pending' 
                        CHECK (status IN ('pending','reviewing','approved','rejected','withdrawn')),
    reviewer_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
    reviewer_note   text,
    created_club_id uuid,  -- filled when approved
    requested_at    timestamptz NOT NULL DEFAULT NOW(),
    reviewed_at     timestamptz,
    UNIQUE (group_id) DEFERRABLE INITIALLY IMMEDIATE  -- one active request per group
);

CREATE INDEX idx_home_promo_status ON commander_home_group_promotion_requests(status, requested_at);

ALTER TABLE commander_home_group_promotion_requests ENABLE ROW LEVEL SECURITY;

-- Host sees their own group's request; service_role sees all
CREATE POLICY home_promo_select ON commander_home_group_promotion_requests
  FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
  );
CREATE POLICY home_promo_insert ON commander_home_group_promotion_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
    AND group_id IN (SELECT id FROM commander_home_groups WHERE owner_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.request_home_group_promotion(
    p_group_id        uuid,
    p_caller_user_id  uuid,
    p_reason          text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_group RECORD; v_new_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id THEN RAISE EXCEPTION 'OWNER_ONLY_ACTION'; END IF;
    IF v_group.promoted_to_club_id IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_PROMOTED'; END IF;

    -- Minimum threshold to even request: 3 completed games + 5 members
    IF COALESCE(v_group.games_hosted, 0) < 3 THEN
        RAISE EXCEPTION 'NEED_MIN_GAMES' USING HINT='requires at least 3 completed games';
    END IF;
    IF COALESCE(v_group.member_count, 0) < 5 THEN
        RAISE EXCEPTION 'NEED_MIN_MEMBERS' USING HINT='requires at least 5 members';
    END IF;

    INSERT INTO commander_home_group_promotion_requests (group_id, requested_by, reason)
    VALUES (p_group_id, p_caller_user_id, p_reason)
    ON CONFLICT (group_id) DO UPDATE 
        SET status = 'pending', 
            reason = EXCLUDED.reason,
            requested_at = NOW(),
            reviewer_id = NULL, 
            reviewer_note = NULL
    RETURNING id INTO v_new_id;

    UPDATE commander_home_groups 
       SET promotion_requested_at = NOW() 
     WHERE id = p_group_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'group', p_group_id, 'promotion_requested',
            jsonb_build_object('reason', p_reason));

    RETURN jsonb_build_object('success', true, 'request_id', v_new_id, 'status', 'pending');
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.request_home_group_promotion(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_home_group_promotion(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.withdraw_home_group_promotion(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF v_group.owner_id <> p_caller_user_id THEN RAISE EXCEPTION 'OWNER_ONLY_ACTION'; END IF;

    UPDATE commander_home_group_promotion_requests 
       SET status = 'withdrawn', reviewed_at = NOW()
     WHERE group_id = p_group_id AND status IN ('pending','reviewing');

    UPDATE commander_home_groups SET promotion_requested_at = NULL WHERE id = p_group_id;

    RETURN jsonb_build_object('success', true);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.withdraw_home_group_promotion(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdraw_home_group_promotion(uuid, uuid) TO authenticated, service_role;
