-- ═══════════════════════════════════════════════════════════════════════
-- 20260822030000_union_level_spin_reserve_wallet.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        3   (moves real balances between pools; changes money routing)
-- AUTHOR:      Claude (Cowork) for Dan
-- AFFECTS:     tables: spin_bonus_pools (+owner_kind, rows MERGED),
--                      spin_reserve_ledger (kind CHECK widened),
--                      union_wallets (+spin_reserve_wallet),
--                      union_wallet_transactions (wallet CHECK widened)
--              rpcs:   fn_spin_reserve_owner (new), fn_spin_reserve_pool (new),
--                      fn_spin_reserve_wallet_fund (new),
--                      fn_spin_reserve_state, fn_spin_reserve_seed,
--                      fn_spin_reserve_seed_from_union,
--                      fn_spin_draw_multiplier, fn_spin_settle_game
--              views:  v_spin_tier_availability, v_spin_reserve_health
-- IRREVERSIBLE: NO for schema; the pool MERGE is reversible only from the
--               'merge' ledger rows this migration writes. See ROLLBACK.
--
-- WHY:
--   Dan, verbatim: "THE RESERVE POOL COMES FROM THE UNION NOT THE CLUBS. IT
--   ONLY COMES FROM THE CLUBS IF THEY ARE A STAND ALONE CLUB WITH NO UNION
--   AFFILIATION. AND YOU NEED TO CREATE THE WALLET TO HOLD THE SEEDED AND
--   RESERVE FUNDS."
--
--   Half of that shipped on 2026-08-20: fn_spin_reserve_seed_from_union debits
--   a union wallet to fund a pool. The other half did not. The POOL is still
--   keyed by club_id, so a union with three clubs runs three unrelated
--   reserves, and there is no wallet of its own — the seeder borrows
--   promo_wallet, which is money earmarked for promotions.
--
--   Production immediately before this migration:
--     Midway Union  balance 10,746.40  seeded 10,000  1,455 spins
--     Club JAQK     balance  5,000.00  seeded  5,000      0 spins
--     SHARK CLUB    balance  5,000.00  seeded  5,000      0 spins
--
--   Three pools is not a smaller version of one pool, it is a worse one. The
--   reserve exists because a 100x is paid out of accumulated volume;
--   splitting the same capital three ways means each fragment clears the 100x
--   threshold at a third the rate, so the top tier stays locked for everyone
--   while the union collectively holds plenty. Pooling is the product.
--
-- HOW:
--   - fn_spin_reserve_owner(club) is the ONE place that answers "whose
--     reserve pays for this game": the club's union if it has one, otherwise
--     the club itself. Every RPC resolves through it, so a standalone club is
--     handled by the same code path with no special case and no second set of
--     rules (Dan chose: standalone behaviour identical to today).
--   - spin_bonus_pools.club_id keeps its name and its UNIQUE index but now
--     holds the OWNER id. In this schema a union already IS a clubs row
--     (clubs.is_union = true, same uuid as unions.id), so union-owned rows
--     need no new key type and every existing join still resolves.
--     owner_kind records which it is, for readers.
--   - union_wallets.spin_reserve_wallet is the wallet Dan asked for. It holds
--     operator capital earmarked for the reserve, it is a valid funding
--     source for a seed, and it is where surplus above the ceiling now goes.
--     Today surplus_return simply decremented the pool and named no
--     destination — the money left the ledger and landed nowhere.
--   - The engine is UNCHANGED. Every RPC keeps its exact signature and still
--     takes the playing club's id; resolution happens inside the database.
--     That is deliberate: the smallest possible change surface on a money
--     path, and no cached client can fall out of contract with it.
--
--   NOT changed: rake_records is still written with the PLAYING club's id.
--   Rake belongs to the club that generated it and flows to the union through
--   the existing settlement path. Only the RESERVE is pooled.
--
-- DAN'S DECISIONS (2026-08-21):
--   - The two 5,000 club seeds MERGE into the union pool (20,746.40 total).
--   - The union ceiling rises 20,000 -> 30,000 so the merge does not
--     immediately trip a surplus return.
--   - Standalone clubs behave exactly as they do today.
--
-- See .agent/workflows/migration-safety.md for the full protocol.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. PRE-FLIGHT ASSERTIONS ─────────────────────────────────────────
DO $preflight$
DECLARE v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY[
    'spin_bonus_pools','spin_reserve_ledger','union_wallets',
    'union_wallet_transactions','clubs','unions','rake_records'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = v_t
    ) THEN
      RAISE EXCEPTION 'pre-flight failed: public.% not found', v_t;
    END IF;
  END LOOP;

  -- The whole design rests on a union being addressable as a clubs row.
  -- If that ever stops being true, club_id can no longer hold an owner id
  -- and this migration must be rewritten rather than re-run.
  IF EXISTS (SELECT 1 FROM public.unions u
             WHERE NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = u.id)) THEN
    RAISE EXCEPTION
      'pre-flight failed: a union exists with no matching clubs row — spin_bonus_pools.club_id cannot address it';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='clubs' AND column_name='union_id'
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: clubs.union_id not found — ownership cannot be resolved';
  END IF;
