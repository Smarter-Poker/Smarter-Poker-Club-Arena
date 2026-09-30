-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429144231 "x35_signup_trigger_creates_wallet_plus_backfill"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b32431f59f395d0deb1f0466272fa808 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 35 — Auth + identity flow E2E.
--
-- Found: handle_new_user trigger creates a public.profiles row but does
-- NOT create a public.wallets row. Result:
--   * 414 of 422 real users have no PLAYER wallet
--   * 12 auth.users have no profile at all (old users pre-trigger)
--   * atomic_table_buyin would fail "Insufficient balance" for all 414
--     because UPDATE wallets WHERE user_id=X AND wallet_type='PLAYER'
--     returns 0 rows
--
-- Fix in two parts:
--   (a) Extend handle_new_user to also INSERT a PLAYER wallet at balance 0
--       (SECURITY DEFINER bypasses the wallet guard)
--   (b) Backfill missing profiles + wallets for the 12 + 414 existing rows

-- ─── Part (a): forward-looking trigger fix ─────────────────────────────────
-- Wrap the existing handle_new_user logic with an additional wallet creation
-- step. Reuse the existing function body intact + add the INSERT at the end.

CREATE OR REPLACE FUNCTION public.handle_new_user_v2_create_wallet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Idempotent: ON CONFLICT skips if a wallet row already exists.
  -- balance=0 + locked_balance=0 is the canonical zero-state.
  -- BUSINESS and PROMO wallets are NOT created here — they're created on
  -- demand via WalletService.ensureWalletsExist when a feature first
  -- requests them, to avoid burning rows for users who never use them.
  INSERT INTO public.wallets (user_id, wallet_type, balance, locked_balance)
  VALUES (NEW.id, 'PLAYER', 0, 0)
  ON CONFLICT (user_id, wallet_type) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[handle_new_user_v2_create_wallet] Wallet creation failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created_wallet ON auth.users;
CREATE TRIGGER on_auth_user_created_wallet
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_v2_create_wallet();

-- ─── Part (b): backfill ────────────────────────────────────────────────────
-- 1. Profiles for the 12 auth.users that have none (the existing
--    handle_new_user logic with safe defaults).

INSERT INTO public.profiles (
  id, email, username, player_number, diamonds, is_vip, vip_tier, vip_expires_at,
  created_at, updated_at, last_login, last_active, is_online,
  streak_count, diamond_multiplier, skill_tier, access_tier
)
SELECT
  u.id,
  COALESCE(u.email, ''),
  -- generate a username from email or random fallback
  LEFT(
    COALESCE(
      NULLIF(SPLIT_PART(COALESCE(u.email, ''), '@', 1), ''),
      'Player' || FLOOR(RANDOM() * 10000)::TEXT
    ), 15),
  nextval('public.profiles_player_number_seq'),
  500, true, 'monthly', NOW() + INTERVAL '30 days',
  NOW(), NOW(), NOW(), NOW(), false,
  0, 1.0, 'Newcomer', 'Full_Access'
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- 2. PLAYER wallets for every real user (non-horse profile) that doesn't
--    have one. Idempotent via the unique (user_id, wallet_type) constraint.

INSERT INTO public.wallets (user_id, wallet_type, balance, locked_balance)
SELECT p.id, 'PLAYER', 0, 0
FROM public.profiles p
LEFT JOIN public.wallets w
  ON w.user_id = p.id AND w.wallet_type = 'PLAYER'
WHERE COALESCE(p.is_horse, false) = false
  AND w.user_id IS NULL
ON CONFLICT (user_id, wallet_type) DO NOTHING;
