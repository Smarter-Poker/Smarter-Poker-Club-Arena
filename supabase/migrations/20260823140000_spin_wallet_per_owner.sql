-- ============================================================================
-- A SPIN WALLET THAT BELONGS TO SOMEBODY
--
-- Dan, 2026-08-23: "YOU NEED TO CREATE A WALLET FOR THE SPINS FOR CLUB OWNERS
-- NOT APART OF THE UNION, AND FOR UNIONS. SPINS SHOULD BE 'ACTIVATED' IN THE
-- OWNERS MENU, AND WHEN THEY ARE, THEY NEED TO DECIDE HOW MUCH THEY ARE
-- 'SEEDING' INTO THE WALLET. (THOSE FUNDS ARE RETURNED ONCE ENOUGH IS
-- COLLECTED) AND ALL PROCEEDS ARE KEPT THERE TO FUND THE MULTIPLIER PAYOUTS."
--
-- On the ceiling: "100X IS THE HIGHEST IT GOES. YES IT RETURNS EVERYTHING IT
-- COLLECTS, RAKE GOES INTO THE RAKE TREASURY, BUT IT NEEDS TO COLLECT FIRST TO
-- DISTRIBUTE."
--
-- WHAT WAS ACTUALLY THERE
-- Most of the shape existed and almost none of it was connected:
--
--   * spin_bonus_pools is already keyed on an OWNER, resolved by
--     fn_spin_reserve_owner as COALESCE(clubs.union_id, club_id) -- a union
--     owns the pool for its clubs, a standalone club owns its own. That is
--     exactly the model asked for, and it already worked.
--   * is_active existed and was DEAD: not read by any function, API route, the
--     engine, or the client. Every pool was active forever by default.
--   * seeded_amount existed and nothing ever repaid it.
--   * fn_spin_reserve_seed MINTED -- it credited the pool and debited nobody,
--     so a "seed" created chips from nothing. It had no caller in application
--     code, which is the only reason that never mattered.
--   * For a union, surplus returned to union_wallets.spin_reserve_wallet. For a
--     standalone club there was NO destination row, so the return went nowhere
--     and was booked as a ledger line with no counterparty.
--
-- In production that added up to exactly ONE pool on the whole platform.
--
-- WHAT THIS DOES
--   1. Activation becomes real: activated_at/by, deactivated_at, and is_active
--      finally means whether an owner offers Spins.
--   2. Seeding becomes real: fn_spin_activate DEBITS a wallet the owner
--      actually holds -- union_wallets for a union, clubs for a club -- so a
--      seed moves money instead of inventing it.
--   3. The seed is a LOAN, repaid once play alone has collected as much as the
--      seed was required to be. It is never repaid out of itself.
--   4. THE CEILING IS RETIRED. Every chip collected stays in the pool to be
--      distributed as prizes. Rake is untouched and still books to the playing
--      club's rake_records, which is the revenue line.
-- ============================================================================

ALTER TABLE public.spin_bonus_pools
  ADD COLUMN IF NOT EXISTS offered_max_stake    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS activated_at         timestamptz,
  ADD COLUMN IF NOT EXISTS activated_by         uuid,
  ADD COLUMN IF NOT EXISTS deactivated_at       timestamptz,
  ADD COLUMN IF NOT EXISTS seed_source_wallet   text,
  ADD COLUMN IF NOT EXISTS seed_returned_at     timestamptz,
  ADD COLUMN IF NOT EXISTS seed_returned_amount numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.spin_bonus_pools.offered_max_stake IS
  'Largest Spin buy-in this owner offers. Set at activation. Drives the required seed and tier thresholds; highest_stake stays the largest buy-in actually PLAYED.';
COMMENT ON COLUMN public.spin_bonus_pools.is_active IS
  'Whether this owner offers Spins. Dead code until 2026-08-23 -- now set only by fn_spin_activate / fn_spin_deactivate and read by fn_spin_owner_can_open.';
COMMENT ON COLUMN public.spin_bonus_pools.seed_source_wallet IS
  'The wallet the seed was debited from, so repayment returns to where it came from.';
COMMENT ON COLUMN public.spin_bonus_pools.seeded_amount IS
  'Seed still owed back to the owner. Drops to zero when repaid; seed_returned_amount keeps the historical total.';

