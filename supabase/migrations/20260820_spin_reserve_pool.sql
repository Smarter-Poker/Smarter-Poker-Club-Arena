-- ═══════════════════════════════════════════════════════════════════════
-- 20260820_spin_reserve_pool.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2                    (additive: new columns, new table, new RPCs)
-- AUTHOR:      Claude (Cowork) for Dan
-- AFFECTS:     tables: spin_bonus_pools (+cols), spin_reserve_ledger (new)
--              rpcs:   fn_spin_reserve_state, fn_spin_reserve_seed,
--                      fn_spin_draw_multiplier, fn_spin_settle_game
--              rls:    both tables locked to service_role
-- IRREVERSIBLE: no
--
-- WHY:
--   Spins currently leak money invisibly. Registration adds each buy-in to
--   tournaments.prize_pool and books the entry fee to rake_records, and then
--   the engine OVERWRITES prize_pool with buy_in x multiplier. Whenever the
--   multiplier is under 3.0 -- about 93% of games -- the difference between
--   what players contributed and what the pool now holds simply stops
--   existing. No debit, no credit, no row.
--
--   Measured on production: 2,091 completed spins, 13,335.00 collected in
--   buy-ins, 11,349.00 paid out in prize pools, 825.60 booked as rake. About
--   1,160 is in no ledger at all, so clubs and unions cannot earn from it and
--   the reconciler cannot see it. Evidence and the full analysis:
--   .agent/audits/2026-08-20-spins-economics-research.md
--
--   Separately, the mechanism that was meant to fund the big multipliers was
--   designed, given this very table, and never connected: spin_bonus_pools has
--   0 rows after 2,091 spins.
--
-- HOW (high level):
--   - Extend spin_bonus_pools with the seed/ceiling/threshold state the
--     format needs. Reuses the EXISTING table rather than creating parallel
--     infrastructure (RULE 12).
--   - Add spin_reserve_ledger: one row per money movement, so every
--     contribution and every jackpot draw is auditable.
--   - fn_spin_draw_multiplier: draws ONLY from multipliers the pool can
--     currently pay. A high tier that cannot be funded is excluded from the
--     draw entirely rather than drawn and then refused -- that makes an
--     unpayable jackpot structurally impossible instead of merely unlikely.
--   - fn_spin_settle_game: books the fixed advertised rake to rake_records
--     (so clubs and unions earn from it normally) and moves the remainder
--     through the pool.
--
--   NOTHING in this migration changes an existing money path on its own. The
--   engine must call the new RPCs for any of it to take effect, which is a
--   separate, reviewable change.
--
-- See .agent/workflows/migration-safety.md for the full protocol.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. PRE-FLIGHT ASSERTIONS ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'spin_bonus_pools'
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: public.spin_bonus_pools not found — this migration extends it rather than creating a parallel pool';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'rake_records'
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: public.rake_records not found — the club/union revenue path depends on it';
  END IF;

  -- The pool is empty today. If that ever stops being true, the backfill
  -- assumptions below need revisiting before this runs.
  IF (SELECT count(*) FROM public.spin_bonus_pools) > 0 THEN
    RAISE NOTICE 'spin_bonus_pools already has rows — new columns default safely, but review before seeding';
  END IF;
END $$;

-- ─── 2. THE ACTUAL CHANGES ────────────────────────────────────────────

-- 2a. Pool state the format needs.
ALTER TABLE public.spin_bonus_pools
  ADD COLUMN IF NOT EXISTS seeded_amount    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ceiling_amount   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS highest_stake    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surplus_returned numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active        boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.spin_bonus_pools.seeded_amount IS
  'Operator money placed into the pool. Never sourced from player contributions.';
COMMENT ON COLUMN public.spin_bonus_pools.ceiling_amount IS
  'Once balance reaches this, surplus stops accruing and is returned to the operator.';
COMMENT ON COLUMN public.spin_bonus_pools.highest_stake IS
  'Largest Spin buy-in currently offered by this club. Jackpot thresholds are measured against it, so the pool must be able to pay at the biggest table open, not merely the current one.';

