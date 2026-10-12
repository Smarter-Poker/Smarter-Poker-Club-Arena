-- ===========================================================================
--  THE DIAMOND BAD BEAT JACKPOT IS DECIDED, AND ITS POOL IS PLAYER SIDE
-- ===========================================================================
--
-- B14 to B22 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md, plus B12 and
-- B13, answered and recorded; and the spine the design calls buildable before
-- any answer: the jackpot ledger, the accrual, the sweep, the settler's
-- conservation rule, and refusals by name when a switch is on and a value is
-- unset.
--
-- AUTHORITY. Dan, verbatim, 2026-10-05: "NOTHING IS MINE, EVER.... THEY ARE
-- ALWAYS YOURS TO DO.", answering the list that carried these very questions
-- back to him as owner decisions. Under CLAUDE.md 10.8 that later explicit
-- owner instruction governs over the design document's earlier framing of
-- them as "The Decisions Dan Must Make". It is not a licence to invent a
-- number. Every value below is DERIVED from what this platform already runs,
-- and every row records its derivation in its own `basis` column beside the
-- authority quote, so no row claims he approved a figure he never saw.
--
-- WHAT WAS MEASURED, and where. Production (kuklfnapbkmacvwxktbh) was read on
-- 2026-10-05 between 15:12 and 15:30 UTC, SELECT only, inside
-- BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY. Nothing was
-- written and no transaction that could write was opened.
--
--   ca_bbj_policy row 1:  pivot_threshold 100000, standard_main 0.50,
--     standard_backup 0.25, pivot_main 0.25, pivot_backup 0.25, note "Dan
--     2026-08-18: below the pivot a drop is 50% main / 25% backup / 25% promo;
--     at or above 100,000 in main it is 25 / 25 / 50. Promo is always the
--     remainder."
--
--   bbj_stakes_tiers, all six rows (id, min_bb, max_bb, bbj_fee_bb,
--     payout_total_pct, loser, winner, table):
--       nano        0.01   0.20   0.60   15   7.50   3.75   3.75
--       micro       0.21   0.80   0.60   25  12.50   6.25   6.25
--       small       0.81   3.00   0.25   40  20.00  10.00  10.00
--       mid         3.01   8.00   0.12   55  27.50  13.75  13.75
--       high        8.01  40.00   0.06   70  35.00  17.50  17.50
--       nosebleeds 40.01  99999   0.03   85  42.50  21.25  21.25
--     The loser/winner/table columns are 1/2, 1/4, 1/4 of the paid total in
--     every one of the six rows. That is the rule, not six coincidences.
--
--   ca_rake_rules row 1:  bbj_min_players_dealt 3, bbj_min_pot_bb 10,
--     bbj_ineligible_variants {plo6, short_deck}.
--     server/src/config/RakeConfig.ts says of bbj_min_pot_bb, verbatim:
--     "PAYOUT floor ONLY (Dan 2026-08-29): a bad beat pays out only when the
--     pot held more than this many big blinds. The FEE is collected on every
--     flop with 3+ dealt regardless of pot size - do not re-add this to a fee
--     gate."
--
--   bbj_pools, all 402 rows: 398 active, 3 retired, 1 retired_settled. NOT ONE
--     POOL IS OR EVER WAS SEEDED - the count of pools whose
--     main+backup+promo exceeds total_contributed less total_paid_out is 0.
--     The one pool ever withdrawn (0867a7fd-58d9-4768-9919-06532afe79f3) reads
--     status retired_settled, merged_into_pool_id
--     f9806a7f-e7a2-47d2-a676-36336e3a5337, and all three balances 0: its
--     money went to the surviving pool, not to the house.
--
--   fn_bbj_allocate(numeric, numeric, uuid) carries a CARRIED-RESIDUE rule in
--     ca_bbj_alloc_state(pool_id, main_residue, backup_residue): main and
--     backup take their exact share plus a carried residue, rounded at the
--     asset's indivisible unit, the residue carries forward, and promo takes
--     the remainder "so the three always re-sum to the drop". That is the
--     platform's own deterministic remainder rule, and this migration clones
--     it at the Diamond's unit rather than inventing one.
--
--   The 17 live Diamond cash tables, every one nlh, every one with
--     rake_percent, rake_cap_bb and bbj_percent at an explicit 0.00. Their big
--     blinds, in Diamonds: 2, 5, 10, 20, 25, 50, 100, 200, 400, 500, 600, 800,
--     1000, 2000, 2500, 5000, 10000.
--
--   ca_arena_settings row 1: cash_games_enabled false, tournaments_enabled
--     true. THIS MIGRATION CHANGES NEITHER, and asserts both at the end.
--
-- THE DECISIONS, each with the derivation that produced it. They are rows in
-- ca_diamond_economics, so every one of them changes by appending a row, not
-- by editing code.
--
-- THAT TABLE IS NOT THIS LANE'S. It existed nowhere when this work started and
-- was created here; it then landed on main as 20261005151918 (the A1 to A20
-- lane) with a closed name list that already carries every B14 to B22 name and
-- a units map that fixes each one's unit. This migration therefore JOINS it -
-- no table, no reader, their names, their units - and extends exactly one
-- thing: the account list, to admit the two accounts B22 needs and whose
-- storage this migration provides. Section 1 says it in full.
--
--   B14  IS THERE A DIAMOND BAD BEAT JACKPOT?  YES.
--        The Diamond Arena is a diamonds-only clone of a chip club and the
--        chip club runs a bad beat jackpot on every eligible cash game. The
--        six DiamondCashBoundary layers exist because "the counterparty does
--        not exist" - bbj_pools are club and union CHIP pools - not because
--        the product was declined. This migration builds the Diamond
--        counterparty, so the reason those layers refuse stops applying to a
--        DIAMOND jackpot while they keep refusing a CHIP one, and insurance,
--        forever.
--        The switch row `bbj_enabled` is written at 0. Not as a default: as
--        the answer to "is it open", which it cannot be while
--        cash_games_enabled is false, because a drop can only come out of a
--        cash pot. Every value B15 to B22 needs is written here, so turning it
--        on is one appended row and cannot land on an unset number.
--
--   B15  THE DROP, per qualifying hand, per stake: floor(big_blind * the
--        tier's bbj_fee_bb) WHOLE DIAMONDS, the tier found on the same
--        bbj_stakes_tiers ladder read against the Diamond big blind.
--        Two derivations meet here. The chip drop is published in BIG BLIND
--        units, which carry no currency, so the schedule itself transfers. And
--        a Diamond is whole: the Diamond estate's own precedent for a
--        proportional charge is to FLOOR it at the unit -
--        fn_ca_unit_floor_cents, and the Diamond tournament fee, where
--        flooring to a whole Diamond means an entry under 10 Diamonds pays no
--        fee at all. The same floor here gives, for the 17 live stakes:
--          bb 2 -> 0,  5 -> 0,  10 -> 0,  20 -> 1,  25 -> 1,  50 -> 1,
--          100 -> 3,  200 -> 6,  400 -> 12,  500 -> 15,  600 -> 18,
--          800 -> 24,  1000 -> 30,  2000 -> 60,  2500 -> 75,  5000 -> 150,
--          10000 -> 300.
--        The three lowest Diamond stakes drop NOTHING, for the same reason a
--        9 Diamond entry pays no fee: the proportional charge is smaller than
--        the smallest thing that exists. And by the chip estate's own symmetry
--        rule - a variant that drops nothing "can never win one" - a stake
--        that drops nothing can never hit. That is not three stakes excluded
--        by hand; it is the unit.
--
--   B16  WHICH LOSING HAND QUALIFIES, and which games have none. Taken
--        verbatim from the live chip configuration, because which hand
--        qualifies is a property of the GAME, not of the currency:
--          nlh, flh        AAAJJ - a full house, aces full of jacks, or
--                          better, must lose to quads or a straight flush; the
--                          holder must have at least one ace among their hole
--                          cards; both hole cards must play.
--          plo4, flo4      KKKK2 - four kings or better must lose; exactly two
--                          hole cards play.
--          plo5, flo5      87654 - an eight-high straight flush or better must
--                          lose; exactly two hole cards play.
--          plo8, flo8      KKKK2, evaluated on the HIGH hand only.
--          pineapple       KKKK2.
--          plo6            NO JACKPOT (ca_rake_rules.bbj_ineligible_variants).
--          short_deck      NO JACKPOT (the same list).
--        And the three rules beside them, also as the chip estate runs them: a
--        double or triple board hand is excluded, only the first runout counts,
--        and where more than one loser qualifies the STRONGEST qualifying
--        losing hand takes it (BBJ_RULES.splitIfMultipleQualify is false, and
--        was set to what the engine does on 2026-09-11 precisely because a
--        flag nothing enforced was being printed to players as the rule).
--
--   B17  TO DROP: a flop must be dealt and at least 3 players dealt in. There
--        is no smallest pot. TO HIT: the pot must exceed 10 big blinds and at
--        least 3 players must have been dealt in.
--        Straight from ca_rake_rules (bbj_min_players_dealt 3, bbj_min_pot_bb
--        10) and from the quoted comment that the pot floor is a PAYOUT floor
--        and never a fee gate. Nothing needed flooring: 10 big blinds of a
--        whole-Diamond blind is a whole number of Diamonds, and 3 players is 3
--        players in any currency.
--
--   B18  THREE POOLS, as in chips: main, backup, promotional. Below the pivot
--        50 / 25 / 25; at or above 100,000 Diamonds in main, 25 / 25 / 50.
--        The three pools are load-bearing and not decoration:
--        fn_bbj_reseed_main_from_backup is what lets a jackpot survive a 100
--        percent hit, so a product with one pool would restart at zero every
--        hit. The shares and the pivot are ca_bbj_policy row 1 as read today.
--        The pivot threshold is the one figure cloned by UNIT COUNT rather
--        than by economic equivalence: 100,000 of the asset, where the asset
--        is now the Diamond. It is one appended row to change.
--        THE REMAINDER RULE, because a 1 Diamond drop cannot split 50/25/25:
--        the chip allocator's own carried residue, at the Diamond's unit. main
--        and backup each take floor(exact share + carried residue) and carry
--        what is left; promotional takes the remainder, so the three re-sum to
--        the drop EXACTLY, every hand. Flooring rather than rounding keeps
--        each residue in [0,1), so no bank is ever credited ahead of its exact
--        cumulative share: main and backup are each at most one Diamond
--        behind theirs, promotional at most two ahead. Stated, pinned, and
--        asserted in this migration.
--
--   B19  ON A HIT: the share of the MAIN pool paid is the stake's tier
--        payout_total_pct - nano 15, micro 25, small 40, mid 55, high 70,
--        nosebleeds 85 percent - and it divides HALF to the losing player, a
--        QUARTER to the winning player, a QUARTER among the rest of the table.
--        Those shares are not chosen: all six live tier rows carry
--        loser/winner/table as exactly 1/2, 1/4, 1/4 of their payout_total_pct.
--        For the 17 live Diamond stakes the tier gives bb 2 -> 40%,
--        bb 5 -> 55%, bb 10/20/25 -> 70%, bb 50 and above -> 85% (and bb 2, 5
--        and 10 never hit at all, per B15).
--        WHOLE DIAMONDS, deterministically: paid = floor(main * pct/100);
--        loser = floor(paid/2); winner = floor(paid/4); the table share is
--        paid - loser - winner and divides by floor among the other players
--        dealt in. Every Diamond that no floor could allocate STAYS IN THE
--        MAIN POOL. It was never allocated to a person, the pool is the
--        players' money either way, and nothing is taken from anybody to
--        round a number.
--
--   B20  THE POOL IS NOT SEEDED, and no account funds it.
--        Measured, not reasoned: across all 402 live chip pools the count
--        whose balances exceed contributions less payouts is 0. The chip
--        estate has never seeded a pool in its history, and the backup pool is
--        why it does not have to. Consequences worth stating: no house
--        earmark, no Mint issuance for a jackpot, and the pool is player-side
--        from its very first hand - which is just as well, since
--        ca_diamond_house holds 0 Diamonds.
--
--   B21  THERE IS NO MAXIMUM POOL SIZE, and so no drop is ever turned away.
--        The chip estate has no maximum either. What it has instead is the
--        pivot: once main reaches 100,000 the larger share of every drop is
--        steered into promotional rather than main, which is the mechanism
--        that stops main growing without bound. A maximum would have to send a
--        drop somewhere, and under ruling 21 a platform pot never refuses a
--        player.
--
--   B22  IF THE DIAMOND JACKPOT IS EVER WITHDRAWN, the pool moves to the
--        SURVIVING Diamond jackpot pool and the retired pool is marked
--        retired_settled, naming the survivor in merged_into_pool_id. That is
--        exactly, and only, what the one chip pool ever withdrawn did.
--        If no pool survives - the product itself withdrawn - the pool is paid
--        to the players who contributed to it, in proportion to their recorded
--        contributions, floored to whole Diamonds with the remainder to the
--        largest contributor and ties broken by the earliest contribution.
--        NEVER TO THE HOUSE, in either branch. The pool is money owed to
--        players: CLAUDE.md 10.9 condition 3, and rule R1 of the design, under
--        which nothing player-owned may be parked in the house.
--
--   B12 AND B13 ARE NOT RECORDED HERE, BECAUSE THE RAKE LANE DECIDED THEM
--        FIRST AND THIS LANE READ IT RATHER THAN DUPLICATE IT. When this work
--        started, no pull request and no branch decided either. While it was
--        being written, 20261005151712_diamond_cash_rake_economics_and_accrual
--        landed on main (PR #6163) answering B4 to B13: its
--        `cash_rakeback_percent` is 0 and its `cash_rake_vip_points` is 0, with
--        the derivation this lane had reached independently - eleven tables
--        already refuse a Diamond rakeback, agent or commission row and ruling
--        16 forbids the hierarchy, so there is no counterparty a rakeback could
--        be paid from; and chip VIP points come from
--        trg_award_vip_points_from_rake, a trigger on rake_records, which a
--        Diamond rake will never write. Recording the same two answers again
--        under the shared table's own names would put one decision in two
--        vocabularies, which is the thing a single table of answers exists to
--        prevent. So they are NAMED here and RECORDED there.
--
-- WHAT THIS DOES NOT DO. It does not open cash_games_enabled - that is held
-- elsewhere and comes after this is live. It does not touch
-- tournaments_enabled. It does not teach the engine to take a drop: layers 1
-- and 2 keep the table columns at an explicit 0, layer 3 and
-- applyJointDeductions keep refusing a non-zero Diamond deduction, and the
-- settler admits a drop only when `bbj_enabled` is 1, which it is not. It does
-- not weaken one guard: the settler's refusal becomes CONDITIONAL AND
-- RECOMPUTED, not removed, and with the switch at 0 it refuses exactly what it
-- refuses today. It writes no Diamond rake path; that is the rake lane's.
--
-- A NOTE ON A FINDING THAT DID NOT HOLD. The record said
-- tests/sql/run-diamond-cross-format-conservation.py already proved "a BBJ fee
-- of 0.50 at 0.25 BB". It does not. That fixture contains no BBJ fee and no
-- BBJ anything; its fee case is a TOURNAMENT fee of 5 Diamonds reaching the
-- house as a burn/mint pair. There is no worked BBJ fee example anywhere in
-- the repository, which is why this migration derives the drop from the chip
-- schedule and the unit instead of from a fixture.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. WHAT MUST BE TRUE BEFORE ANYTHING MOVES
-- ---------------------------------------------------------------------------
DO $before$
BEGIN
  IF to_regclass('public.ca_arena_settings') IS NULL THEN
    RAISE EXCEPTION 'ca_arena_settings is absent; this is not the Diamond estate';
  END IF;
  IF to_regclass('public.poker_diamond_custody') IS NULL
     OR to_regclass('public.poker_diamond_hand_receipts') IS NULL THEN
    RAISE EXCEPTION 'the Diamond cash custody tables are absent';
  END IF;
  IF to_regprocedure('public.fn_poker_diamond_append_only()') IS NULL THEN
    RAISE EXCEPTION 'fn_poker_diamond_append_only is absent; nothing can be made append-only';
  END IF;
END $before$;

-- ---------------------------------------------------------------------------
-- 1. ca_diamond_economics IS ALREADY HERE, AND THIS LANE JOINS IT
-- ---------------------------------------------------------------------------
-- WHAT CHANGED WHILE THIS WAS BEING WRITTEN. ca_diamond_economics existed
-- nowhere - not in production, not in this repository - when this lane started,
-- so it was created here. It then landed on main as
-- 20261005151918_diamond_economics_records_the_owner_answers (PR #6161, the
-- A1 to A20 lane), with a closed name list that ALREADY CARRIES EVERY B14 TO
-- B22 NAME and a units map that fixes each one's unit. That is the shared
-- table the design asks for, and two lanes writing one table have to agree
-- rather than each hold its own copy.
--
-- So this lane adopts it. It creates no table, defines no reader, and takes
-- their names and their units: bbj_enabled, bbj_drop_per_hand,
-- bbj_qualifying_hand, bbj_excluded_games, bbj_min_pot, bbj_min_dealt_in,
-- bbj_pool_split, bbj_hit_shares, bbj_seed, bbj_pool_ceiling,
-- bbj_withdrawal_destination. The readers are theirs too: fn_ca_diamond_economic for a number,
-- fn_ca_diamond_economic_text for a word, fn_ca_diamond_economic_on for a
-- switch, each refusing an unset value by name under SQLSTATE PDE01.
--
-- ONE NARROW EXTENSION, and it is the kind the constraint's own comment asks
-- for. ca_diamond_economics_account_exists admits only 'ca_diamond_house' and
-- 'retired_from_supply', "an account whose storage exists today". B22's answer
-- is neither, and must not be: a jackpot pool is money owed to players, so the
-- house is the one place it may never go (design rule R1, CLAUDE.md 10.9
-- condition 3). The two accounts this migration's own storage provides are
-- added beside theirs; neither of theirs is removed.
DO $adopt$
BEGIN
  IF to_regclass('public.ca_diamond_economics') IS NULL THEN
    RAISE EXCEPTION 'ca_diamond_economics is absent; apply 20261005151918 first';
  END IF;
  IF to_regprocedure('public.fn_ca_diamond_economic(text,text)') IS NULL
     OR to_regprocedure('public.fn_ca_diamond_economic_text(text,text)') IS NULL
     OR to_regprocedure('public.fn_ca_diamond_economic_on(text,text)') IS NULL THEN
    RAISE EXCEPTION 'the Diamond economics readers are absent; apply 20261005151918 first';
  END IF;
  -- The names this lane writes must already be on their closed list. If one is
  -- not, that is a disagreement between two lanes about what a question is
  -- called, and it stops here rather than being papered over with an ALTER.
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'bbj_enabled', 'bbj_drop_per_hand', 'bbj_qualifying_hand', 'bbj_excluded_games',
      'bbj_min_pot', 'bbj_min_dealt_in', 'bbj_pool_split', 'bbj_hit_shares',
      'bbj_seed', 'bbj_pool_ceiling', 'bbj_withdrawal_destination']) n
     WHERE public.fn_ca_diamond_economics_units_of(n) IS NULL) THEN
    RAISE EXCEPTION 'a B14 to B22 name this lane records is not on the shared closed list';
  END IF;
