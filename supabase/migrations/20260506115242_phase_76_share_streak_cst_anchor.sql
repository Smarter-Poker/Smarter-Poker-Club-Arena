-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506115242 "phase_76_share_streak_cst_anchor"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d0a177246b4fba4d38841b772bee8aa9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 76 — Anchor share-streak day computation to America/Chicago.
-- See repo migration 20260506112000_fix_share_streak_cst_anchor.sql for full rationale.
-- All reward thresholds + multiplier values preserved; only the day anchor changes.

CREATE OR REPLACE FUNCTION public.fn_sync_share_streak_multiplier(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today         DATE         := (now() AT TIME ZONE 'America/Chicago')::DATE;
    v_yesterday     DATE         := v_today - 1;
    v_streak_days   INTEGER      := 0;
    v_multiplier    DECIMAL(4,2) := 1.00;
    v_has_active    BOOLEAN      := false;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.share_events
        WHERE user_id = p_user_id
          AND (created_at AT TIME ZONE 'America/Chicago')::DATE >= v_yesterday
    ) INTO v_has_active;

    IF v_has_active THEN
        WITH daily_shares AS (
            SELECT date_trunc('day', created_at AT TIME ZONE 'America/Chicago')::DATE AS share_day
            FROM public.share_events
            WHERE user_id = p_user_id
            GROUP BY share_day
        ),
        numbered AS (
            SELECT
                share_day,
                share_day - (ROW_NUMBER() OVER (ORDER BY share_day DESC) * INTERVAL '1 day')::DATE AS grp
            FROM daily_shares
            WHERE share_day <= v_today
        ),
        current_streak AS (
            SELECT COUNT(*) AS streak_days
            FROM numbered
            WHERE grp = (
                SELECT grp FROM numbered
                WHERE share_day >= v_yesterday
                ORDER BY share_day DESC
                LIMIT 1
            )
        )
        SELECT streak_days INTO v_streak_days FROM current_streak;
    END IF;

    IF v_streak_days >= 30 THEN v_multiplier := 2.00;
    ELSIF v_streak_days >= 14 THEN v_multiplier := 1.75;
    ELSIF v_streak_days >= 7 THEN v_multiplier := 1.50;
    ELSIF v_streak_days >= 3 THEN v_multiplier := 1.20;
    ELSE v_multiplier := 1.00;
    END IF;

    UPDATE public.profiles
    SET diamond_multiplier = v_multiplier,
        updated_at = now()
    WHERE id = p_user_id
      AND COALESCE(diamond_multiplier, 1.00) != v_multiplier;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_sync_share_streak_multiplier(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_reset_broken_streak_multipliers()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_yesterday DATE := ((now() AT TIME ZONE 'America/Chicago') - INTERVAL '1 day')::DATE;
    v_count     INTEGER;
BEGIN
    WITH stale_users AS (
        SELECT p.id
        FROM public.profiles p
        WHERE COALESCE(p.diamond_multiplier, 1.00) > 1.00
          AND NOT EXISTS (
              SELECT 1 FROM public.share_events se
              WHERE se.user_id = p.id
                AND (se.created_at AT TIME ZONE 'America/Chicago')::DATE >= v_yesterday
          )
    )
    UPDATE public.profiles
    SET diamond_multiplier = 1.00,
        updated_at = now()
    WHERE id IN (SELECT id FROM stale_users);

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_reset_broken_streak_multipliers() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_award_share_streak_diamonds(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $func$
DECLARE
    v_today           date    := (now() AT TIME ZONE 'America/Chicago')::date;
    v_yesterday       date    := v_today - 1;
    v_streak_days     integer := 0;
    v_reward_diamonds integer := 0;
    v_reward_tier     text    := 'none';
    v_ref_id          text;
    v_award_result    jsonb;
BEGIN
    WITH daily_shares AS (
        SELECT date_trunc('day', created_at AT TIME ZONE 'America/Chicago')::DATE AS share_day
        FROM public.share_events
        WHERE user_id = p_user_id
          AND created_at >= (now() - INTERVAL '90 days')
        GROUP BY share_day
    ),
    numbered AS (
        SELECT
            share_day,
            share_day - ROW_NUMBER() OVER (ORDER BY share_day ASC)::integer AS grp
        FROM daily_shares
        WHERE share_day <= v_today
    ),
    active_grp AS (
        SELECT grp FROM numbered
        WHERE share_day >= v_yesterday
        ORDER BY share_day DESC
        LIMIT 1
    ),
    current_streak AS (
        SELECT COUNT(*) AS streak_days
        FROM numbered
        WHERE grp = (SELECT grp FROM active_grp)
    )
    SELECT COALESCE(streak_days, 0) INTO v_streak_days FROM current_streak;

    IF v_streak_days = 30 THEN
        v_reward_tier := 'legend';    v_reward_diamonds := 500;
    ELSIF v_streak_days = 14 THEN
        v_reward_tier := 'master';    v_reward_diamonds := 200;
    ELSIF v_streak_days = 7 THEN
        v_reward_tier := 'expert';    v_reward_diamonds := 100;
    ELSIF v_streak_days = 3 THEN
        v_reward_tier := 'streak';    v_reward_diamonds := 50;
    ELSE
        RETURN jsonb_build_object(
            'awarded', false,
            'streak_days', v_streak_days,
            'reason', 'no_milestone'
        );
    END IF;

    v_ref_id := format('streak_milestone_%s_%s_%s', p_user_id, v_reward_tier, v_today);

    SELECT public.add_diamonds_to_balance(
        p_user_id      := p_user_id,
        p_amount       := v_reward_diamonds,
        p_type         := 'streak_reward',
        p_description  := format('%s-day share streak milestone bonus', v_streak_days),
        p_reference_id := v_ref_id
    ) INTO v_award_result;

    INSERT INTO public.share_streak_rewards (user_id, reward_day, streak_length, diamonds_awarded)
    VALUES (p_user_id, v_today, v_streak_days, v_reward_diamonds)
    ON CONFLICT (user_id, reward_day) DO NOTHING;

    PERFORM public.fn_sync_share_streak_multiplier(p_user_id);

    RETURN jsonb_build_object(
        'awarded',      true,
        'streak_days',  v_streak_days,
        'tier',         v_reward_tier,
        'diamonds',     v_reward_diamonds,
        'award_result', v_award_result
    );
END;
$func$;

GRANT EXECUTE ON FUNCTION public.fn_award_share_streak_diamonds(uuid) TO authenticated, service_role;
