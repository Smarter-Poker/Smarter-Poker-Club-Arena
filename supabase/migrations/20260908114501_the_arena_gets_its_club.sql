-- 20260908114501_the_arena_gets_its_club.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- PHASE 5.1: THE DIAMOND ARENA GETS ITS CLUB, AND CREATING IT MINTS NOTHING.
-- (docs/DIAMOND-ACCOUNTING-STANDARD.md 3.2 "Diamond Arena"; roadmap Phase 5.1; ruling 16;
--  CLAUDE.md 10.9, 10.86; docs/changelog/2026-09-08-the-arena-gets-its-club.md)
--
-- The arena's accounting foundation was built on 2026-09-08 and deliberately stopped one step
-- short: `clubs.asset`, `clubs.is_platform`, `ca_arena_settings`, `fn_arena_deposit` /
-- `fn_arena_withdraw`, `fn_ca_arena_diamonds()` and two log-only rules all exist, and NO CLUB DOES.
-- `ca_arena_settings.club_id` is NULL and its own note says "club_id is set when the arena club is
-- created". This creates it.
--
-- CREATING A CLUB MINTS 100,000 CHIPS, AND THAT HAD TO BE STOPPED FIRST.
--
-- `fn_seed_new_club_opening_bank` is a BEFORE INSERT trigger on `clubs` that assigns
-- `NEW.chip_treasury := 100000` for every club that is not a union - unconditionally, with no
-- reference to `asset`, because when it was written there was only one asset. The autoledger then
-- journals that treasury into `chip_ledger` as `issuance_reserve -> club_treasury`, and
-- `fn_record_new_club_opening_bank` writes the matching row into `ca_mint_ledger` as a mint of
-- 100,000 CHIPS.
--
-- So inserting the Diamond Arena club unchanged would have created a hundred thousand chips inside
-- a club whose asset is diamonds, registered them against the chip supply, and left the chip trial
-- balance carrying a club that plays in another currency. Nobody would have asked for it and
-- nothing would have refused it: the grant is a courtesy for a new customer club, and the platform
-- club is not a customer.
--
-- Both functions now return early for any club whose asset is not 'chips'. The house is funded the
-- way the standard says (3.2, arena item 4) - `fn_ca_mint(diamonds, destination = house)` - not by
-- a side effect of INSERT.
--
-- WHAT ELSE IS HERE
--
--   * ONE platform club, enforced by a partial unique index rather than by hope. "One platform
--     club" is stated in ruling 16 and in the standard; until now nothing made it true.
--   * The club is owned by the platform service identity (`smarterpoker`, role god,
--     2d1cd6c3-...), never by a person - CLAUDE.md 10.10 rule 2. That is also the uuid the chip
--     auto-ledger already uses as its actor of last resort, so the books name the same entity.
--   * Every balance column is written to ZERO explicitly - chip_treasury, chip_pool,
--     promo_balance, insurance_balance - so no ledger row is written at all (the auto-ledger
--     skips a zero delta) and the club begins with nothing.
--   * `ca_arena_settings.club_id` is set to it, which switches on `fn_ca_arena_diamonds()`, the
--     deposit and withdraw doors, and the cross-asset seat guard - all of which read that row and
--     return early while it is NULL.
--   * The owner gets a `club_members` row at zero, because `trg_club_owner_has_a_player_wallet`
--     is a deferred constraint trigger that requires it.
--
-- WHAT THIS DOES NOT DO. No table, no tournament, no diamond, no rake, no horse. The entry
-- condition for a diamond table opening is unchanged and is not met today: seven consecutive days
-- of `fn_ca_diamond_trial_balance` at zero on every account, suspense zero, and no open critical
-- incident. Creating the club is what lets the reporting surfaces in 5.3 be written against
-- something real; it is not the arena opening.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. A club that does not play in chips gets no chip opening bank.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_seed_new_club_opening_bank()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.is_union, false) THEN
    RETURN NEW;
  END IF;

  -- THE OPENING GRANT IS DENOMINATED IN CHIPS. Handing it to a club that plays in another asset
  -- would create a hundred thousand chips inside it, register them against the chip supply, and
  -- put a diamond club in the chip trial balance - none of it asked for by anyone. The platform
  -- club is funded by fn_ca_mint(diamonds, destination = house) instead (standard 3.2).
  IF COALESCE(NEW.asset, 'chips') <> 'chips' THEN
    RETURN NEW;
  END IF;

  -- THE MINT (2026-09-03): the opening grant is issued from the same account
  -- fn_ca_mint issues from, so the journal row reads
  -- issuance_reserve -> club_treasury, category mint, like every other mint.
  NEW.chip_treasury := 100000;
  PERFORM public.fn_ca_declare_ledger(
    'mint', 'issuance_reserve', NULL, NULL,
    'club-opening-grant:' || NEW.id::text);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_record_new_club_opening_bank()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_chip_id uuid;
  v_supply numeric;
  v_op text := 'club-opening-grant:' || NEW.id::text;
  v_owner_label text;
