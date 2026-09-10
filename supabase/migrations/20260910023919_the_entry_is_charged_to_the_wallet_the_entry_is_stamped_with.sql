-- 20260910023024_the_entry_is_charged_to_the_wallet_the_entry_is_stamped_with.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-10, found while settling satellite
-- 9fee70de-c692-48fb-a423-98d730ab02bc):
--
-- A tournament entry touches two club wallets that must be the same wallet:
-- the one the buy-in is DEBITED from, and the one stamped on
-- tournament_players.club_id, which is where every prize, refund and
-- entitlement for that entry is CREDITED (fn_credit_player_wallet_once
-- resolves the 'tourney:<id>:...' key through that stamp). They were resolved
-- by two different functions:
--
--   stamp  : trg_tournament_players_stamp_club ->
--            fn_tournament_club_for_user(user, tournament, NULL), the
--            union-aware resolver: for a union-hosted event, the player's own
--            member club inside that union.
--   debit  : atomic_deduct_wallet_and_log, which since
--            20260909212340_wallet_debit_uses_the_game_club_and_cannot_mint
--            reads tournaments.club_id directly. For a union-hosted event that
--            is the union's house club (club_id = union_id), which is NOT the
--            wallet the player plays from. Before that migration it read
--            fn_player_home_club - the player's OLDEST club - which agreed
--            with the stamp only by coincidence.
--
-- Measured on the buy-in ledger (chip_ledger.category = 'tournament_buyin')
-- for union-hosted events over the last 24h: 3,232 of 5,863 entries
-- (73,659.00 chips) were debited from a different club wallet than the one
-- their prize will be paid into. Since 21:23 UTC every one of them was taken
-- from the fade0000 house-club wallet and stamped a0000000 / a41434bb. The
-- satellite above: both entrants debited 20.00 from fade0000, both stamped
-- a0000000, so the 30.00 + 8.00 settlement would have landed in wallets the
-- entry never came from. Per player the chips conserve; per club they do not:
-- the house-club wallets drain by every buy-in and the member-club wallets
-- fill by every prize, and when a house-club wallet reaches zero the next
-- union entry is refused as "insufficient".
--
-- THE FIX, at the line: atomic_deduct_wallet_and_log resolves the wallet for a
-- tournament debit (and for a table debit at a tournament table) through
-- fn_tournament_club_for_user, the same function the stamp uses, with the
-- declared ledger club as its preferred club. Debit and stamp can no longer
-- disagree because they are one call. A player with no member club inside
-- the event's union is refused out loud instead of being charged at a club
-- they do not play from. Standalone club events are unaffected: the resolver
-- returns tournaments.club_id for them.
--
-- THE ONE-TIME CORRECTION, shipped with its cause (10.11/10.12): entries that
-- are still in flight (tournament REGISTERING/RUNNING/COMPLETING, no
-- settlement batch) whose stamp differs from the wallet the ledger proves was
-- charged are re-stamped to the CHARGED wallet, so their prize or refund
-- returns to the wallet it came from. 746 rows in the rolled-back probe at
-- the time of writing (408 of them charged at the house club since 21:23, the
-- rest charged at the oldest club by the path before it); the migration
-- asserts that it corrects exactly the rows it selected and leaves none. Entries in
-- events already COMPLETED were paid to the stamped wallet: those chips are
-- with the same player, in another of their own club wallets, and are not
-- moved (10.9 rule 3 - nothing is taken back for our mistake).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'debit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric;
  v_club_id uuid;
  v_context_club uuid;
  v_context_tournament uuid;
  v_declared_club uuid;
  v_declared_text text;
  v_has_club boolean;
