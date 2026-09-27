-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419160320 "phase24f_cron_reminders_and_janitors"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c92c22be95c2a947cbcd8b1ea9e53986 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART F — pg_cron jobs for home games
--  -----------------------------------------------------------------------
--  P2.1  /cron/home-game-reminders     — 6h-before + 1h-before (Dan's cadence)
--  P2.2  /cron/home-group-stale-sweep  — hide stale groups + warning emails
--  P2.3  /cron/home-game-auto-complete — flip past games to completed
--  P2.5  /cron/home-host-pending-nudge — nudge hosts with old pending requests
--  P2.6  /cron/home-game-recap-prompt  — review prompts 12h after game end
-- =========================================================================

-- ────────────────────────────────────────────────────────────────────────
-- Dedup columns on rsvps (so each reminder fires exactly once per window)
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE commander_home_rsvps
    ADD COLUMN IF NOT EXISTS reminder_6h_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS reminder_1h_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS review_prompt_sent_at timestamptz;

-- ────────────────────────────────────────────────────────────────────────
-- Dedup column on members for host pending nudges
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE commander_home_members
    ADD COLUMN IF NOT EXISTS pending_nudge_sent_at timestamptz;

-- ────────────────────────────────────────────────────────────────────────
-- P2.1: Game reminders — 6h + 1h before (Dan's cadence)
-- Runs every 15 minutes. Window matching uses slack of ±7.5min to avoid misses.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_send_home_game_reminders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_6h_sent int := 0;
    v_1h_sent int := 0;
    v_rsvp    RECORD;
    v_slug    text;
BEGIN
    -- 6-hour reminders: games starting in ~5h45min to ~6h15min from now
    FOR v_rsvp IN
        SELECT 
            r.id AS rsvp_id, r.user_id, r.game_id,
            g.group_id, g.title AS game_title, g.scheduled_date, g.start_time, g.address,
            grp.name AS group_name
          FROM commander_home_rsvps r
          JOIN commander_home_games g ON g.id = r.game_id
          JOIN commander_home_groups grp ON grp.id = g.group_id
         WHERE r.response = 'yes'
           AND r.reminder_6h_sent_at IS NULL
           AND g.status IN ('scheduled','confirmed')
           -- scheduled_datetime between 5h45m and 6h15m from now
           AND (g.scheduled_date + COALESCE(g.start_time, TIME '19:00')) 
               BETWEEN NOW() + INTERVAL '5 hours 45 minutes'
                   AND NOW() + INTERVAL '6 hours 15 minutes'
    LOOP
        SELECT sp.slug INTO v_slug FROM social_pages sp
         WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_rsvp.group_id::text
         LIMIT 1;

        PERFORM public.fn_emit_home_notification(
            v_rsvp.user_id,
            'home_game_reminder_6h',
            COALESCE(v_rsvp.game_title, v_rsvp.group_name) || ' — tonight in 6 hours',
            'See you at ' || COALESCE(v_rsvp.start_time::text, '') || 
                CASE WHEN v_rsvp.address IS NOT NULL 
                     THEN ' — ' || v_rsvp.address ELSE '' END,
            '/hub/home-games/' || COALESCE(v_slug, v_rsvp.group_id::text),
            jsonb_build_object('game_id', v_rsvp.game_id, 'window', '6h'),
            'home_game_reminders'
        );

        UPDATE commander_home_rsvps 
           SET reminder_6h_sent_at = NOW()
         WHERE id = v_rsvp.rsvp_id;

        v_6h_sent := v_6h_sent + 1;
    END LOOP;

    -- 1-hour reminders: games starting in ~45min to ~75min from now
    FOR v_rsvp IN
        SELECT 
            r.id AS rsvp_id, r.user_id, r.game_id,
            g.group_id, g.title AS game_title, g.scheduled_date, g.start_time, g.address,
            grp.name AS group_name
          FROM commander_home_rsvps r
          JOIN commander_home_games g ON g.id = r.game_id
          JOIN commander_home_groups grp ON grp.id = g.group_id
         WHERE r.response = 'yes'
           AND r.reminder_1h_sent_at IS NULL
           AND g.status IN ('scheduled','confirmed')
           AND (g.scheduled_date + COALESCE(g.start_time, TIME '19:00')) 
               BETWEEN NOW() + INTERVAL '45 minutes'
                   AND NOW() + INTERVAL '75 minutes'
    LOOP
        SELECT sp.slug INTO v_slug FROM social_pages sp
         WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_rsvp.group_id::text
         LIMIT 1;

        PERFORM public.fn_emit_home_notification(
            v_rsvp.user_id,
            'home_game_reminder_1h',
            'Starting in 1 hour — ' || COALESCE(v_rsvp.game_title, v_rsvp.group_name),
            'Head out soon. ' || COALESCE(v_rsvp.start_time::text, 'tonight'),
            '/hub/home-games/' || COALESCE(v_slug, v_rsvp.group_id::text),
            jsonb_build_object('game_id', v_rsvp.game_id, 'window', '1h'),
            'home_game_reminders'
        );

        UPDATE commander_home_rsvps 
           SET reminder_1h_sent_at = NOW()
         WHERE id = v_rsvp.rsvp_id;

        v_1h_sent := v_1h_sent + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'sent_6h', v_6h_sent,
        'sent_1h', v_1h_sent,
        'run_at', NOW()
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_send_home_game_reminders() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_send_home_game_reminders() TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P2.2: Stale group sweep — hide stale + send warning at 35d, hidden at 45d
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_home_group_stale_sweep(
    p_warning_days int DEFAULT 35,
    p_hide_days    int DEFAULT 45
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_warned int := 0;
    v_hidden int := 0;
    v_group  RECORD;
    v_slug   text;
BEGIN
    -- WARNINGS: groups 35-45 days stale, owner not yet notified this cycle
    FOR v_group IN
        SELECT g.* FROM commander_home_groups g
         WHERE g.is_active = true
           AND g.last_activity_at IS NOT NULL
           AND g.last_activity_at < NOW() - (p_warning_days || ' days')::interval
           AND g.last_activity_at > NOW() - (p_hide_days || ' days')::interval
           AND (g.visibility_override_until IS NULL OR g.visibility_override_until < NOW())
           AND (g.inactivity_warning_sent_at IS NULL 
                OR g.inactivity_warning_sent_at < g.last_activity_at)
    LOOP
        SELECT sp.slug INTO v_slug FROM social_pages sp
         WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;

        PERFORM public.fn_emit_home_notification(
            v_group.owner_id, 'home_group_stale_warning',
            v_group.name || ' will be hidden soon',
            'No recent activity in ' || p_warning_days || '+ days. Post something to stay visible.',
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text) || '/host',
            jsonb_build_object(
                'group_id', v_group.id, 
                'days_until_hidden', p_hide_days - EXTRACT(day FROM (NOW() - v_group.last_activity_at))::int
            ),
            NULL
        );

        UPDATE commander_home_groups 
           SET inactivity_warning_sent_at = NOW()
         WHERE id = v_group.id;

        v_warned := v_warned + 1;
    END LOOP;

    -- HIDDEN NOTICES: groups now >= 45d stale, owner not yet notified
    FOR v_group IN
        SELECT g.* FROM commander_home_groups g
         WHERE g.is_active = true
           AND g.last_activity_at IS NOT NULL
           AND g.last_activity_at < NOW() - (p_hide_days || ' days')::interval
           AND (g.visibility_override_until IS NULL OR g.visibility_override_until < NOW())
           AND (g.inactivity_hidden_sent_at IS NULL 
                OR g.inactivity_hidden_sent_at < g.last_activity_at)
    LOOP
        SELECT sp.slug INTO v_slug FROM social_pages sp
         WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_group.id::text LIMIT 1;

        PERFORM public.fn_emit_home_notification(
            v_group.owner_id, 'home_group_hidden',
            v_group.name || ' is now hidden from discovery',
            'Your group was inactive for ' || p_hide_days || '+ days. Revive anytime to reappear.',
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text) || '/host',
            jsonb_build_object('group_id', v_group.id, 'action', 'revive'),
            NULL
        );

        UPDATE commander_home_groups 
           SET inactivity_hidden_sent_at = NOW()
         WHERE id = v_group.id;

        v_hidden := v_hidden + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'warnings_sent', v_warned,
        'hidden_notices_sent', v_hidden,
        'run_at', NOW()
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_home_group_stale_sweep(int, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_home_group_stale_sweep(int, int) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P2.3: Auto-complete past games (6h after end_time defaults to 3am next day)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_home_game_auto_complete()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_completed int := 0;
    v_game      RECORD;
BEGIN
    -- Flip to completed if: status in scheduled/confirmed AND 
    -- (scheduled_date + COALESCE(end_time, 3am_next_day) + 6h) < NOW()
    FOR v_game IN
        SELECT * FROM commander_home_games
         WHERE status IN ('scheduled','confirmed','in_progress')
           AND (
               scheduled_date + COALESCE(end_time, TIME '03:00') 
                 + INTERVAL '6 hours'
                 + CASE WHEN end_time IS NULL OR end_time < TIME '06:00' 
                        THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END
               ) < NOW()
    LOOP
        -- Use SECURITY DEFINER path through direct UPDATE (skip the complete_home_game RPC 
        -- because it wants auth.uid(); this is cron context)
        UPDATE commander_home_games 
           SET status = 'completed', updated_at = NOW()
         WHERE id = v_game.id;

        -- Bump group's games_hosted
        UPDATE commander_home_groups 
           SET games_hosted = COALESCE(games_hosted, 0) + 1
         WHERE id = v_game.group_id;

        -- Mark flakes
        UPDATE commander_home_rsvps
           SET flaked = true
         WHERE game_id = v_game.id 
           AND response = 'yes' 
           AND checked_in_at IS NULL;

        -- Increment attended for checked-in members
        UPDATE commander_home_members m
           SET games_attended = COALESCE(m.games_attended, 0) + 1,
               last_attended  = NOW()
          FROM commander_home_rsvps r
         WHERE r.game_id = v_game.id AND r.user_id = m.user_id
           AND m.group_id = v_game.group_id AND r.checked_in_at IS NOT NULL;

        INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
        VALUES (v_game.group_id, NULL, 'game', v_game.id, 'auto_completed',
                jsonb_build_object('source', 'cron', 'scheduled_date', v_game.scheduled_date));

        v_completed := v_completed + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'completed_count', v_completed,
        'run_at', NOW()
    );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_home_game_auto_complete() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_home_game_auto_complete() TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P2.5: Host pending nudge — ping hosts when requests sit > 48h
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_home_host_pending_nudge()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_sent int := 0;
    v_host RECORD;
BEGIN
    FOR v_host IN
        SELECT DISTINCT grp.owner_id, grp.id AS group_id, grp.name AS group_name,
               COUNT(m.id) AS pending_count,
               sp.slug
          FROM commander_home_members m
          JOIN commander_home_groups grp ON grp.id = m.group_id
          LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id=grp.id::text
         WHERE m.status = 'pending'
           AND m.created_at < NOW() - INTERVAL '48 hours'
           AND (m.pending_nudge_sent_at IS NULL 
                OR m.pending_nudge_sent_at < NOW() - INTERVAL '3 days')
         GROUP BY grp.owner_id, grp.id, grp.name, sp.slug
    LOOP
        PERFORM public.fn_emit_home_notification(
            v_host.owner_id, 'home_group_pending_nudge',
            v_host.pending_count || ' pending request' || 
                CASE WHEN v_host.pending_count = 1 THEN '' ELSE 's' END,
            'Review requests waiting for ' || v_host.group_name,
            '/hub/home-games/' || COALESCE(v_host.slug, v_host.group_id::text) || '/host',
            jsonb_build_object('group_id', v_host.group_id, 'pending_count', v_host.pending_count),
            'home_game_host_requests'
        );

        UPDATE commander_home_members
           SET pending_nudge_sent_at = NOW()
         WHERE group_id = v_host.group_id AND status = 'pending'
           AND created_at < NOW() - INTERVAL '48 hours';

        v_sent := v_sent + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'hosts_nudged', v_sent, 'run_at', NOW());
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_home_host_pending_nudge() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_home_host_pending_nudge() TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- P2.6: Game recap prompt — 12h after game end, nudge checked-in attendees
-- (Only if user_notification_preferences.home_game_review_prompts = true)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_home_game_recap_prompt()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_sent int := 0;
    v_attendee RECORD;
    v_slug text;
