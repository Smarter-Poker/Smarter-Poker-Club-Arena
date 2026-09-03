-- ═══════════════════════════════════════════════════════════════════════════════
-- Round 35 — Auth + identity flow E2E.
--
-- The handle_new_user trigger created a public.profiles row but never created
-- a public.wallets row. Result:
--   * 414 of 422 real users had no PLAYER wallet
--   * 12 auth.users had no profile at all (pre-trigger users)
--   * atomic_table_buyin would fail "Insufficient balance" for all 414
--     because UPDATE wallets WHERE user_id=X AND wallet_type='PLAYER'
--     returns 0 rows and v_new_balance becomes NULL.
--
-- Fix in two parts:
--   (a) NEW trigger handle_new_user_v2_create_wallet that fires AFTER INSERT
--       on auth.users and idempotently creates a PLAYER wallet at balance=0.
--       SECURITY DEFINER lets it bypass the wallet guard (Phase 4.1.6a).
--   (b) Backfill: 12 missing profiles + 414 missing wallets.
--
-- Post-state verified: 1008/1008 auth users have profiles + PLAYER wallets.
--
-- BUSINESS and PROMO wallets intentionally NOT created on signup —
-- they're created on demand by WalletService.ensureWalletsExist when a
-- feature first requests them, to avoid burning rows for users who never
-- need them.
-- ═══════════════════════════════════════════════════════════════════════════════

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
  RAISE WARNING '[handle_new_user_v2_create_wallet] Wallet creation failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created_wallet ON auth.users;
CREATE TRIGGER on_auth_user_created_wallet
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_v2_create_wallet();

-- Backfill profiles for the 12 auth.users that have none.
INSERT INTO public.profiles (
  id, email, username, player_number, diamonds, is_vip, vip_tier, vip_expires_at,
  created_at, updated_at, last_login, last_active, is_online,
  streak_count, diamond_multiplier, skill_tier, access_tier
)
SELECT
  u.id,
  COALESCE(u.email, ''),
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

-- Backfill PLAYER wallets for every real user without one.
INSERT INTO public.wallets (user_id, wallet_type, balance, locked_balance)
SELECT p.id, 'PLAYER', 0, 0
FROM public.profiles p
LEFT JOIN public.wallets w
  ON w.user_id = p.id AND w.wallet_type = 'PLAYER'
WHERE COALESCE(p.is_horse, false) = false
  AND w.user_id IS NULL
ON CONFLICT (user_id, wallet_type) DO NOTHING;