BEGIN
  IF p_user_id IS NULL
     OR p_amount IS NULL
     OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount <= 0
     OR p_amount <> round(p_amount,2) THEN
    RAISE EXCEPTION 'wallet debit requires a positive two-decimal amount'
      USING ERRCODE='22023';
  END IF;

  v_declared_text:=NULLIF(current_setting('app.ledger_club_id',true),'');
  IF v_declared_text IS NOT NULL THEN
    BEGIN
      v_declared_club:=v_declared_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'wallet debit declared club is not a UUID'
        USING ERRCODE='22023';
    END;
    v_club_id:=v_declared_club;
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT t.club_id, t.tournament_id INTO v_context_club, v_context_tournament
      FROM public.tables t
     WHERE t.id=p_table_id;
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'wallet debit table % has no club context',p_table_id
        USING ERRCODE='P0002';
    END IF;
    IF v_context_tournament IS NOT NULL THEN
      -- THE ENTRY IS CHARGED TO THE WALLET THE ENTRY IS STAMPED WITH
      -- (2026-09-10): a tournament table resolves the wallet the way the
      -- entry stamp does, so a rebuy at a union event comes from the same
      -- member-club wallet the buy-in came from.
      v_context_club:=public.fn_tournament_club_for_user(
        p_user_id,v_context_tournament,v_club_id);
      IF v_context_club IS NULL THEN
        RAISE EXCEPTION 'no club wallet in the union of tournament % resolves for player %',
          v_context_tournament,p_user_id USING ERRCODE='42501';
      END IF;
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own table %',p_table_id
        USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF p_related_entity_id IS NOT NULL
     AND lower(COALESCE(p_category,'')) IN
       ('tournament_buyin','tournament_rebuy','rebuy','reentry','addon') THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id=p_related_entity_id
                     AND t.club_id IS NOT NULL) THEN
      RAISE EXCEPTION 'wallet debit tournament % has no club context',
        p_related_entity_id USING ERRCODE='P0002';
    END IF;
    -- THE ENTRY IS CHARGED TO THE WALLET THE ENTRY IS STAMPED WITH
    -- (2026-09-10). trg_tournament_players_stamp_club stamps the entry with
    -- fn_tournament_club_for_user; the debit reads the same function with the
    -- same preferred club, so the wallet a prize returns to is the wallet the
    -- buy-in left. Reading tournaments.club_id here charged the union's house
    -- club for every union-hosted entry (3,232 entries / 73,659.00 in 24h).
    v_context_club:=public.fn_tournament_club_for_user(
      p_user_id,p_related_entity_id,v_club_id);
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'no club wallet in the union of tournament % resolves for player %',
        p_related_entity_id,p_user_id USING ERRCODE='42501';
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own tournament %',
        p_related_entity_id USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF v_club_id IS NULL THEN
    v_club_id:=public.fn_player_home_club(p_user_id,NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    IF public.fn_ensure_club_wallet(p_user_id,v_club_id) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'player % has no active wallet at club %',p_user_id,v_club_id
        USING ERRCODE='42501';
    END IF;
    SELECT cm.chip_balance INTO v_balance
      FROM public.club_members cm
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
     FOR UPDATE;
    IF v_balance IS NULL OR v_balance<p_amount THEN
      RETURN false;
    END IF;
    UPDATE public.club_members cm
       SET chip_balance=cm.chip_balance-p_amount,updated_at=now()
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
       AND cm.chip_balance>=p_amount;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    INSERT INTO public.chip_transactions(
      club_id,from_user_id,amount,transaction_type,notes
    ) VALUES (
      v_club_id,p_user_id,p_amount,p_category,
      COALESCE(NULLIF(p_description,''),'Wallet debit')
    );
    RETURN true;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.club_members cm WHERE cm.user_id=p_user_id
  ) INTO v_has_club;
  IF v_has_club THEN
    RAISE EXCEPTION 'No active club wallet resolves for Club Arena debit from player %',
      p_user_id USING ERRCODE='42501';
  END IF;

  UPDATE public.wallets w
     SET balance=w.balance-p_amount,updated_at=now()
   WHERE w.user_id=p_user_id AND w.wallet_type='PLAYER'
     AND w.balance>=p_amount;
  RETURN FOUND;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Post-conditions on the function: the debit and the stamp read one resolver.
