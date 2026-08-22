-- ============================================================================
-- Migration: the credit deduped, the LEDGER did not
-- Date:      2026-08-22
-- Tier:      2 (additive function + wrapper rewrite; no schema change, no
--               data movement, no signature change to an existing function)
-- ============================================================================
--
-- WHAT WAS WRONG
--
-- Every prize path in the engine is written as two calls:
--
--     credit_player_wallet(user, amount, key)   -- idempotent
--     log_wallet_transaction(... 'prize' ...)   -- NOT idempotent, always runs
--
-- `credit_player_wallet` dedupes correctly: it inserts the key into
-- `wallet_credit_idempotency` with ON CONFLICT DO NOTHING and RETURNs early
-- when the row already existed. That is what the 2026-07-28 "A3 FIX" bought,
-- and it works -- the chips are credited exactly once.
--
-- But it RETURNS void, so the caller cannot tell "I credited" from "someone
-- else already had". It logs either way. When the stuck-COMPLETING watchdog
-- (`recoverStuckCompletingTournaments`) races the normal finish path -- both
-- deliberately using the identical key `tourney:{id}:prize:{user}:{place}` --
-- the second call credits nothing and writes a second ledger row anyway.
--
-- So the 2026-07-28 fix did not remove the double payment; it converted a
-- double PAYMENT into a double ENTRY, silently, and nothing has looked at it
-- since. Measured 2026-08-22 over completed tournaments of the preceding two
-- days: 95 phantom prize rows, 7,446.45 chips of prize money that appears in
-- `wallet_transactions` and was never paid. Every single one is the pair
-- ("Tournament winner prize: 1st place", "Tournament prize (recovery):
-- position 1 - <name>") landing 0.06s to 0.7s apart, always place 1.
--
-- Player balances are CORRECT. What is wrong is the ledger, and the ledger is
-- what profit, rakeback and the leaderboards are computed from.
--
-- WHAT THIS DOES
--
-- Adds `fn_credit_player_wallet_once`, which is `credit_player_wallet` with
-- one difference: it RETURNS boolean -- true when THIS call performed the
-- credit, false when the key had already been used. `credit_player_wallet`
-- becomes a thin wrapper over it, so there is exactly one implementation of
-- the crediting rules and no existing caller changes behaviour.
--
-- On top of it, `fn_credit_and_log` performs both halves under that one key:
-- it credits, and it writes the ledger row ONLY if the credit was its own. The
-- engine's prize sites call that instead of the two RPCs in sequence, so the
-- entry is written by whichever path actually moved the money and by no other,
-- and a retry after a committed-but-timed-out call is a no-op for both halves
-- rather than a missing row.
--
-- ROLLBACK
--
--   DROP FUNCTION IF EXISTS public.fn_credit_player_wallet_once(uuid, numeric, text);
--   -- then re-apply the pre-existing body of credit_player_wallet from
--   -- supabase/migrations (git history) so it stops calling the dropped helper.
--   -- Dropping the helper WITHOUT restoring credit_player_wallet's own body
--   -- breaks every credit on the platform.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_credit_player_wallet_once(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer; v_tourn uuid; v_club uuid; v_balance numeric;
  v_is_tournament boolean := false; v_has_any_club boolean;
BEGIN
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        -- FALSE, not void: the caller needs to know it must NOT write a
        -- ledger row for a credit somebody else already made.
        IF v_inserted = 0 THEN RETURN false; END IF;
    END IF;

    IF p_idempotency_key IS NOT NULL AND p_idempotency_key LIKE 'tourney:%' THEN
      v_is_tournament := true;
      BEGIN
        v_tourn := (split_part(p_idempotency_key, ':', 2))::uuid;
      EXCEPTION WHEN OTHERS THEN v_tourn := NULL;
      END;
      IF v_tourn IS NOT NULL THEN
        SELECT tp.club_id INTO v_club FROM tournament_players tp
         WHERE tp.tournament_id = v_tourn AND tp.user_id = p_user_id LIMIT 1;
        IF v_club IS NULL THEN
          SELECT t.club_id INTO v_club FROM tournaments t WHERE t.id = v_tourn;
          -- a union tournament is hosted by the house club; prefer the player's
          -- own club in that union
          v_club := COALESCE(public.fn_player_home_club(p_user_id, NULL), v_club);
        END IF;
      END IF;
    END IF;

    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;

    IF v_club IS NOT NULL THEN
      -- CLUB ARENA: standalone club wallet, always.
      PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
       WHERE user_id = p_user_id AND club_id = v_club
       RETURNING chip_balance INTO v_balance;
      IF v_balance IS NOT NULL THEN RETURN true; END IF;
    END IF;

    -- Reaching here means no club wallet could be used.
    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id)
      INTO v_has_any_club;

    IF v_is_tournament OR v_has_any_club THEN
      -- This IS Club Arena money. It must never be pooled into a global wallet.
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical','credit_player_wallet',
              'Club Arena credit could not resolve a club wallet - payment refused rather than pooled',
              jsonb_build_object('user_id',p_user_id,'amount',p_amount,
                                 'idempotency_key',p_idempotency_key,'tournament_id',v_tourn));
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;

    -- SMARTER.POKER: user belongs to no club at all. The global wallet is the
    -- only wallet they have, and the rule permits it here.
    UPDATE wallets SET balance = balance + p_amount, updated_at = NOW()
      WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    IF NOT FOUND THEN
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
        VALUES (p_user_id, 'PLAYER', p_amount, 0, NOW(), NOW());
    END IF;

    RETURN true;
