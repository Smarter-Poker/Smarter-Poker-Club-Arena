-- ============================================================================
-- SPIN WALLET HARDENING — reading my own feature back as an attacker
--
-- Phases 1-3 gave the Spin wallet an owner, a real seed, an owner menu and
-- per-owner boards. This is the adversarial pass over all of it. Six findings,
-- two of them already causing real damage in production.
--
-- ── 1. A MINTING FUNCTION BECAME A MINT-TO-WALLET CHANNEL (critical) ────────
--
-- fn_spin_reserve_seed credits balance AND seeded_amount and debits NOBODY.
-- Phase 1 waved that away: "it had no caller in application code, which is the
-- only reason that never mattered." That reasoning died the moment Phase 1
-- shipped, because Phase 1 made seeded_amount a REPAYABLE LOAN that pays out to
-- a real wallet. The chain is: activate normally (which records a
-- seed_source_wallet), call fn_spin_reserve_seed to inflate seeded_amount from
-- nothing, and the next qualifying settle hands that invented amount to the
-- owner's wallet as real chips.
--
-- It is still EXECUTABLE by service_role — the role every API route and the
-- engine run as. Its only legitimate caller, fn_spin_reserve_seed_from_union,
-- debits the union wallet properly first. So the credit is inlined there and
-- the bare minter is DROPPED.
--
-- ── 2. THE IDEMPOTENCY GUARD READ BEFORE IT LOCKED (high, already happened) ─
--
-- fn_spin_settle_game checked "already settled?" BEFORE taking its row lock.
-- Two concurrent settles for one tournament both passed the check, then
-- serialised on the lock and both booked. The engine retries settlement three
-- times, so a call that timed out client-side after committing reproduces it
-- exactly.
--
-- FIVE tournaments in production are double-booked, with gaps of 19ms to 1.9s
-- between the duplicate pairs — the signature of that retry loop. The pool was
-- over-credited 36.20 net (211.20 of contributions that no player paid, less
-- 175.00 of prize draws that were never awarded), spin_count over-counted by 5,
-- and rake_records carries five duplicate revenue rows.
--
-- Fixed three ways: the check now runs AFTER the lock; a partial unique index
-- makes a second booking impossible even if some future caller forgets; and
-- the five existing cases are repaired below.
--
-- ── 3. THE REPAYMENT BAR WAS OWNER-ADJUSTABLE (high) ────────────────────────
--
-- The bar was fn_spin_required_seed(offered_max_stake), read live. But
-- fn_spin_activate rewrites offered_max_stake, and deactivate/reactivate is an
-- owner-reachable path to it. Activate at stake 100 (seed 20,000), deactivate,
-- reactivate at stake 1 (bar 200) and the whole 20,000 becomes repayable after
-- 200 chips of play. Raising it instead means an outstanding seed can never be
-- repaid. The bar is now FROZEN at activation in its own column.
--
-- ── 4. REACTIVATION DOUBLE-SEEDED AND REDIRECTED THE REPAYMENT (high) ───────
--
-- Reactivating while a seed was outstanding added a second full seed and
-- OVERWROTE seed_source_wallet, so the whole accumulated amount would later be
-- repaid to whichever wallet was named last — possibly not the one that paid
-- it. Now refused unless the same wallet is used.
--
-- ── 5. A ZERO-ROW UPDATE AFTER THE WALLET MOVED REPORTED SUCCESS (medium) ───
--
-- Both money paths did `UPDATE ... RETURNING ... INTO` after moving the wallet
-- and never checked FOUND. With no pool row that debits the owner, credits
-- nothing, and returns ok:true. Now raises, so the transaction rolls back.
--
-- ── 6. A DEAD GATE (low) ───────────────────────────────────────────────────
--
-- fn_spin_owner_can_open has no callers anywhere — the engine reads the table
-- directly with the same three predicates. Two independent copies of a money
-- gate drift. Dropped, and the comment that claimed it was the reader of
-- is_active is corrected.
-- ============================================================================

-- ── The bar, frozen at the moment the seed is taken ────────────────────────
ALTER TABLE public.spin_bonus_pools
  ADD COLUMN IF NOT EXISTS required_seed_at_activation numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.spin_bonus_pools.required_seed_at_activation IS
  'The repayment bar, frozen when the seed was taken. Deliberately NOT recomputed from offered_max_stake, which the owner can change by reactivating - lowering it would repay a large seed after trivial play, raising it would strand one forever.';

