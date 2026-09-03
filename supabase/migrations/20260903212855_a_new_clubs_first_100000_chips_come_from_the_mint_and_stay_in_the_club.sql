-- A NEW CLUB'S FIRST 100,000 CHIPS COME FROM THE MINT, AND STAY IN THE CLUB
-- Chip Accounting Standard, lane-2 F4 pulled forward. Dan, 2026-09-03
-- (binding): "'THE MINT' WHERE ALL CHIPS AND DIAMONDS ARE CREATED, AND MUST
-- FLOW FROM. NEW CLUBS THAT ARE JUST CREATED START WITH 100,000 CHIPS (FROM
-- THE MINT TO THE CLUB UPON CREATION). THOSE CHIPS CAN EVER ONLY BE USED
-- INSIDE THAT CLUB, CAN NEVER BE TRANSFERRED OR USED FOR ANY OTHER PURPOSE
-- EXCEPT PLAYING INSIDE THAT CLUB."
--
-- WHAT WAS WRONG. The opening grant was two triggers on clubs:
-- trg_seed_new_club_opening_bank (BEFORE INSERT) set chip_treasury to
-- 100,000 and declared the journal row against `system_mint`;
-- trg_record_new_club_opening_bank (AFTER INSERT) wrote the
-- `club_opening_grant` chip_transactions row. Neither touched the Mint
-- register: ca_mint_ledger held 337 rows on 2026-09-03 21:30 UTC, every one
-- a diamond, and ZERO chips - while 16 clubs were created in 30 days, 13 of
-- them with a 100,000 opening grant (1,300,000 chips issued off the
-- register). fn_ca_mint, the Mint proper, issues chips to a club from
-- `issuance_reserve` and writes the register; the opening grant used a
-- different account name and no register row, so the Mint's supply could
-- never add up to the chips in circulation.
--
-- And nothing kept the opening chips inside the club: fn_union_clawback_from
-- _club could pull a member club's treasury to the union bank down to zero,
-- opening grant included (0 clawbacks in 30 days, but the door was open).
--
-- THE RULE:
--   1. The opening grant IS a Mint issuance: same account as fn_ca_mint
--      (`issuance_reserve` -> `club_treasury`, category `mint`), one
--      ca_mint_ledger row (asset chips, holder club, class seeded, op
--      `club-opening-grant:<club id>`, linked to its chip_ledger row), one
--      `club_opening_grant` chip_transactions row as before (the integrity
--      report and the quick reconcile read that type). The amount stays
--      100,000 and still lands at INSERT, so nothing about club creation
--      changes for the owner.
--   2. The opening grant never leaves the club. The only door from a club's
--      treasury to an account outside the club is the union clawback; it now
--      refuses to take the treasury below the club's outstanding opening
--      grant (100,000 for a club that received one, 0 otherwise), with the
--      floor named in the refusal. Sends to the club's own agents and players
--      and the opening allocations (BBJ seed, spin seed, promo budget) are
--      inside the club and untouched. Chips minted later by fn_ca_mint are
--      not part of the floor.
-- Nothing is backfilled: the register's chip baseline (the chips that exist
-- today, pre-standard) is Phase 3's job, the way the diamond baseline was
-- posted on 2026-09-03.
--
-- Three CREATE OR REPLACE statements (two trigger functions, one door), one
-- transaction, and a rolled-back self-check that creates a club and reads
-- the register.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_seed_new_club_opening_bank()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_union, false) THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_record_new_club_opening_bank()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_chip_id uuid;
  v_supply numeric;
  v_op text := 'club-opening-grant:' || NEW.id::text;
  v_owner_label text;