END $preflight$;

-- ─── 2. OWNERSHIP ─────────────────────────────────────────────────────

-- The single answer to "whose reserve pays for this game".
--
-- A club affiliated to a union draws on the union's reserve. A club with no
-- union affiliation draws on its own. There is no third case, and no caller
-- is allowed to decide this for itself — that is how three pools happened.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_owner(p_club_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    (SELECT c.union_id FROM public.clubs c WHERE c.id = p_club_id),
    p_club_id
  );
$$;

COMMENT ON FUNCTION public.fn_spin_reserve_owner(uuid) IS
  'Resolves a playing club to the entity whose Spin reserve pool funds its prizes: the union if affiliated, otherwise the club itself. Added 2026-08-22 — the reserve is a union-level pool per Dan, and clubs only hold their own when standalone.';

-- Resolve AND guarantee the pool row exists. Every RPC below calls exactly
-- this, so "which pool" is decided in one place and cannot drift.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_pool(p_club_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_owner uuid;
BEGIN
  v_owner := public.fn_spin_reserve_owner(p_club_id);

  INSERT INTO public.spin_bonus_pools (club_id, owner_kind)
  VALUES (v_owner,
          CASE WHEN EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_owner)
               THEN 'union' ELSE 'club' END)
  ON CONFLICT (club_id) DO NOTHING;

  RETURN v_owner;
END; $$;

-- ─── 3. SCHEMA ────────────────────────────────────────────────────────

ALTER TABLE public.spin_bonus_pools
  ADD COLUMN IF NOT EXISTS owner_kind text NOT NULL DEFAULT 'club';

DO $ownerkind$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'spin_bonus_pools_owner_kind_check') THEN
    ALTER TABLE public.spin_bonus_pools
      ADD CONSTRAINT spin_bonus_pools_owner_kind_check
      CHECK (owner_kind IN ('union','club'));
  END IF;
END $ownerkind$;

COMMENT ON COLUMN public.spin_bonus_pools.club_id IS
  'The OWNER of this reserve, not necessarily a playing club. A union owns one pool shared by all its clubs; a standalone club owns its own. Resolve with fn_spin_reserve_owner(). Named club_id for history — a union is itself a clubs row in this schema.';
COMMENT ON COLUMN public.spin_bonus_pools.owner_kind IS
  'union | club — which kind of entity club_id points at.';

-- The wallet Dan asked for.
ALTER TABLE public.union_wallets
  ADD COLUMN IF NOT EXISTS spin_reserve_wallet numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.union_wallets.spin_reserve_wallet IS
  'Operator capital earmarked for the Spin Reserve Pool: undeployed seed money in, surplus above the pool ceiling back out. Never sourced from player funds. The DEPLOYED reserve is spin_bonus_pools.balance — this wallet holds only what is NOT currently in the pool, so the two never double-count.';

-- Widen the wallet discriminator so reserve movements can be booked.
DO $walletcheck$
DECLARE v_con text;
BEGIN
  SELECT conname INTO v_con FROM pg_constraint
   WHERE conrelid = 'public.union_wallet_transactions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%wallet%ANY%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.union_wallet_transactions DROP CONSTRAINT %I', v_con);
  END IF;
  ALTER TABLE public.union_wallet_transactions
    ADD CONSTRAINT union_wallet_transactions_wallet_check
    CHECK (wallet IN ('chip_balance','rake_wallet','bbj_wallet','promo_wallet',
                      'insurance_wallet','spin_reserve_wallet'));
END $walletcheck$;

-- Widen the ledger kinds. 'merge' and 'wallet_return' are DISTINCT kinds on
-- purpose: v_spin_reserve_health counts kind='adjustment' as shortfall events
-- and the spin-sweep cron alerts on any non-zero count, so booking a pool
-- merge as an adjustment would page someone about a shortfall that never
-- happened.
DO $kindcheck$
DECLARE v_con text;
BEGIN
  SELECT conname INTO v_con FROM pg_constraint
   WHERE conrelid = 'public.spin_reserve_ledger'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%kind%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.spin_reserve_ledger DROP CONSTRAINT %I', v_con);
  END IF;
  ALTER TABLE public.spin_reserve_ledger
    ADD CONSTRAINT spin_reserve_ledger_kind_check
    CHECK (kind IN ('seed','contribution','jackpot_draw','surplus_return',
                    'adjustment','merge','wallet_return'));