ALTER TABLE public.spin_reserve_ledger DROP CONSTRAINT IF EXISTS spin_reserve_ledger_kind_check;
ALTER TABLE public.spin_reserve_ledger ADD CONSTRAINT spin_reserve_ledger_kind_check
  CHECK (kind = ANY (ARRAY[
    'seed', 'contribution', 'jackpot_draw', 'surplus_return',
    'adjustment', 'merge', 'wallet_return',
    'seed_return', 'activation', 'deactivation'
  ]));

CREATE OR REPLACE FUNCTION public.fn_spin_required_seed(p_offered_max_stake numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $fn$
  SELECT round(GREATEST(COALESCE(p_offered_max_stake, 0), 0) * 100 * 2, 2);
$fn$;

COMMENT ON FUNCTION public.fn_spin_required_seed(numeric) IS
  'Seed an owner must put up to offer Spins: two top-tier (100x) jackpots at their largest offered stake. Mirrors requiredSeed() in src/config/spinSpec.ts.';

CREATE OR REPLACE FUNCTION public.fn_spin_owner_kind(p_owner_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_owner_id)
              THEN 'union' ELSE 'club' END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_spin_move_owner_wallet(
  p_owner_id uuid, p_owner_kind text, p_wallet text, p_delta numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_after numeric;
BEGIN
  IF p_owner_kind = 'union' THEN
    IF p_wallet NOT IN ('chip_balance','promo_wallet','rake_wallet','spin_reserve_wallet') THEN
      RAISE EXCEPTION 'unknown union wallet %', p_wallet;
    END IF;
    EXECUTE format(
      'UPDATE public.union_wallets SET %I = %I + $1, updated_at = now()
        WHERE union_id = $2 AND %I + $1 >= 0 RETURNING %I',
      p_wallet, p_wallet, p_wallet, p_wallet)
      INTO v_after USING p_delta, p_owner_id;
  ELSE
    IF p_wallet NOT IN ('chip_treasury','promo_balance') THEN
      RAISE EXCEPTION 'unknown club wallet %', p_wallet;
    END IF;
    EXECUTE format(
      'UPDATE public.clubs SET %I = COALESCE(%I,0) + $1
        WHERE id = $2 AND COALESCE(%I,0) + $1 >= 0 RETURNING %I',
      p_wallet, p_wallet, p_wallet, p_wallet)
      INTO v_after USING p_delta, p_owner_id;
  END IF;
  RETURN v_after;
END;
$fn$;

COMMENT ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) IS
  'Signed move against a wallet the Spin pool owner holds: union_wallets for a union, clubs for a club. Returns NULL if the wallet is missing or the move would overdraw it. The column allow-list is what stops this being an arbitrary-column write primitive.';

CREATE OR REPLACE FUNCTION public.fn_spin_activate(
  p_club_id uuid, p_seed_amount numeric, p_offered_max_stake numeric,
  p_source_wallet text, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_owner uuid; v_kind text; v_required numeric;
  v_wallet_after numeric; v_bal numeric; v_active boolean; v_activated timestamptz;
BEGIN
  IF COALESCE(p_offered_max_stake,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'max_stake_must_be_positive');
  END IF;

  v_owner    := public.fn_spin_reserve_pool(p_club_id);
  v_kind     := public.fn_spin_owner_kind(v_owner);
  v_required := public.fn_spin_required_seed(p_offered_max_stake);

  SELECT is_active, activated_at INTO v_active, v_activated
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  IF COALESCE(v_active,false) AND v_activated IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_active', 'owner_id', v_owner);
  END IF;

  IF COALESCE(p_seed_amount,0) < v_required THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seed_below_required',
      'required_seed', v_required, 'offered', COALESCE(p_seed_amount,0),
      'owner_id', v_owner, 'owner_kind', v_kind);
  END IF;

  v_wallet_after := public.fn_spin_move_owner_wallet(
                      v_owner, v_kind, p_source_wallet, -p_seed_amount);
  IF v_wallet_after IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_funds_or_no_wallet',
      'wallet', p_source_wallet, 'owner_id', v_owner, 'owner_kind', v_kind);
  END IF;

  UPDATE public.spin_bonus_pools
     SET balance            = balance + p_seed_amount,
         seeded_amount      = seeded_amount + p_seed_amount,
         seed_source_wallet = p_source_wallet,
         offered_max_stake  = p_offered_max_stake,
         highest_stake      = GREATEST(highest_stake, p_offered_max_stake),
         ceiling_amount     = 0,
         owner_kind         = v_kind,
         is_active          = true,
         activated_at       = now(),
         activated_by       = p_actor,
         deactivated_at     = NULL,
         updated_at         = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_owner, 'seed', p_seed_amount, v_bal,
          format('activation seed from %s %s (repayable)', v_kind, p_source_wallet));

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_owner, 'activation', 0, v_bal,
          format('Spins activated, max stake %s, required seed %s',
                 p_offered_max_stake, v_required));

  RETURN jsonb_build_object('ok', true, 'owner_id', v_owner, 'owner_kind', v_kind,
    'balance', v_bal, 'seeded_amount', p_seed_amount, 'required_seed', v_required,
    'source_wallet', p_source_wallet, 'source_wallet_after', v_wallet_after,
    'offered_max_stake', p_offered_max_stake);
