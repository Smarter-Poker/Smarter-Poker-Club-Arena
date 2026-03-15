-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: handle_new_user() must also insert into public.users
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Problem: club_members.user_id has FK to public.users, but handle_new_user()
-- only creates profiles and diamond_wallets. New signups can't join clubs.
--
-- Fix: Add public.users insert to the trigger + backfill existing auth.users.
--
-- Created: 2026-03-15
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Update the trigger function to also insert into public.users
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    -- Create public.users entry (required for club_members FK)
    INSERT INTO users (id, username, email)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'username', 'Player_' || substring(NEW.id::text from 1 for 8)),
        NEW.email
    )
    ON CONFLICT (id) DO NOTHING;

    -- Create profile if not exists (minimal fields only)
    INSERT INTO profiles (id, username, display_name)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'username', 'Player_' || substring(NEW.id::text from 1 for 8)),
        COALESCE(NEW.raw_user_meta_data->>'display_name', 'New Player')
    )
    ON CONFLICT (id) DO NOTHING;

    -- Create diamond wallet with starting balance
    INSERT INTO diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (NEW.id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Backfill: insert any auth.users missing from public.users
INSERT INTO users (id, username, email)
SELECT
    au.id,
    COALESCE(au.raw_user_meta_data->>'username', 'Player_' || substring(au.id::text from 1 for 8)),
    au.email
FROM auth.users au
WHERE NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = au.id
)
ON CONFLICT (id) DO NOTHING;