END $kindcheck$;

-- ─── 4. THE MERGE ─────────────────────────────────────────────────────
--
-- Every pool whose owner is not itself is folded into its owner's pool and
-- removed. Written generically rather than against the three known uuids, so
-- a club that joins a union later is handled by re-running this block.
--
-- Historical ledger rows keep their ORIGINAL club_id. History is not
-- rewritten; the views below resolve through fn_spin_reserve_owner so those
-- rows still count toward the pool that absorbed them.
DO $merge$
DECLARE
  v_ids uuid[]; v_id uuid;
  r public.spin_bonus_pools%ROWTYPE;
  v_owner uuid; v_after numeric;
  v_moved integer := 0; v_total numeric := 0;
BEGIN
  -- Snapshot the ids first, then act on one row at a time. Deleting the row a
  -- FOR UPDATE cursor is currently positioned on is asking for trouble; the
  -- per-row lock below gives the same safety without iterating over a table
  -- that is being deleted from.
  SELECT array_agg(p.club_id ORDER BY p.club_id) INTO v_ids
    FROM public.spin_bonus_pools p
   WHERE public.fn_spin_reserve_owner(p.club_id) <> p.club_id;

  FOREACH v_id IN ARRAY COALESCE(v_ids, ARRAY[]::uuid[]) LOOP
    SELECT * INTO r FROM public.spin_bonus_pools
     WHERE club_id = v_id FOR UPDATE;
    CONTINUE WHEN r.club_id IS NULL;

    v_owner := public.fn_spin_reserve_owner(r.club_id);

    INSERT INTO public.spin_bonus_pools (club_id, owner_kind)
    VALUES (v_owner,
            CASE WHEN EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_owner)
                 THEN 'union' ELSE 'club' END)
    ON CONFLICT (club_id) DO NOTHING;

    -- Out of the club pool, to zero.
    INSERT INTO public.spin_reserve_ledger
      (club_id, kind, amount, balance_after, note)
    VALUES (r.club_id, 'merge', -r.balance, 0,
            format('pool merged into union reserve %s (seeded %s, deposited %s, drawn %s, %s spins)',
                   v_owner, r.seeded_amount, r.total_deposited, r.total_drawn, r.spin_count));

    -- Into the owner pool. Counters add so the merged pool's lifetime
    -- statistics stay true; highest_stake takes the max because the pool must
    -- be able to pay at the biggest table it now backs anywhere.
    UPDATE public.spin_bonus_pools o
       SET balance          = o.balance          + r.balance,
           seeded_amount    = o.seeded_amount    + r.seeded_amount,
           total_deposited  = o.total_deposited  + r.total_deposited,
           total_drawn      = o.total_drawn      + r.total_drawn,
           surplus_returned = o.surplus_returned + r.surplus_returned,
           spin_count       = o.spin_count       + r.spin_count,
           bonus_count      = o.bonus_count      + r.bonus_count,
           highest_stake    = GREATEST(o.highest_stake, r.highest_stake),
           updated_at       = now()
     WHERE o.club_id = v_owner
     RETURNING o.balance INTO v_after;

    INSERT INTO public.spin_reserve_ledger
      (club_id, kind, amount, balance_after, note)
    VALUES (v_owner, 'merge', r.balance, v_after,
            format('absorbed club pool %s', r.club_id));

    DELETE FROM public.spin_bonus_pools WHERE club_id = r.club_id;

    v_moved := v_moved + 1;
    v_total := v_total + r.balance;
  END LOOP;

  RAISE NOTICE 'merged % club pool(s), % moved into union reserves', v_moved, v_total;
END $merge$;

UPDATE public.spin_bonus_pools
   SET owner_kind = CASE WHEN EXISTS (SELECT 1 FROM public.unions u WHERE u.id = club_id)
                         THEN 'union' ELSE 'club' END,
       updated_at = now();

-- Dan's call: the ceiling rises with the pooled capital so the merge does not
-- immediately hand the excess straight back as surplus.
UPDATE public.spin_bonus_pools
   SET ceiling_amount = 30000, updated_at = now()
 WHERE owner_kind = 'union' AND ceiling_amount > 0 AND ceiling_amount < 30000;

-- The reserve wallet exists for every union from here on.
INSERT INTO public.union_wallets (union_id)
SELECT u.id FROM public.unions u
 WHERE NOT EXISTS (SELECT 1 FROM public.union_wallets w WHERE w.union_id = u.id);