COMMENT ON COLUMN public.spin_bonus_pools.is_active IS
  'Whether this owner offers Spins. Set only by fn_spin_activate / fn_spin_deactivate, and read by TournamentRecurringService.activatedSpinOwners when deciding whose boards to open.';

-- Existing pools carry a seed taken under the old rule; freeze their bar at
-- what it was computed from at the time.
UPDATE public.spin_bonus_pools
   SET required_seed_at_activation = public.fn_spin_required_seed(offered_max_stake)
 WHERE required_seed_at_activation = 0 AND offered_max_stake > 0;

-- ── 1. Kill the minter, keeping its one honest caller whole ────────────────
CREATE OR REPLACE FUNCTION public.fn_spin_reserve_seed_from_union(
  p_union_id uuid, p_club_id uuid, p_amount numeric,
  p_highest_stake numeric DEFAULT NULL, p_ceiling numeric DEFAULT NULL,
  p_wallet text DEFAULT 'spin_reserve_wallet', p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_key text := COALESCE(p_idempotency_key,
                  'spinseed:' || p_union_id::text || ':' || p_club_id::text);
  v_bal numeric; v_after numeric; v_owner uuid; v_pool_bal numeric;
BEGIN
  IF COALESCE(p_amount,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF p_wallet NOT IN ('spin_reserve_wallet','promo_wallet','rake_wallet','chip_balance') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsupported_wallet');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);
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

  -- INLINED from the dropped fn_spin_reserve_seed. The credit only ever
  -- belonged immediately after the debit above; as a separate callable
  -- function it was a mint.
  UPDATE public.spin_bonus_pools
     SET balance            = balance + p_amount,
         seeded_amount      = seeded_amount + p_amount,
         -- Record the source, or this seed can never be repaid (the repayment
         -- refuses to guess a wallet). The old function left it NULL.
         seed_source_wallet = COALESCE(seed_source_wallet, p_wallet),
         highest_stake      = COALESCE(p_highest_stake, highest_stake),
         offered_max_stake  = GREATEST(offered_max_stake, COALESCE(p_highest_stake, 0)),
         updated_at         = now()
   WHERE club_id = v_owner
   RETURNING balance INTO v_pool_bal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'spin pool row missing for owner % after debiting the union wallet', v_owner;
  END IF;

  UPDATE public.spin_bonus_pools
     SET required_seed_at_activation =
           GREATEST(required_seed_at_activation,
                    public.fn_spin_required_seed(offered_max_stake))
   WHERE club_id = v_owner;

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_owner, 'seed', p_amount, v_pool_bal,
          format('union seed from %s [%s]', p_wallet, v_key));

  RETURN jsonb_build_object('ok', true, 'wallet', p_wallet,
    'debited', p_amount, 'union_balance_after', v_after,
    'owner_id', v_owner, 'pool_balance', v_pool_bal);
END;
$fn$;

DROP FUNCTION IF EXISTS public.fn_spin_reserve_seed(uuid, numeric, numeric, numeric);

-- ── 6. The dead gate ───────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.fn_spin_owner_can_open(uuid);

-- ── 3, 4, 5. Activation: freeze the bar, refuse a conflicting reseed ────────
CREATE OR REPLACE FUNCTION public.fn_spin_activate(
  p_club_id uuid, p_seed_amount numeric, p_offered_max_stake numeric,
  p_source_wallet text, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_owner uuid; v_kind text; v_required numeric; v_seed numeric;
  v_wallet_after numeric; v_bal numeric; v_active boolean; v_activated timestamptz;
  v_outstanding numeric; v_prev_wallet text;
BEGIN
  IF COALESCE(p_offered_max_stake,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'max_stake_must_be_positive');
  END IF;

  v_owner    := public.fn_spin_reserve_pool(p_club_id);
  v_kind     := public.fn_spin_owner_kind(v_owner);
  v_required := public.fn_spin_required_seed(p_offered_max_stake);

  -- A stake so small the bar rounds to zero would let a pool open with no seed
  -- at all. The database enforces its own invariant rather than trusting the
  -- route's board-stake allow-list to be the only thing standing here.
  IF v_required <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'max_stake_too_small',
      'offered_max_stake', p_offered_max_stake);
  END IF;

  -- The pool stores money at 2dp. Taking an unrounded seed debits one number
  -- and records another.
  v_seed := round(COALESCE(p_seed_amount, 0), 2);

  SELECT is_active, activated_at, seeded_amount, seed_source_wallet
    INTO v_active, v_activated, v_outstanding, v_prev_wallet
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  IF COALESCE(v_active,false) AND v_activated IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_active', 'owner_id', v_owner);
  END IF;

  -- Reactivating on top of an unpaid seed used to add a second full seed AND
  -- overwrite the wallet it would be repaid to. Refuse rather than quietly
  -- redirect somebody's money.
  IF COALESCE(v_outstanding,0) > 0
     AND v_prev_wallet IS NOT NULL
     AND v_prev_wallet <> p_source_wallet THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seed_outstanding_to_another_wallet',
      'outstanding', v_outstanding, 'owed_to', v_prev_wallet, 'owner_id', v_owner);
  END IF;

  IF v_seed < v_required THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seed_below_required',
      'required_seed', v_required, 'offered', v_seed,
      'owner_id', v_owner, 'owner_kind', v_kind);
  END IF;

  v_wallet_after := public.fn_spin_move_owner_wallet(
                      v_owner, v_kind, p_source_wallet, -v_seed);
  IF v_wallet_after IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_funds_or_no_wallet',
      'wallet', p_source_wallet, 'owner_id', v_owner, 'owner_kind', v_kind);
  END IF;

  UPDATE public.spin_bonus_pools
     SET balance            = balance + v_seed,
         seeded_amount      = seeded_amount + v_seed,
         seed_source_wallet = p_source_wallet,
         offered_max_stake  = p_offered_max_stake,
         highest_stake      = GREATEST(highest_stake, p_offered_max_stake),
         -- FROZEN HERE. Never recomputed from offered_max_stake afterwards.
         required_seed_at_activation = GREATEST(required_seed_at_activation, v_required),
         ceiling_amount     = 0,
         owner_kind         = v_kind,
         is_active          = true,
         activated_at       = now(),
         activated_by       = p_actor,
         deactivated_at     = NULL,
         updated_at         = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  -- The wallet has already moved. A zero-row UPDATE here would be a silent
  -- burn reported as success, so it becomes a rollback instead.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spin pool row vanished for owner % after debiting % from %',
      v_owner, v_seed, p_source_wallet;
  END IF;

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_owner, 'seed', v_seed, v_bal,
          format('activation seed from %s %s (repayable at %s)', v_kind, p_source_wallet, v_required));

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_owner, 'activation', 0, v_bal,
          format('Spins activated, max stake %s, required seed %s',
                 p_offered_max_stake, v_required));

  RETURN jsonb_build_object('ok', true, 'owner_id', v_owner, 'owner_kind', v_kind,
    'balance', v_bal, 'seeded_amount', v_seed, 'required_seed', v_required,
    'source_wallet', p_source_wallet, 'source_wallet_after', v_wallet_after,
    'offered_max_stake', p_offered_max_stake);