-- ---------------------------------------------------------------------------
DO $body$
DECLARE v_def text; v_stamp text; v_n integer;
BEGIN
  SELECT pg_get_functiondef('public.atomic_deduct_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid)'::regprocedure) INTO v_def;
  v_n := (length(v_def) - length(replace(v_def, 'fn_tournament_club_for_user(', ''))) / length('fn_tournament_club_for_user(');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'post-condition: the debit resolves the wallet % times through fn_tournament_club_for_user, expected 2', v_n;
  END IF;
  IF position('SELECT t.club_id INTO v_context_club' IN v_def) > 0 THEN
    RAISE EXCEPTION 'post-condition: the debit still reads tournaments.club_id directly';
  END IF;
  SELECT p.prosrc INTO v_stamp FROM pg_proc p JOIN pg_trigger t ON t.tgfoid = p.oid
   WHERE t.tgrelid = 'public.tournament_players'::regclass AND t.tgname = 'trg_tournament_players_stamp_club';
  IF v_stamp IS NULL OR position('fn_tournament_club_for_user(' IN v_stamp) = 0 THEN
    RAISE EXCEPTION 'post-condition: the entry stamp no longer uses fn_tournament_club_for_user';
  END IF;
END
$body$;

-- ---------------------------------------------------------------------------
-- One-time correction, shipped with its cause: in-flight entries are
-- re-stamped to the wallet the ledger proves was charged.
-- ---------------------------------------------------------------------------
DO $body$
DECLARE v_expected integer; v_done integer; v_left integer;
BEGIN
  -- The NEWEST buy-in row for each in-flight entry names the wallet that was
  -- charged; only entries whose stamp disagrees with it are corrected.
  CREATE TEMP TABLE fix_stamp ON COMMIT DROP AS
  SELECT latest.tp_id, latest.stamped_club, latest.charged_club FROM (
    SELECT DISTINCT ON (tp.id) tp.id AS tp_id, tp.club_id AS stamped_club, l.club_id AS charged_club
      FROM public.chip_ledger l
      JOIN public.tournament_players tp
        ON tp.tournament_id = l.tournament_id AND tp.user_id = l.from_entity_id
      JOIN public.tournaments t ON t.id = l.tournament_id
     WHERE l.category = 'tournament_buyin' AND l.from_type = 'player_wallet'
       AND l.to_type = 'prize_liability'
       AND l.club_id IS NOT NULL
       AND t.status IN ('REGISTERING', 'RUNNING', 'COMPLETING')
       AND NOT EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b WHERE b.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b WHERE b.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_final_table_deal_batches b WHERE b.tournament_id = t.id)
       -- the charged wallet must exist for that player, or the credit would have nowhere to land
       AND EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = tp.user_id AND m.club_id = l.club_id)
     ORDER BY tp.id, l.created_at DESC
  ) latest
  WHERE latest.charged_club IS DISTINCT FROM latest.stamped_club;
  SELECT count(*) INTO v_expected FROM fix_stamp;

  UPDATE public.tournament_players tp
     SET club_id = f.charged_club
    FROM fix_stamp f
   WHERE tp.id = f.tp_id AND tp.club_id = f.stamped_club;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> v_expected THEN
    RAISE EXCEPTION 'one-time correction changed % rows, expected %', v_done, v_expected;
  END IF;

  -- The same selection, re-read after the write: the newest buy-in row for
  -- every in-flight entry must now name the wallet the entry is stamped with.
  SELECT count(*) INTO v_left FROM (
    SELECT DISTINCT ON (tp.id) tp.id, tp.club_id AS stamped_club, l.club_id AS charged_club
      FROM public.chip_ledger l
      JOIN public.tournament_players tp
        ON tp.tournament_id = l.tournament_id AND tp.user_id = l.from_entity_id
      JOIN public.tournaments t ON t.id = l.tournament_id
     WHERE l.category = 'tournament_buyin' AND l.from_type = 'player_wallet'
       AND l.to_type = 'prize_liability' AND l.club_id IS NOT NULL
       AND t.status IN ('REGISTERING', 'RUNNING', 'COMPLETING')
       AND NOT EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b WHERE b.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b WHERE b.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_final_table_deal_batches b WHERE b.tournament_id = t.id)
       AND EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = tp.user_id AND m.club_id = l.club_id)
     ORDER BY tp.id, l.created_at DESC
  ) latest
  WHERE latest.charged_club IS DISTINCT FROM latest.stamped_club;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'post-condition: % in-flight entries are still stamped with a wallet they were not charged at', v_left;
  END IF;
  RAISE NOTICE 'the entry is charged to the wallet the entry is stamped with: % in-flight entries re-stamped to their charged wallet', v_done;
END
$body$;

COMMIT;
