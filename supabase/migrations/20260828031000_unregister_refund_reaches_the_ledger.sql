-- ═══════════════════════════════════════════════════════════════════════════
--  UNREGISTERING REFUNDED THE PLAYER AND TOLD THE LEDGER NOTHING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Applied to production 2026-08-27 via the Supabase MCP (apply_migration
-- "unregister_writes_the_refund_row_the_ledger_needs"). This file is the record
-- of why, per CLAUDE.md.
--
-- THE HOLE. fn_unregister_from_tournament refunded through
-- credit_player_wallet, which calls fn_credit_player_wallet_once, which moves
-- chips and writes NO wallet_transactions row. The registration's
-- `tournament_buyin` debit therefore survived with nothing offsetting it.
--
-- atomic_cancel_tournament decides each player's refund from that ledger:
--
--     sum(debit  where category in ('tournament_buyin','rebuy','addon'))
--   - sum(credit where category = 'refund')
--
-- so every register/unregister cycle left another unoffset debit behind and the
-- cancel paid for all of them. K cycles pay (K+1) times the buy-in. The cancel
-- is callable by any club admin on a RUNNING event, and the wallet idempotency
-- key dedupes a repeated USER, not a repeated CHARGE, so nothing downstream
-- caught it.
--
-- PROVEN, not assumed. register, unregister, register as one funded member,
-- inside a transaction that rolled itself back:
--
--   PROBE4 "Sunday Deep Stack Satellite $5" buyin=4.50
--          | reg=true unreg=true reg=true | ledger rows=2
--          | cancel would refund 10.00 | balance 5000.00->4995.00
--
-- The player was out 5.00 and the cancel would have paid them 10.00.
--
-- AFTER THIS MIGRATION, same event, same member, one cycle and then three:
--
--   REPROBE4 buyin=4.50
--            | 1 cycle:  rows=3  cancel refunds 5.00
--            | 3 cycles:         cancel refunds 5.00
--            | balance 5000.00->4995.00
--
-- Three cycles now pay the same as one, which is the point: the answer stopped
-- depending on how many times the player changed their mind.
--
-- THE FIX. Refund through fn_credit_and_log, the same helper
-- atomic_cancel_tournament itself uses. It credits once and, only if the credit
-- actually happened, writes the matching `refund` row against the tournament.
-- The money movement is unchanged; what changes is that the ledger now says so.
--
-- THE IDEMPOTENCY KEY IS DELIBERATELY UNCHANGED. It stays
-- 'tourn_unreg:<registration_id>', so an unregistration already refunded under
-- the old code cannot be paid a second time by the new code, and the club
-- resolution inside fn_credit_player_wallet_once behaves exactly as it did.
-- A new key would have been a second bug wearing the first one's clothes.
--
-- NO BACKFILL IS NEEDED AND NONE IS DONE. wallet_credit_idempotency holds zero
-- keys matching 'tourn_unreg:%'. The path was open and never taken, so there is
-- no historical over-refund to unwind.

CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_t       record;
  v_reg_id  uuid;
  v_amount  numeric;
  v_split   record;
  v_is_bounty boolean;
  v_ms      numeric;
  v_logged  boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, bounty_amount,
         is_bounty, is_pko, is_mystery_bounty,
         start_time, current_players, club_id, name
    INTO v_t
  FROM public.tournaments
  WHERE id = p_tournament_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  IF v_t.start_time IS NOT NULL THEN
    v_ms := EXTRACT(EPOCH FROM (v_t.start_time - now())) * 1000;
    IF v_ms <= 60000 AND v_ms > -300000 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_close_to_start');
    END IF;
  END IF;

  DELETE FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = v_uid
     AND status = 'registered'
  RETURNING id INTO v_reg_id;

  IF v_reg_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_registered_or_seated');
  END IF;

  -- POOL SYMMETRY 2026-08-26: reverse the exact fn_tournament_entry_split
  -- components registration added (prize/bounty/rake), not the raw buy_in.
  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  v_amount := v_split.charge;

  IF v_amount > 0 THEN
    -- LEDGER SYMMETRY 2026-08-27. This used to call credit_player_wallet, which
    -- moves chips and writes nothing. atomic_cancel_tournament reads the ledger
    -- to decide what a player is owed, so an unoffset buy-in debit made the
    -- cancel pay again for a registration that had already been refunded here.
    -- fn_credit_and_log is the helper the cancel itself uses: it credits once
    -- against the same key as before, and writes the matching `refund` row only
    -- if the credit actually happened.
    v_logged := public.fn_credit_and_log(
      v_uid,
      v_amount,
      'tourn_unreg:' || v_reg_id::text,
      'refund',
      'Tournament unregistration refund: ' || COALESCE(v_t.name, 'Unknown'),
      p_tournament_id);
  END IF;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES
      (NULL, NULL, v_t.club_id, -v_split.rake, v_split.rake, 1,
       0, true, p_tournament_id, 'fn_unregister_from_tournament',
       jsonb_build_object('kind', 'tournament_fee_refund', 'user_id', v_uid,
                          'registration_id', v_reg_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = GREATEST(COALESCE(current_players, 1) - 1, 0),
         prize_pool  = GREATEST(COALESCE(prize_pool, 0)  - v_split.prize, 0),
         bounty_pool = GREATEST(COALESCE(bounty_pool, 0) - v_split.bounty, 0),
         total_rake  = GREATEST(COALESCE(total_rake, 0)  - v_split.rake, 0)
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'refunded', v_amount, 'registration_id', v_reg_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_unregister_from_tournament(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_unregister_from_tournament(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_unregister_from_tournament(uuid) IS
  'Unregisters the caller from a tournament and refunds the exact entry split through fn_credit_and_log, so the refund appears in wallet_transactions and atomic_cancel_tournament cannot pay for the same registration twice. Hardened 2026-08-27.';