BEGIN
  -- The seeder above refuses to set a chip treasury on a non-chip club, so this would return
  -- early on the amount test anyway. It is stated rather than inferred, so that setting the
  -- treasury by hand on a diamond club cannot quietly re-arm a chip mint.
  IF COALESCE(NEW.is_union, false)
     OR COALESCE(NEW.asset, 'chips') <> 'chips'
     OR COALESCE(NEW.chip_treasury, 0) <> 100000 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.chip_transactions (
    club_id, amount, transaction_type, notes, balance_after, metadata
  ) VALUES (
    NEW.id,
    100000,
    'club_opening_grant',
    'New Club Opening Bank',
    100000,
    jsonb_build_object(
      'source', 'the_mint',
      'destination', 'club_bank',
      'club_owner_id', NEW.owner_id,
      'club_code', NEW.club_id,
      'opening_balance', 100000,
      'mint_op_id', v_op
    )
  );

  /* THE REGISTER (2026-09-03): the row fn_ca_mint would have written. The
     journal row was written by the clubs auto-ledger when the treasury was
     set at INSERT (issuance_reserve -> club_treasury, key = v_op). */
  SELECT id INTO v_chip_id FROM public.chip_ledger
   WHERE idempotency_key = v_op
   ORDER BY created_at DESC LIMIT 1;
  IF v_chip_id IS NULL THEN
    SELECT id INTO v_chip_id FROM public.chip_ledger
     WHERE category = 'mint' AND from_type = 'issuance_reserve'
       AND to_type = 'club_treasury' AND to_entity_id = NEW.id AND amount = 100000
     ORDER BY created_at DESC LIMIT 1;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + 100000
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_owner_label FROM public.profiles p WHERE p.id = NEW.owner_id;

  BEGIN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason,
       performed_by, performed_by_label, chip_ledger_id)
    VALUES
      (v_op, 'mint', 'chips', 'club', NEW.id, NEW.name, 100000,
       0, 100000, v_supply,
       'New Club Opening Bank: 100,000 chips from the Mint on creation, playable inside this club only',
       NEW.owner_id, v_owner_label, v_chip_id);
  EXCEPTION WHEN unique_violation THEN
    NULL;  -- the same club's grant is already on the register
  END;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. One platform club, by construction.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ca_clubs_one_platform_club
  ON public.clubs ((is_platform)) WHERE is_platform;
COMMENT ON INDEX public.ca_clubs_one_platform_club IS
  'Ruling 16 and standard 3.2 both say ONE platform club. This is what makes that true rather than hoped: a second is_platform row cannot be inserted.';

-- ---------------------------------------------------------------------------
-- 3. The club.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_service uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';  -- smarterpoker, role god (10.10 rule 2)
  v_club uuid;
  v_chips_before numeric;
  v_diamonds_before numeric;
