-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503072235 "harden_signup_2026_05_03"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 45d399d3dee522851ee64edb01d4c0fe of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- HARDEN SIGNUP — 2026-05-03
-- ─────────────────────────────────────────────────────────────────────────
-- Background: zero successful signups Apr 24 → May 3. Root cause was an edge
-- middleware misconfig (separately fixed in geo-blocks.json), but the trigger
-- chain on auth.users had latent issues that would have masked future
-- regressions:
--
--   1. handle_new_user issued CREATE SEQUENCE inside a SECURITY DEFINER
--      function. The sequence already exists at last_value=897788, so the
--      block was dead code that just added privilege risk and a race window.
--
--   2. All three on-signup triggers swallowed errors with `EXCEPTION WHEN
--      OTHERS THEN RAISE WARNING; RETURN NEW`. RAISE WARNING never persists
--      to a queryable surface — failures were invisible.
--
-- This migration:
--   A) Creates public.signup_errors as a queryable error trail
--   B) Rewrites all three trigger functions to dual-write to signup_errors
--      on failure (still non-blocking — auth.users insert always succeeds)
--   C) Removes the CREATE SEQUENCE block from handle_new_user
--   D) Adds public.signup_health_view for the /api/health/signup probe
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A) Error trail table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signup_errors (
  id           bigserial PRIMARY KEY,
  user_id      uuid,
  email        text,
  trigger_name text NOT NULL,
  error_code   text,
  error_msg    text,
  raw_meta     jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_errors_occurred_at_idx
  ON public.signup_errors (occurred_at DESC);
CREATE INDEX IF NOT EXISTS signup_errors_user_id_idx
  ON public.signup_errors (user_id);
CREATE INDEX IF NOT EXISTS signup_errors_trigger_idx
  ON public.signup_errors (trigger_name, occurred_at DESC);

-- Lock down — only service_role reads this. Auth users have no business here.
ALTER TABLE public.signup_errors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signup_errors_service_only ON public.signup_errors;
CREATE POLICY signup_errors_service_only
  ON public.signup_errors
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.signup_errors IS
  'Append-only trail of trigger errors during auth.users INSERT. Triggers swallow exceptions to keep signup unblocked, but log here for forensics. Drained by /api/health/signup-errors and queried by the health-monitor cron.';

-- ── B) Pre-create the player number sequence (was inside trigger) ─────────
-- Already exists at last_value=897788; this is just a hygiene pass.
CREATE SEQUENCE IF NOT EXISTS public.profiles_player_number_seq
  START WITH 1260
  OWNED BY public.profiles.player_number;

-- ── C) Rewrite handle_new_user — no DDL, structured logging ───────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    next_player_num BIGINT;
    generated_username TEXT;
    resolved_full_name TEXT;
    v_first_name TEXT;
    v_last_name TEXT;