END;
$fn$;

-- ── The owner-menu read, now reporting the frozen bar ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_spin_owner_state(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_owner uuid; v_r public.spin_bonus_pools%ROWTYPE; v_required numeric;
BEGIN
  v_owner := public.fn_spin_reserve_owner(p_club_id);
  SELECT * INTO v_r FROM public.spin_bonus_pools WHERE club_id = v_owner;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'owner_id', v_owner,
      'owner_kind', public.fn_spin_owner_kind(v_owner),
      'is_active', false, 'balance', 0, 'offered_max_stake', 0,
      'required_seed', 0, 'seeded_amount', 0, 'seed_returned_amount', 0,
      'seed_repayable_in', 0, 'collected_from_play', 0, 'total_drawn', 0,
      'spin_count', 0, 'bonus_count', 0);
  END IF;

  -- While a seed is outstanding the bar that matters is the FROZEN one it was
  -- taken under, not what the current stake would imply.
  v_required := CASE
    WHEN v_r.seeded_amount > 0 AND v_r.required_seed_at_activation > 0
      THEN v_r.required_seed_at_activation
    ELSE public.fn_spin_required_seed(v_r.offered_max_stake)
  END;

  RETURN jsonb_build_object(
    'ok', true, 'owner_id', v_owner, 'owner_kind', v_r.owner_kind,
    'is_active', v_r.is_active AND v_r.activated_at IS NOT NULL,
    'activated_at', v_r.activated_at, 'balance', v_r.balance,
    'offered_max_stake', v_r.offered_max_stake, 'required_seed', v_required,
    'seeded_amount', v_r.seeded_amount, 'seed_source_wallet', v_r.seed_source_wallet,
    'seed_returned_amount', v_r.seed_returned_amount,
    'seed_returned_at', v_r.seed_returned_at,
    'seed_repayable_in', GREATEST(v_required - v_r.total_deposited, 0),
    'collected_from_play', v_r.total_deposited, 'total_drawn', v_r.total_drawn,
    'spin_count', v_r.spin_count, 'bonus_count', v_r.bonus_count);