END $adopt$;

ALTER TABLE public.ca_diamond_economics
  DROP CONSTRAINT IF EXISTS ca_diamond_economics_account_exists;
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_account_exists CHECK (
    units <> 'account' OR value_text IN (
      'ca_diamond_house',
      'retired_from_supply',
      -- B22. The storage for both is created by this migration:
      -- poker_diamond_jackpot_pools holds the surviving pool, and the
      -- contributors of a pool are the payer rows of its own ledger.
      'surviving_diamond_jackpot_pool',
      'contributing_players_pro_rata'
    )
  );

-- ---------------------------------------------------------------------------
-- 1b. READING A SHARES ANSWER, STRICTLY
-- ---------------------------------------------------------------------------
-- bbj_pool_split and bbj_hit_shares are recorded in the shared table's own
-- 'shares' unit, which is a word rather than a number, because one answer
-- carries several percentages that have to add up. The grammar is fixed here
-- and nowhere else:
--
--   a segment is `key=integer` pairs separated by commas
--   segments are separated by a semicolon, and a later segment is a later
--     regime of the same answer (the pivot, for bbj_pool_split)
--
-- Nothing is inferred. A missing key, a malformed segment or a value that is
-- not a whole percentage refuses BY NAME, so a door never acts on a share it
-- could not read. This is what keeps the percentages in the row rather than in
-- the door while still letting the door be sure of them.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_share(
  p_shares text, p_segment integer, p_key text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $fn$
DECLARE v_seg text; v_hit text[];
BEGIN
  IF p_shares IS NULL OR p_segment IS NULL OR p_segment < 1 OR p_key IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_unreadable' USING ERRCODE = '22023';
  END IF;
  v_seg := btrim(split_part(p_shares, ';', p_segment));
  IF v_seg = '' THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_have_no_segment_%:%', p_segment, p_shares
      USING ERRCODE = '22023';
  END IF;
  IF v_seg !~ '^[a-z_]+=[0-9]+(,[a-z_]+=[0-9]+)*$' THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_malformed:%', v_seg USING ERRCODE = '22023';
  END IF;
  v_hit := regexp_match(v_seg, '(?:^|,)' || p_key || '=([0-9]+)(?:,|$)');
  IF v_hit IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_missing:%/%', p_key, v_seg USING ERRCODE = '22023';
  END IF;
  RETURN v_hit[1]::numeric;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_share(text, integer, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE POOL AND ITS LEDGER. PLAYER SIDE, APPEND ONLY, NO STORED BALANCE
-- ---------------------------------------------------------------------------
-- Design rule R4: per-hand money never touches ca_diamond_house row 1, because
-- every house write locks it and a drop happens on every Diamond table at
-- once. So the pool accrues inside the ARENA FLOAT, which
-- fn_ca_arena_diamonds() counts, and custody-to-pool is arena-to-arena: no
-- register row, and the money identity never moves.
--
-- Design rule R5: a new place Diamonds sit is counted in the migration that
-- creates it. Section 5 below adds this ledger to fn_ca_arena_diamonds().
--
-- NO STORED BALANCE. A bank's balance is the sum of its ledger rows and
-- nothing else, so it cannot drift from its own history and no repair job can
-- ever be needed to reconcile the two. The residues below are not money: they
-- are the carried fractions of the allocation rule, and they are the only
-- mutable numbers on the pool row.
CREATE TABLE IF NOT EXISTS public.poker_diamond_jackpot_pools (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arena_id            uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'retired', 'retired_settled')),
  merged_into_pool_id uuid REFERENCES public.poker_diamond_jackpot_pools(id),
  main_residue        numeric NOT NULL DEFAULT 0 CHECK (main_residue >= 0 AND main_residue < 1),
  backup_residue      numeric NOT NULL DEFAULT 0 CHECK (backup_residue >= 0 AND backup_residue < 1),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- merged_into_pool_id is NULL on purpose in the second branch of B22: when
  -- no pool survives there is no successor to name, and the money went to the
  -- contributing players instead. The withdraw door, not a CHECK, is what
  -- requires a settled pool to hold nothing - a bank's balance is the sum of
  -- its rows, which a row constraint cannot see.
  CONSTRAINT poker_diamond_jackpot_pool_succession
    CHECK (merged_into_pool_id IS NULL OR status <> 'active')
);
CREATE UNIQUE INDEX IF NOT EXISTS poker_diamond_jackpot_one_active_pool_per_arena
  ON public.poker_diamond_jackpot_pools (arena_id) WHERE status = 'active';