-- ─── 5. THE RPCs ──────────────────────────────────────────────────────
-- Signatures are IDENTICAL to what the engine calls today. Only the pool
-- they resolve to has changed.

CREATE OR REPLACE FUNCTION public.fn_spin_reserve_state(p_club_id uuid)
RETURNS TABLE(balance numeric, seeded_amount numeric, ceiling_amount numeric,
              highest_stake numeric, total_deposited numeric, total_drawn numeric,
              spin_count integer, bonus_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_owner uuid;
BEGIN
  v_owner := public.fn_spin_reserve_pool(p_club_id);
  RETURN QUERY
  SELECT p.balance, p.seeded_amount, p.ceiling_amount, p.highest_stake,
         p.total_deposited, p.total_drawn, p.spin_count, p.bonus_count
  FROM public.spin_bonus_pools p WHERE p.club_id = v_owner;
END; $$;

CREATE OR REPLACE FUNCTION public.fn_spin_reserve_seed(
  p_club_id uuid, p_amount numeric,
  p_highest_stake numeric DEFAULT NULL, p_ceiling numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_bal numeric; v_owner uuid;
BEGIN
  IF COALESCE(p_amount,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  UPDATE public.spin_bonus_pools
     SET balance        = balance + p_amount,
         seeded_amount  = seeded_amount + p_amount,
         highest_stake  = COALESCE(p_highest_stake, highest_stake),
         ceiling_amount = COALESCE(p_ceiling, ceiling_amount),
         updated_at     = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_owner, 'seed', p_amount, v_bal,
          CASE WHEN v_owner = p_club_id THEN 'operator seed'
               ELSE format('operator seed (requested for club %s)', p_club_id) END);

  RETURN jsonb_build_object('ok', true, 'balance', v_bal,
                            'owner_id', v_owner, 'pooled', v_owner <> p_club_id);
END; $$;

-- Funded seed. Now defaults to the dedicated reserve wallet as its source,
-- and credits the OWNER's pool.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_seed_from_union(
  p_union_id uuid, p_club_id uuid, p_amount numeric,
  p_highest_stake numeric DEFAULT NULL, p_ceiling numeric DEFAULT NULL,
  p_wallet text DEFAULT 'spin_reserve_wallet',
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_key text := COALESCE(p_idempotency_key,
                  'spinseed:' || p_union_id::text || ':' || p_club_id::text);
  v_bal numeric; v_after numeric; v_pool jsonb; v_owner uuid;
BEGIN
  IF COALESCE(p_amount,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF p_wallet NOT IN ('spin_reserve_wallet','promo_wallet','rake_wallet','chip_balance') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsupported_wallet');
  END IF;

  -- The union being debited must be the one that actually owns this club's
  -- reserve. Without this a union could seed a pool it does not fund.
  v_owner := public.fn_spin_reserve_owner(p_club_id);
  IF v_owner <> p_union_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_does_not_own_this_reserve',
      'owner_id', v_owner);
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_wallet_transactions
             WHERE union_id = p_union_id AND tx_type = 'spin_reserve_seed'
               AND notes LIKE '%' || v_key || '%') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_seeded');
  END IF;

  EXECUTE format('SELECT %I FROM public.union_wallets WHERE union_id = $1 FOR UPDATE', p_wallet)
    INTO v_bal USING p_union_id;

  IF v_bal IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_wallet_not_found');
  END IF;
  IF v_bal < p_amount THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_union_funds',
      'wallet', p_wallet, 'available', v_bal, 'requested', p_amount);
  END IF;

  EXECUTE format(
    'UPDATE public.union_wallets SET %I = %I - $1, updated_at = now()
      WHERE union_id = $2 RETURNING %I', p_wallet, p_wallet, p_wallet)
    INTO v_after USING p_amount, p_union_id;

  INSERT INTO public.union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
  VALUES (p_union_id, p_wallet, 'debit', p_amount, v_after, 'spin_reserve_seed',
          p_club_id,
          format('Spin Reserve Pool seed (operator capital, not player funds) [%s]', v_key));

  v_pool := public.fn_spin_reserve_seed(p_club_id, p_amount, p_highest_stake, p_ceiling);

  RETURN jsonb_build_object('ok', true, 'wallet', p_wallet,
    'debited', p_amount, 'union_balance_after', v_after,
    'owner_id', v_owner, 'pool_balance', v_pool->'balance');
END; $$;

-- Put operator capital INTO the reserve wallet. Without this the wallet can
-- only ever be spent down. p_from_wallet moves money between union wallets;
-- omitting it books an external operator deposit.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_wallet_fund(
  p_union_id uuid, p_amount numeric,
  p_from_wallet text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_from numeric; v_after numeric; v_res numeric;
BEGIN
  IF COALESCE(p_amount,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;

  -- NOT ON CONFLICT: union_wallets carries no advertised unique constraint on
  -- union_id, and an ON CONFLICT naming a column without one is a runtime
  -- error rather than a no-op.
  INSERT INTO public.union_wallets (union_id)
  SELECT p_union_id
   WHERE NOT EXISTS (SELECT 1 FROM public.union_wallets w WHERE w.union_id = p_union_id);

  IF p_from_wallet IS NOT NULL THEN
    IF p_from_wallet NOT IN ('promo_wallet','rake_wallet','chip_balance') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'unsupported_source_wallet');
    END IF;
    EXECUTE format('SELECT %I FROM public.union_wallets WHERE union_id = $1 FOR UPDATE', p_from_wallet)
      INTO v_from USING p_union_id;
    IF COALESCE(v_from,0) < p_amount THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_union_funds',
        'wallet', p_from_wallet, 'available', COALESCE(v_from,0), 'requested', p_amount);
    END IF;
    EXECUTE format(
      'UPDATE public.union_wallets SET %I = %I - $1, updated_at = now()
        WHERE union_id = $2 RETURNING %I', p_from_wallet, p_from_wallet, p_from_wallet)
      INTO v_after USING p_amount, p_union_id;
    INSERT INTO public.union_wallet_transactions
      (union_id, wallet, direction, amount, balance_after, tx_type, notes)
    VALUES (p_union_id, p_from_wallet, 'debit', p_amount, v_after,
            'spin_reserve_wallet_fund',
            COALESCE(p_note, 'moved to the Spin reserve wallet'));
  END IF;

  UPDATE public.union_wallets
     SET spin_reserve_wallet = spin_reserve_wallet + p_amount, updated_at = now()
   WHERE union_id = p_union_id RETURNING spin_reserve_wallet INTO v_res;

  INSERT INTO public.union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, notes)
  VALUES (p_union_id, 'spin_reserve_wallet', 'credit', p_amount, v_res,
          'spin_reserve_wallet_fund',
          COALESCE(p_note, CASE WHEN p_from_wallet IS NULL
                                THEN 'operator deposit'
                                ELSE format('from %s', p_from_wallet) END));

  RETURN jsonb_build_object('ok', true, 'spin_reserve_wallet', v_res);
END; $$;

-- THE DRAW. The affordability + threshold gate is unchanged line for line;
-- the only difference is which pool it reads.
CREATE OR REPLACE FUNCTION public.fn_spin_draw_multiplier(
  p_club_id uuid, p_buy_in numeric, p_tiers jsonb,
  p_rake_rate numeric DEFAULT 0.08, p_seats integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_bal numeric := 0; v_stake numeric := 0; v_contrib numeric := 0;
  v_eligible jsonb := '[]'::jsonb; v_tier jsonb;
  v_total numeric := 0; v_roll numeric; v_acc numeric := 0;
  v_pick numeric := NULL; v_locked jsonb := '[]'::jsonb;
  v_prize numeric; v_thr numeric; v_owner uuid;
BEGIN
  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT balance, GREATEST(highest_stake, COALESCE(p_buy_in,0))
    INTO v_bal, v_stake FROM public.spin_bonus_pools WHERE club_id = v_owner;

  -- What this game itself puts in is available to fund its own prize.
  v_contrib := round(COALESCE(p_buy_in,0) * COALESCE(p_seats,3)
                     * (1 - COALESCE(p_rake_rate,0.08)), 2);

  FOR v_tier IN SELECT * FROM jsonb_array_elements(p_tiers) LOOP
    v_prize := (v_tier->>'multiplier')::numeric * COALESCE(p_buy_in,0);
    v_thr   := COALESCE((v_tier->>'reserveThresholdX')::numeric, 0);

    IF (v_bal + v_contrib) < v_prize THEN
      -- AFFORDABILITY: cannot be paid, so must not be selectable.
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'reason', 'unaffordable',
        'unlocksAt', round(v_prize - v_contrib, 2));
    ELSIF v_thr > 0 AND v_bal < (v_tier->>'multiplier')::numeric * v_stake * v_thr THEN
      -- JACKPOT THRESHOLD: affordable, but not yet backed by the required
      -- multiple of its own prize at the biggest stake running.
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'reason', 'threshold',
        'unlocksAt', round((v_tier->>'multiplier')::numeric * v_stake * v_thr, 2));
    ELSE
      v_eligible := v_eligible || v_tier;
      v_total := v_total + COALESCE((v_tier->>'freq')::numeric, 0);
    END IF;
  END LOOP;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_eligible_tiers',
      'reserve_balance', v_bal, 'locked', v_locked, 'owner_id', v_owner);
  END IF;

  v_roll := (('x' || encode(extensions.gen_random_bytes(6),'hex'))::bit(48)::bigint)::numeric
            / 281474976710656::numeric * v_total;

  FOR v_tier IN SELECT * FROM jsonb_array_elements(v_eligible) LOOP
    v_acc := v_acc + COALESCE((v_tier->>'freq')::numeric,0);
    IF v_roll < v_acc THEN v_pick := (v_tier->>'multiplier')::numeric; EXIT; END IF;
  END LOOP;
  IF v_pick IS NULL THEN
    v_pick := (v_eligible -> (jsonb_array_length(v_eligible)-1) ->> 'multiplier')::numeric;
  END IF;

  RETURN jsonb_build_object('ok', true, 'multiplier', v_pick,
    'reserve_balance', v_bal, 'highest_stake', v_stake,
    'contribution', v_contrib, 'locked', v_locked, 'owner_id', v_owner,
    'eligible_count', jsonb_array_length(v_eligible));