BEGIN
    FOR v_attendee IN
        SELECT r.id AS rsvp_id, r.user_id, r.game_id,
               g.title, g.scheduled_date, g.group_id
          FROM commander_home_rsvps r
          JOIN commander_home_games g ON g.id = r.game_id
         WHERE r.checked_in_at IS NOT NULL
           AND r.review_prompt_sent_at IS NULL
           AND g.status = 'completed'
           AND g.updated_at < NOW() - INTERVAL '12 hours'
           AND g.updated_at > NOW() - INTERVAL '7 days'  -- don't backfill ancient games
           AND NOT EXISTS (
               SELECT 1 FROM commander_home_game_reviews rv
                WHERE rv.game_id = r.game_id AND rv.reviewer_id = r.user_id)
    LOOP
        SELECT sp.slug INTO v_slug FROM social_pages sp
         WHERE sp.linked_entity_type = 'home_group' AND sp.linked_entity_id = v_attendee.group_id::text LIMIT 1;

        PERFORM public.fn_emit_home_notification(
            v_attendee.user_id, 'home_game_review_prompt',
            'How was ' || COALESCE(v_attendee.title, 'the game') || '?',
            'Leave a quick review for the host.',
            '/hub/home-games/' || COALESCE(v_slug, v_attendee.group_id::text) || '/games/' || v_attendee.game_id::text,
            jsonb_build_object('game_id', v_attendee.game_id),
            'home_game_review_prompts'
        );

        UPDATE commander_home_rsvps 
           SET review_prompt_sent_at = NOW()
         WHERE id = v_attendee.rsvp_id;

        v_sent := v_sent + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'prompts_sent', v_sent, 'run_at', NOW());
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_home_game_recap_prompt() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_home_game_recap_prompt() TO service_role;

