-- 20260908114517_the_books_learn_the_arena.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- PHASE 5.3: THE BOOKS LEARN THAT A DIAMOND CAN SIT ON A FELT.
-- (standard 3.2 "Diamond Arena" item 5; roadmap 5.3; CLAUDE.md 10.9, 10.86;
--  docs/changelog/2026-09-08-the-books-learn-the-arena.md)
--
-- The arena club exists as of 20260908...; its doors read `ca_arena_settings.club_id` and were
-- inert while it was NULL. They are live now, and NOT ONE of the diamond reporting surfaces knows
-- that an arena wallet exists. Three defects follow from that, all of them latent until the first
-- deposit and all of them fixed here. None had shown up yet because the arena holds 0.
--
-- 1. A DEPOSIT WOULD HAVE BURNED THE MONEY IT PARKED.
--    `fn_arena_deposit` writes a negative journal row with class 'arena'. Asked what that row is,
--    `fn_ca_diamond_journal_origin` answered 'spend' - so the register would have recorded a BURN
--    of every diamond deposited, while the diamonds themselves sat safely in a club wallet. Supply
--    would have understated the platform's own liability by the entire arena float, permanently
--    and silently. The mirror image was worse: a WITHDRAWAL classified as 'arena', which the
--    register reads as a MINT, so taking your own diamonds back out would have created them again.
--
--    A deposit is neither. It is money moving between two accounts of the same owner - exactly
--    what the classifier already says about a player-to-player transfer, and for exactly the same
--    reason: supply moves, none is created or retired. Both arena kinds now return NULL there,
--    beside the transfers, and the positive 'arena' branch narrows to the arcade awards it was
--    really written for. A deposit also stops counting as "what players spent playing", which it
--    never was - parking money is not spending it.
--
-- 2. THE IDENTITY WOULD HAVE BROKEN ON THE FIRST DEPOSIT.
--    `fn_ca_diamond_trial_balance` asserts `players + house = register`. Once diamonds sit in an
--    arena wallet they are in none of those three, so the register row would have reported a
--    break for money that had gone exactly where it was supposed to go. The trial balance gains an
--    `arena_wallets` row and the identity becomes `players + house + arena = register`, which is
--    what it always meant.
--
-- 3. THE CHIP SUPPLY SNAPSHOT WOULD HAVE COUNTED DIAMONDS AS CHIPS.
--    `fn_ca_supply_snapshot` sums `club_members.chip_balance` and four `clubs` columns across
--    EVERY club. The arena's member wallets are denominated in diamonds and live in the same
--    columns, so every diamond on the felt would have been added to the chip supply. It excludes
--    the platform club now. (The chip TRIAL BALANCE is unaffected and is deliberately left alone:
--    it works from `chip_ledger`, and the `club_members` auto-ledger fires only on
--    `promo_balance`, so an arena deposit writes it no rows.)
--
-- `ca_diamond_snapshots` gains `arena_diamonds`, and the deploy gate's basis becomes
-- profiles + arena on BOTH sides of the comparison - so a deposit, which moves diamonds without
-- creating or destroying any, nets to zero and never reads as unexplained. A gate that fires on
-- correct behaviour is a gate somebody switches off.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION pg_temp.ca_patch(p_oid oid, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $ca$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT pg_get_functiondef(p_oid) INTO v_def;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_patch: marker found % times in %', v_n, p_oid::regprocedure; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $ca$;

-- ---------------------------------------------------------------------------
-- 1. An arena movement is a transfer, not issuance and not retirement.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch(
  'public.fn_ca_diamond_journal_origin(text,text,text,text,numeric)'::regprocedure,
$ca_from$  -- The deletion door writes its own register row.$ca_from$,
$ca_to$  -- THE ARENA DOORS MOVE MONEY, THEY DO NOT ISSUE IT. A deposit takes diamonds out of
  -- profiles.diamonds and puts them in the platform club's member wallet; a withdrawal is the
  -- mirror. The player still owns them and the supply is unchanged, so the register must not
  -- follow either leg - the same treatment, for the same reason, as a player-to-player transfer
  -- above. Classified as 'spend' (deposit) and 'arena' (withdrawal), the register would have
  -- burned the float on the way in and minted it on the way out (2026-09-08).
  IF v_kind IN ('arena_deposit', 'arena_withdraw') THEN RETURN NULL; END IF;
  -- The deletion door writes its own register row.$ca_to$);

SELECT pg_temp.ca_patch(
  'public.fn_ca_diamond_journal_origin(text,text,text,text,numeric)'::regprocedure,
$ca_from$    ELSIF v_class = 'arena' OR v_kind LIKE 'arcade%' THEN$ca_from$,
$ca_to$    -- 'arcade%' only. The 'arena' CLASS now belongs to the arena doors, which are handled
    -- as transfers above; leaving it here would have made a withdrawal mint.
    ELSIF v_kind LIKE 'arcade%' THEN$ca_to$);

-- ---------------------------------------------------------------------------
-- 2. The diamond trial balance counts what is on the felt.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('public.fn_ca_diamond_trial_balance(timestamptz)'::regprocedure,
$ca_from$  v_house_ledger numeric;$ca_from$,
$ca_to$  v_house_ledger numeric;
  v_arena numeric;$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_diamond_trial_balance(timestamptz)'::regprocedure,
$ca_from$  -- register: the identity over every holder (D9), read in the same snapshot as the balances.$ca_from$,
$ca_to$  -- arena_wallets: diamonds a player has deposited onto the platform club's felt. Still theirs,
  -- still in the supply, and in neither profiles nor the house - so the identity below has to
  -- count them or a deposit reads as a break (2026-09-08).
  v_arena := public.fn_ca_arena_diamonds();
  IF s0.id IS NOT NULL AND s0.arena_diamonds IS NOT NULL THEN
    v_delta := v_arena - s0.arena_diamonds;
  ELSE
    v_delta := NULL;
  END IF;
  v_tot_now := v_tot_now + v_arena; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
  RETURN QUERY SELECT 'arena_wallets'::text, v_arena, v_delta, NULL::numeric, NULL::numeric, NULL::numeric,
    ('diamonds on the Diamond Arena felt (platform club member wallets). A deposit moves them out of '
     || 'profiles.diamonds without changing the supply, so they are counted here and in the register '
     || 'identity below. The Mint issues nothing for a deposit and retires nothing for a withdrawal.')::text;

  -- register: the identity over every holder (D9), read in the same snapshot as the balances.$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_diamond_trial_balance(timestamptz)'::regprocedure,
$ca_from$  RETURN QUERY SELECT 'register'::text, v_reg, NULL::numeric, NULL::numeric, NULL::numeric, (v_players + v_house) - v_reg,
    ('fn_ca_mint_supply(diamonds) over every holder is ' || v_reg || '; players + house is ' || (v_players + v_house)$ca_from$,
$ca_to$  RETURN QUERY SELECT 'register'::text, v_reg, NULL::numeric, NULL::numeric, NULL::numeric, (v_players + v_house + v_arena) - v_reg,
    ('fn_ca_mint_supply(diamonds) over every holder is ' || v_reg || '; players + house + arena is ' || (v_players + v_house + v_arena)$ca_to$);

-- ---------------------------------------------------------------------------
-- 3. The snapshot stores the float, on both sides of the comparison.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_diamond_snapshots ADD COLUMN IF NOT EXISTS arena_diamonds numeric;
COMMENT ON COLUMN public.ca_diamond_snapshots.arena_diamonds IS
  'Diamonds on the Diamond Arena felt at the moment of the snapshot. Part of the basis for unexplained, so a deposit - which moves diamonds without creating or destroying any - nets to zero rather than reading as a break.';

-- the declaration first: a body patch that referenced v_arena_now before it was declared
-- failed to compile at the intermediate CREATE OR REPLACE (2026-09-08).
SELECT pg_temp.ca_patch('public.fn_ca_diamond_snapshot()'::regprocedure,
$ca_from$  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric; v_house numeric;$ca_from$,
$ca_to$  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric; v_house numeric; v_arena_now numeric;$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_diamond_snapshot()'::regprocedure,
$ca_from$  v_total := v_prof;$ca_from$,
$ca_to$  -- The basis is what players hold PLUS what they have parked on the arena felt. Both sides of
  -- the comparison below use the same basis, so a deposit nets to zero and the deploy gate keeps
  -- meaning "diamonds appeared or vanished" rather than "diamonds moved" (2026-09-08).
  v_arena_now := public.fn_ca_arena_diamonds();
  v_total := v_prof + v_arena_now;$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_diamond_snapshot()'::regprocedure,
$ca_from$    v_prev_basis := prev.profile_diamonds;$ca_from$,
$ca_to$    v_prev_basis := prev.profile_diamonds + COALESCE(prev.arena_diamonds, 0);$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_diamond_snapshot()'::regprocedure,
$ca_from$    (profile_diamonds, wallet_diamonds, cert_diamonds, total, journaled_delta, delta_vs_prev, unexplained,$ca_from$,
$ca_to$    (arena_diamonds, profile_diamonds, wallet_diamonds, cert_diamonds, total, journaled_delta, delta_vs_prev, unexplained,$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_diamond_snapshot()'::regprocedure,
$ca_from$    (v_prof, v_wal, v_cert, v_total, v_journal,$ca_from$,
$ca_to$    (v_arena_now, v_prof, v_wal, v_cert, v_total, v_journal,$ca_to$);

-- ---------------------------------------------------------------------------
-- 4. The chip supply snapshot stops counting diamonds.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('public.fn_ca_supply_snapshot()'::regprocedure,
$ca_from$    (SELECT COALESCE(sum(chip_balance),0) FROM club_members)            AS member_wallets,$ca_from$,
$ca_to$    -- EVERY aggregate here excludes the platform club: its wallets and treasuries are
    -- denominated in diamonds and sit in the same columns, so counting them would add the whole
    -- arena float to the chip supply (2026-09-08).
    (SELECT COALESCE(sum(cm.chip_balance),0) FROM club_members cm
       JOIN clubs c ON c.id = cm.club_id WHERE NOT COALESCE(c.is_platform, false)) AS member_wallets,$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_supply_snapshot()'::regprocedure,
$ca_from$    (SELECT COALESCE(sum(promo_balance),0) FROM club_members)           AS member_promo,$ca_from$,
$ca_to$    (SELECT COALESCE(sum(cm.promo_balance),0) FROM club_members cm
       JOIN clubs c ON c.id = cm.club_id WHERE NOT COALESCE(c.is_platform, false)) AS member_promo,$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_supply_snapshot()'::regprocedure,
$ca_from$    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs)                  AS treasuries,$ca_from$,
$ca_to$    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS treasuries,$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_supply_snapshot()'::regprocedure,
$ca_from$    (SELECT COALESCE(sum(chip_pool),0) FROM clubs)                      AS chip_pools,$ca_from$,
$ca_to$    (SELECT COALESCE(sum(chip_pool),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS chip_pools,$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_supply_snapshot()'::regprocedure,
$ca_from$    (SELECT COALESCE(sum(promo_balance),0) FROM clubs)                  AS club_promo,$ca_from$,
$ca_to$    (SELECT COALESCE(sum(promo_balance),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS club_promo,$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_supply_snapshot()'::regprocedure,
$ca_from$    (SELECT COALESCE(sum(insurance_balance),0) FROM clubs)              AS club_insurance,$ca_from$,
$ca_to$    (SELECT COALESCE(sum(insurance_balance),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS club_insurance,$ca_to$);

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_diff numeric; v_arena numeric; v_left text; v_body text;
BEGIN
  -- the classifier: both arena kinds are transfers, in both directions
  IF public.fn_ca_diamond_journal_origin('arena_deposit', 'arena_deposit', 'fn_arena_deposit', 'arena', -100) IS NOT NULL THEN
    RAISE EXCEPTION 'a deposit still registers: %',
      public.fn_ca_diamond_journal_origin('arena_deposit', 'arena_deposit', 'fn_arena_deposit', 'arena', -100);
  END IF;
  IF public.fn_ca_diamond_journal_origin('arena_withdraw', 'arena_withdraw', 'fn_arena_withdraw', 'arena', 100) IS NOT NULL THEN
    RAISE EXCEPTION 'a withdrawal still mints: %',
      public.fn_ca_diamond_journal_origin('arena_withdraw', 'arena_withdraw', 'fn_arena_withdraw', 'arena', 100);
  END IF;
  -- and the ordinary classifications still work
  IF public.fn_ca_diamond_journal_origin('arcade_prize', 'arcade_prize', 'x', NULL, 50) <> 'arena' THEN
    RAISE EXCEPTION 'an arcade award no longer registers';
  END IF;
  IF public.fn_ca_diamond_journal_origin('time_bank', 'time_bank', 'x', NULL, -10) <> 'spend' THEN
    RAISE EXCEPTION 'an ordinary spend stopped classifying';
  END IF;
  IF public.fn_ca_diamond_journal_origin('daily_challenge_claim', 'daily_challenge_claim', 'x', 'earned', 100) <> 'reward' THEN
    RAISE EXCEPTION 'an ordinary reward stopped classifying';
  END IF;

  -- the trial balance names the felt and closes on it
  SELECT balance_now INTO v_arena FROM public.fn_ca_diamond_trial_balance(now() - interval '75 minutes')
   WHERE account = 'arena_wallets';
  IF v_arena IS NULL THEN RAISE EXCEPTION 'the trial balance does not report arena_wallets'; END IF;
  IF v_arena <> public.fn_ca_arena_diamonds() THEN
    RAISE EXCEPTION 'the trial balance says the arena holds % and the arena says %', v_arena, public.fn_ca_arena_diamonds();
  END IF;
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_trial_balance(now() - interval '75 minutes')
   WHERE account = 'register';
  IF v_diff <> 0 THEN RAISE EXCEPTION 'the register identity is off by %', v_diff; END IF;

  -- the chip snapshot excludes the platform club everywhere it aggregates
  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_supply_snapshot';
  IF (length(v_body) - length(replace(v_body, 'is_platform', ''))) / length('is_platform') < 6 THEN
    RAISE EXCEPTION 'the chip supply snapshot still counts the platform club somewhere';
  END IF;

  -- nothing became unreachable, and the money still adds up
  SELECT string_agg(finding || ': ' || object, '; ') INTO v_left FROM public.fn_ca_diamond_unreachable_money();
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'unreachable money paths: %', v_left; END IF;
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_arena_diamonds() THEN
    RAISE EXCEPTION 'players + arena <> register';
  END IF;
END $$;

COMMIT;