END; $$;

-- SETTLEMENT.
--   rake_records still takes p_club_id — the club that ran the game earns the
--   rake and settles it to its union normally. Only the reserve is pooled.
--   Surplus above the ceiling now lands in the union's reserve wallet instead
--   of leaving the ledger with no destination at all.
CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(
  p_tournament_id uuid, p_club_id uuid, p_buy_in numeric,
  p_seats integer, p_multiplier numeric, p_rake_rate numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_ceiling numeric; v_return numeric := 0;
  v_available numeric; v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_wallet_after numeric := NULL;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled');
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT ceiling_amount, balance INTO v_ceiling, v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- Money in.
  UPDATE public.spin_bonus_pools
     SET balance = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count = spin_count + 1,
         highest_stake = GREATEST(highest_stake, p_buy_in),
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_available;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_available,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_owner = p_club_id THEN 'buy-ins less fixed rake'
               ELSE format('buy-ins less fixed rake (club %s)', p_club_id) END);

  -- Money out. The draw gate should make a shortfall impossible, but if one
  -- occurs anyway the pool goes to exactly zero and the operator-covered
  -- remainder is RECORDED. Players are paid either way, so aborting would
  -- only delete the evidence.
  IF v_prize > v_available THEN
    v_shortfall := round(v_prize - v_available, 2);
    v_drawn := v_available;
  ELSE
    v_drawn := v_prize;
  END IF;

  UPDATE public.spin_bonus_pools
     SET balance = balance - v_drawn,
         total_drawn = total_drawn + v_drawn,
         bonus_count = bonus_count + CASE WHEN p_multiplier >= 10 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'jackpot_draw', -v_drawn, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_shortfall > 0
               THEN format('prize pool (pool covered %s of %s)', v_drawn, v_prize)
               ELSE 'prize pool' END);

  IF v_shortfall > 0 THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, note)
    VALUES (v_owner, p_tournament_id, 'adjustment', 0, v_bal,
            p_multiplier, p_buy_in, p_seats,
            format('SHORTFALL %s covered by operator — pool was too thin for a %sx. Seed it.',
                   v_shortfall, p_multiplier));
  END IF;

  -- Rake belongs to the PLAYING club, not the pool owner.
  IF v_rake > 0 AND p_club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, p_club_id, v_rake, v_collected, p_seats, 0, true,
            p_tournament_id, 'fn_spin_settle_game',
            jsonb_build_object('kind','spin_rake','multiplier',p_multiplier,
                               'buy_in',p_buy_in,'rake_rate',p_rake_rate,
                               'shortfall',v_shortfall,'reserve_owner',v_owner));
  END IF;

  -- Surplus above the ceiling returns to the union's reserve wallet, where it
  -- can be re-deployed. For a standalone club there is no union wallet, so it
  -- behaves exactly as before: it leaves the pool and is recorded as returned
  -- to the operator.
  IF v_ceiling > 0 AND v_bal > v_ceiling THEN
    v_return := round(v_bal - v_ceiling, 2);
    UPDATE public.spin_bonus_pools
       SET balance = balance - v_return,
           surplus_returned = surplus_returned + v_return,
           updated_at = now()
     WHERE club_id = v_owner RETURNING balance INTO v_bal;

    UPDATE public.union_wallets
       SET spin_reserve_wallet = spin_reserve_wallet + v_return, updated_at = now()
     WHERE union_id = v_owner RETURNING spin_reserve_wallet INTO v_wallet_after;

    IF v_wallet_after IS NOT NULL THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
      VALUES (v_owner, 'spin_reserve_wallet', 'credit', v_return, v_wallet_after,
              'spin_reserve_surplus', p_club_id,
              'Spin reserve above ceiling returned to the union reserve wallet');
    END IF;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, note)
    VALUES (v_owner, p_tournament_id,
            CASE WHEN v_wallet_after IS NOT NULL THEN 'wallet_return' ELSE 'surplus_return' END,
            -v_return, v_bal,
            CASE WHEN v_wallet_after IS NOT NULL
                 THEN 'balance above ceiling returned to the union reserve wallet'
                 ELSE 'balance above ceiling returned to operator' END);
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'surplus_returned', v_return,
    'owner_id', v_owner, 'reserve_wallet', v_wallet_after);
