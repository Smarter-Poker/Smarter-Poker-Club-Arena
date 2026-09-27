-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815160400 "fn_collect_bounty_atomic_pool_funded_payout"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4685b3954fcd68006add9e7fb1a9ded8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- DAN'S SPEC 2026-08-15 (part 3): bounties are now PAID OUT OF the funded
-- bounty_pool, atomically, in one RPC. Replaces four separate engine writes
-- (read knocker -> update stats -> credit wallet -> insert record) that were a
-- non-atomic read-modify-write: a concurrent knockout lost a head increment,
-- and nothing ever checked the pool.
--
-- Handles all three modes from the tournament's own flags:
--   REGULAR : full head -> knocker's wallet
--   PKO     : half -> knocker's wallet, half -> knocker's own head (stays in
--             the pool, so bounty_pool_paid only rises by the cash half)
--   MYSTERY : the head assigned at registration (tiered ladder) -> wallet
--
-- Conservation: payouts are capped at (bounty_pool - bounty_pool_paid) so the
-- pool can never be overdrawn, and any residual is settled to the champion by
-- fn_finalize_bounty_pool at completion.

CREATE OR REPLACE FUNCTION public.fn_collect_bounty(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_collector_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_elim record;
  v_head numeric;
  v_available numeric;
  v_payable numeric;
  v_cash numeric;
  v_to_head numeric;
  v_cents integer;
  v_cash_cents integer;
  v_mode text;
BEGIN
  IF p_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_party');
  END IF;

  SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         bounty_pool, bounty_pool_paid
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_bounty_tournament');
  END IF;

  -- One bounty per eliminated player per tournament.
  IF EXISTS (SELECT 1 FROM tournament_bounties
              WHERE tournament_id = p_tournament_id
                AND eliminated_player_id = p_eliminated_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_collected');
  END IF;

  SELECT current_bounty, mystery_bounty_value INTO v_elim
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id
   FOR UPDATE;

  v_mode := CASE WHEN COALESCE(v_t.is_pko,false) THEN 'pko'
                 WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery'
                 ELSE 'regular' END;

  v_head := COALESCE(NULLIF(v_elim.current_bounty, 0),
                     NULLIF(v_elim.mystery_bounty_value, 0),
                     v_t.bounty_amount, 0);
  IF v_head <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_head_value');
  END IF;

  v_available := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);
  IF v_available <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                              'head', v_head, 'available', v_available);
  END IF;
  v_payable := LEAST(v_head, v_available);

  IF v_mode = 'pko' THEN
    -- Exact-conserving 50/50: the odd cent goes to the growing head.
    v_cents      := round(v_payable * 100)::integer;
    v_cash_cents := (v_cents / 2)::integer;
    v_cash       := v_cash_cents / 100.0;
    v_to_head    := (v_cents - v_cash_cents) / 100.0;
  ELSE
    v_cash    := v_payable;
    v_to_head := 0;
  END IF;

  -- Credit the cash half (idempotent on the natural pair key).
  IF v_cash > 0 THEN
    PERFORM public.credit_player_wallet(
      p_collector_user_id, v_cash,
      'tourney:' || p_tournament_id || ':bounty:' || p_eliminated_user_id
        || ':' || p_collector_user_id);
    PERFORM public.log_wallet_transaction(
      p_collector_user_id, 'PLAYER', v_cash, 'credit', 'bounty',
      CASE v_mode WHEN 'pko'     THEN 'PKO bounty (cash half) from eliminated player'
                  WHEN 'mystery' THEN 'Mystery bounty revealed from eliminated player'
                  ELSE 'Bounty collected from eliminated player' END,
      NULL, NULL, p_tournament_id);
  END IF;

  -- Collector stats + growing head, as atomic SQL increments (never a
  -- read-modify-write, which previously lost concurrent knockouts).
  UPDATE tournament_players
     SET bounties_collected = COALESCE(bounties_collected,0) + 1,
         bounty_winnings    = round(COALESCE(bounty_winnings,0) + v_cash, 2),
         current_bounty     = round(COALESCE(current_bounty,0) + v_to_head, 2)
   WHERE tournament_id = p_tournament_id AND user_id = p_collector_user_id;

  -- The eliminated player's head is consumed.
  UPDATE tournament_players
     SET current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

  -- Only the cash actually leaving the pool counts as paid; the PKO half that
  -- moved onto the knocker's head is still pool money.
  UPDATE tournaments
     SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_cash, 2)
   WHERE id = p_tournament_id;

  INSERT INTO tournament_bounties
    (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
     added_to_collector_bounty, is_mystery_revealed)
  VALUES (p_tournament_id, p_eliminated_user_id, p_collector_user_id, v_payable,
          CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END,
          v_mode = 'mystery');

  RETURN jsonb_build_object('ok', true, 'mode', v_mode, 'head', v_head,
    'paid_cash', v_cash, 'added_to_head', v_to_head, 'capped', v_payable < v_head,
    'pool_remaining', round(v_available - v_cash, 2));
END;
$function$;

-- Settle whatever is left in the bounty pool to the champion (their own
-- unclaimed head plus any residual from the tiered mystery draw).
CREATE OR REPLACE FUNCTION public.fn_finalize_bounty_pool(
  p_tournament_id uuid, p_winner_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t record; v_residual numeric;
BEGIN
  SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_pool, bounty_pool_paid
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok', true, 'residual', 0, 'reason', 'not_a_bounty_tournament');
  END IF;

  v_residual := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);
  IF v_residual <= 0 OR p_winner_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'residual', GREATEST(v_residual, 0));
  END IF;

  PERFORM public.credit_player_wallet(p_winner_user_id, v_residual,
    'tourney:' || p_tournament_id || ':ownbounty:' || p_winner_user_id);
  PERFORM public.log_wallet_transaction(
    p_winner_user_id, 'PLAYER', v_residual, 'credit', 'bounty',
    'Unclaimed bounty pool awarded to champion', NULL, NULL, p_tournament_id);

  UPDATE tournaments SET bounty_pool_paid = COALESCE(bounty_pool,0) WHERE id = p_tournament_id;
  UPDATE tournament_players
     SET bounty_winnings = round(COALESCE(bounty_winnings,0) + v_residual, 2),
         current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;

  RETURN jsonb_build_object('ok', true, 'residual', v_residual, 'paid_to', p_winner_user_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid) TO service_role;
