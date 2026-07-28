-- 20260724e_credit_player_wallet_idempotency.sql
-- TOURNEY-AUDIT 2026-07-24 [money] P0-1: credit_player_wallet was a bare,
-- non-idempotent `balance += amount`, but is called inside 3x-retry loops for
-- tournament PRIZES (GameServer.ts) and BOUNTIES (creditBountyToWallet). A
-- committed-but-timed-out RPC -> loop retries -> player credited 2-3x (chip
-- mint). Fix: make the credit idempotent, backward-compatibly, via an optional
-- p_idempotency_key. Applied to the live DB via apply_migration; this file keeps
-- source in sync.

-- 1. Dedup table for idempotent wallet credits.
CREATE TABLE IF NOT EXISTS public.wallet_credit_idempotency (
  key        text PRIMARY KEY,
  user_id    uuid,
  amount     numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wallet_credit_idempotency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_credit_idempotency FROM PUBLIC;
GRANT SELECT, INSERT ON public.wallet_credit_idempotency TO service_role;

-- 2. Replace credit_player_wallet with a backward-compatible idempotent version.
--    Drop the old 2-arg signature and create a 3-arg version whose new param has
--    DEFAULT NULL, so EVERY existing caller (2 named args, key omitted) resolves
--    to this function with p_idempotency_key = NULL and behaves EXACTLY as before.
--    NOTE: the function name is unchanged, so the guard_wallet_balance_write
--    trigger whitelist (regex 'function (public\.)?credit_player_wallet\(')
--    still permits the internal wallets UPDATE.
DROP FUNCTION IF EXISTS public.credit_player_wallet(uuid, numeric);

CREATE OR REPLACE FUNCTION public.credit_player_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer;
BEGIN
    -- Idempotency gate: only engaged when a key is supplied. The first caller
    -- for a given key wins the INSERT; any later call with the same key finds
    -- ROW_COUNT = 0 and returns without crediting. This neutralises the
    -- committed-but-timed-out RPC retry double-credit (tournament prizes/bounties).
    -- If the credit below fails, the whole function transaction (incl. this
    -- INSERT) rolls back, so a genuine retry is still allowed.
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
            RETURN;  -- already credited under this key: idempotent no-op
        END IF;
    END IF;

    -- Original behaviour, unchanged.
    UPDATE wallets SET balance = balance + p_amount, updated_at = NOW()
      WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    IF NOT FOUND THEN
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
        VALUES (p_user_id, 'PLAYER', p_amount, 0, NOW(), NOW());
    END IF;
END;
$function$;

-- 3. Preserve original ownership + grants exactly (postgres + service_role only).
--    (Supabase default-privileges re-grant EXECUTE to anon/authenticated on new
--    public functions; revoke them so this money RPC stays service_role-only.)
ALTER FUNCTION public.credit_player_wallet(uuid, numeric, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.credit_player_wallet(uuid, numeric, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_player_wallet(uuid, numeric, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_player_wallet(uuid, numeric, text) TO postgres, service_role;