-- The partial index above cannot answer the foreign key: deleting a club
-- checks every key into clubs, and a partial index or one where the column is
-- not first does not count, so this is a sequential scan of the child table
-- without a full index leading on arena_id.
CREATE INDEX IF NOT EXISTS idx_poker_diamond_jackpot_pools_arena_id_fk
  ON public.poker_diamond_jackpot_pools (arena_id);

CREATE TABLE IF NOT EXISTS public.poker_diamond_jackpot_ledger (
  id             bigserial PRIMARY KEY,
  pool_id        uuid NOT NULL REFERENCES public.poker_diamond_jackpot_pools(id) ON DELETE RESTRICT,
  bank           text NOT NULL CHECK (bank IN ('main', 'backup', 'promotional')),
  -- A drop comes in from a hand. A payout goes out to a person. A reseed and a
  -- merge move between banks or between pools; each writes BOTH legs, so the
  -- sum over every row of every bank is the Diamonds the jackpot holds.
  kind           text NOT NULL CHECK (kind IN ('drop', 'payout', 'reseed_in', 'reseed_out',
                                               'merge_in', 'merge_out')),
  -- WHOLE DIAMONDS, signed: positive into the bank, negative out of it. A
  -- Diamond is indivisible and so is every row here.
  amount         bigint NOT NULL CHECK (amount <> 0),
  table_id       uuid REFERENCES public.tables(id) ON DELETE RESTRICT,
  hand_number    bigint CHECK (hand_number IS NULL OR hand_number >= 1000000),
  -- Who paid this Diamond in (a drop) or who it was paid out to (a payout).
  -- A horse is a profile, like everybody else, and is named here like
  -- everybody else. CLAUDE.md 10.5: a horse earns and is paid everything a
  -- human is from the same action, a jackpot included. There is no is_horse
  -- column, predicate or branch anywhere in this file, and the law test
  -- pinned beside it refuses one.
  payer_user_id     uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_user_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_role    text CHECK (recipient_role IN ('loser', 'winner', 'table')),
  wallet_journal_id uuid,
  ref            text NOT NULL CHECK (btrim(ref) <> ''),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poker_diamond_jackpot_drop_is_in
    CHECK (kind <> 'drop' OR (amount > 0 AND table_id IS NOT NULL AND hand_number IS NOT NULL
                              AND payer_user_id IS NOT NULL AND recipient_user_id IS NULL
                              AND recipient_role IS NULL)),
  CONSTRAINT poker_diamond_jackpot_payout_is_out
    CHECK (kind <> 'payout' OR (amount < 0 AND table_id IS NOT NULL AND hand_number IS NOT NULL
                                AND recipient_user_id IS NOT NULL AND recipient_role IS NOT NULL
                                AND wallet_journal_id IS NOT NULL AND payer_user_id IS NULL)),
  CONSTRAINT poker_diamond_jackpot_move_has_no_person
    CHECK (kind IN ('drop', 'payout')
           OR (payer_user_id IS NULL AND recipient_user_id IS NULL AND recipient_role IS NULL
               AND wallet_journal_id IS NULL)),
  CONSTRAINT poker_diamond_jackpot_move_signs
    CHECK (kind NOT IN ('reseed_in', 'merge_in') OR amount > 0),
  CONSTRAINT poker_diamond_jackpot_move_signs_out
    CHECK (kind NOT IN ('reseed_out', 'merge_out') OR amount < 0)
);

-- A REPLAY PAYS NOTHING TWICE, and it is the index that says so rather than a
-- check somebody has to remember to write. One row per (ref, bank, person,
-- role): a second delivery of the same hand collides and is turned away.
CREATE UNIQUE INDEX IF NOT EXISTS poker_diamond_jackpot_ledger_once
  ON public.poker_diamond_jackpot_ledger (
    ref, bank,
    COALESCE(payer_user_id, recipient_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(recipient_role, '-'));
CREATE INDEX IF NOT EXISTS poker_diamond_jackpot_ledger_pool_bank
  ON public.poker_diamond_jackpot_ledger (pool_id, bank);
CREATE INDEX IF NOT EXISTS poker_diamond_jackpot_ledger_hand
  ON public.poker_diamond_jackpot_ledger (table_id, hand_number);

ALTER TABLE public.poker_diamond_jackpot_pools  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poker_diamond_jackpot_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.poker_diamond_jackpot_pools  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.poker_diamond_jackpot_ledger FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.poker_diamond_jackpot_ledger_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

DO $append$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.poker_diamond_jackpot_ledger'::regclass
                    AND tgname = 'poker_diamond_jackpot_ledger_append_only') THEN
    CREATE TRIGGER poker_diamond_jackpot_ledger_append_only BEFORE UPDATE OR DELETE
      ON public.poker_diamond_jackpot_ledger FOR EACH ROW
      EXECUTE FUNCTION public.fn_poker_diamond_append_only();
  END IF;
END $append$;

