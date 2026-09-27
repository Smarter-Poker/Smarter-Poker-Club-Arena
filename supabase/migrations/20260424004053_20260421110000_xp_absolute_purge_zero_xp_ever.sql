-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424004053 "20260421110000_xp_absolute_purge_zero_xp_ever"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9e22839b06bb817024600e48e69240a7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════
-- XP ABSOLUTE PURGE — ZERO XP ANYWHERE EVER
-- ═══════════════════════════════════════════════════════════════
-- Per CEO directive: XP is completely removed from the platform.
-- Drops: 19 XP functions, 5 XP triggers, 16 XP columns across 14
-- tables, 1 XP table (xp_logs), 1 view recreated, 4 non-XP-named
-- functions scrubbed. Stubs preserved for signatures apps may still
-- call so they no-op rather than 42883.

-- ═══ Step 1: Drop XP triggers ═══════════════════════════════════
DROP TRIGGER IF EXISTS trg_award_xp_on_post     ON public.social_posts;
DROP TRIGGER IF EXISTS trg_reward_xp_on_post    ON public.social_posts;
DROP TRIGGER IF EXISTS trig_comment_xp          ON public.social_comments;
DROP TRIGGER IF EXISTS trig_reaction_xp         ON public.social_interactions;
DROP TRIGGER IF EXISTS trigger_xp_immutability  ON public.user_progress;

-- ═══ Step 2: Drop view that depends on xp columns ═══════════════
DROP VIEW IF EXISTS public.club_memberships CASCADE;

-- ═══ Step 3: Drop XP columns across all tables ═══════════════════
ALTER TABLE public.bot_profiles               DROP COLUMN IF EXISTS xp_total              CASCADE;
ALTER TABLE public.club_members               DROP COLUMN IF EXISTS xp                    CASCADE;
ALTER TABLE public.club_members               DROP COLUMN IF EXISTS reputation_xp         CASCADE;
ALTER TABLE public.player_wallets             DROP COLUMN IF EXISTS xp                    CASCADE;
ALTER TABLE public.profiles                   DROP COLUMN IF EXISTS xp                    CASCADE;
ALTER TABLE public.profiles                   DROP COLUMN IF EXISTS xp_total              CASCADE;
ALTER TABLE public.training_achievements      DROP COLUMN IF EXISTS xp_reward             CASCADE;
ALTER TABLE public.training_daily_challenges  DROP COLUMN IF EXISTS bonus_xp_multiplier   CASCADE;
ALTER TABLE public.training_leaderboard       DROP COLUMN IF EXISTS total_xp              CASCADE;
ALTER TABLE public.training_level_history     DROP COLUMN IF EXISTS xp_earned             CASCADE;
ALTER TABLE public.training_progress          DROP COLUMN IF EXISTS xp                    CASCADE;
ALTER TABLE public.trivia_scores              DROP COLUMN IF EXISTS xp_earned             CASCADE;
ALTER TABLE public.trivia_streaks             DROP COLUMN IF EXISTS total_xp_earned       CASCADE;
ALTER TABLE public.user_progress              DROP COLUMN IF EXISTS xp                    CASCADE;

-- ═══ Step 4: Drop xp_logs table ══════════════════════════════════
DROP TABLE IF EXISTS public.xp_logs CASCADE;

-- ═══ Step 5: Recreate club_memberships view WITHOUT xp columns ══
CREATE OR REPLACE VIEW public.club_memberships AS
  SELECT
    club_id, user_id, role, agent_id, joined_at, parent_agent_id,
    invited_by, notes, last_active_at, created_at, updated_at,
    is_bot, status, chip_balance, diamonds, is_active,
    orange_ball_status, rank_level, credit_limit, credit_used,
    nickname, last_active, tier, trust_score, sessions_played
  FROM club_members;