END;
$function$;

-- The original entry point keeps its exact name, arguments, return type and
-- privileges. It is now a wrapper, so the crediting rules live in exactly one
-- place and the two implementations cannot drift the way the three prize
-- formulas did before 2026-08-20.
CREATE OR REPLACE FUNCTION public.credit_player_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  PERFORM public.fn_credit_player_wallet_once(p_user_id, p_amount, p_idempotency_key);
END;
$function$;

-- Same grants as credit_player_wallet: the engine's service role and nobody
-- else. A player-facing role that could call this could mint chips.
REVOKE ALL ON FUNCTION public.fn_credit_player_wallet_once(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_credit_player_wallet_once(uuid, numeric, text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_credit_player_wallet_once(uuid, numeric, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_player_wallet_once(uuid, numeric, text) TO service_role;

-- ---------------------------------------------------------------------------
-- The pair, done atomically.
--
-- This, not a boolean returned to the engine, is what actually closes the
-- hole. Gating the log on a boolean in TypeScript would reintroduce the same
-- class of bug from the other side: the credit sites all sit inside 3x retry
-- loops, so a committed-but-timed-out first attempt would make the second
-- attempt see `false` and write NO ledger row at all. Doing both halves under
-- one idempotency key makes the pair exactly-once no matter how many times the
-- caller retries -- which is the property the callers already assume they have.
CREATE OR REPLACE FUNCTION public.fn_credit_and_log(
  p_user_id           uuid,
  p_amount            numeric,
  p_idempotency_key   text,
  p_category          text,
  p_description       text,
  p_related_entity_id uuid    DEFAULT NULL,
  p_wallet_type       text    DEFAULT 'PLAYER',
  p_table_id          uuid    DEFAULT NULL,
  p_hand_id           uuid    DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_credited boolean;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    -- Without a key there is nothing to make this exactly-once, and a prize
    -- path that silently degrades to at-least-once is the whole defect.
    RAISE EXCEPTION 'fn_credit_and_log requires an idempotency key';
  END IF;

  v_credited := public.fn_credit_player_wallet_once(p_user_id, p_amount, p_idempotency_key);

  IF NOT v_credited THEN
    -- Somebody already paid this exact prize. The ledger row they wrote is the
    -- only one that should exist.
    RETURN false;
  END IF;

  PERFORM public.log_wallet_transaction(
    p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description,
    p_table_id, p_hand_id, p_related_entity_id);

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid) TO service_role;

-- Post-apply assertions: the migration aborts on its own assumption violations.
DO $assert$
DECLARE v_ret text; v_sec boolean;
BEGIN
  SELECT pg_get_function_result(p.oid), p.prosecdef INTO v_ret, v_sec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_credit_player_wallet_once';
  IF v_ret IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'fn_credit_player_wallet_once must return boolean, got %', v_ret;
  END IF;
  IF v_sec THEN
    RAISE EXCEPTION 'fn_credit_player_wallet_once must NOT be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'credit_player_wallet'
       AND pg_get_function_result(p.oid) = 'void') THEN
    RAISE EXCEPTION 'credit_player_wallet changed shape - callers would break';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_credit_and_log') THEN
    RAISE EXCEPTION 'fn_credit_and_log was not created';
  END IF;

  IF has_function_privilege('anon',
       'public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_credit_and_log is reachable by a player role';
  END IF;

  IF has_function_privilege('anon',
       'public.fn_credit_player_wallet_once(uuid, numeric, text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_credit_player_wallet_once(uuid, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_credit_player_wallet_once is reachable by a player role';
  END IF;
END $assert$;
