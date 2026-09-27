-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503085330 "add_auth_integrity_audit_2026_05_03h"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c7a3f84224e5794f475c1a661a72e02e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- AUTH INTEGRITY AUDIT — find + heal orphan auth.users
-- ─────────────────────────────────────────────────────────────────────────
-- An orphan = an auth.users row that's missing one of: profile, wallet,
-- user_diamonds. Caused by:
--   - Trigger silently failed (and logged to signup_errors)
--   - User was inserted via direct SQL bypassing the trigger
--   - One of the post-signup steps in the client never completed
--
-- This RPC distinguishes REAL users from system/test users:
--   - email LIKE '%@hydra.bot'           → horse-game NPC
--   - email LIKE '%@example.invalid'     → reserved test domain (RFC)
--   - email LIKE '%@example.com'         → reserved test domain (RFC)
--   - email LIKE 'probe-%@probe.smarter.poker' → our health probes
--   - email LIKE 'horse_%@'              → game NPC convention
--
-- Returns counts for both buckets so we can alert ONLY on real orphans.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_system_user(email text) RETURNS boolean
 LANGUAGE sql IMMUTABLE
AS $$
  SELECT email IS NULL
      OR email LIKE '%@hydra.bot'
      OR email LIKE '%@probe.smarter.poker'
      OR email LIKE '%@probe.smarter.local'
      OR email LIKE '%.invalid'
      OR email LIKE '%@example.com'
      OR email LIKE '%@example.org'
      OR email LIKE '%@example.net'
      OR email LIKE '%@test.local'
      OR email LIKE 'horse_%@%'
      OR email LIKE 'samson-%@%';
$$;

CREATE OR REPLACE FUNCTION public.audit_auth_integrity()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    real_no_profile  int := 0;
    real_no_wallet   int := 0;
    real_no_diamonds int := 0;
    sys_no_profile   int := 0;
    sys_no_wallet    int := 0;
    sys_no_diamonds  int := 0;
    total_users      int := 0;
BEGIN
    SELECT count(*) INTO total_users FROM auth.users WHERE deleted_at IS NULL;

    SELECT
        count(*) FILTER (WHERE NOT public.is_system_user(u.email) AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)),
        count(*) FILTER (WHERE NOT public.is_system_user(u.email) AND NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = u.id AND w.wallet_type = 'PLAYER')),
        count(*) FILTER (WHERE NOT public.is_system_user(u.email) AND NOT EXISTS (SELECT 1 FROM public.user_diamonds d WHERE d.user_id = u.id)),
        count(*) FILTER (WHERE public.is_system_user(u.email) AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)),
        count(*) FILTER (WHERE public.is_system_user(u.email) AND NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = u.id AND w.wallet_type = 'PLAYER')),
        count(*) FILTER (WHERE public.is_system_user(u.email) AND NOT EXISTS (SELECT 1 FROM public.user_diamonds d WHERE d.user_id = u.id))
    INTO real_no_profile, real_no_wallet, real_no_diamonds,
         sys_no_profile,  sys_no_wallet,  sys_no_diamonds
    FROM auth.users u
    WHERE u.deleted_at IS NULL;

    RETURN jsonb_build_object(
        'total_users', total_users,
        'real_orphans', jsonb_build_object(
            'no_profile',  real_no_profile,
            'no_wallet',   real_no_wallet,
            'no_diamonds', real_no_diamonds
        ),
        'system_orphans', jsonb_build_object(
            'no_profile',  sys_no_profile,
            'no_wallet',   sys_no_wallet,
            'no_diamonds', sys_no_diamonds
        ),
        'audited_at', now()
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.audit_auth_integrity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_auth_integrity() TO service_role;

-- ── HEAL function — backfills missing rows for REAL users only ──────────
CREATE OR REPLACE FUNCTION public.heal_auth_integrity()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
    healed_profiles  int := 0;
    healed_wallets   int := 0;
    healed_diamonds  int := 0;
BEGIN
    -- Heal missing profiles (real users only)
    WITH inserted AS (
        INSERT INTO public.profiles (
            id, email, username, player_number, diamonds, diamond_multiplier,
            streak_count, skill_tier, access_tier, is_vip, vip_tier, vip_expires_at,
            created_at, updated_at, last_login, last_active
        )
        SELECT
            u.id,
            u.email,
            COALESCE(u.raw_user_meta_data->>'poker_alias',
                     SPLIT_PART(u.email, '@', 1),
                     'Player' || nextval('public.profiles_player_number_seq')),
            nextval('public.profiles_player_number_seq'),
            500, 1.0, 0, 'Newcomer', 'Full_Access', true, 'monthly',
            NOW() + INTERVAL '30 days',
            COALESCE(u.created_at, NOW()),
            NOW(), NOW(), NOW()
        FROM auth.users u
        WHERE u.deleted_at IS NULL
          AND NOT public.is_system_user(u.email)
          AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
        ON CONFLICT (id) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO healed_profiles FROM inserted;

    -- Heal missing PLAYER wallets
    WITH inserted AS (
        INSERT INTO public.wallets (user_id, wallet_type, balance, locked_balance)
        SELECT u.id, 'PLAYER', 0, 0
        FROM auth.users u
        WHERE u.deleted_at IS NULL
          AND NOT public.is_system_user(u.email)
          AND NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = u.id AND w.wallet_type = 'PLAYER')
        ON CONFLICT (user_id, wallet_type) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO healed_wallets FROM inserted;

    -- Heal missing user_diamonds
    WITH inserted AS (
        INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned)
        SELECT u.id, 100, 100
        FROM auth.users u
        WHERE u.deleted_at IS NULL
          AND NOT public.is_system_user(u.email)
          AND NOT EXISTS (SELECT 1 FROM public.user_diamonds d WHERE d.user_id = u.id)
        ON CONFLICT (user_id) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO healed_diamonds FROM inserted;

    RETURN jsonb_build_object(
        'healed_profiles',  healed_profiles,
        'healed_wallets',   healed_wallets,
        'healed_diamonds',  healed_diamonds,
        'healed_at', now()
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.heal_auth_integrity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heal_auth_integrity() TO service_role;

COMMENT ON FUNCTION public.audit_auth_integrity() IS
  'Counts orphan auth.users by missing-table, splitting REAL users from system/test users. Used by /api/cron/auth-integrity-audit. Real orphans alert on; system orphans are noise.';
COMMENT ON FUNCTION public.heal_auth_integrity() IS
  'Backfills missing profile/wallet/user_diamonds rows for REAL orphans only. Idempotent (ON CONFLICT DO NOTHING). Run from /api/cron/auth-integrity-audit when audit detects real orphans.';
