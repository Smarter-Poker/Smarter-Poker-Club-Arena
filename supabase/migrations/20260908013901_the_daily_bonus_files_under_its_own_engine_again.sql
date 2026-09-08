-- The Daily Club Arena Bonus journal rows carry reference ids of the form
-- ca_daily_bonus:<user>:<date>:<slot> and file under the engine
-- 'club_arena_daily' (20260907234436). A later redefinition of
-- fn_ca_diamond_engine_of that branched from an older body dropped that
-- prefix, so the first live claims (2026-09-08) were filed under catalog_v2.
-- This restores the branch on top of the body as it stands in production
-- today, moves the misfiled diamonds to their engine, and gives the engine
-- the same per-user daily cap the bonus itself observes.
--
-- Anyone redefining this function: keep every prefix branch. The daily bonus
-- branch must stay ahead of the type/source fallbacks.

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN starts_with(p_reference_id, 'ca_daily_bonus:')   THEN 'club_arena_daily'
        WHEN starts_with(p_reference_id, 'wheel:')            THEN 'wheel'
        WHEN starts_with(p_reference_id, 'trivia_tourn_')     THEN 'trivia_tournaments'
        WHEN starts_with(p_reference_id, 'trivia_session_')   THEN 'trivia'
        WHEN starts_with(p_reference_id, 'trivia_wheel_')     THEN 'trivia'
        WHEN starts_with(p_reference_id, 'challenge_claim')   THEN 'daily_challenges'
        WHEN starts_with(p_reference_id, 'daily_mission_milestones:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily-missions-historical-multiplier:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily_mission_')    THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'streak_milestone_') THEN 'share_streak'
        WHEN starts_with(p_reference_id, 'streak_')           THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'signup:')           THEN 'signup'
        WHEN starts_with(p_reference_id, 'easter_egg_')       THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'video_favorite_')   THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'vip_stipend_')      THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'hotd_')             THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'progress_')         THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'customization-cert-fund') THEN 'cert_fixture'
        WHEN p_source = 'complete_daily_challenge' THEN 'memory_game'
        WHEN p_source = 'handle_new_user'          THEN 'signup'
        WHEN p_source = 'union'                    THEN 'union_grant'
        WHEN p_source = 'the_mint'                 THEN 'mint'
        WHEN COALESCE(p_transaction_type, p_type) IN ('wheel_prize', 'wheel_spin') THEN 'wheel'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'referral_bonus', 'referral_bonus_reversal', 'referral_qualified',
                'referral_referee', 'referral_vip_conversion')             THEN 'referrals'
        WHEN COALESCE(p_transaction_type, p_type) = 'signup_bonus'         THEN 'signup'
        WHEN COALESCE(p_transaction_type, p_type) = 'union_grant'          THEN 'union_grant'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'pvp_refund', 'pvp_win', 'pvp_tie_refund', 'trivia_run',
                'trivia_daily_bonus', 'daily_trivia', 'trivia_reward',
                'trivia_prize_wheel', 'endless_reward', 'survival_reward',
                'mixed_reward', 'time_attack_reward', 'trivia_double_win')  THEN 'trivia'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'tournament_prize', 'tournament_entry_refund',
                'tournament_cancel_refund')                                THEN 'trivia_tournaments'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_challenge_claim') THEN 'daily_challenges'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_mission_milestone', 'daily_mission_reward') THEN 'daily_missions'
        WHEN COALESCE(p_transaction_type, p_type) = 'streak_reward'        THEN 'share_streak'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'daily_login', 'easter_egg', 'training_reward',
                'video_favorite', 'vip_stipend')                           THEN 'catalog_v2'
        WHEN COALESCE(p_transaction_type, p_type) IN ('credit', 'earn', 'bonus') THEN 'legacy_credit'
        WHEN p_description LIKE 'Diamond Rewards v2:%'                      THEN 'catalog_v2'
        ELSE 'other'
    END;
$function$;

COMMENT ON FUNCTION public.fn_ca_diamond_engine_of(text, text, text, text, text) IS
  'Classifies a diamond journal row into its earning engine for the budget ledger. Prefix branches come first; keep every one of them when redefining (the ca_daily_bonus: prefix files the Daily Club Arena Bonus under club_arena_daily).';

-- The engine observes the same per-user daily ceiling as the bonus itself.
INSERT INTO public.diamond_engine_daily_caps (engine, max_per_user_per_day, max_per_user_per_day_vip, note, updated_at)
VALUES ('club_arena_daily', 110, 150, 'Daily Club Arena Bonus: the bonus already counts toward the platform daily cap (20260907234848)', now())
ON CONFLICT (engine) DO NOTHING;

-- Re-file the rows that were journaled while the prefix was missing.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT t.user_id, t.amount,
               to_char((t.created_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM') AS period,
               (t.created_at AT TIME ZONE 'America/Chicago')::date AS day
          FROM public.diamond_transactions t
         WHERE t.reference_id LIKE 'ca_daily_bonus:%'
           AND t.issuance_class = 'promotional'
           AND NOT public.fn_ca_is_fixture_account(t.user_id)
    LOOP
        UPDATE public.diamond_reward_budgets
           SET spent_diamonds = GREATEST(0, spent_diamonds - r.amount), updated_at = now()
         WHERE engine = 'catalog_v2' AND period = r.period;

        INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds, updated_at)
        VALUES (r.period, 'club_arena_daily', 9223372036854775807, r.amount, now())
        ON CONFLICT (period, engine) DO UPDATE
           SET spent_diamonds = diamond_reward_budgets.spent_diamonds + EXCLUDED.spent_diamonds,
               updated_at = now();

        UPDATE public.diamond_user_daily_awards
           SET awarded = GREATEST(0, awarded - r.amount), updated_at = now()
         WHERE user_id = r.user_id AND engine = 'catalog_v2' AND day = r.day;

        INSERT INTO public.diamond_user_daily_awards (user_id, engine, day, awarded, updated_at)
        VALUES (r.user_id, 'club_arena_daily', r.day, r.amount, now())
        ON CONFLICT (user_id, engine, day) DO UPDATE
           SET awarded = diamond_user_daily_awards.awarded + EXCLUDED.awarded, updated_at = now();
    END LOOP;
END $$;