-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820193700 "spin_reserve_seed_from_union"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 16443c61e5c0996674e06e153b668229 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260820_spin_reserve_seed_from_union.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2   (new RPC; moves money between two internal ledgers)
-- AUTHOR:      Claude (Cowork) for Dan
-- AFFECTS:     rpcs: fn_spin_reserve_seed_from_union
--              reads/writes: union_wallets, union_wallet_transactions,
--                            spin_bonus_pools, spin_reserve_ledger
-- IRREVERSIBLE: no  (reversal path documented at the bottom)
--
-- WHY:
--   The Spin Reserve Pool must be seeded with OPERATOR money before 100x and
--   500x become eligible to be drawn. Dan: "GO AHEAD AND SEED IT FROM THE
--   MIDWAY UNION BANK." The seed is explicitly not taken from player
--   contributions, so it comes from a union wallet.
--
--   Doing it as a loose UPDATE would leave the union side unbooked, which is
--   the exact class of defect this whole Spin workstream exists to fix
--   (.agent/audits/2026-08-20-spins-economics-research.md). Both sides get a
--   ledger row or neither does.
--
-- HOW:
--   - Debits the named union wallet, defaulting to promo_wallet: a jackpot
--     pool is a player-facing promotional guarantee, which is what that
--     wallet is for. rake_wallet is deliberately NOT the default — that money
--     is owed to clubs at settlement.
--   - Writes union_wallet_transactions (debit) and spin_reserve_ledger (seed).
--   - Refuses to overdraw, and is idempotent per (union, club, idempotency key)
--     so a retry cannot double-seed.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_spin_reserve_seed_from_union(
  p_union_id uuid,
  p_club_id uuid,
  p_amount numeric,
  p_highest_stake numeric,
  p_ceiling numeric,
  p_wallet text DEFAULT 'promo_wallet',
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_key text := COALESCE(p_idempotency_key,
                  'spinseed:' || p_union_id::text || ':' || p_club_id::text);
  v_bal numeric; v_after numeric; v_pool jsonb;
BEGIN
  IF COALESCE(p_amount,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF p_wallet NOT IN ('promo_wallet','rake_wallet','chip_balance') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsupported_wallet');
  END IF;

  -- Idempotent: a retry must never double-seed.
  IF EXISTS (SELECT 1 FROM public.union_wallet_transactions
             WHERE union_id = p_union_id AND tx_type = 'spin_reserve_seed'
               AND notes LIKE '%' || v_key || '%') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_seeded');
  END IF;

  -- Lock the union wallet and check funds BEFORE touching the pool.
  EXECUTE format('SELECT %I FROM public.union_wallets WHERE union_id = $1 FOR UPDATE', p_wallet)
    INTO v_bal USING p_union_id;

  IF v_bal IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_wallet_not_found');
  END IF;
  IF v_bal < p_amount THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_union_funds',
      'available', v_bal, 'requested', p_amount);
  END IF;

  EXECUTE format(
    'UPDATE public.union_wallets SET %I = %I - $1, updated_at = now()
      WHERE union_id = $2 RETURNING %I', p_wallet, p_wallet, p_wallet)
    INTO v_after USING p_amount, p_union_id;

  INSERT INTO public.union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
  VALUES (p_union_id, p_wallet, 'debit', p_amount, v_after, 'spin_reserve_seed',
          p_club_id,
          format('Spin Reserve Pool seed for club %s (operator capital, not player funds) [%s]',
                 p_club_id, v_key));

  -- Credit the pool through the existing seeder so its own ledger row is written.
  v_pool := public.fn_spin_reserve_seed(p_club_id, p_amount, p_highest_stake, p_ceiling);

  RETURN jsonb_build_object('ok', true, 'wallet', p_wallet,
    'debited', p_amount, 'union_balance_after', v_after,
    'pool_balance', v_pool->'balance');
END; $fn$;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_seed_from_union(uuid,uuid,numeric,numeric,numeric,text,text)
  FROM PUBLIC, anon, authenticated;

-- ─── REVERSAL (if ever needed) ────────────────────────────────────────
--   UPDATE union_wallets SET promo_wallet = promo_wallet + <amt> WHERE union_id = ...;
--   UPDATE spin_bonus_pools SET balance = balance - <amt>, seeded_amount = seeded_amount - <amt>
--    WHERE club_id = ...;
--   DELETE FROM union_wallet_transactions WHERE tx_type='spin_reserve_seed' AND ...;
--   DELETE FROM spin_reserve_ledger WHERE kind='seed' AND club_id = ...;
-- ═══════════════════════════════════════════════════════════════════════
