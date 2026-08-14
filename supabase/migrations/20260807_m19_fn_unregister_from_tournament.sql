-- ============================================================================
-- AUDIT M19 — tournament money: one real feature to fix, two dead duplicates
--             of engine-owned logic to delete
-- ============================================================================
--
-- M19 was filed as "five more client credit call sites, all tournament money",
-- found after M17 shipped because the original inventory grepped for
-- `atomic_credit_wallet_and_log` and `fn_idempotent_credit_wallet` and missed a
-- THIRD generic primitive, `credit_player_wallet`. Reading the server changes
-- the shape of the finding substantially, in both directions.
--
-- WHAT IS ALREADY RIGHT
-- The engine owns tournament payouts, and owns them well.
-- `server/src/tournament/TournamentManagerEliminations.ts` computes each prize
-- server-side from `tournaments.payout_structure` and `prize_pool`, credits it
-- through `credit_player_wallet` WITH an idempotency key derived from the payout
-- itself (`tourney:{id}:prize:{user}:{position}`), retries three times, and logs
-- the transaction. That is exactly the shape M17 spent its whole sweep trying to
-- establish everywhere else.
--
-- WHAT IS ACTUALLY WRONG
-- `TournamentService.ts` carries a SECOND, client-side implementation of the
-- same payouts — and this one passes NO idempotency key at all, because
-- `credit_player_wallet`'s third parameter defaults to NULL and the client only
-- ever passes two arguments. So it is not merely an unbacked credit: if it were
-- ever unblocked it would pay a second time ON TOP of the engine's payment, and
-- the engine's key could not stop it, because a call with no key never touches
-- the dedupe table. It would also double-pay against its own `retryAsync`
-- retries.
--
-- Two of the three client methods have NO callers anywhere outside
-- TournamentService: `eliminatePlayer` and `collectBounty`. They are dead
-- duplicates of engine logic and they are the dangerous ones, so they are
-- deleted in the accompanying client change rather than converted. There is no
-- function to preserve — the engine already does this, correctly.
--
-- The third, `unregisterPlayer`, IS a live player-facing feature: it is called
-- from five different pages, and it is how a player takes their buy-in back
-- before a tournament starts. It is broken in production like the rest of M17,
-- and it is what this migration fixes.
--
-- WHY NOT REUSE atomic_tournament_unregister
-- It exists, and it is service_role-only, so granting it would be the obvious
-- move. It also takes `p_refund_amount` from its caller — the same shape as
-- every other M17 mint — plus it performs no authorization check at all (any
-- caller could unregister any user) and passes no idempotency key. Granting it
-- to `authenticated` would hand players a "refund me any amount from any
-- tournament" button. It is left alone; the engine may still use it.
--
-- THE KEY IS DERIVED FROM THE REGISTRATION ROW, NOT THE PAIR
-- `tourn_unreg:<tournament>:<user>` looks right and is wrong: a player who
-- registers, unregisters, re-registers and unregisters again would have the
-- second refund silently swallowed as a duplicate. The DELETE returns the
-- `tournament_players.id` it removed, and that is the key. Each registration is
-- a new row, so each unregistration is a distinct payout, while any retry of the
-- SAME unregistration collapses to one credit.
-- ============================================================================

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
  v_ms      numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  -- There is no user parameter on purpose. A player may only unregister
  -- themselves, and the way to guarantee that is to never accept a target.
  SELECT id, status, buy_in_amount, buy_in_fee, start_time, current_players
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

  -- The one-minute lockout the client documented but could not enforce. Its
  -- comment said as much: "nothing enforced - players could yank their entry at
  -- the exact start instant and race the seating flow". Enforced here, where the
  -- seating flow cannot interleave with it, because both take this row lock.
  IF v_t.start_time IS NOT NULL THEN
    v_ms := EXTRACT(EPOCH FROM (v_t.start_time - now())) * 1000;
    IF v_ms <= 60000 AND v_ms > -300000 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_close_to_start');
    END IF;
  END IF;

  -- Delete-first as a compare-and-swap: `status = 'registered'` means a player
  -- the engine has already seated cannot be unregistered out from under it.
  DELETE FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = v_uid
     AND status = 'registered'
  RETURNING id INTO v_reg_id;

  IF v_reg_id IS NULL THEN
    -- Either never registered, or already seated. The client used to guess
    -- between those with a separate read; one predicate answers both.
    RETURN jsonb_build_object('ok', false, 'reason', 'not_registered_or_seated');
  END IF;

  v_amount := trunc((COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0)) * 100) / 100;

  IF v_amount > 0 THEN
    -- Key derived from the registration row, so re-registering later is a new
    -- payout while a retry of THIS unregistration is not.
    PERFORM public.credit_player_wallet(v_uid, v_amount, 'tourn_unreg:' || v_reg_id::text);
  END IF;

  UPDATE public.tournaments
     SET current_players = GREATEST(COALESCE(current_players, 1) - 1, 0)
   WHERE id = p_tournament_id;

  -- No compensating re-INSERT on failure. The client carried one because its
  -- delete and its refund were separate round trips; here a failed refund rolls
  -- the delete back with it, so the player is simply still registered.
  RETURN jsonb_build_object('ok', true, 'refunded', v_amount, 'registration_id', v_reg_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_unregister_from_tournament(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_unregister_from_tournament(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_unregister_from_tournament(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_unregister_from_tournament(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_unregister_from_tournament(uuid) IS
  'AUDIT M19: a player unregisters THEMSELVES from a tournament and is refunded '
  'buy_in_amount + buy_in_fee read from the tournaments row. No user parameter '
  'and no amount parameter, both on purpose. Idempotency key is the deleted '
  'tournament_players row id, so re-registering later is a distinct payout.';