END;
$fn$;

COMMENT ON FUNCTION public.fn_spin_activate(uuid, numeric, numeric, text, uuid) IS
  'Owner turns Spins on: debits a wallet they hold for the seed, records it as outstanding, marks the pool active. Refuses below the required seed or without the funds.';

CREATE OR REPLACE FUNCTION public.fn_spin_deactivate(p_club_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_owner uuid; v_bal numeric;
BEGIN
  v_owner := public.fn_spin_reserve_pool(p_club_id);
  UPDATE public.spin_bonus_pools
     SET is_active = false, deactivated_at = now(), updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (v_owner, 'deactivation', 0, v_bal,
          'Spins deactivated - no money moved, the pool still backs games already sold');

  RETURN jsonb_build_object('ok', true, 'owner_id', v_owner, 'balance', v_bal);
END;
$fn$;

COMMENT ON FUNCTION public.fn_spin_deactivate(uuid, uuid) IS
  'Stops new Spins for this owner. Deliberately moves NO money: the balance backs games already sold, and an outstanding seed is still repaid by the normal rule.';

CREATE OR REPLACE FUNCTION public.fn_spin_owner_can_open(p_club_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_ok boolean;
BEGIN
  SELECT p.is_active AND p.activated_at IS NOT NULL AND p.balance > 0
    INTO v_ok FROM public.spin_bonus_pools p
   WHERE p.club_id = public.fn_spin_reserve_owner(p_club_id);
  RETURN COALESCE(v_ok, false);
END;
$fn$;

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

  v_required := public.fn_spin_required_seed(v_r.offered_max_stake);

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

COMMENT ON FUNCTION public.fn_spin_owner_state(uuid) IS
  'Everything the owner menu shows about a Spin wallet in one read: active, balance, seed outstanding, and how much more play must collect before the seed is repaid.';

-- ── SETTLEMENT: NO CEILING, AND THE SEED COMES BACK ────────────────────────

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
  v_required numeric; v_collected_play numeric; v_max_stake numeric;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
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

  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

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

  -- Rake belongs to the PLAYING club, not the pool owner. Unchanged: this is
  -- the revenue line Dan means by "RAKE GOES INTO THE RAKE TREASURY".
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
  -- Dan: the seed is "RETURNED ONCE ENOUGH IS COLLECTED". Enough means play
  -- alone has collected at least what the seed was required to be, so the pool
  -- now stands on its own. total_deposited only ever accumulates from
  -- settlement and never from a seed, so the seed is never repaid out of itself.
  --
  -- WHAT REPLACED THE CEILING. This used to sweep everything above
  -- ceiling_amount back to the operator on every settle. Dan: "YES IT RETURNS
  -- EVERYTHING IT COLLECTS... BUT IT NEEDS TO COLLECT FIRST TO DISTRIBUTE."
  -- The pool is not a revenue account -- it is the float the multipliers are
  -- paid from, and capping it just re-locks the top tiers after a big hit.
  SELECT seeded_amount, seed_source_wallet, owner_kind, total_deposited, offered_max_stake
    INTO v_seed, v_wallet, v_kind, v_collected_play, v_max_stake
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  v_required := public.fn_spin_required_seed(v_max_stake);

  -- TWO conditions, and both are load-bearing:
  --
  --   v_collected_play >= v_required  play has genuinely generated at least
  --                                   the seed's worth, so the seed is never
  --                                   repaid out of itself.
  --   v_bal - v_seed   >= v_required  and after handing it back the pool STILL
  --                                   holds that much on its own.
  --
  -- The second is the one that is easy to leave out and wrong to. total_deposited
  -- is cumulative forever, so on any pool that has run for a while the first
  -- condition is true immediately -- and repaying on that alone would drain the
  -- float the instant it qualified. Measured against the live house pool at the
  -- time of writing: balance 24,964.26 with a 20,000 seed would have dropped to
  -- 4,964.26, which cannot cover a single 100x at a stake of 100, so the top of
  -- the ladder would have re-locked the moment the operator got their money back.
  --
  -- v_wallet IS NOT NULL is a deliberate refusal to guess. The one pool that
  -- predates this migration carries a 20,000 seed from before any source was
  -- recorded; it stays outstanding rather than being repaid to a wallet chosen
  -- by inference. Money does not move on a guess.
  IF COALESCE(v_seed,0) > 0 AND v_wallet IS NOT NULL AND v_required > 0
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

      v_seed_returned := v_seed;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_seed, v_bal,
              format('seed repaid to %s %s - play collected %s, pool still holds %s against a required seed of %s',
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

-- ── LOCK THE MONEY MOVERS AWAY FROM CLIENTS ────────────────────────────────
REVOKE ALL ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_activate(uuid, numeric, numeric, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_deactivate(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_activate(uuid, numeric, numeric, text, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_spin_deactivate(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_owner_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_owner_can_open(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_required_seed(numeric) TO authenticated;

-- The retired ceiling must not be able to fire from a stale row.
UPDATE public.spin_bonus_pools SET ceiling_amount = 0 WHERE ceiling_amount <> 0;

-- The one pool that predates activation has been running since before any of
-- this existed. Record it as activated so the new gate does not switch it off,
-- and adopt its largest played stake as its offered maximum.
UPDATE public.spin_bonus_pools
   SET activated_at      = COALESCE(activated_at, created_at, now()),
       offered_max_stake = GREATEST(offered_max_stake, highest_stake),
       owner_kind        = public.fn_spin_owner_kind(club_id)
 WHERE is_active AND activated_at IS NULL;

-- ── ASSERTIONS ─────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.spin_bonus_pools WHERE ceiling_amount <> 0;
  IF v_n > 0 THEN RAISE EXCEPTION 'ceiling retired but % pool(s) still carry one', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.spin_bonus_pools
   WHERE is_active AND activated_at IS NULL;
  IF v_n > 0 THEN RAISE EXCEPTION '% active pool(s) have no activated_at', v_n; END IF;

  IF public.fn_spin_required_seed(100) <> 20000 THEN
    RAISE EXCEPTION 'required seed for a 100 stake should be 20000, got %',
      public.fn_spin_required_seed(100);
  END IF;
  IF public.fn_spin_required_seed(0) <> 0 THEN
    RAISE EXCEPTION 'required seed for a zero stake must be zero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_spin_activate') THEN
    RAISE EXCEPTION 'fn_spin_activate missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_spin_owner_state') THEN
    RAISE EXCEPTION 'fn_spin_owner_state missing';
  END IF;

  -- The settle path must no longer contain a ceiling sweep. Match the SWEEP'S
  -- OWN SIGNATURE, not the word "ceiling_amount": pg_get_functiondef returns
  -- comments too, and the block above that explains why the ceiling was retired
  -- necessarily names it. Grepping for the noun would make this assertion fail
  -- on its own explanation.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_spin_settle_game'
                AND pg_get_functiondef(p.oid) ILIKE '%surplus_returned = surplus_returned%') THEN
    RAISE EXCEPTION 'fn_spin_settle_game still sweeps surplus to the operator';
  END IF;
END $assert$;