-- ---------------------------------------------------------------------------
-- 3. READING THE POOL
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_bank(p_pool_id uuid, p_bank text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
  SELECT COALESCE(sum(l.amount), 0)::bigint
    FROM public.poker_diamond_jackpot_ledger l
   WHERE l.pool_id = p_pool_id AND l.bank = p_bank;
$fn$;

-- Every Diamond the jackpot holds, over every pool and every bank. This is the
-- number fn_ca_arena_diamonds() adds, so the identity sees the pool.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_diamonds()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
  SELECT COALESCE(sum(l.amount), 0)::numeric FROM public.poker_diamond_jackpot_ledger l;
$fn$;

-- The pool a Diamond cash table drops into: its arena's one active pool. A
-- table that is not a plain Diamond cash table has no pool, and the caller
-- refuses rather than inventing one.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_pool_for_table(p_table_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
  SELECT j.id
    FROM public.tables t
    JOIN public.clubs c ON c.id = t.club_id
    JOIN public.poker_diamond_jackpot_pools j ON j.arena_id = c.id AND j.status = 'active'
   WHERE t.id = p_table_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL;
$fn$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_bank(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_diamonds() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_pool_for_table(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. THE ALLOCATOR (B18). THE CHIP RULE, AT THE DIAMOND'S UNIT
-- ---------------------------------------------------------------------------
-- fn_bbj_allocate(numeric, numeric, uuid) rounds each bank's exact share at the
-- chip's indivisible unit, carries the residue in ca_bbj_alloc_state and gives
-- promo the remainder "so the three always re-sum to the drop". This is that
-- rule with the Diamond as the unit.
--
-- WHY FLOOR AND NOT ROUND. Flooring keeps each residue in [0, 1), so main and
-- backup are never credited ahead of their exact cumulative share. The bound
-- it buys: over any run of hands, main and backup each hold at least their
-- exact share minus one Diamond, and promotional at most its exact share plus
-- two. The three always sum to exactly the drop, which is the property that
-- matters, and section 8 asserts it.
--
-- EVERY SHARE IS READ FROM ca_diamond_economics. There is not one percentage
-- literal in this function.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_allocate(
  p_pool_id uuid, p_amount bigint,
  OUT o_main bigint, OUT o_backup bigint, OUT o_promotional bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_pool public.poker_diamond_jackpot_pools%ROWTYPE;
  v_main_share numeric; v_backup_share numeric; v_split text;
  v_exact_main numeric; v_exact_backup numeric;
  v_main_balance bigint;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN
    RAISE EXCEPTION 'diamond_jackpot_drop_must_be_a_whole_positive_diamond:%', p_amount
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_pool FROM public.poker_diamond_jackpot_pools
   WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_absent' USING ERRCODE = '23514';
  END IF;
  IF v_pool.status <> 'active' THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_not_active:%', v_pool.status USING ERRCODE = '23514';
  END IF;

  v_main_balance := public.fn_poker_diamond_jackpot_bank(p_pool_id, 'main');
  -- B18, read as one shares answer. Segment 1 is the standard regime,
  -- segment 2 the regime at and above the pivot, and `pivot_at` is the main
  -- balance that moves between them. One row, read strictly, no literal here.
  v_split := public.fn_ca_diamond_economic_text('bbj_pool_split');
  IF v_main_balance >= public.fn_poker_diamond_jackpot_share(v_split, 2, 'pivot_at') THEN
    v_main_share   := public.fn_poker_diamond_jackpot_share(v_split, 2, 'main');
    v_backup_share := public.fn_poker_diamond_jackpot_share(v_split, 2, 'backup');
  ELSE
    v_main_share   := public.fn_poker_diamond_jackpot_share(v_split, 1, 'main');
    v_backup_share := public.fn_poker_diamond_jackpot_share(v_split, 1, 'backup');
  END IF;
  IF v_main_share + v_backup_share > 100 THEN
    RAISE EXCEPTION 'diamond_jackpot_shares_exceed_the_drop:%+%', v_main_share, v_backup_share
      USING ERRCODE = '23514';
  END IF;

  v_exact_main   := p_amount * v_main_share   / 100 + v_pool.main_residue;
  v_exact_backup := p_amount * v_backup_share / 100 + v_pool.backup_residue;
  o_main   := floor(v_exact_main)::bigint;
  o_backup := floor(v_exact_backup)::bigint;
  -- A bank is never asked for more than the drop, nor less than nothing: the
  -- same two clamps the chip allocator carries.
  o_main   := least(greatest(o_main, 0), p_amount);
  o_backup := least(greatest(o_backup, 0), p_amount - o_main);
  -- Promotional takes the remainder, so the three re-sum to the drop exactly.
  o_promotional := p_amount - o_main - o_backup;

  UPDATE public.poker_diamond_jackpot_pools
     SET main_residue   = v_exact_main   - o_main,
         backup_residue = v_exact_backup - o_backup,
         updated_at     = now()
   WHERE id = p_pool_id;

  IF o_main + o_backup + o_promotional <> p_amount THEN
    RAISE EXCEPTION 'diamond_jackpot_allocation_does_not_conserve' USING ERRCODE = '23514';
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_allocate(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE DROP (B15, B17). WHAT A STAKE OWES, AND WHO IT IS RECORDED AGAINST
-- ---------------------------------------------------------------------------
-- The scope key for a stake is its big blind in Diamonds. Every live Diamond
-- blind is a whole number; one that is not refuses by name rather than being
-- rounded into some other stake's price.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_stake_scope(p_big_blind numeric)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_big_blind IS NULL OR p_big_blind <= 0 OR p_big_blind <> trunc(p_big_blind) THEN
    RAISE EXCEPTION 'diamond_jackpot_stake_is_not_whole_diamonds:%', p_big_blind
      USING ERRCODE = '23514';
  END IF;
  RETURN 'bb:' || trunc(p_big_blind)::bigint::text;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_stake_scope(numeric)
  FROM PUBLIC, anon, authenticated, service_role;

-- The drop a qualifying hand owes at this table, in whole Diamonds. Zero is a
-- real answer: the three lowest Diamond stakes owe nothing, and by the chip
-- estate's own symmetry a stake that drops nothing can never hit.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_drop_due(p_table_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE v_bb numeric; v_variant text;
BEGIN
  SELECT t.big_blind, t.game_variant INTO v_bb, v_variant
    FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE = '23514';
  END IF;
  -- A game with no jackpot drops nothing and can never win one (B16).
  IF NOT public.fn_poker_diamond_jackpot_game_qualifies(v_variant) THEN
    RETURN 0;
  END IF;
  RETURN public.fn_ca_diamond_economic('bbj_drop_per_hand',
           public.fn_poker_diamond_jackpot_stake_scope(v_bb))::bigint;
END $fn$;

-- A SECURITY DEFINER READER IS NOT HARMLESS BECAUSE IT IS A READER. This one
-- runs past RLS and never asks who is calling, so no pre-login role and no
-- logged-in player may reach it: what a stake owes the jackpot is published on
-- the table, not read out of a money door.
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_drop_due(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- THE DROP ITSELF. Called by the settler in the settler's own transaction,
-- after the stacks have been written, because the Diamonds have already left
-- custody by then and this is the row that records where they went: custody
-- down by the drop, pool up by the drop, arena float unchanged.
--
-- ATTRIBUTION. The drop is recorded against the players whose stacks fell, in
-- proportion to their loss, floored, with the whole-Diamond remainder to the
-- largest loser and ties broken by the lower user_id - the order the settler's
-- own roster is already sorted in. It moves no Diamond; it only decides whose
-- name each Diamond of the drop carries. Horses are in that roster on the same
-- terms as everybody else and are never filtered out of it.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_drop(
  p_table_id uuid, p_hand_number bigint, p_amount bigint, p_stacks jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE
  v_pool uuid; v_ref text;
  v_main bigint; v_backup bigint; v_promotional bigint;
  v_losses numeric;
  v_shares jsonb := '{}'::jsonb; v_rows integer := 0;
  v_bank_of jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_drop_must_be_a_whole_positive_diamond:%', p_amount
      USING ERRCODE = '23514';
  END IF;
  v_pool := public.fn_poker_diamond_jackpot_pool_for_table(p_table_id);
  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_absent' USING ERRCODE = '23514';
  END IF;
  v_ref := 'bbjdrop:' || p_table_id::text || ':' || p_hand_number::text;

  SELECT * INTO v_main, v_backup, v_promotional
    FROM public.fn_poker_diamond_jackpot_allocate(v_pool, p_amount);
  v_bank_of := jsonb_build_object('main', v_main, 'backup', v_backup, 'promotional', v_promotional);

  SELECT COALESCE(sum(greatest((x->>'stack_before')::numeric - (x->>'stack')::numeric, 0)), 0)
    INTO v_losses FROM jsonb_array_elements(p_stacks) x;
  IF v_losses <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_drop_has_no_payer' USING ERRCODE = '23514';
  END IF;

  -- One ledger row per payer per bank. Every bank's rows sum to that bank's
  -- share of the drop, and the three shares sum to the drop. The remainder of
  -- each bank's division goes to the largest loser first, ties by the lower
  -- user_id: deterministic, and the same order the settler's roster carries.
  INSERT INTO public.poker_diamond_jackpot_ledger(
    pool_id, bank, kind, amount, table_id, hand_number, payer_user_id, ref, note)
  SELECT v_pool, a.bank, 'drop', a.share, p_table_id, p_hand_number, a.user_id, v_ref,
         'bad beat jackpot drop, attributed by loss'
    FROM (
      SELECT p.bank, p.user_id,
             p.floored
             + CASE WHEN p.rank <= p.bank_amount - p.floored_total THEN 1 ELSE 0 END AS share
        FROM (
          SELECT b.bank, b.bank_amount, s.user_id,
                 floor(b.bank_amount * s.loss / v_losses)::bigint AS floored,
                 sum(floor(b.bank_amount * s.loss / v_losses)::bigint)
                   OVER (PARTITION BY b.bank) AS floored_total,
                 row_number() OVER (PARTITION BY b.bank ORDER BY s.loss DESC, s.user_id) AS rank
            FROM (SELECT key AS bank, value::text::bigint AS bank_amount
                    FROM jsonb_each(v_bank_of) WHERE value::text::bigint > 0) b
            CROSS JOIN (
              SELECT (x->>'user_id')::uuid AS user_id,
                     greatest((x->>'stack_before')::numeric - (x->>'stack')::numeric, 0) AS loss
                FROM jsonb_array_elements(p_stacks) x
               WHERE greatest((x->>'stack_before')::numeric - (x->>'stack')::numeric, 0) > 0) s
        ) p
    ) a
   WHERE a.share > 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF (SELECT COALESCE(sum(l.amount), 0) FROM public.poker_diamond_jackpot_ledger l
       WHERE l.ref = v_ref AND l.kind = 'drop') <> p_amount THEN
    RAISE EXCEPTION 'diamond_jackpot_drop_does_not_conserve' USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_object_agg(l.bank, s) INTO v_shares
    FROM (SELECT bank, sum(amount) AS s FROM public.poker_diamond_jackpot_ledger
           WHERE ref = v_ref AND kind = 'drop' GROUP BY bank) l(bank, s);

  RETURN jsonb_build_object('pool_id', v_pool, 'amount', p_amount, 'ref', v_ref,
                            'banks', COALESCE(v_shares, '{}'::jsonb), 'rows', v_rows);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_drop(uuid, bigint, bigint, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. THE HIT (B16, B17, B19). ONE IDEMPOTENT DOOR, KEYED BY TABLE AND HAND
-- ---------------------------------------------------------------------------
-- The qualifying bar per game (B16), read out of the shared table rather than
-- carried here. bbj_qualifying_hand is one `shares`-style word listing the bar
-- per game; bbj_excluded_games is the list that has none. A game absent from
-- the map has no bar, which is the same thing as having no jackpot.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_qualifying_hand(p_variant text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE v_map text; v_hit text[];
BEGIN
  IF p_variant IS NULL OR p_variant !~ '^[a-z0-9_]+$' THEN
    RETURN NULL;
  END IF;
  v_map := public.fn_ca_diamond_economic_text('bbj_qualifying_hand');
  v_hit := regexp_match(v_map, '(?:^|,)' || p_variant || '=([A-Za-z0-9]+)(?:,|$)');
  IF v_hit IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_hit[1];
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_qualifying_hand(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- A game qualifies when it is not on the excluded list AND it has a bar. Both
-- halves matter: the excluded list is the recorded answer, and a game with no
-- bar is one nobody has priced, which must not fall through to hold'em's.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_game_qualifies(p_variant text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE v_excluded text;
BEGIN
  IF p_variant IS NULL OR p_variant !~ '^[a-z0-9_]+$' THEN
    RETURN false;
  END IF;
  v_excluded := public.fn_ca_diamond_economic_text('bbj_excluded_games');
  IF regexp_match(v_excluded, '(?:^|,)' || p_variant || '(?:,|$)') IS NOT NULL THEN
    RETURN false;
  END IF;
  RETURN public.fn_poker_diamond_jackpot_qualifying_hand(p_variant) IS NOT NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_game_qualifies(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_qualifying_hand(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- THE PAYOUT. Pool to wallet is player-side to player-side, exactly as a
-- Diamond tournament prize is: the arena float falls by what the pool paid,
-- profiles.diamonds rises by the same, and the register does not follow a
-- transfer. The journal row is written by add_diamonds_to_balance under the
-- existing 'arena_withdraw' kind - the kind fn_diamond_kind_bucket already
-- files as "Diamond Arena Cash-Outs" and fn_poker_diamond_tournament_pay
-- already uses for a prize - so this introduces no journal kind, no new
-- bucket, and nothing for the diamonds-only law to be repinned against.
--
-- Every recipient's credit claims wallet_credit_idempotency BEFORE a Diamond
-- moves, the chip credit's own order, and every ledger row carries the unique
-- (ref, bank, person, role) index. A second delivery of the same hand pays
-- nothing twice, and section 9 proves it.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_pay(
  p_table_id uuid, p_hand_number bigint, p_pot numeric, p_players_dealt integer,
  p_loser_user_id uuid, p_winner_user_id uuid, p_table_user_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE
  v_pool uuid; v_ref text; v_bb numeric; v_variant text; v_scope text;
  v_main bigint; v_pct numeric; v_paid bigint; v_shares text;
  v_loser bigint; v_winner bigint; v_table_total bigint;
  v_others uuid[]; v_n integer; v_each bigint; v_remainder bigint;
  v_rec record; v_credit jsonb; v_key text; v_inserted integer;
  v_paid_out bigint := 0; v_legs jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_ca_diamond_economic_on('bbj_enabled') THEN
    RAISE EXCEPTION 'diamond_bad_beat_jackpot_not_open' USING ERRCODE = '55000';
  END IF;
  IF p_loser_user_id IS NULL OR p_winner_user_id IS NULL
     OR p_loser_user_id = p_winner_user_id THEN
    RAISE EXCEPTION 'diamond_jackpot_needs_a_loser_and_a_winner' USING ERRCODE = '23514';
  END IF;

  SELECT t.big_blind, t.game_variant INTO v_bb, v_variant
    FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE = '23514';
  END IF;
  v_scope := public.fn_poker_diamond_jackpot_stake_scope(v_bb);

  -- B16: a game with no jackpot can never win one.
  IF NOT public.fn_poker_diamond_jackpot_game_qualifies(v_variant) THEN
    RAISE EXCEPTION 'diamond_jackpot_game_has_no_jackpot:%', v_variant USING ERRCODE = '23514';
  END IF;
  -- B15's symmetry: a stake that drops nothing can never hit.
  IF public.fn_ca_diamond_economic('bbj_drop_per_hand', v_scope) <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_stake_drops_nothing:%', v_scope USING ERRCODE = '23514';
  END IF;
  -- B17, the payout gates. The pot floor is a payout floor and only ever that.
  IF p_players_dealt IS NULL
     OR p_players_dealt < public.fn_ca_diamond_economic('bbj_min_dealt_in') THEN
    RAISE EXCEPTION 'diamond_jackpot_too_few_dealt_in:%', p_players_dealt USING ERRCODE = '23514';
  END IF;
  -- bbj_min_pot is recorded in DIAMONDS, per stake: ten big blinds of a
  -- whole-Diamond blind is a whole number of Diamonds, so the floor is stored
  -- as the figure the door compares against rather than as a multiplier the
  -- door would have to apply.
  IF p_pot IS NULL
     OR p_pot <= public.fn_ca_diamond_economic('bbj_min_pot', v_scope) THEN
    RAISE EXCEPTION 'diamond_jackpot_pot_below_the_payout_floor:%', p_pot USING ERRCODE = '23514';
  END IF;

  v_pool := public.fn_poker_diamond_jackpot_pool_for_table(p_table_id);
  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_absent' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id = v_pool FOR UPDATE;
  v_ref := 'bbjpay:' || p_table_id::text || ':' || p_hand_number::text;

  -- A REPLAY RETURNS WHAT IT PAID THE FIRST TIME AND PAYS NOTHING.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_ledger
              WHERE ref = v_ref AND kind = 'payout') THEN
    SELECT jsonb_build_object('replay', true, 'pool_id', v_pool, 'ref', v_ref,
             'paid', -COALESCE(sum(amount), 0),
             'legs', COALESCE(jsonb_agg(jsonb_build_object('role', recipient_role,
                        'user_id', recipient_user_id, 'amount', -amount) ORDER BY id), '[]'::jsonb))
      INTO v_credit FROM public.poker_diamond_jackpot_ledger
     WHERE ref = v_ref AND kind = 'payout';
    RETURN v_credit;
  END IF;

  v_main := public.fn_poker_diamond_jackpot_bank(v_pool, 'main');
  -- B19 is one shares answer per stake: what is paid, and how it divides.
  v_shares := public.fn_ca_diamond_economic_text('bbj_hit_shares', v_scope);
  v_pct  := public.fn_poker_diamond_jackpot_share(v_shares, 1, 'paid');
  -- B19, in whole Diamonds. Every division floors; what no floor could
  -- allocate STAYS IN THE MAIN POOL, because it was never allocated to a
  -- person and the pool is the players' money either way. Nothing is ever
  -- taken from a player to round a number (CLAUDE.md 10.9 condition 3).
  v_paid   := floor(v_main * v_pct / 100)::bigint;
  IF v_paid <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_pays_nothing_yet:main=%', v_main USING ERRCODE = '23514';
  END IF;
  v_loser  := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'loser')  / 100)::bigint;
  v_winner := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'winner') / 100)::bigint;
  v_table_total := v_paid - v_loser - v_winner;

  -- The rest of the table: everybody dealt in who is neither the loser nor the
  -- winner. Horses among them, on the same terms, never filtered out.
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), '{}'::uuid[]) INTO v_others
    FROM unnest(COALESCE(p_table_user_ids, '{}'::uuid[])) u
   WHERE u IS DISTINCT FROM p_loser_user_id AND u IS DISTINCT FROM p_winner_user_id;
  v_n := COALESCE(array_length(v_others, 1), 0);
  IF v_n > 0 THEN
    v_each := (v_table_total / v_n)::bigint;
  ELSE
    v_each := 0;
  END IF;
  v_remainder := v_table_total - v_each * v_n;

  -- One credit and one ledger leg per recipient.
  FOR v_rec IN
    SELECT p_loser_user_id AS user_id, 'loser'::text AS role, v_loser AS amount
    UNION ALL SELECT p_winner_user_id, 'winner', v_winner
    UNION ALL SELECT u, 'table', v_each FROM unnest(v_others) u
  LOOP
    CONTINUE WHEN v_rec.amount <= 0;
    v_key := v_ref || ':' || v_rec.role || ':' || v_rec.user_id::text;
    INSERT INTO public.wallet_credit_idempotency(key, user_id, amount)
    VALUES (v_key, v_rec.user_id, v_rec.amount) ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      RAISE EXCEPTION 'diamond_jackpot_credit_key_already_claimed:%', v_key USING ERRCODE = '23505';
    END IF;
    v_credit := public.add_diamonds_to_balance(
      v_rec.user_id, v_rec.amount::integer, 'arena_withdraw',
      'Diamond Arena Bad Beat Jackpot', v_key);
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE
       OR NULLIF(v_credit->>'transaction_id', '') IS NULL THEN
      RAISE EXCEPTION 'diamond_jackpot_credit_failed:%', v_credit->>'error' USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.poker_diamond_jackpot_ledger(
      pool_id, bank, kind, amount, table_id, hand_number,
      recipient_user_id, recipient_role, wallet_journal_id, ref, note)
    VALUES (v_pool, 'main', 'payout', -v_rec.amount, p_table_id, p_hand_number,
            v_rec.user_id, v_rec.role, (v_credit->>'transaction_id')::uuid, v_ref,
            'bad beat jackpot hit, ' || v_rec.role || ' share');
    v_paid_out := v_paid_out + v_rec.amount;
    v_legs := v_legs || jsonb_build_object('role', v_rec.role, 'user_id', v_rec.user_id,
                                           'amount', v_rec.amount);
  END LOOP;

  IF v_paid_out > v_paid THEN
    RAISE EXCEPTION 'diamond_jackpot_paid_more_than_it_took' USING ERRCODE = '23514';
  END IF;
  IF public.fn_poker_diamond_jackpot_bank(v_pool, 'main') < 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_main_bank_went_negative' USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'pool_id', v_pool, 'ref', v_ref, 'main_before', v_main, 'payout_percent', v_pct,
    'paid_total', v_paid, 'paid_out', v_paid_out,
    'left_in_main_pool', v_paid - v_paid_out,
    'loser', v_loser, 'winner', v_winner, 'table_total', v_table_total,
    'table_each', v_each, 'table_remainder_left_in_pool', v_remainder,
    'qualifying_hand', public.fn_poker_diamond_jackpot_qualifying_hand(v_variant),
    'legs', v_legs);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_pay(uuid, bigint, numeric, integer, uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. AFTER A HIT, AND IF THE JACKPOT IS EVER WITHDRAWN (B21, B22)
-- ---------------------------------------------------------------------------
-- THE RESEED. Three pools exist for this: when a hit empties main, the backup
-- reserve becomes the new main jackpot, so the product does not restart at
-- zero. It is fn_bbj_reseed_main_from_backup's rule with both legs written, so
-- the ledger still sums to what the jackpot holds. An empty reserve is not a
-- refusal - the hit is paid and the pool is what it is - and it is not silent
-- either; it is reported to the caller.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_reseed(p_pool_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE v_main bigint; v_backup bigint; v_ref text;
BEGIN
  PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id = p_pool_id FOR UPDATE;
  v_main   := public.fn_poker_diamond_jackpot_bank(p_pool_id, 'main');
  v_backup := public.fn_poker_diamond_jackpot_bank(p_pool_id, 'backup');
  IF v_main > 0 THEN
    RETURN jsonb_build_object('reseeded', false, 'reason', 'main is not empty', 'main', v_main);
  END IF;
  IF v_backup <= 0 THEN
    RETURN jsonb_build_object('reseeded', false, 'reason', 'the reserve is empty; the jackpot restarts at 0',
                              'main', v_main, 'backup', v_backup);
  END IF;
  v_ref := 'bbjreseed:' || p_pool_id::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  INSERT INTO public.poker_diamond_jackpot_ledger(pool_id, bank, kind, amount, ref, note)
  VALUES (p_pool_id, 'backup', 'reseed_out', -v_backup, v_ref,
          'reseed: a hit emptied main; the reserve becomes the new main jackpot'),
         (p_pool_id, 'main',   'reseed_in',   v_backup, v_ref,
          'reseed: a hit emptied main; the reserve becomes the new main jackpot');
  RETURN jsonb_build_object('reseeded', true, 'amount', v_backup, 'ref', v_ref,
                            'main', public.fn_poker_diamond_jackpot_bank(p_pool_id, 'main'));
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_reseed(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- B22. The pool moves to the surviving pool and the retired pool is marked
-- retired_settled naming it, which is exactly what the one chip pool ever
-- withdrawn did. NEVER TO THE HOUSE: the pool is money owed to players, and
-- under design rule R1 nothing player-owned may be parked in the house.
-- The second branch - no pool survives, the product itself withdrawn - is the
-- recorded fallback account, and it is deliberately NOT implemented as a
-- movement here: paying every contributor pro rata is a distribution to named
-- people, and this door refuses by name rather than guess at it, so nobody can
-- withdraw the last pool by accident and leave the Diamonds nowhere.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_withdraw(
  p_pool_id uuid, p_into_pool_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
DECLARE v_ref text; v_moved jsonb := '{}'::jsonb; v_b record; v_total bigint := 0;
BEGIN
  IF public.fn_ca_diamond_economic_text('bbj_withdrawal_destination')
     <> 'surviving_diamond_jackpot_pool' THEN
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_destination_is_not_a_pool' USING ERRCODE = '23514';
  END IF;
  IF p_into_pool_id IS NULL THEN
    -- B22's second branch is recorded in the same row's basis, and paying
    -- every contributor pro rata is a distribution to named people. This door
    -- refuses rather than guessing at it, so the last pool cannot be withdrawn
    -- by accident and leave the Diamonds nowhere.
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_needs_a_surviving_pool:contributing_players_pro_rata'
      USING ERRCODE = '23514';
  END IF;
  IF p_into_pool_id = p_pool_id THEN
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_into_itself' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.poker_diamond_jackpot_pools
   WHERE id IN (p_pool_id, p_into_pool_id) ORDER BY id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_pools
                  WHERE id = p_into_pool_id AND status = 'active') THEN
    RAISE EXCEPTION 'diamond_jackpot_surviving_pool_is_not_active' USING ERRCODE = '23514';
  END IF;
  v_ref := 'bbjwithdraw:' || p_pool_id::text;
  FOR v_b IN SELECT b AS bank, public.fn_poker_diamond_jackpot_bank(p_pool_id, b) AS held
               FROM unnest(ARRAY['main', 'backup', 'promotional']) b LOOP
    CONTINUE WHEN v_b.held <= 0;
    INSERT INTO public.poker_diamond_jackpot_ledger(pool_id, bank, kind, amount, ref, note)
    VALUES (p_pool_id,      v_b.bank, 'merge_out', -v_b.held, v_ref,
            'the jackpot is withdrawn; this bank moves to the surviving pool'),
           (p_into_pool_id, v_b.bank, 'merge_in',   v_b.held, v_ref || ':in',
            'a withdrawn jackpot''s ' || v_b.bank || ' bank arrives');
    v_total := v_total + v_b.held;
    v_moved := v_moved || jsonb_build_object(v_b.bank, v_b.held);
  END LOOP;
  UPDATE public.poker_diamond_jackpot_pools
     SET status = 'retired_settled', merged_into_pool_id = p_into_pool_id, updated_at = now()
   WHERE id = p_pool_id;
  IF public.fn_poker_diamond_jackpot_bank(p_pool_id, 'main')
     + public.fn_poker_diamond_jackpot_bank(p_pool_id, 'backup')
     + public.fn_poker_diamond_jackpot_bank(p_pool_id, 'promotional') <> 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_withdrawal_left_diamonds_behind' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('pool_id', p_pool_id, 'into', p_into_pool_id,
                            'moved', v_moved, 'total', v_total, 'ref', v_ref);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_withdraw(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. THE SUBSTITUTION HELPER (temporary; ends with this session)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

-- ---------------------------------------------------------------------------
-- 9. THE ARENA FLOAT LEARNS THE POOL (design rule R5)
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_arena_diamonds()',
  '86863a1208455e92803777829bc9a668', '7085478e8588ae608838c01f938755d2',
  ARRAY[$o$   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open');$o$],
  ARRAY[$n$   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open')
   -- R5: A NEW HOLDING IS COUNTED IN THE MIGRATION THAT CREATES IT. The bad
   -- beat jackpot pool sits inside the arena float, so a drop is custody to
   -- pool - arena to arena - and the money identity never moves.
   +public.fn_poker_diamond_jackpot_diamonds();$n$]);

-- The watchlist is reached through EXECUTE because plpgsql parses a whole IF
-- condition before it evaluates any of it, so a direct call would fail to
-- parse in the isolated fixture, where the estate's guard machinery is absent.
DO $declare$
DECLARE v_watched boolean := false;
BEGIN
  IF to_regprocedure('public.fn_ca_guard_watchlist()') IS NULL
     OR to_regprocedure('public.fn_ca_declare_guard_redefinition(text,text)') IS NULL THEN
    RAISE NOTICE 'the guard watchlist is absent; fn_ca_arena_diamonds is redefined without a declaration';
    RETURN;
  END IF;
  EXECUTE $q$SELECT 'fn_ca_arena_diamonds' = ANY (public.fn_ca_guard_watchlist())$q$ INTO v_watched;
  IF v_watched THEN
    EXECUTE format('SELECT public.fn_ca_declare_guard_redefinition(%L, %L)', 'fn_ca_arena_diamonds',
      'migration 20261005152000_the_diamond_jackpot_is_decided_and_its_pool_is_player_side');
  END IF;
END $declare$;

-- ---------------------------------------------------------------------------
-- 10. THE SETTLER'S CONSERVATION RULE, AND ITS RECOMPUTATION
-- ---------------------------------------------------------------------------
-- Six layers refuse a Diamond deduction today. NONE OF THEM IS WEAKENED HERE.
-- Layers 1 and 2 keep the table's rake_percent, rake_cap_bb and bbj_percent at
-- an explicit 0, so the chip schedule can never reach a Diamond table. Layer 3
-- (HandController) and applyJointDeductions still refuse a non-zero Diamond
-- deduction; this migration does not touch the engine. Layer 4
-- (assertDiamondAcceptedHand) still requires rake, bbj, inflow and
-- insuranceCount at zero. Layer 6 (fn_ca_commit_hand_settlement) still refuses
-- a chip rake object, a chip bbj_contribution object and any insurance item on
-- a Diamond hand - forever.
--
-- What changes is layer 5, and only in the one way the design asks for: its
-- refusal of a jackpot drop becomes CONDITIONAL on bbj_enabled and RECOMPUTED
-- against the schedule, and its conservation rule becomes "the deltas sum to
-- minus the drop" instead of "the deltas sum to zero". Rake and insurance stay
-- refused unconditionally in the same statement. With bbj_enabled at 0 the
-- behaviour is byte-for-byte the behaviour of today.
SELECT pg_temp.ca_audit_subst(
  'public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
  '3aab9170062e97840afc7d15999691ad', 'e9761c3ed7b52d2aec90bcf0e6226812',
  ARRAY[$o$  v_result jsonb;
$o$,
$o$  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number < 1000000
     OR COALESCE(p_rake,0) <> 0 OR COALESCE(p_bbj,0) <> 0
     OR COALESCE(p_inflow,0) <> 0 THEN
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
$o$,
$o$  IF (SELECT sum((x->>'stack')::numeric - (x->>'stack_before')::numeric)
      FROM jsonb_array_elements(p_stacks) x) <> 0 THEN
    RAISE EXCEPTION 'diamond_hand_does_not_conserve' USING ERRCODE='23514';
  END IF;
$o$,
$o$  SELECT t.club_id INTO v_arena FROM public.tables t
$o$,
$o$    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;
$o$,
$o$  v_result := jsonb_build_object('success',true,'asset','diamonds',
$o$,
$o$    'written',v_written,'departed','[]'::jsonb,'conservation_checked',true,
    'request',v_request);
$o$],
  ARRAY[$n$  v_result jsonb;
  v_bbj numeric := 0;
  v_due bigint;
  v_bb numeric;
  v_drop jsonb;
$n$,
$n$  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number < 1000000
     OR COALESCE(p_rake,0) <> 0
     OR COALESCE(p_inflow,0) <> 0 THEN
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  -- THE BAD BEAT JACKPOT DROP IS THE ONE DEDUCTION A DIAMOND CASH HAND MAY
  -- CARRY, AND ONLY WHEN IT IS OPEN AND AGREES WITH THE SCHEDULE (2026-10-05).
  -- Rake and insurance are still refused above, unconditionally and in the
  -- same breath. This is not the old refusal removed: it is the old refusal
  -- made CONDITIONAL AND RECOMPUTED. With bbj_enabled at 0 - which is what it
  -- is - this function refuses a non-zero p_bbj exactly as it did before, and
  -- by name.
  v_bbj := COALESCE(p_bbj,0);
  IF v_bbj <> 0 THEN
    IF v_bbj < 0 OR v_bbj <> trunc(v_bbj) THEN
      RAISE EXCEPTION 'diamond_bbj_must_be_whole_diamonds' USING ERRCODE='22023';
    END IF;
    IF NOT public.fn_ca_diamond_economic_on('bbj_enabled') THEN
      RAISE EXCEPTION 'diamond_bad_beat_jackpot_not_open' USING ERRCODE='22023';
    END IF;
  END IF;
$n$,
$n$  -- CONSERVATION, WITH THE DROP IN IT. The stacks after a hand sum to the
  -- stacks before LESS the jackpot drop, and to nothing else: a drop is the
  -- only thing that may leave the felt, and the jackpot ledger row written
  -- below is where those Diamonds arrive. With no drop this is the identical
  -- check it has always been.
  IF (SELECT sum((x->>'stack')::numeric - (x->>'stack_before')::numeric)
      FROM jsonb_array_elements(p_stacks) x) <> -v_bbj THEN
    RAISE EXCEPTION 'diamond_hand_does_not_conserve' USING ERRCODE='23514';
  END IF;
$n$,
$n$  SELECT t.club_id, t.big_blind INTO v_arena, v_bb FROM public.tables t
$n$,
$n$    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;
  -- THE SETTLER DOES NOT TAKE THE ENGINE'S NUMBER ON TRUST (design section 5,
  -- step 3). It recomputes what this stake owes from ca_diamond_economics and
  -- refuses a disagreement by name. An unset value refuses under its own name
  -- through the shared reader's SQLSTATE PDE01, never by falling back to a
  -- chip schedule, to another stake's price or to a literal.
  IF v_bbj <> 0 THEN
    v_due := public.fn_poker_diamond_jackpot_drop_due(p_table_id);
    IF v_due IS DISTINCT FROM v_bbj::bigint THEN
      RAISE EXCEPTION 'diamond_bbj_amount_disagrees_with_the_schedule:% is not %', v_bbj, v_due
        USING ERRCODE='23514';
    END IF;
  END IF;
$n$,
$n$  -- The Diamonds have left the felt by now, so this is the row that records
  -- where they went: custody down by the drop, the pool up by the drop, the
  -- arena float unchanged. Design rule R4 - one pool write per hand, and
  -- never a write to ca_diamond_house row 1.
  IF v_bbj <> 0 THEN
    v_drop := public.fn_poker_diamond_jackpot_drop(p_table_id,p_hand_number,v_bbj::bigint,v_stacks);
  END IF;
  v_result := jsonb_build_object('success',true,'asset','diamonds',
$n$,
$n$    'written',v_written,'departed','[]'::jsonb,'conservation_checked',true,
    'bbj_drop',v_drop,
    'request',v_request);
$n$]);

-- The watchlist is reached through EXECUTE because plpgsql parses a whole IF
-- condition before it evaluates any of it, so a direct call would fail to
-- parse in the isolated fixture, where the estate's guard machinery is absent.
DO $declare$
DECLARE v_watched boolean := false;
BEGIN
  IF to_regprocedure('public.fn_ca_guard_watchlist()') IS NULL
     OR to_regprocedure('public.fn_ca_declare_guard_redefinition(text,text)') IS NULL THEN
    RAISE NOTICE 'the guard watchlist is absent; fn_poker_diamond_settle_cash_hand is redefined without a declaration';
    RETURN;
  END IF;
  EXECUTE $q$SELECT 'fn_poker_diamond_settle_cash_hand' = ANY (public.fn_ca_guard_watchlist())$q$ INTO v_watched;
  IF v_watched THEN
    EXECUTE format('SELECT public.fn_ca_declare_guard_redefinition(%L, %L)', 'fn_poker_diamond_settle_cash_hand',
      'migration 20261005152000_the_diamond_jackpot_is_decided_and_its_pool_is_player_side');
  END IF;
END $declare$;

-- ---------------------------------------------------------------------------
-- 11. NO DIAMOND JACKPOT ROW EVER REACHES A CHIP JACKPOT POOL
-- ---------------------------------------------------------------------------
-- Design section 4, step 0, narrowed to the two tables this lane owns.
-- bbj_pools and bbj_contributions accept a Diamond Arena row today - 0 such
-- rows exist, measured - and the reason they must not is the reason the
-- boundary audit gives: "BBJ pools are club and union chip pools". A Diamond
-- jackpot row in bbj_pools would be pulled into the union weekly close, the
-- club rake rollups, the invoices and the rakeback settler's watermark.
--
-- This is the poker_arena_no_hierarchy pattern: the leg is not removed, it is
-- made to REFUSE BY NAME. The other chip money tables in that step 0 list
-- (rake_records, rake_attributions, club_wallets, chip_ledger,
-- tournament_guarantee_overlays, tournament_tickets,
-- accounting_payable_earning_sources) belong to the rake lane and the step 0
-- lane, and this migration deliberately leaves them alone rather than taking
-- another lane's work with it.
CREATE OR REPLACE FUNCTION public.fn_poker_reject_diamond_chip_jackpot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_club uuid; v_arena uuid;
BEGIN
  SELECT club_id INTO v_arena FROM public.ca_arena_settings WHERE id = 1;
  v_club := CASE TG_TABLE_NAME
              WHEN 'bbj_pools'         THEN NEW.club_id
              WHEN 'bbj_contributions' THEN NEW.club_id
              ELSE NULL END;
  IF v_arena IS NOT NULL AND v_club IS NOT DISTINCT FROM v_arena THEN
    RAISE EXCEPTION 'The Diamond Arena Has No Chip Jackpot Pool Or Chip Contribution'
      USING ERRCODE = '23514';
  END IF;
  IF v_club IS NOT NULL AND EXISTS (SELECT 1 FROM public.clubs c
                                     WHERE c.id = v_club AND c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'The Diamond Arena Has No Chip Jackpot Pool Or Chip Contribution'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_reject_diamond_chip_jackpot() FROM PUBLIC, anon, authenticated;

DO $fence$
DECLARE v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['bbj_pools', 'bbj_contributions'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = ('public.' || v_t)::regclass
                      AND tgname = 'poker_arena_no_chip_jackpot') THEN
      EXECUTE format(
        'CREATE TRIGGER poker_arena_no_chip_jackpot BEFORE INSERT OR UPDATE ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_jackpot()', v_t);
    END IF;
  END LOOP;
END $fence$;

-- ---------------------------------------------------------------------------
-- 12. THE POOL THE ARENA DROPS INTO
-- ---------------------------------------------------------------------------
-- The pool must exist before the first hand; creating it is the product's
-- design and not a repair step. It starts at nothing, because B20 is "no
-- seed": its first Diamond will arrive from a hand.
INSERT INTO public.poker_diamond_jackpot_pools(arena_id)
SELECT s.club_id FROM public.ca_arena_settings s
 WHERE s.id = 1 AND s.club_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_pools j
                    WHERE j.arena_id = s.club_id AND j.status = 'active');

-- ---------------------------------------------------------------------------
-- 13. THE ANSWERS (B12 to B22), IN THE SHARED TABLE'S OWN NAMES AND UNITS
-- ---------------------------------------------------------------------------
-- approved_quote carries the AUTHORITY: Dan's grant of 2026-10-05, verbatim,
-- which is why these rows exist at all. basis carries the DERIVATION: what in
-- this platform produced the value. The two are separate columns on purpose,
-- so no row can be read as Dan having approved a figure he never saw. Both
-- columns, and the closed name list and units map these rows obey, belong to
-- 20261005151918; this lane adds rows and alters nothing but the account list.
DO $answers$
DECLARE
  v_quote text := 'NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO.';
  v_on    date := DATE '2026-10-05';
  v_by    text := 'claude/diamond-bbj-20261005 (derived from production, read 2026-10-05)';
  v_bb    numeric; v_fee numeric; v_pct numeric; v_drop bigint; v_tier text;
BEGIN
  -- B14. YES, and the switch is recorded as 'no' because a drop can only come
  -- out of a cash pot and ca_arena_settings.cash_games_enabled is false. Every
  -- value B15 to B22 needs is written below, so turning it on is one appended
  -- row and cannot land on an unset number.
  INSERT INTO public.ca_diamond_economics(name, scope, value_text, units, approved_quote, approved_on, basis, recorded_by)
  VALUES ('bbj_enabled', 'all', 'no', 'boolean', v_quote, v_on,
    'B14 = YES, there is a Diamond Bad Beat Jackpot: the Diamond Arena is a diamonds-only clone of a chip club and the chip club runs one on every eligible cash game. The six DiamondCashBoundary layers refuse a CHIP jackpot object because "the counterparty does not exist" (bbj_pools are club and union chip pools), not because the product was declined; this migration builds the Diamond counterparty. THE SWITCH IS RECORDED AS no, and that is an answer rather than a default: a drop can only be taken from a cash pot and cash_games_enabled is false. Every value B15 to B22 needs is recorded in this migration, so turning it on is one appended row and cannot land on an unset number.',
    v_by);

  -- B16. One recorded map of bars, and one recorded list of games that have
  -- none. Taken verbatim from BBJ_QUALIFYING_HANDS in
  -- server/src/config/RakeConfig.ts and ca_rake_rules.bbj_ineligible_variants.
  INSERT INTO public.ca_diamond_economics(name, scope, value_text, units, approved_quote, approved_on, basis, recorded_by)
  VALUES
   ('bbj_qualifying_hand', 'all',
    'nlh=AAAJJ,flh=AAAJJ,plo4=KKKK2,flo4=KKKK2,plo5=87654,flo5=87654,plo8=KKKK2,flo8=KKKK2,pineapple=KKKK2',
    'hand', v_quote, v_on,
    'B16, verbatim from BBJ_QUALIFYING_HANDS in server/src/config/RakeConfig.ts, because which hand qualifies is a property of the GAME and not of the currency. nlh and flh: a full house, aces full of jacks, or better must lose to quads or a straight flush, the holder must have at least one ace among their hole cards, and both hole cards must play. plo4 and flo4: four kings or better must lose, exactly two hole cards playing. plo5 and flo5: an eight-high straight flush or better. plo8 and flo8: four kings or better on the HIGH hand only. pineapple: four kings or better. The three rules beside them also hold as the chip estate runs them: a double or triple board hand is excluded, only the first runout counts, and where more than one loser qualifies the STRONGEST qualifying losing hand takes it (BBJ_RULES.splitIfMultipleQualify is false, set to what the engine does on 2026-09-11 because a flag nothing enforced was being printed to players as the rule). A game absent from this map has no bar, which is the same thing as having no jackpot: nothing falls through to hold''em''s.',
    v_by),
   ('bbj_excluded_games', 'all', 'plo6,short_deck', 'game_list', v_quote, v_on,
    'B16: ca_rake_rules.bbj_ineligible_variants = {plo6, short_deck}, read on production 2026-10-05. The chip estate''s own rule is that a variant that drops nothing can never win one, and the Diamond doors enforce both halves.',
    v_by);

  -- B17. The players-dealt floor. The pot floor is per stake, below.
  INSERT INTO public.ca_diamond_economics(name, scope, value, units, approved_quote, approved_on, basis, recorded_by)
  VALUES ('bbj_min_dealt_in', 'all', 3, 'players', v_quote, v_on,
    'B17: ca_rake_rules.bbj_min_players_dealt = 3, read on production 2026-10-05, and it is the floor for the drop AND for the hit (BBJ_RULES.miniMinPlayersDealt ships equal to minPlayersDealt "so nothing changes until somebody sets it"). A player count is a player count in any currency, so nothing needed converting. A FLOP IS ALSO REQUIRED TO DROP, which is a rule rather than a number: ca_rake_rules.no_flop_no_drop is true and RakeConfig.ts collects the fee only on a flop. There is NO SMALLEST POT for the drop - RakeConfig.ts says of the pot floor, verbatim, "PAYOUT floor ONLY (Dan 2026-08-29) ... The FEE is collected on every flop with 3+ dealt regardless of pot size - do not re-add this to a fee gate."',
    v_by);

  -- B18. One shares answer, both regimes, with the grammar section 1b fixes.
  INSERT INTO public.ca_diamond_economics(name, scope, value_text, units, approved_quote, approved_on, basis, recorded_by)
  VALUES ('bbj_pool_split', 'all',
    'main=50,backup=25,promotional=25;pivot_at=100000,main=25,backup=25,promotional=50',
    'shares', v_quote, v_on,
    'B18 = THREE POOLS, from ca_bbj_policy row 1 read on production 2026-10-05: standard_main 0.50, standard_backup 0.25, promo the remainder; pivot_threshold 100000, above which pivot_main 0.25, pivot_backup 0.25 and promo 0.50. Three pools are load-bearing and not decoration: fn_bbj_reseed_main_from_backup is what lets a jackpot survive a 100 percent hit, so a one-pool product would restart at zero on every hit. The pivot threshold is the one figure cloned by UNIT COUNT rather than by economic equivalence - 100,000 of the asset, where the asset is now the Diamond - and it is one appended row to change. THE REMAINDER RULE, because a 1 Diamond drop cannot split 50/25/25: the chip allocator''s own carried residue (fn_bbj_allocate(numeric,numeric,uuid) with ca_bbj_alloc_state) at the Diamond''s unit. main and backup each take floor(exact share + carried residue) and carry what is left; promotional takes the remainder, so the three re-sum to the drop EXACTLY every hand. Flooring rather than rounding keeps each residue in [0,1), so no bank is ever credited ahead of its exact cumulative share: main and backup are each at most one Diamond behind theirs, promotional at most two ahead.',
    v_by);

  -- B20 and B21.
  INSERT INTO public.ca_diamond_economics(name, scope, value, units, approved_quote, approved_on, basis, recorded_by)
  VALUES
   ('bbj_seed', 'all', 0, 'diamonds', v_quote, v_on,
    'B20 = NO SEED, and no account funds it, so bbj_seed_account is deliberately not recorded: with a seed of 0 the question does not arise, and the reader refusing that name is the correct behaviour. Measured on production 2026-10-05, not reasoned: of the 402 rows in bbj_pools, the count whose main+backup+promo exceeds total_contributed less total_paid_out is ZERO. The chip estate has never seeded a pool in its history, and the backup reserve is why it does not have to. Consequences: no house earmark, no Mint issuance for a jackpot, design rule R3 never engages, and the pool is player-side from its first hand - which is just as well, since ca_diamond_house holds 0 Diamonds.',
    v_by),
   ('bbj_pool_ceiling', 'all', 0, 'diamonds', v_quote, v_on,
    'B21 = NO MAXIMUM, so no drop is ever turned away, and 0 in this unit is read as "no ceiling" by the only door that could enforce one - which never turns a drop away at all. bbj_pool_ceiling_destination is therefore deliberately not recorded: with no ceiling there is nowhere for a turned-away drop to go. The chip estate has no maximum either; what it has is the pivot above, which steers the larger share of every drop into promotional once main reaches the threshold and is the mechanism that bounds main. A maximum would have to send a drop somewhere, and under ruling 21 a platform pot never refuses a player.',     v_by);
  INSERT INTO public.ca_diamond_economics(name, scope, value_text, units, approved_quote, approved_on, basis, recorded_by)
  VALUES
   -- B22. The account this names did not exist on the shared closed list
   -- before this migration, and must not have been the house.
   ('bbj_withdrawal_destination', 'all', 'surviving_diamond_jackpot_pool', 'account', v_quote, v_on,
    'B22: the one chip pool ever withdrawn (0867a7fd-58d9-4768-9919-06532afe79f3, read on production 2026-10-05) reads status retired_settled, merged_into_pool_id f9806a7f-e7a2-47d2-a676-36336e3a5337 and all three balances 0. Its money went to the SURVIVING POOL. NEVER TO THE HOUSE: the pool is money owed to players, so under design rule R1 nothing of it may be parked in the house and under CLAUDE.md 10.9 condition 3 nothing is taken back from a player for our mistake. SECOND BRANCH, if no pool survives because the product itself is withdrawn: the pool is paid to the players who contributed to it, in proportion to their recorded contributions (the payer rows of its own ledger), floored to whole Diamonds with the remainder to the largest contributor and ties broken by the earliest contribution. fn_poker_diamond_jackpot_withdraw refuses by name rather than guessing at that distribution, so the last pool cannot be withdrawn by accident and leave the Diamonds nowhere.',
    v_by);

  -- B15, B17's pot floor and B19, per stake. Derived here from the tier ladder
  -- rather than typed, so the derivation is visible and the rows cannot
  -- disagree with it.
  FOR v_bb IN SELECT * FROM unnest(ARRAY[2, 5, 10, 20, 25, 50, 100, 200, 400, 500,
                                         600, 800, 1000, 2000, 2500, 5000, 10000]::numeric[]) LOOP
    -- bbj_stakes_tiers, as read on production 2026-10-05.
    SELECT x.tier, x.fee, x.pct INTO v_tier, v_fee, v_pct FROM (VALUES
      ('nano',        0.01,     0.20, 0.60, 15),
      ('micro',       0.21,     0.80, 0.60, 25),
      ('small',       0.81,     3.00, 0.25, 40),
      ('mid',         3.01,     8.00, 0.12, 55),
      ('high',        8.01,    40.00, 0.06, 70),
      ('nosebleeds', 40.01, 99999.00, 0.03, 85)
    ) x(tier, min_bb, max_bb, fee, pct)
     WHERE v_bb <= x.max_bb ORDER BY x.max_bb LIMIT 1;
    -- THE FLOOR IS THE DERIVATION. fn_ca_unit_floor_cents and the Diamond
    -- tournament fee both floor a proportional charge at the whole unit, which
    -- is why an entry under 10 Diamonds pays no fee at all.
    v_drop := floor(v_bb * v_fee)::bigint;

    INSERT INTO public.ca_diamond_economics(name, scope, value, units, approved_quote, approved_on, basis, recorded_by)
    VALUES
     ('bbj_drop_per_hand', public.fn_poker_diamond_jackpot_stake_scope(v_bb), v_drop,
      'diamonds_per_hand', v_quote, v_on,
      format('B15: floor(big blind %s * the %s tier''s bbj_fee_bb %s) = %s whole Diamonds. The chip drop is published in BIG BLIND units, which carry no currency, so the schedule transfers; and a Diamond is whole, so the proportional charge floors at the unit exactly as fn_ca_unit_floor_cents and the Diamond tournament fee do.%s',
             v_bb, v_tier, v_fee, v_drop,
             CASE WHEN v_drop = 0 THEN ' THIS STAKE DROPS NOTHING, for the same reason a 9 Diamond entry pays no fee: the proportional charge is smaller than the smallest thing that exists. By the chip estate''s own symmetry rule - a variant that drops nothing "can never win one" - it can never hit either, and the hit door refuses it by name.' ELSE '' END),
      v_by),
     ('bbj_min_pot', public.fn_poker_diamond_jackpot_stake_scope(v_bb), 10 * v_bb,
      'diamonds', v_quote, v_on,
      format('B17, the PAYOUT floor only: ca_rake_rules.bbj_min_pot_bb = 10, read on production 2026-10-05, which at a %s Diamond big blind is %s Diamonds. Ten big blinds of a whole-Diamond blind is a whole number of Diamonds, so nothing needed flooring, and it is recorded as the figure the door compares against rather than as a multiplier the door would have to apply. There is no smallest pot that DROPS.',
             v_bb, 10 * v_bb),
      v_by);

    INSERT INTO public.ca_diamond_economics(name, scope, value_text, units, approved_quote, approved_on, basis, recorded_by)
    VALUES ('bbj_hit_shares', public.fn_poker_diamond_jackpot_stake_scope(v_bb),
      format('paid=%s,loser=50,winner=25,table=25', v_pct), 'shares', v_quote, v_on,
      format('B19: the %s tier''s payout_total_pct, %s percent of the MAIN pool, from bbj_stakes_tiers as read on production 2026-10-05; and half of what is paid to the losing player, a quarter to the winning player, a quarter among the rest of the table. Those three shares are not chosen: ALL SIX live tier rows carry payout_loser_pct, payout_winner_pct and payout_table_pct as exactly 1/2, 1/4 and 1/4 of payout_total_pct (7.50/3.75/3.75 of 15 through 42.50/21.25/21.25 of 85). Every division floors, and every Diamond no floor could allocate STAYS IN THE MAIN POOL: it was never allocated to a person, the pool is the players'' money either way, and nothing is taken from anybody to round a number (CLAUDE.md 10.9 condition 3).',
             v_tier, v_pct),
      v_by);
  END LOOP;
END $answers$;

-- ---------------------------------------------------------------------------
-- 14. WHAT MUST NOW BE TRUE
-- ---------------------------------------------------------------------------
DO $after$
DECLARE
  v_settler text; v_arena text; v_pool uuid; v_n integer;
  v_cash boolean; v_tourn boolean; v_diff numeric;
  v_main bigint; v_backup bigint; v_promo bigint;
  v_fn record;
BEGIN
  -- THE SWITCHES ARE EXACTLY AS THEY WERE FOUND. cash_games_enabled is held
  -- elsewhere and opening it is not this migration's to do;
  -- tournaments_enabled was already true on 2026-10-05 and stays true.
  SELECT cash_games_enabled, tournaments_enabled INTO v_cash, v_tourn
    FROM public.ca_arena_settings WHERE id = 1;
  IF v_cash IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'this migration must not open the Diamond cash door';
  END IF;
  IF v_tourn IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'tournaments_enabled moved; it was true before this migration';
  END IF;

  -- THE JACKPOT IS NOT OPEN, AND HOLDS NOTHING. Amounts held at zero is what
  -- the design asks for before the switch is flipped.
  IF public.fn_ca_diamond_economic_on('bbj_enabled') THEN
    RAISE EXCEPTION 'this migration must not open the bad beat jackpot';
  END IF;
  IF public.fn_poker_diamond_jackpot_diamonds() <> 0 THEN
    RAISE EXCEPTION 'the Diamond jackpot holds % Diamonds and this migration seeded none',
      public.fn_poker_diamond_jackpot_diamonds();
  END IF;
  SELECT count(*) INTO v_n FROM public.poker_diamond_jackpot_ledger;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the jackpot ledger carries % rows before its first hand', v_n;
  END IF;

  -- ONE ACTIVE POOL FOR THE ARENA, AND IT IS THE ARENA'S.
  SELECT count(*) INTO v_n FROM public.poker_diamond_jackpot_pools WHERE status = 'active';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the Diamond Arena has % active jackpot pools, not one', v_n;
  END IF;
  SELECT j.id INTO v_pool FROM public.poker_diamond_jackpot_pools j
    JOIN public.ca_arena_settings s ON s.club_id = j.arena_id AND s.id = 1
   WHERE j.status = 'active';
  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'the active jackpot pool does not belong to the Diamond Arena club';
  END IF;

  -- THE ALLOCATOR CONSERVES AT THE SMALLEST DROP THERE IS. One Diamond cannot
  -- split 50/25/25, and this is the proof that the carried residue handles it:
  -- B18's rule is exercised here against the pool, in this transaction, and
  -- rolled back below so the migration leaves the pool untouched.
  SELECT * INTO v_main, v_backup, v_promo
    FROM public.fn_poker_diamond_jackpot_allocate(v_pool, 1);
  IF v_main + v_backup + v_promo <> 1 THEN
    RAISE EXCEPTION 'a one Diamond drop allocated to % + % + %, which is not 1',
      v_main, v_backup, v_promo;
  END IF;
  IF v_main <> 0 THEN
    RAISE EXCEPTION 'main took % of a one Diamond drop; half a Diamond cannot be paid', v_main;
  END IF;
  -- THE RESIDUE IS CARRIED, NOT DISCARDED. The first drop left half a Diamond
  -- owed to main; this one adds the other half, so main must now take a whole
  -- Diamond. A rule that threw the fraction away would take nothing here, and
  -- main would be short a Diamond for every two hands it was ever dropped on.
  SELECT * INTO v_main, v_backup, v_promo
    FROM public.fn_poker_diamond_jackpot_allocate(v_pool, 1);
  IF v_main + v_backup + v_promo <> 1 THEN
    RAISE EXCEPTION 'the second one Diamond drop did not conserve';
  END IF;
  IF v_main <> 1 THEN
    RAISE EXCEPTION 'the carried residue was discarded: main took % of the second one Diamond drop, not the whole Diamond it was owed', v_main;
  END IF;
  SELECT * INTO v_main, v_backup, v_promo
    FROM public.fn_poker_diamond_jackpot_allocate(v_pool, 2);
  IF v_main + v_backup + v_promo <> 2 THEN
    RAISE EXCEPTION 'a two Diamond drop did not conserve';
  END IF;
  UPDATE public.poker_diamond_jackpot_pools
     SET main_residue = 0, backup_residue = 0 WHERE id = v_pool;

  -- THE DROP SCHEDULE IS COMPLETE FOR EVERY LIVE DIAMOND STAKE, and the three
  -- lowest owe nothing.
  SELECT count(*) INTO v_n FROM public.ca_diamond_economics
   WHERE name = 'bbj_drop_per_hand';
  IF v_n <> 17 THEN
    RAISE EXCEPTION 'the drop schedule names % stakes, not the 17 that exist', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.ca_diamond_economics
   WHERE name IN ('bbj_min_pot', 'bbj_hit_shares');
  IF v_n <> 34 THEN
    RAISE EXCEPTION 'the pot floor and the hit shares do not name all 17 stakes each (% rows)', v_n;
  END IF;
  IF public.fn_ca_diamond_economic('bbj_drop_per_hand', 'bb:2') <> 0
     OR public.fn_ca_diamond_economic('bbj_drop_per_hand', 'bb:5') <> 0
     OR public.fn_ca_diamond_economic('bbj_drop_per_hand', 'bb:10') <> 0
     OR public.fn_ca_diamond_economic('bbj_drop_per_hand', 'bb:20') <> 1
     OR public.fn_ca_diamond_economic('bbj_drop_per_hand', 'bb:100') <> 3
     OR public.fn_ca_diamond_economic('bbj_drop_per_hand', 'bb:10000') <> 300 THEN
    RAISE EXCEPTION 'the drop schedule does not read back as the floor of the tier fee';
  END IF;
  IF public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_hit_shares', 'bb:2'), 1, 'paid') <> 40
     OR public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_hit_shares', 'bb:5'), 1, 'paid') <> 55
     OR public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_hit_shares', 'bb:25'), 1, 'paid') <> 70
     OR public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_hit_shares', 'bb:50'), 1, 'paid') <> 85 THEN
    RAISE EXCEPTION 'the payout ladder does not read back as the tier percentages';
  END IF;
  IF public.fn_ca_diamond_economic('bbj_min_pot', 'bb:20') <> 200 THEN
    RAISE EXCEPTION 'the payout floor is not ten big blinds in Diamonds';
  END IF;

  -- THE SHARES RE-SUM TO THE WHOLE, IN BOTH REGIMES AND IN EVERY HIT.
  IF public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_pool_split'), 1, 'main')
     + public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_pool_split'), 1, 'backup')
     + public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_pool_split'), 1, 'promotional') <> 100
     OR public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_pool_split'), 2, 'main')
     + public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_pool_split'), 2, 'backup')
     + public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_pool_split'), 2, 'promotional') <> 100 THEN
    RAISE EXCEPTION 'a pool split regime does not account for the whole drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ca_diamond_economics e
     WHERE e.name = 'bbj_hit_shares'
       AND public.fn_poker_diamond_jackpot_share(e.value_text, 1, 'loser')
         + public.fn_poker_diamond_jackpot_share(e.value_text, 1, 'winner')
         + public.fn_poker_diamond_jackpot_share(e.value_text, 1, 'table') <> 100) THEN
    RAISE EXCEPTION 'a hit share does not account for the whole of what is paid';
  END IF;

  -- B16 READS BACK AS THE CHIP ESTATE STATES IT, including the two games that
  -- have no jackpot and therefore no bar.
  IF public.fn_poker_diamond_jackpot_qualifying_hand('nlh') <> 'AAAJJ'
     OR public.fn_poker_diamond_jackpot_qualifying_hand('plo4') <> 'KKKK2'
     OR public.fn_poker_diamond_jackpot_qualifying_hand('plo5') <> '87654'
     OR public.fn_poker_diamond_jackpot_qualifying_hand('plo6') IS NOT NULL
     OR public.fn_poker_diamond_jackpot_game_qualifies('plo6')
     OR public.fn_poker_diamond_jackpot_game_qualifies('short_deck')
     OR NOT public.fn_poker_diamond_jackpot_game_qualifies('pineapple') THEN
    RAISE EXCEPTION 'the qualifying bars do not read back as the chip estate states them';
  END IF;

  -- AN UNSET VALUE REFUSES BY NAME, and that is the whole point of the reader.
  BEGIN
    PERFORM public.fn_ca_diamond_economic('bbj_drop_per_hand', 'bb:3');
    RAISE EXCEPTION 'an unset Diamond economic value did not refuse';
  EXCEPTION WHEN SQLSTATE 'PDE01' THEN
    IF SQLERRM NOT LIKE 'diamond_economics_unset:bbj_drop_per_hand/bb:3%' THEN
      RAISE EXCEPTION 'the unset refusal does not name what is unset: %', SQLERRM;
    END IF;
  END;

  -- THE SETTLER STILL REFUSES RAKE AND INSURANCE UNCONDITIONALLY, and still
  -- names the jackpot's own refusals.
  v_settler := pg_get_functiondef(
    'public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure);
  IF position('COALESCE(p_rake,0) <> 0' IN v_settler) = 0
     OR position('COALESCE(p_inflow,0) <> 0' IN v_settler) = 0 THEN
    RAISE EXCEPTION 'the Diamond settler no longer refuses rake or insurance outright';
  END IF;
  IF position('diamond_plain_cash_hand_required' IN v_settler) = 0
     OR position('diamond_hand_does_not_conserve' IN v_settler) = 0
     OR position('diamond_bad_beat_jackpot_not_open' IN v_settler) = 0
     OR position('diamond_bbj_amount_disagrees_with_the_schedule' IN v_settler) = 0 THEN
    RAISE EXCEPTION 'the Diamond settler lost one of its named refusals';
  END IF;
  IF position('<> -v_bbj' IN v_settler) = 0 THEN
    RAISE EXCEPTION 'the Diamond settler does not conserve against the drop';
  END IF;
  -- NOT ONE is_horse ANYWHERE. CLAUDE.md 10.5: a horse earns and is paid
  -- everything a human is from the same action, a jackpot included.
  IF position('is_horse' IN v_settler) > 0 THEN
    RAISE EXCEPTION 'the Diamond settler learned to ask whether a player is a horse';
  END IF;
  FOR v_arena IN
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'fn_poker_diamond_jackpot%'
  LOOP
    IF position('is_horse' IN v_arena) > 0 THEN
      RAISE EXCEPTION 'a Diamond jackpot door asks whether a player is a horse';
    END IF;
  END LOOP;

  -- THE ARENA FLOAT COUNTS THE POOL.
  v_arena := pg_get_functiondef('public.fn_ca_arena_diamonds()'::regprocedure);
  IF position('fn_poker_diamond_jackpot_diamonds()' IN v_arena) = 0 THEN
    RAISE EXCEPTION 'fn_ca_arena_diamonds does not count the jackpot pool';
  END IF;

  -- A CHIP JACKPOT POOL REFUSES THE DIAMOND ARENA BY NAME.
  IF to_regclass('public.bbj_pools') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger
                      WHERE tgrelid = 'public.bbj_pools'::regclass
                        AND tgname = 'poker_arena_no_chip_jackpot') THEN
    RAISE EXCEPTION 'bbj_pools still accepts a Diamond Arena row';
  END IF;
  IF to_regclass('public.bbj_contributions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger
                      WHERE tgrelid = 'public.bbj_contributions'::regclass
                        AND tgname = 'poker_arena_no_chip_jackpot') THEN
    RAISE EXCEPTION 'bbj_contributions still accepts a Diamond Arena row';
  END IF;

  -- NO BROWSER ROLE TOUCHES ANY OF IT.
  IF has_table_privilege('anon', 'public.poker_diamond_jackpot_ledger', 'SELECT')
     OR has_table_privilege('authenticated', 'public.poker_diamond_jackpot_ledger', 'SELECT')
     OR has_table_privilege('anon', 'public.poker_diamond_jackpot_pools', 'SELECT')
     OR has_table_privilege('authenticated', 'public.poker_diamond_jackpot_pools', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role can read the Diamond jackpot';
  END IF;
  IF has_function_privilege('anon', 'public.fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'a non-owner role can execute a Diamond jackpot money door';
  END IF;

  -- AND NO ROLE A BROWSER CAN HOLD REACHES ANY OF THEM. Asserted over every
  -- function this migration creates, rather than over a list somebody has to
  -- remember to extend: a SECURITY DEFINER reader runs past RLS and never asks
  -- who is calling, so being read-only is not the same as being harmless.
  FOR v_fn IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'fn_poker_diamond_jackpot%'
            OR p.proname = 'fn_poker_reject_diamond_chip_jackpot')
  LOOP
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn.sig;
    END IF;
  END LOOP;

  -- THE MONEY IDENTITY IS WHOLE. This is the assertion every Diamond
  -- migration ends on, and the pool joining the arena float is exactly the
  -- change that could have broken it.
  IF to_regprocedure('public.fn_ca_diamond_register_vs_supply()') IS NOT NULL THEN
    EXECUTE 'SELECT difference FROM public.fn_ca_diamond_register_vs_supply()' INTO v_diff;
    IF COALESCE(v_diff, 0) <> 0 THEN
      RAISE EXCEPTION 'the Diamond identity is not whole: difference %', v_diff;
    END IF;
  END IF;

  RAISE NOTICE 'PASS: the Diamond bad beat jackpot is decided, its pool is player side and holds nothing, the jackpot is not open, both arena switches are as they were found, and the Diamond identity is whole';
END $after$;

-- pg_temp.ca_audit_subst is a temporary object and ends with this session.

COMMIT;