BEGIN
  SELECT public.fn_ca_mint_supply('chips'), public.fn_ca_mint_supply('diamonds')
    INTO v_chips_before, v_diamonds_before;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_service) THEN
    RAISE EXCEPTION 'the platform service identity is missing; a club owned by nobody is worse than no club';
  END IF;

  SELECT id INTO v_club FROM public.clubs WHERE is_platform;

  IF v_club IS NULL THEN
    INSERT INTO public.clubs (
      name, description, tagline, owner_id, asset, is_platform, is_union, union_id,
      is_public, requires_approval, is_private, status, lifecycle_status,
      chip_treasury, chip_pool, promo_balance, insurance_balance, total_rake,
      bbj_enabled, bbj_rake_enabled, spins_enabled, spins_preseed_amount,
      color_theme, slug, game_types, game_variants
    ) VALUES (
      'Diamond Arena',
      'The platform club. Every table and tournament inside it plays in diamonds, and every seat is funded by depositing diamonds a player already holds.',
      'Play Your Diamonds',
      v_service,
      'diamonds',
      true,
      false,
      NULL,           -- a platform club belongs to no union (standard 3.2)
      true,           -- anyone may join; it is the platform's own room
      false,
      false,
      'active',
      'active',
      0, 0, 0, 0, 0,  -- EVERY balance zero: the auto-ledger writes nothing for a zero delta,
                      -- so creating this club moves no money in either currency
      true, true, false, 0,
      'royal-blue',
      'diamond-arena',
      ARRAY['NLH'], ARRAY['nlh']
    )
    RETURNING id INTO v_club;
  END IF;

  -- The owner needs a member wallet: trg_club_owner_has_a_player_wallet is a DEFERRABLE
  -- constraint trigger and would refuse the club at COMMIT without it.
  --
  -- Memberships may only be created by a declared source (fn_require_explicit_club_membership_source),
  -- and this is the one it was written for: 'club_owner_create', the owner's own wallet at the
  -- moment the club exists. The setting is transaction-local and cleared straight after, so it
  -- cannot leak into anything else this migration does.
  PERFORM set_config('app.club_membership_source', 'club_owner_create', true);
  INSERT INTO public.club_members (club_id, user_id, role, chip_balance, status)
  VALUES (v_club, v_service, 'owner', 0, 'active')
  ON CONFLICT DO NOTHING;
  PERFORM set_config('app.club_membership_source', '', true);

  -- Switches on fn_ca_arena_diamonds(), both arena doors and the cross-asset seat guard, all of
  -- which read this row and return early while club_id is NULL.
  UPDATE public.ca_arena_settings SET club_id = v_club, updated_at = now() WHERE id = 1;

  -- ---- assertions -------------------------------------------------------
  IF (SELECT count(*) FROM public.clubs WHERE is_platform) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one platform club, found %', (SELECT count(*) FROM public.clubs WHERE is_platform);
  END IF;
  IF (SELECT asset FROM public.clubs WHERE id = v_club) <> 'diamonds' THEN
    RAISE EXCEPTION 'the arena club does not play in diamonds';
  END IF;
  IF (SELECT COALESCE(chip_treasury,0) + COALESCE(chip_pool,0) + COALESCE(promo_balance,0)
        + COALESCE(insurance_balance,0) + COALESCE(total_rake,0)
        FROM public.clubs WHERE id = v_club) <> 0 THEN
    RAISE EXCEPTION 'the arena club was created holding money: %',
      (SELECT row_to_json(c) FROM (SELECT chip_treasury, chip_pool, promo_balance, insurance_balance, total_rake
                                     FROM public.clubs WHERE id = v_club) c);
  END IF;
  IF (SELECT club_id FROM public.ca_arena_settings WHERE id = 1) IS DISTINCT FROM v_club THEN
    RAISE EXCEPTION 'ca_arena_settings does not point at the arena club';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_members WHERE club_id = v_club AND user_id = v_service) THEN
    RAISE EXCEPTION 'the arena owner has no member wallet';
  END IF;

  -- NOTHING WAS MINTED IN EITHER CURRENCY. This is the assertion the whole first half exists for.
  IF public.fn_ca_mint_supply('chips') <> v_chips_before THEN
    RAISE EXCEPTION 'creating the arena club minted % chips',
      public.fn_ca_mint_supply('chips') - v_chips_before;
  END IF;
  IF public.fn_ca_mint_supply('diamonds') <> v_diamonds_before THEN
    RAISE EXCEPTION 'creating the arena club minted % diamonds',
      public.fn_ca_mint_supply('diamonds') - v_diamonds_before;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE club_id = v_club) THEN
    NULL;  -- expected: a zero delta writes no ledger row
  ELSE
    RAISE EXCEPTION 'the arena club already has % chip ledger row(s)',
      (SELECT count(*) FROM public.chip_ledger WHERE club_id = v_club);
  END IF;

  RAISE NOTICE 'arena club % created, owner %, all balances zero, nothing minted', v_club, v_service;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The identities still hold, and nothing became unreachable.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_left text;
BEGIN
  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the diamond register and the players disagree';
  END IF;
  IF public.fn_ca_arena_diamonds() <> 0 THEN
    RAISE EXCEPTION 'the arena holds % diamonds before it has opened', public.fn_ca_arena_diamonds();
  END IF;
  SELECT string_agg(finding || ': ' || object, '; ') INTO v_left FROM public.fn_ca_diamond_unreachable_money();
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'unreachable money paths: %', v_left; END IF;

  -- the seed guard is stated, not inferred
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_seed_new_club_opening_bank')
     NOT LIKE '%THE OPENING GRANT IS DENOMINATED IN CHIPS%' THEN
    RAISE EXCEPTION 'the opening grant would still be handed to a club that plays in another asset';
  END IF;
END $$;

COMMIT;