BEGIN
    resolved_full_name := COALESCE(
        NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
        NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'name', '')), ''),
        NULLIF(TRIM(
            COALESCE(NEW.raw_user_meta_data->>'given_name', '') || ' ' ||
            COALESCE(NEW.raw_user_meta_data->>'family_name', '')
        ), ''),
        ''
    );

    v_first_name := COALESCE(NEW.raw_user_meta_data->>'first_name', '');
    v_last_name := COALESCE(NEW.raw_user_meta_data->>'last_name', '');

    IF v_first_name = '' AND v_last_name = '' AND resolved_full_name != '' THEN
        v_first_name := split_part(resolved_full_name, ' ', 1);
        v_last_name := CASE
            WHEN position(' ' in resolved_full_name) > 0
            THEN substring(resolved_full_name from position(' ' in resolved_full_name) + 1)
            ELSE ''
        END;
    END IF;

    generated_username := COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'poker_alias', ''),
        NULLIF(REGEXP_REPLACE(resolved_full_name, '[^a-zA-Z0-9]', '', 'g'), ''),
        SPLIT_PART(COALESCE(NEW.email, ''), '@', 1),
        'Player' || FLOOR(RANDOM() * 10000)::TEXT
    );
    generated_username := LEFT(generated_username, 15);

    -- Sequence is now guaranteed to exist (created above as a regular DDL,
    -- not inside this function). nextval() is the only privileged call left.
    SELECT nextval('public.profiles_player_number_seq') INTO next_player_num;

    INSERT INTO public.profiles (
        id, full_name, first_name, last_name, email, username, avatar_url,
        player_number, streak_count, diamonds, diamond_multiplier, skill_tier,
        access_tier, is_vip, vip_tier, vip_expires_at,
        created_at, updated_at, last_login, last_active, is_online
    ) VALUES (
        NEW.id, resolved_full_name, v_first_name, v_last_name,
        COALESCE(NEW.email, ''), generated_username,
        COALESCE(NEW.raw_user_meta_data->>'avatar_url',
                 NEW.raw_user_meta_data->>'picture', ''),
        next_player_num, 0, 500, 1.0, 'Newcomer',
        CASE
            WHEN NEW.raw_user_meta_data->>'state' IN ('WA','ID','MI','NV','CA') THEN 'Restricted_Tier'
            ELSE 'Full_Access'
        END,
        true, 'monthly', NOW() + INTERVAL '30 days',
        NOW(), NOW(), NOW(), NOW(), true
    )
    ON CONFLICT (id) DO UPDATE SET
        last_login = NOW(),
        last_active = NOW(),
        is_online = true,
        full_name = CASE WHEN COALESCE(profiles.full_name, '') = '' THEN EXCLUDED.full_name ELSE profiles.full_name END,
        first_name = CASE WHEN COALESCE(profiles.first_name, '') = '' THEN EXCLUDED.first_name ELSE profiles.first_name END,
        last_name = CASE WHEN COALESCE(profiles.last_name, '') = '' THEN EXCLUDED.last_name ELSE profiles.last_name END,
        avatar_url = CASE WHEN COALESCE(profiles.avatar_url, '') = '' THEN EXCLUDED.avatar_url ELSE profiles.avatar_url END,
        player_number = COALESCE(profiles.player_number, EXCLUDED.player_number),
        diamonds = CASE WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500 ELSE profiles.diamonds END,
        is_vip = CASE WHEN profiles.is_vip IS NULL OR profiles.is_vip = false THEN true ELSE profiles.is_vip END,
        vip_tier = CASE WHEN profiles.vip_tier IS NULL THEN 'monthly' ELSE profiles.vip_tier END,
        vip_expires_at = CASE WHEN profiles.vip_expires_at IS NULL THEN NOW() + INTERVAL '30 days' ELSE profiles.vip_expires_at END;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Defensive: never block auth.users INSERT, but DO leave a forensic trail.
    BEGIN
      INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg, raw_meta)
      VALUES (NEW.id, NEW.email, 'handle_new_user', SQLSTATE, SQLERRM, NEW.raw_user_meta_data);
    EXCEPTION WHEN OTHERS THEN NULL; -- never let logging itself break signup
    END;
    RETURN NEW;
END;
$function$;

-- ── Wallet trigger — same pattern ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user_v2_create_wallet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.wallets (user_id, wallet_type, balance, locked_balance)
  VALUES (NEW.id, 'PLAYER', 0, 0)
  ON CONFLICT (user_id, wallet_type) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg)
    VALUES (NEW.id, NEW.email, 'handle_new_user_v2_create_wallet', SQLSTATE, SQLERRM);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END;
$function$;

-- ── Diamonds + streaks trigger — same pattern ─────────────────────────────
CREATE OR REPLACE FUNCTION public.initialize_user_diamonds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned)
    VALUES (NEW.id, 100, 100)
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.user_daily_streaks (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg)
      VALUES (NEW.id, NEW.email, 'initialize_user_diamonds', SQLSTATE, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NEW;
END;
$function$;

-- ── D) Health view for the synthetic probe ────────────────────────────────
CREATE OR REPLACE VIEW public.signup_health_view AS
SELECT
  (SELECT count(*) FROM auth.users WHERE created_at > now() - interval '15 minutes') AS new_users_15m,
  (SELECT count(*) FROM auth.users WHERE created_at > now() - interval '1 hour')     AS new_users_1h,
  (SELECT count(*) FROM auth.users WHERE created_at > now() - interval '24 hours')   AS new_users_24h,
  (SELECT count(*) FROM public.signup_errors WHERE occurred_at > now() - interval '1 hour') AS errors_1h,
  (SELECT count(*) FROM public.signup_errors WHERE occurred_at > now() - interval '24 hours') AS errors_24h,
  (SELECT max(created_at) FROM auth.users) AS last_signup_at,
  (SELECT max(occurred_at) FROM public.signup_errors) AS last_error_at;

COMMENT ON VIEW public.signup_health_view IS
  'Single-row view powering /api/health/signup. If new_users_24h=0 page on call.';

GRANT SELECT ON public.signup_health_view TO service_role;