END; $$;

-- ─── 6. VIEWS ─────────────────────────────────────────────────────────

-- One row per CLUB, resolved to the pool that actually backs it. Keyed by
-- club so a lobby asking about an affiliated club still gets an answer after
-- the merge — the 2026-08-21 can_draw_500x incident was exactly this failure
-- mode: a deployed client selecting something that had quietly stopped
-- existing, and a hook that swallowed the error.
DROP VIEW IF EXISTS public.v_spin_tier_availability;
CREATE VIEW public.v_spin_tier_availability AS
  SELECT c.id AS club_id,
         (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x
    FROM public.clubs c
    JOIN public.spin_bonus_pools p
      ON p.club_id = public.fn_spin_reserve_owner(c.id);

COMMENT ON VIEW public.v_spin_tier_availability IS
  'Public, balance-hiding availability of the top spin tier (100x). One boolean per CLUB, computed against the reserve that backs it — the union pool if affiliated, its own if standalone. Nothing here lets a reader recover the reserve balance.';

REVOKE ALL ON public.v_spin_tier_availability FROM PUBLIC;
GRANT SELECT ON public.v_spin_tier_availability TO anon, authenticated, service_role;

-- Operator health. The column set is UNCHANGED on purpose: World Hub
-- pages/api/cron/spin-sweep.js selects can_draw_500x, and that reader deploys
-- separately. Retiring the 500x columns is a two-step (ship the reader, then
-- drop) and is deliberately NOT done here.
DROP VIEW IF EXISTS public.v_spin_reserve_health;
CREATE VIEW public.v_spin_reserve_health AS
  SELECT p.club_id,
         COALESCE(c.name, u.name) AS club_name,
         p.balance, p.seeded_amount, p.highest_stake, p.ceiling_amount,
         p.spin_count, p.total_deposited, p.total_drawn,
         round(p.highest_stake * 500::numeric, 2) AS top_jackpot,
         round(p.highest_stake * 500::numeric * 2.0, 2) AS need_for_500x,
         round(p.highest_stake * 100::numeric * 1.5, 2) AS need_for_100x,
         (p.balance >= p.highest_stake * 500::numeric * 2.0) AS can_draw_500x,
         (p.balance >= p.highest_stake * 100::numeric * 1.5) AS can_draw_100x,
         (p.balance < p.highest_stake * 10::numeric) AS is_thin,
         -- Resolved through ownership so a merged club's history still counts
         -- toward the pool that absorbed it.
         (SELECT count(*) FROM public.spin_reserve_ledger l
           WHERE public.fn_spin_reserve_owner(l.club_id) = p.club_id
             AND l.kind = 'adjustment') AS shortfall_events,
         (SELECT count(*) FROM public.tournaments t
           WHERE public.fn_spin_reserve_owner(t.club_id) = p.club_id
             AND t.variant = 'spin'
             AND t.status = ANY (ARRAY['RUNNING','COMPLETED'])
             AND COALESCE(t.buy_in_fee, 0::numeric) = 0::numeric
             AND t.started_at > now() - '24:00:00'::interval
             AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l2
                              WHERE l2.tournament_id = t.id)) AS unbooked_24h
    FROM public.spin_bonus_pools p
    LEFT JOIN public.clubs c ON c.id = p.club_id
    LEFT JOIN public.unions u ON u.id = p.club_id;