-- =========================================================================
--  Schedule all home-games crons via pg_cron
-- =========================================================================

-- P2.1: reminders every 15 min (catches 6h and 1h windows)
SELECT cron.schedule(
    'home-game-reminders-6h-1h',
    '*/15 * * * *',
    $$SELECT public.fn_send_home_game_reminders();$$
);

-- P2.2: stale sweep nightly at 2AM UTC
SELECT cron.schedule(
    'home-group-stale-sweep',
    '0 2 * * *',
    $$SELECT public.fn_home_group_stale_sweep(35, 45);$$
);

-- P2.3: auto-complete hourly
SELECT cron.schedule(
    'home-game-auto-complete',
    '17 * * * *',  -- :17 past the hour to avoid top-of-hour stampedes
    $$SELECT public.fn_home_game_auto_complete();$$
);

-- P2.5: pending nudge daily at 9AM UTC (~5AM ET, sensible host-waking hour)
SELECT cron.schedule(
    'home-host-pending-nudge',
    '0 9 * * *',
    $$SELECT public.fn_home_host_pending_nudge();$$
);

-- P2.6: recap prompts daily at 10AM UTC
SELECT cron.schedule(
    'home-game-recap-prompt',
    '0 10 * * *',
    $$SELECT public.fn_home_game_recap_prompt();$$
);
