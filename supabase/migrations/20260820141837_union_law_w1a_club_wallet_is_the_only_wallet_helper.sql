-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820141837 "union_law_w1a_club_wallet_is_the_only_wallet_helper"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d24edc1cb533ed493068ac6ad2d9e7de of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- W1a — THE CLUB WALLET IS THE ONLY WALLET (2026-08-20)
--
-- Owner's rule: "There is NEVER a global wallet except inside smarter.poker.
-- The Club Arena is its own standalone wallet. Every single club a player joins
-- creates a new, standalone wallet for that club specifically. They are never
-- joined, combined, or have access to each other, ever."
--
-- Every Club Arena money path I hardened previously still carried a
-- global-wallet FALLBACK for the transition. Those fallbacks are now the bug:
-- they are the only remaining way club money can leak into a shared pot.
--
-- Replacement rule, applied from here down:
--   * A club wallet IS the club_members row for (user, club). Joining a club
--     creates it; it is never merged with any other club's wallet.
--   * If the wallet row is missing when money must land, it is CREATED —
--     never redirected to a global wallet, so chips can never be stranded.
--   * If no club can be resolved for a Club Arena operation, the operation
--     FAILS LOUDLY instead of silently using a shared wallet.
--
-- fn_pay_player_chips is the shared credit helper; making it strict fixes
-- rakeback, agent settlement and every future payout in one place.
-- ============================================================================

-- Ensure a standalone wallet exists for this (player, club). ----------------
CREATE OR REPLACE FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user_id IS NULL OR p_club_id IS NULL THEN RETURN false; END IF;

  INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at,
                            created_at, updated_at, status, is_active)
  VALUES (p_club_id, p_user_id, 'player', 0, NOW(), NOW(), NOW(), 'active', true)
  ON CONFLICT (club_id, user_id) DO NOTHING;

  RETURN true;
END $function$;

-- Strict credit helper: club wallet only, never the global wallet. ----------
CREATE OR REPLACE FUNCTION public.fn_pay_player_chips(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_club_hint uuid DEFAULT NULL, p_related_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid; v_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('paid', false, 'reason', 'non_positive');
  END IF;

  v_club := public.fn_player_home_club(p_user_id, p_club_hint);

  IF v_club IS NULL THEN
    -- CLUB ARENA RULE: there is no shared wallet to fall back to.
    RAISE EXCEPTION 'no club wallet resolves for player % — Club Arena money cannot be paid to a global wallet', p_user_id
      USING HINT = 'Pass an explicit club, or ensure the player holds a club membership.';
  END IF;

  -- A club a player belongs to always has its own wallet; create if absent
  -- rather than redirecting the money anywhere else.
  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);

  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_club
   RETURNING chip_balance INTO v_balance;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'club wallet for player % in club % could not be credited', p_user_id, v_club;
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
  VALUES
    (p_user_id, 'PLAYER', 'credit', p_amount, p_category,
     p_description || ' [club wallet]', p_related_id, v_balance);

  RETURN jsonb_build_object('paid', true, 'club_id', v_club,
                            'source', 'club_chips', 'balance_after', v_balance);
END $function$;

-- Home club resolution must not depend on the retired scoping flag ----------
CREATE OR REPLACE FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;

  IF p_club_hint IS NOT NULL AND EXISTS (
       SELECT 1 FROM club_members m
        WHERE m.user_id = p_user_id AND m.club_id = p_club_hint) THEN
    RETURN p_club_hint;
  END IF;

  SELECT ts.club_id INTO v_club
    FROM table_seats ts
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL AND ts.club_id IS NOT NULL
   ORDER BY ts.joined_at DESC LIMIT 1;
  IF v_club IS NOT NULL THEN RETURN v_club; END IF;

  SELECT ts.club_id INTO v_club
    FROM table_seats ts
   WHERE ts.user_id = p_user_id AND ts.club_id IS NOT NULL
   ORDER BY ts.joined_at DESC LIMIT 1;
  IF v_club IS NOT NULL THEN RETURN v_club; END IF;

  SELECT m.club_id INTO v_club
    FROM club_members m
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$;