-- The balance must never go negative. This is the invariant the whole
-- threshold-gating design exists to protect, so it is enforced by the
-- database rather than trusted to application code.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spin_bonus_pools_balance_non_negative'
  ) THEN
    ALTER TABLE public.spin_bonus_pools
      ADD CONSTRAINT spin_bonus_pools_balance_non_negative CHECK (balance >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS spin_bonus_pools_club_uniq
  ON public.spin_bonus_pools (club_id);

-- 2b. The ledger. Every movement, one row, forever.
CREATE TABLE IF NOT EXISTS public.spin_reserve_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id        uuid NOT NULL,
  tournament_id  uuid,
  kind           text NOT NULL CHECK (kind IN (
                   'seed', 'contribution', 'jackpot_draw', 'surplus_return', 'adjustment'
                 )),
  amount         numeric NOT NULL,          -- signed: + into pool, - out of pool
  balance_after  numeric NOT NULL,
  multiplier     numeric,
  buy_in         numeric,
  seats          integer,
  house_rake     numeric,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spin_reserve_ledger_club_time
  ON public.spin_reserve_ledger (club_id, created_at DESC);
CREATE INDEX IF NOT EXISTS spin_reserve_ledger_tournament
  ON public.spin_reserve_ledger (tournament_id) WHERE tournament_id IS NOT NULL;

COMMENT ON TABLE public.spin_reserve_ledger IS
  'Audit trail for the Spin Reserve Pool. Added 2026-08-20 after production analysis found ~1,160 of Spin margin existing in no ledger at all across 2,091 games.';

-- 2c. RLS. Money tables are service_role only; players never read the pool
--     balance in real time (that is deliberate per the format spec) and
--     never write to it at all.
ALTER TABLE public.spin_reserve_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spin_bonus_pools    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS spin_reserve_ledger_service ON public.spin_reserve_ledger;
CREATE POLICY spin_reserve_ledger_service ON public.spin_reserve_ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS spin_bonus_pools_service ON public.spin_bonus_pools;
CREATE POLICY spin_bonus_pools_service ON public.spin_bonus_pools
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2d. Read the pool, creating it lazily.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_state(p_club_id uuid)
RETURNS TABLE(
  balance numeric, seeded_amount numeric, ceiling_amount numeric,
  highest_stake numeric, total_deposited numeric, total_drawn numeric,
  spin_count integer, bonus_count integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.spin_bonus_pools (club_id)
  VALUES (p_club_id)
  ON CONFLICT (club_id) DO NOTHING;

  RETURN QUERY
  SELECT p.balance, p.seeded_amount, p.ceiling_amount, p.highest_stake,
         p.total_deposited, p.total_drawn, p.spin_count, p.bonus_count
  FROM public.spin_bonus_pools p
  WHERE p.club_id = p_club_id;
END; $$;

-- 2e. Seed with operator money.
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_seed(
  p_club_id uuid, p_amount numeric, p_highest_stake numeric DEFAULT NULL,
  p_ceiling numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_bal numeric;
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;

  INSERT INTO public.spin_bonus_pools (club_id) VALUES (p_club_id)
  ON CONFLICT (club_id) DO NOTHING;

  UPDATE public.spin_bonus_pools
     SET balance        = balance + p_amount,
         seeded_amount  = seeded_amount + p_amount,
         highest_stake  = COALESCE(p_highest_stake, highest_stake),
         ceiling_amount = COALESCE(p_ceiling, ceiling_amount),
         updated_at     = now()
   WHERE club_id = p_club_id
   RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (p_club_id, 'seed', p_amount, v_bal, 'operator seed');

  RETURN jsonb_build_object('ok', true, 'balance', v_bal);
END; $$;

-- 2f. THE DRAW.
--
-- Dan's core principle: a high multiplier is not eligible to be SELECTED
-- until the pool can pay it. Excluding it from the draw -- rather than
-- drawing it and then refusing -- is what makes an unpayable jackpot
-- structurally impossible. No player is ever shown a prize that is then
-- taken away, and the balance cannot go negative because nothing that would
-- take it there can be chosen.
--
-- Tiers, frequencies and thresholds are passed in by the caller from the
-- single source of truth (src/config/spinSpec.ts), so this function never
-- becomes a fourth competing copy of the table.
CREATE OR REPLACE FUNCTION public.fn_spin_draw_multiplier(
  p_club_id uuid,
  p_buy_in numeric,
  p_tiers jsonb           -- [{multiplier, freq, reserveThresholdX}, ...]
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_bal numeric := 0; v_stake numeric := 0;
  v_eligible jsonb := '[]'::jsonb;
  v_tier jsonb; v_total numeric := 0; v_roll numeric; v_acc numeric := 0;
  v_pick numeric := NULL; v_locked jsonb := '[]'::jsonb;
BEGIN
  INSERT INTO public.spin_bonus_pools (club_id) VALUES (p_club_id)
  ON CONFLICT (club_id) DO NOTHING;

  SELECT balance, GREATEST(highest_stake, COALESCE(p_buy_in, 0))
    INTO v_bal, v_stake
    FROM public.spin_bonus_pools WHERE club_id = p_club_id;

  -- Build the eligible set.
  FOR v_tier IN SELECT * FROM jsonb_array_elements(p_tiers) LOOP
    IF COALESCE((v_tier->>'reserveThresholdX')::numeric, 0) <= 0
       OR v_bal >= (v_tier->>'multiplier')::numeric * v_stake
                   * (v_tier->>'reserveThresholdX')::numeric
    THEN
      v_eligible := v_eligible || v_tier;
      v_total := v_total + COALESCE((v_tier->>'freq')::numeric, 0);
    ELSE
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'unlocksAt', round((v_tier->>'multiplier')::numeric * v_stake
                           * (v_tier->>'reserveThresholdX')::numeric, 2));
    END IF;
  END LOOP;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_eligible_tiers');
  END IF;

  -- Crypto-grade draw over the ELIGIBLE weights. gen_random_bytes gives a
  -- uniform draw; random() is not acceptable on a path that sets a real
  -- prize. Locked tiers' probability is redistributed proportionally, which
  -- is what excluding them from the denominator already achieves.
  v_roll := (('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint)::numeric
            / 281474976710656::numeric * v_total;

  FOR v_tier IN SELECT * FROM jsonb_array_elements(v_eligible) LOOP
    v_acc := v_acc + COALESCE((v_tier->>'freq')::numeric, 0);
    IF v_roll < v_acc THEN
      v_pick := (v_tier->>'multiplier')::numeric;
      EXIT;
    END IF;
  END LOOP;

  IF v_pick IS NULL THEN
    -- Floating point landed exactly on the top edge; take the last eligible.
    v_pick := (v_eligible -> (jsonb_array_length(v_eligible) - 1) ->> 'multiplier')::numeric;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'multiplier', v_pick, 'reserve_balance', v_bal,
    'highest_stake', v_stake, 'locked', v_locked,
    'eligible_count', jsonb_array_length(v_eligible));
END; $$;

-- 2g. SETTLEMENT. One call, all four movements, atomic.
--
--   collected  = seats x buy_in            every player pays exactly buy_in
--   house_rake = rake_rate x collected     FIXED, booked every single game
--   reserve_in = collected - house_rake    everything else
--   prize_pool = buy_in x multiplier       drawn from the pool
--
-- The pool absorbs 100% of the prize variance and the house takes exactly the
-- advertised rake win or lose. E[prize] = E[multiplier] x buy_in = reserve_in
-- by construction, so the pool is net-neutral over volume and its balance is
-- a direct measure of solvency.
CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(
  p_tournament_id uuid,
  p_club_id uuid,
  p_buy_in numeric,
  p_seats integer,
  p_multiplier numeric,
  p_rake_rate numeric
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_ceiling numeric; v_return numeric := 0;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0
     OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  -- Idempotent: a re-run of the settler must not double-book.
  IF EXISTS (
    SELECT 1 FROM public.spin_reserve_ledger
    WHERE tournament_id = p_tournament_id AND kind IN ('contribution','jackpot_draw')
  ) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled');
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  INSERT INTO public.spin_bonus_pools (club_id) VALUES (p_club_id)
  ON CONFLICT (club_id) DO NOTHING;

  SELECT ceiling_amount INTO v_ceiling
    FROM public.spin_bonus_pools WHERE club_id = p_club_id FOR UPDATE;

  -- Money in, then money out. Ordered so the balance never dips below zero
  -- mid-transaction even when the prize exceeds this game's contribution --
  -- the CHECK constraint would abort the whole settlement if it did.
  UPDATE public.spin_bonus_pools
     SET balance         = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count      = spin_count + 1,
         highest_stake   = GREATEST(highest_stake, p_buy_in),
         updated_at      = now()
   WHERE club_id = p_club_id
   RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (p_club_id, p_tournament_id, 'contribution', v_reserve_in, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake, 'buy-ins less fixed rake');

  UPDATE public.spin_bonus_pools
     SET balance     = balance - v_prize,
         total_drawn = total_drawn + v_prize,
         bonus_count = bonus_count + CASE WHEN p_multiplier >= 10 THEN 1 ELSE 0 END,
         updated_at  = now()
   WHERE club_id = p_club_id
   RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (p_club_id, p_tournament_id, 'jackpot_draw', -v_prize, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake, 'prize pool');

  -- The house rake goes to rake_records, which is what actually reaches the
  -- club and its union. This row is the whole point of the migration: today
  -- this money exists nowhere.
  IF v_rake > 0 AND p_club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, p_club_id, v_rake, v_collected, p_seats, 0, true,
            p_tournament_id, 'fn_spin_settle_game',
            jsonb_build_object('kind','spin_rake','multiplier',p_multiplier,
                               'buy_in',p_buy_in,'rake_rate',p_rake_rate));
  END IF;

  -- Ceiling: money above it is returned rather than left idle forever.
  IF v_ceiling > 0 AND v_bal > v_ceiling THEN
    v_return := round(v_bal - v_ceiling, 2);
    UPDATE public.spin_bonus_pools
       SET balance = balance - v_return,
           surplus_returned = surplus_returned + v_return,
           updated_at = now()
     WHERE club_id = p_club_id
     RETURNING balance INTO v_bal;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, note)
    VALUES (p_club_id, p_tournament_id, 'surplus_return', -v_return, v_bal,
            'balance above ceiling returned to operator');
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'balance', v_bal, 'surplus_returned', v_return);
END; $$;

REVOKE ALL ON FUNCTION public.fn_spin_reserve_state(uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_reserve_seed(uuid, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_draw_multiplier(uuid, numeric, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) FROM PUBLIC, anon, authenticated;

COMMIT;

-- ─── 3. POST-APPLY ASSERTIONS ─────────────────────────────────────────
-- Run these and confirm 0 surprises before declaring done.
--
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name='spin_bonus_pools'
--      AND column_name IN ('seeded_amount','ceiling_amount','highest_stake',
--                          'surplus_returned','is_active');
--   -- expect 5
--
--   SELECT conname FROM pg_constraint
--    WHERE conname='spin_bonus_pools_balance_non_negative';
--   -- expect 1 row
--
--   SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND proname LIKE 'fn_spin_%';
--   -- expect 4
--
--   -- No money function may be reachable by anon:
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND p.proname LIKE 'fn_spin_%'
--      AND has_function_privilege('anon', p.oid, 'EXECUTE');
--   -- expect 0 rows
--
-- ─── 4. ROLLBACK (Tier 2 — additive, but provided anyway) ──────────────
--   DROP FUNCTION IF EXISTS public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric);
--   DROP FUNCTION IF EXISTS public.fn_spin_draw_multiplier(uuid,numeric,jsonb);
--   DROP FUNCTION IF EXISTS public.fn_spin_reserve_seed(uuid,numeric,numeric,numeric);
--   DROP FUNCTION IF EXISTS public.fn_spin_reserve_state(uuid);
--   DROP TABLE IF EXISTS public.spin_reserve_ledger;
--   ALTER TABLE public.spin_bonus_pools
--     DROP CONSTRAINT IF EXISTS spin_bonus_pools_balance_non_negative,
--     DROP COLUMN IF EXISTS seeded_amount,   DROP COLUMN IF EXISTS ceiling_amount,
--     DROP COLUMN IF EXISTS highest_stake,   DROP COLUMN IF EXISTS surplus_returned,
--     DROP COLUMN IF EXISTS is_active;
-- ═══════════════════════════════════════════════════════════════════════