BEGIN
  IF COALESCE(NEW.is_union, false) OR COALESCE(NEW.chip_treasury, 0) <> 100000 THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_clawback_from_club(p_union_id uuid, p_club_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_is_lead boolean;
  v_treasury numeric;
  v_after numeric;
  v_floor numeric := 0;
  v_now numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM union_admins ua
     WHERE ua.union_id = p_union_id AND ua.user_id = v_uid AND ua.role = 'union_lead'
  ) OR EXISTS (
    SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_uid
  ) INTO v_is_lead;
  IF NOT v_is_lead THEN
    RETURN jsonb_build_object('success', false, 'error', 'union lead access required');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM union_clubs uc WHERE uc.union_id = p_union_id AND uc.club_id = p_club_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'club is not in this union');
  END IF;

  /* THE OPENING GRANT STAYS IN THE CLUB (Dan, 2026-09-03). A club that
     received the 100,000 opening bank keeps it: a clawback may take the
     treasury down to that floor and no further. Chips the club earned or was
     minted later are above the floor and remain reachable. */
  IF EXISTS (SELECT 1 FROM chip_transactions t
              WHERE t.club_id = p_club_id AND t.transaction_type = 'club_opening_grant') THEN
    v_floor := 100000;
  END IF;
  SELECT COALESCE(chip_treasury, 0) INTO v_now FROM clubs WHERE id = p_club_id;
  IF v_now - p_amount < v_floor THEN
    RETURN jsonb_build_object('success', false, 'error',
      'the opening grant stays in the club: a clawback may not take the treasury below ' || v_floor::text,
      'club_treasury', v_now, 'floor', v_floor, 'max_clawback', GREATEST(0, v_now - v_floor));
  END IF;

  -- CHIP STANDARD 2.4 (2026-09-03): a clawback is ONE `union_settlement` row
  -- from the club bank to the union bank, keyed and correlated on the op when
  -- one is given. The union_wallets trigger is skipped; the clubs trigger
  -- writes the row with the union bank as its counterparty. Never a refusal.
  PERFORM public.fn_ca_declare_ledger('union_settlement', 'union_bank', p_union_id, NULL,
    CASE WHEN p_op_id IS NOT NULL THEN 'union_clawback:' || p_op_id::text END, ARRAY['union_wallets']);
  IF p_op_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_correlation', p_op_id::text, true);
  END IF;

  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount
   WHERE id = p_club_id AND COALESCE(chip_treasury, 0) >= p_amount
  RETURNING chip_treasury INTO v_treasury;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury balance');
  END IF;

  INSERT INTO union_wallets (union_id, chip_balance)
  VALUES (p_union_id, p_amount)
  ON CONFLICT (union_id) DO UPDATE
    SET chip_balance = COALESCE(union_wallets.chip_balance, 0) + p_amount,
        updated_at = NOW()
  RETURNING chip_balance INTO v_after;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, club_id, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'credit', p_amount, v_after, 'clawback',
    p_club_id, p_op_id, COALESCE(NULLIF(p_notes, ''), 'Clawback from club treasury'), v_uid
  );

  INSERT INTO chip_transactions (club_id, amount, transaction_type, notes)
  VALUES (p_club_id, p_amount, 'union_clawback',
          COALESCE(NULLIF(p_notes, ''), 'Union clawback from club treasury'));

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'club_treasury', v_treasury, 'union_balance', v_after
  );
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_seed_new_club_opening_bank() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_record_new_club_opening_bank() FROM PUBLIC, anon, authenticated;

-- Self-check, rolled back inside a savepoint: create a club, read the
-- journal and the register, then undo it. Nothing persists but the code.
DO $$
DECLARE v_club uuid; v_owner uuid; v_ledger record; v_reg record; v_tx int;
BEGIN
  SELECT id INTO v_owner FROM public.profiles WHERE role IN ('admin','god') ORDER BY created_at LIMIT 1;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'no admin profile to own the probe club'; END IF;
  BEGIN
    INSERT INTO public.clubs (name, owner_id, is_union)
    VALUES ('MINT SELF-CHECK ' || clock_timestamp()::text, v_owner, false)
    RETURNING id INTO v_club;
    SELECT from_type, to_type, category, amount, idempotency_key INTO v_ledger
      FROM public.chip_ledger WHERE to_entity_id = v_club AND category = 'mint' ORDER BY created_at DESC LIMIT 1;
    IF v_ledger IS NULL OR v_ledger.from_type <> 'issuance_reserve' OR v_ledger.to_type <> 'club_treasury'
       OR v_ledger.amount <> 100000 THEN
      RAISE EXCEPTION 'the opening grant did not journal as issuance_reserve -> club_treasury 100000: %', v_ledger;
    END IF;
    SELECT action, asset, holder_type, amount, chip_ledger_id INTO v_reg
      FROM public.ca_mint_ledger WHERE op_id = 'club-opening-grant:' || v_club::text;
    IF v_reg IS NULL OR v_reg.asset <> 'chips' OR v_reg.holder_type <> 'club' OR v_reg.amount <> 100000 THEN
      RAISE EXCEPTION 'the opening grant is not on the register: %', v_reg;
    END IF;
    IF v_reg.chip_ledger_id IS NULL THEN
      RAISE EXCEPTION 'the register row is not linked to its journal row';
    END IF;
    SELECT count(*) INTO v_tx FROM public.chip_transactions
     WHERE club_id = v_club AND transaction_type = 'club_opening_grant';
    IF v_tx <> 1 THEN RAISE EXCEPTION 'expected one club_opening_grant transaction, found %', v_tx; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MINT_SELFCHECK_OK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'MINT_SELFCHECK_OK' THEN RAISE; END IF;
    -- the savepoint rolled the probe club back; the code stays
  END;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE name LIKE 'MINT SELF-CHECK %') THEN
    RAISE EXCEPTION 'the probe club survived the rollback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_union_clawback_from_club'
                    AND prosrc LIKE '%the opening grant stays in the club%') THEN
    RAISE EXCEPTION 'the clawback floor is missing';
  END IF;
END $$;

COMMIT;
