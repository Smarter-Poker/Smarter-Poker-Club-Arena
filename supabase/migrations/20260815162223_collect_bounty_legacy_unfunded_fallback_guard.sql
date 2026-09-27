-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815162223 "collect_bounty_legacy_unfunded_fallback_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4dc2d2bb3f5a769cfd62123ed1147703 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- URGENT GUARD 2026-08-15, caught by live verification before it bit:
-- fn_collect_bounty caps payouts at (bounty_pool - bounty_pool_paid). That is
-- correct for events funded through fn_register_for_tournament, but the
-- recurring/horse seeding path inserts tournament_players DIRECTLY and never
-- funds bounty_pool. Every currently-running bounty tournament therefore has
-- bounty_pool = 0 (verified: "Afternoon Bounty (NLH)", 18 players, pool 0),
-- so the new engine would have refused every knockout with
-- 'bounty_pool_exhausted' and silently stopped paying bounties.
--
-- Guard: a bounty event with NO funded pool is treated as LEGACY/unfunded and
-- pays the head exactly as before (house-funded, same as its house-funded
-- prize pool). Funded events keep full pool discipline. The response flags
-- which mode was used so the funding rollout can be tracked.

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
  v_t record; v_elim record;
  v_head numeric; v_available numeric; v_payable numeric;
  v_cash numeric; v_to_head numeric;
  v_cents integer; v_cash_cents integer;
  v_mode text; v_funded boolean;
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

  -- Funded vs legacy. A pool of 0 means nothing was ever collected for
  -- bounties on this event (horse-seeded / pre-funding-model tournament).
  v_funded  := COALESCE(v_t.bounty_pool, 0) > 0;
  v_available := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);

  IF v_funded THEN
    IF v_available <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                                'head', v_head, 'available', v_available);
    END IF;
    v_payable := LEAST(v_head, v_available);
  ELSE
    -- Legacy unfunded event: pay the head, exactly as before the funding model.
    v_payable := v_head;
  END IF;

  IF v_mode = 'pko' THEN
    v_cents      := round(v_payable * 100)::integer;
    v_cash_cents := (v_cents / 2)::integer;
    v_cash       := v_cash_cents / 100.0;
    v_to_head    := (v_cents - v_cash_cents) / 100.0;
  ELSE
    v_cash := v_payable; v_to_head := 0;
  END IF;

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

  UPDATE tournament_players
     SET bounties_collected = COALESCE(bounties_collected,0) + 1,
         bounty_winnings    = round(COALESCE(bounty_winnings,0) + v_cash, 2),
         current_bounty     = round(COALESCE(current_bounty,0) + v_to_head, 2)
   WHERE tournament_id = p_tournament_id AND user_id = p_collector_user_id;

  UPDATE tournament_players SET current_bounty = 0
   WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

  -- Only funded events track drawdown; legacy events have no pool to draw.
  IF v_funded THEN
    UPDATE tournaments
       SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_cash, 2)
     WHERE id = p_tournament_id;
  END IF;

  INSERT INTO tournament_bounties
    (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
     added_to_collector_bounty, is_mystery_revealed)
  VALUES (p_tournament_id, p_eliminated_user_id, p_collector_user_id, v_payable,
          CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END,
          v_mode = 'mystery');

  RETURN jsonb_build_object('ok', true, 'mode', v_mode, 'funded', v_funded,
    'head', v_head, 'paid_cash', v_cash, 'added_to_head', v_to_head,
    'capped', v_funded AND v_payable < v_head,
    'pool_remaining', CASE WHEN v_funded THEN round(v_available - v_cash, 2) END);
END;
$function$;

-- Same treatment for the champion settlement: never touch a legacy event.
CREATE OR REPLACE FUNCTION public.fn_finalize_bounty_pool(
  p_tournament_id uuid, p_winner_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t record; v_residual numeric; v_own numeric;
BEGIN
  SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_pool, bounty_pool_paid
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok', true, 'residual', 0, 'reason', 'not_a_bounty_tournament');
  END IF;

  IF COALESCE(v_t.bounty_pool, 0) <= 0 THEN
    -- Legacy unfunded event: pay the champion their own remaining head, which
    -- is what the pre-funding-model code did.
    SELECT COALESCE(NULLIF(current_bounty,0), NULLIF(mystery_bounty_value,0), 0)
      INTO v_own FROM tournament_players
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    IF COALESCE(v_own,0) <= 0 OR p_winner_user_id IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'residual', 0, 'funded', false);
    END IF;
    PERFORM public.credit_player_wallet(p_winner_user_id, v_own,
      'tourney:' || p_tournament_id || ':ownbounty:' || p_winner_user_id);
    PERFORM public.log_wallet_transaction(
      p_winner_user_id, 'PLAYER', v_own, 'credit', 'bounty',
      'Tournament champion: own bounty head collected', NULL, NULL, p_tournament_id);
    UPDATE tournament_players
       SET bounty_winnings = round(COALESCE(bounty_winnings,0) + v_own, 2),
           current_bounty = 0
     WHERE tournament_id = p_tournament_id AND user_id = p_winner_user_id;
    RETURN jsonb_build_object('ok', true, 'residual', v_own, 'funded', false,
                              'paid_to', p_winner_user_id);
  END IF;

  v_residual := round(COALESCE(v_t.bounty_pool,0) - COALESCE(v_t.bounty_pool_paid,0), 2);
  IF v_residual <= 0 OR p_winner_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'residual', GREATEST(v_residual,0), 'funded', true);
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

  RETURN jsonb_build_object('ok', true, 'residual', v_residual, 'funded', true,
                            'paid_to', p_winner_user_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid) TO service_role;