END;
$fn$;

-- ── 2. Settlement: lock BEFORE deciding it is already settled ──────────────
CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(
  p_tournament_id uuid, p_club_id uuid, p_buy_in numeric,
  p_seats integer, p_multiplier numeric, p_rake_rate numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_available numeric;
  v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_kind text; v_seed numeric; v_wallet text;
  v_required numeric; v_collected_play numeric;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  -- LOCK FIRST, THEN ASK. This used to run the already-settled check above the
  -- lock, so two concurrent settles for one tournament both saw "not settled",
  -- serialised here, and both booked. The engine retries settlement three
  -- times, so a call that timed out client-side AFTER committing hit it
  -- exactly. Five tournaments were double-booked in production before this
  -- line moved; see the repair at the end of this migration.
  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled');
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  UPDATE public.spin_bonus_pools
     SET balance = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count = spin_count + 1,
         highest_stake = GREATEST(highest_stake, p_buy_in),
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_available;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
      v_owner, p_tournament_id;
  END IF;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_available,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_owner = p_club_id THEN 'buy-ins less fixed rake'
               ELSE format('buy-ins less fixed rake (club %s)', p_club_id) END);

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
            format('SHORTFALL %s covered by operator - pool was too thin for a %sx. Seed it.',
                   v_shortfall, p_multiplier));
  END IF;

  -- Rake belongs to the PLAYING club, not the pool owner. This is the revenue
  -- line Dan means by "RAKE GOES INTO THE RAKE TREASURY".
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

  -- ── THE SEED COMES BACK ─────────────────────────────────────────────────
  -- Dan: "RETURNED ONCE ENOUGH IS COLLECTED". Enough means play alone has
  -- collected at least what the seed was required to be, AND the pool still
  -- holds that much after handing it back. total_deposited only ever
  -- accumulates from settlement, so the seed is never repaid out of itself.
  --
  -- The bar is the FROZEN one. Reading it live from offered_max_stake let an
  -- owner lower it by reactivating at a smaller stake: seed 20,000 at stake
  -- 100, reactivate at stake 1, and the bar drops to 200.
  SELECT seeded_amount, seed_source_wallet, owner_kind, total_deposited,
         required_seed_at_activation
    INTO v_seed, v_wallet, v_kind, v_collected_play, v_required
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  IF COALESCE(v_seed,0) > 0 AND v_wallet IS NOT NULL AND COALESCE(v_required,0) > 0
     AND v_collected_play >= v_required
     AND (v_bal - v_seed) >= v_required
  THEN
    v_wallet_after := public.fn_spin_move_owner_wallet(v_owner, v_kind, v_wallet, v_seed);

    IF v_wallet_after IS NOT NULL THEN
      UPDATE public.spin_bonus_pools
         SET balance              = balance - v_seed,
             seeded_amount        = 0,
             seed_returned_amount = seed_returned_amount + v_seed,
             seed_returned_at     = now(),
             updated_at           = now()
       WHERE club_id = v_owner RETURNING balance INTO v_bal;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'spin pool row vanished for owner % after repaying % to %',
          v_owner, v_seed, v_wallet;
      END IF;

      v_seed_returned := v_seed;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_seed, v_bal,
              format('seed repaid to %s %s - play collected %s, pool still holds %s against a bar of %s',
                     v_kind, v_wallet, v_collected_play, v_bal, v_required));
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'seed_returned', v_seed_returned,
    'owner_id', v_owner, 'source_wallet_after', v_wallet_after);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_settle_game(uuid, uuid, numeric, integer, numeric, numeric) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_activate(uuid, numeric, numeric, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_activate(uuid, numeric, numeric, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_owner_state(uuid) TO authenticated;

-- ── 2b. REPAIR THE FIVE THAT ALREADY DOUBLE-BOOKED ─────────────────────────
--
-- Each affected tournament has exactly two contribution rows and two
-- jackpot_draw rows. The players paid ONCE and were paid ONCE; the second pair
-- is bookkeeping that never corresponded to money. So: delete the later copy
-- of each, and unwind its effect on the pool's running totals.
--
-- The pool figures are corrected from the rows actually deleted rather than
-- from a hardcoded number, so this is right whatever the exact set turns out
-- to be at apply time.
DO $repair$
DECLARE
  r record;
  v_rake_dupes integer := 0;
  v_total_games integer := 0;
BEGIN
  CREATE TEMP TABLE _spin_dupes ON COMMIT DROP AS
  WITH ranked AS (
    SELECT id, club_id, tournament_id, kind, amount, created_at,
           row_number() OVER (PARTITION BY tournament_id, kind
                              ORDER BY created_at, id) AS rn
    FROM public.spin_reserve_ledger
    WHERE tournament_id IS NOT NULL
      AND kind IN ('contribution','jackpot_draw')
  )
  SELECT * FROM ranked WHERE rn > 1;

  -- PER OWNER. Only one pool exists today, but summing across owners and
  -- applying the total to whichever one happened to sort first would be a
  -- silent misattribution the moment a second club activates.
  FOR r IN
    SELECT club_id,
           COALESCE(sum(amount) FILTER (WHERE kind='contribution'), 0) AS extra_in,
           COALESCE(sum(amount) FILTER (WHERE kind='jackpot_draw'), 0) AS extra_out,
           count(DISTINCT tournament_id) FILTER (WHERE kind='contribution') AS extra_spins
      FROM _spin_dupes GROUP BY club_id
  LOOP
    -- amount is signed: contributions positive, draws negative. Removing both
    -- means subtracting the net they added.
    UPDATE public.spin_bonus_pools
       SET balance         = balance - (r.extra_in + r.extra_out),
           total_deposited = total_deposited - r.extra_in,
           total_drawn     = total_drawn + r.extra_out,   -- extra_out is negative
           spin_count      = GREATEST(spin_count - r.extra_spins, 0),
           updated_at      = now()
     WHERE club_id = r.club_id;

    INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
    SELECT r.club_id, 'adjustment', 0, balance,
           format('REPAIR: removed %s duplicate settlement pair(s) left by the read-before-lock race - unwound %s of contributions and %s of draws that no player ever paid or was paid',
                  r.extra_spins, r.extra_in, -r.extra_out)
      FROM public.spin_bonus_pools WHERE club_id = r.club_id;

    v_total_games := v_total_games + r.extra_spins;
  END LOOP;

  IF v_total_games = 0 THEN
    RAISE NOTICE 'no duplicate spin settlements to repair';
    RETURN;
  END IF;

  -- The duplicate rake rows were revenue that was never earned.
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY tournament_id
                                  ORDER BY created_at, id) AS rn
    FROM public.rake_records
    WHERE source = 'fn_spin_settle_game'
      AND tournament_id IN (SELECT DISTINCT tournament_id FROM _spin_dupes)
  )
  DELETE FROM public.rake_records rr USING ranked
   WHERE rr.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS v_rake_dupes = ROW_COUNT;

  DELETE FROM public.spin_reserve_ledger l USING _spin_dupes d WHERE l.id = d.id;

  RAISE NOTICE 'repaired % duplicate spin settlement(s) and % duplicate rake row(s)',
    v_total_games, v_rake_dupes;