-- ═══ Step 6: Drop XP protection/trigger functions ═══════════════
DROP FUNCTION IF EXISTS public.enforce_xp_immutability()     CASCADE;
DROP FUNCTION IF EXISTS public.fn_prevent_xp_deletion()      CASCADE;
DROP FUNCTION IF EXISTS public.fn_prevent_xp_modification()  CASCADE;
DROP FUNCTION IF EXISTS public.protect_xp()                  CASCADE;
DROP FUNCTION IF EXISTS public.prevent_xp_loss()             CASCADE;
DROP FUNCTION IF EXISTS public.law_xp_permanence()           CASCADE;
DROP FUNCTION IF EXISTS public.fn_award_xp_on_social_post()  CASCADE;
DROP FUNCTION IF EXISTS public.fn_reward_xp_on_social_post() CASCADE;
DROP FUNCTION IF EXISTS public.fn_trigger_post_xp()          CASCADE;
DROP FUNCTION IF EXISTS public.fn_trigger_comment_xp()       CASCADE;
DROP FUNCTION IF EXISTS public.fn_trigger_reaction_xp()      CASCADE;

-- ═══ Step 7: Stub app-callable XP write APIs ═══════════════════
CREATE OR REPLACE FUNCTION public.add_xp(p_user_id uuid, p_amount integer)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.add_xp(uuid,integer) IS 'XP REMOVED: no-op stub.';

CREATE OR REPLACE FUNCTION public.fn_add_xp(p_user_id uuid, p_amount integer)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.fn_add_xp(uuid,integer) IS 'XP REMOVED: no-op stub.';

CREATE OR REPLACE FUNCTION public.fn_award_xp(
  p_user_id uuid, p_amount integer, p_source text,
  p_multiplier numeric DEFAULT 1.0,
  p_context    jsonb   DEFAULT '{}'::jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN NULL; END; $f$;
COMMENT ON FUNCTION public.fn_award_xp(uuid,integer,text,numeric,jsonb) IS 'XP REMOVED: no-op stub.';

CREATE OR REPLACE FUNCTION public.fn_award_social_xp(
  p_user_id uuid, p_action_type text, p_reference_id uuid DEFAULT NULL::uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.fn_award_social_xp(uuid,text,uuid) IS 'XP REMOVED: no-op stub.';

-- add_player_xp returns integer (not void) — match that
CREATE OR REPLACE FUNCTION public.add_player_xp(
  p_user_id uuid, p_amount integer, p_reason text DEFAULT NULL::text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN 0; END; $f$;
COMMENT ON FUNCTION public.add_player_xp(uuid,integer,text) IS 'XP REMOVED: returns 0.';

-- ═══ Step 8: Stub XP read APIs to always return 0 ══════════════
CREATE OR REPLACE FUNCTION public.fn_get_user_xp(p_user_id uuid)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN 0; END; $f$;
COMMENT ON FUNCTION public.fn_get_user_xp(uuid) IS 'XP REMOVED: always returns 0.';

CREATE OR REPLACE FUNCTION public.get_user_total_xp(p_user_id uuid)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN 0; END; $f$;
COMMENT ON FUNCTION public.get_user_total_xp(uuid) IS 'XP REMOVED: always returns 0.';

-- ═══ Step 9: Neuter level-calc helpers ═════════════════════════
CREATE OR REPLACE FUNCTION public.fn_calculate_level(p_xp integer)
 RETURNS integer LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $f$
BEGIN
  -- XP REMOVED: level derivation from XP is no longer meaningful.
  RETURN 1;
END;
$f$;

CREATE OR REPLACE FUNCTION public.get_user_level_stats(p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $f$
BEGIN
  RETURN jsonb_build_object(
    'xp',           0,
    'level',        1,
    'xp_to_next',   0,
    'progress_pct', 0
  );
END;
$f$;

-- ═══ Step 10: Scrub XP from create_bot_player ══════════════════
CREATE OR REPLACE FUNCTION public.create_bot_player(
  p_username text, p_display_name text DEFAULT NULL::text
)
 RETURNS bigint
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $f$
DECLARE
    v_bot_number bigint;
    v_bot_id     uuid;
BEGIN
    SELECT NEXTVAL('bot_number_seq') INTO v_bot_number;
    v_bot_id := gen_random_uuid();

    -- XP REMOVED: xp_total column dropped from profiles.
    INSERT INTO profiles (
        id, player_number, username, full_name,
        skill_tier, access_tier, diamonds, created_at
    ) VALUES (
        v_bot_id, v_bot_number, p_username,
        COALESCE(p_display_name, p_username),
        'Horse', 'Bot_System', 0, NOW()
    );

    RETURN v_bot_number;
END;
$f$;