REVOKE ALL ON public.v_spin_reserve_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_spin_reserve_health TO service_role;

-- ─── 7. GRANTS ────────────────────────────────────────────────────────
-- fn_spin_reserve_owner is the ONE exception, and it must be. A function
-- invoked inside a view has its EXECUTE privilege checked against the CALLING
-- role, not the view's owner, so revoking it from anon would make every
-- v_spin_tier_availability read fail — which is precisely the dark-badge
-- outage this view exists to prevent. It is safe to grant: it maps a club to
-- its union, and clubs.union_id is already readable by anon. It reveals
-- nothing about any balance.
REVOKE ALL ON FUNCTION public.fn_spin_reserve_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_spin_reserve_owner(uuid) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_pool(uuid)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_reserve_state(uuid)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_reserve_seed(uuid, numeric, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_reserve_seed_from_union(uuid, uuid, numeric, numeric, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_reserve_wallet_fund(uuid, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_draw_multiplier(uuid, numeric, jsonb, numeric, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric)
  FROM PUBLIC, anon, authenticated;

COMMIT;

-- ─── 8. POST-APPLY ASSERTIONS ─────────────────────────────────────────
-- Run these and confirm 0 surprises before declaring done.
--
--   -- No pool owned by an affiliated club:
--   SELECT count(*) FROM spin_bonus_pools p
--    WHERE fn_spin_reserve_owner(p.club_id) <> p.club_id;            -- 0
--
--   -- Every club resolves to a pool that exists:
--   SELECT count(*) FROM clubs c
--    WHERE NOT EXISTS (SELECT 1 FROM spin_bonus_pools p
--                       WHERE p.club_id = fn_spin_reserve_owner(c.id));  -- 0
--
--   -- Every club still gets a tier-availability row (the 500x lesson):
--   SELECT (SELECT count(*) FROM clubs) = (SELECT count(*) FROM v_spin_tier_availability);
--                                                                    -- true
--
--   -- Money conserved by the merge:
--   SELECT sum(balance) FROM spin_bonus_pools;                       -- 20746.40
--
--   -- The merge booked both sides and nets to zero:
--   SELECT count(*), sum(amount) FROM spin_reserve_ledger WHERE kind='merge';
--                                                                    -- 4, 0.00
--
--   -- The wallet exists for every union:
--   SELECT count(*) FROM unions u
--    WHERE NOT EXISTS (SELECT 1 FROM union_wallets w WHERE w.union_id=u.id);  -- 0
--
--   -- No money function reachable by anon. fn_spin_reserve_owner is the one
--   -- permitted exception (see the grants section for why) — it moves no
--   -- money and exposes no balance:
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND p.proname LIKE 'fn_spin_%'
--      AND p.proname <> 'fn_spin_reserve_owner'
--      AND has_function_privilege('anon', p.oid, 'EXECUTE');          -- 0 rows
--
--   -- And anon CAN read the badge view:
--   SET ROLE anon; SELECT count(*) FROM v_spin_tier_availability; RESET ROLE;
--
-- ─── 9. ROLLBACK (Tier 3 — pasted, as required) ────────────────────────
--   -- RPC bodies: re-apply 20260820_spin_reserve_pool.sql then
--   -- 20260820_spin_reserve_affordability_gate.sql, in that order. Both are
--   -- CREATE OR REPLACE throughout and restore the club-keyed versions.
--
--   -- Then un-merge, from the ledger rows this migration wrote:
--   DO $$
--   DECLARE r record; v_owner uuid;
--   BEGIN
--     FOR r IN SELECT club_id, -amount AS amt, note FROM spin_reserve_ledger
--               WHERE kind='merge' AND amount < 0 LOOP
--       v_owner := (regexp_match(r.note, 'union reserve ([0-9a-f-]{36})'))[1]::uuid;
--       INSERT INTO spin_bonus_pools (club_id, balance) VALUES (r.club_id, r.amt)
--         ON CONFLICT (club_id) DO UPDATE SET balance = spin_bonus_pools.balance + r.amt;
--       UPDATE spin_bonus_pools SET balance = balance - r.amt WHERE club_id = v_owner;
--     END LOOP;
--   END $$;
--
--   ALTER TABLE spin_bonus_pools DROP COLUMN IF EXISTS owner_kind;
--   ALTER TABLE union_wallets    DROP COLUMN IF EXISTS spin_reserve_wallet;
--   DROP FUNCTION IF EXISTS public.fn_spin_reserve_wallet_fund(uuid,numeric,text,text);
--   DROP FUNCTION IF EXISTS public.fn_spin_reserve_pool(uuid);
--   DROP FUNCTION IF EXISTS public.fn_spin_reserve_owner(uuid);
--
--   -- KNOWN GAP: balances are restored by the block above; the lifetime
--   -- counters (seeded_amount, total_deposited, total_drawn, spin_count)
--   -- absorbed by the merge are NOT unwound. Reconstruct them from the
--   -- 'merge' ledger notes, which record each pool's figures at merge time.
-- ═══════════════════════════════════════════════════════════════════════