END $repair$;

-- ── 2c. AND MAKE IT STRUCTURALLY IMPOSSIBLE ────────────────────────────────
-- The lock ordering above fixes the race. This makes a second booking fail
-- even if some future caller settles by another path.
CREATE UNIQUE INDEX IF NOT EXISTS uq_spin_ledger_one_booking_per_game
  ON public.spin_reserve_ledger (tournament_id, kind)
  WHERE tournament_id IS NOT NULL AND kind IN ('contribution','jackpot_draw');

-- ── ASSERTIONS ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT tournament_id, kind FROM public.spin_reserve_ledger
     WHERE tournament_id IS NOT NULL AND kind IN ('contribution','jackpot_draw')
     GROUP BY 1,2 HAVING count(*) > 1) d;
  IF v_n > 0 THEN RAISE EXCEPTION '% tournament(s) still double-booked', v_n; END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_spin_reserve_seed') THEN
    RAISE EXCEPTION 'the minting fn_spin_reserve_seed is still callable';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_spin_owner_can_open') THEN
    RAISE EXCEPTION 'the dead fn_spin_owner_can_open is still present';
  END IF;

  -- The settle path must take its lock BEFORE it decides the game is settled.
  IF (SELECT position('FOR UPDATE' in pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_spin_settle_game')
     > (SELECT position('already_settled' in pg_get_functiondef(p.oid))
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='fn_spin_settle_game')
  THEN
    RAISE EXCEPTION 'fn_spin_settle_game still checks already_settled before locking';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='uq_spin_ledger_one_booking_per_game') THEN
    RAISE EXCEPTION 'the one-booking-per-game index was not created';
  END IF;

  IF public.fn_spin_required_seed(100) <> 20000 THEN
    RAISE EXCEPTION 'required seed drifted';
  END IF;
END $assert$;
