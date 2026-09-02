-- ============================================================================
--  bbj_payouts finally points at its hand
-- ============================================================================
--
--  Recorded in production as migration `bbj_payouts_link_to_their_hand`.
--
--  `bbj_atomic_payout_v2` inserted `hand_id` as a hardcoded NULL and always
--  had. The only link between a jackpot and the hand that won it was
--  (table_id, hand_number) -- which is why `fn_bbj_hand_detail` joins on that
--  pair, and why a hand that goes missing takes the rundown with it forever.
--
--  hand_history is written BEFORE the payout
--  (ServerTableEngineSettlement.ts:1009 vs :1407), so the row is there to be
--  found. When it is not -- `runStep` continues after a failed step by design
--  -- hand_id stays NULL, which is now a readable fact rather than the default
--  for every row. A replay of the payout retries the link, because on the
--  first pass the hand_history insert may have been the step that failed.
--
--  DELIBERATELY NOT A FOREIGN KEY YET. hand_history rows are pruned; ON DELETE
--  RESTRICT would make the pruner fail on a jackpot hand, and ON DELETE SET
--  NULL would quietly erase the very evidence this adds. The prune exemption
--  in 20260827d is what keeps those rows alive; a constraint can follow once
--  that has run for a while without incident.
--
--  Verified against production with a rolled-back probe (CLAUDE.md 11.5): a
--  payout written for a real hand came back with bbj_payouts.hand_id equal to
--  that hand_history row's id, four recipients summing exactly to the total.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bbj_atomic_payout_v2(p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_payout_total_percent numeric, p_loser_user_id uuid, p_winner_user_id uuid, p_dealt_in_ids uuid[], p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(applied boolean, already_paid boolean, recovered boolean, payout_id uuid, total_payout numeric, loser_share numeric, winner_share numeric, table_share numeric, per_player_share numeric, balance_after numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_main numeric; v_backup numeric;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric;
  v_per numeric; v_remainder numeric; v_payout_id uuid; v_existing uuid;
  v_club_id uuid; v_pre_hit_balance numeric; v_winner_name text; v_loser_name text;
  v_table_ids uuid[]; v_n_table integer; v_recovered boolean := false; v_uid uuid;
  v_hand_id uuid;
BEGIN
  IF p_payout_total_percent IS NULL OR p_payout_total_percent <= 0 OR p_payout_total_percent > 100 THEN
    RAISE EXCEPTION 'bbj payout percent % out of range (0,100]', p_payout_total_percent;
  END IF;

  SELECT COALESCE(array_agg(x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  SELECT id INTO v_existing FROM bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;

  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share
      INTO v_total, v_loser, v_winner, v_table FROM bbj_payouts bp WHERE bp.id = v_existing;
    IF v_n_table > 0 THEN v_per := ROUND(v_table / v_n_table, 2); ELSE v_per := 0; END IF;
    IF bbj_credit_one_recipient(v_existing, p_table_id, p_loser_user_id, v_loser, p_loser_user_id = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    IF bbj_credit_one_recipient(v_existing, p_table_id, p_winner_user_id, v_winner, p_winner_user_id = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      IF bbj_credit_one_recipient(v_existing, p_table_id, v_uid, v_per, v_uid = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    END LOOP;

    -- A replay is also the second chance to attach the hand: on the first pass
    -- the hand_history insert may have been the step that failed.
    UPDATE bbj_payouts bp
       SET hand_id = h.id
      FROM public.hand_history h
     WHERE bp.id = v_existing AND bp.hand_id IS NULL
       AND h.table_id = p_table_id AND h.hand_number = p_hand_number;

    RETURN QUERY SELECT false, true, v_recovered, v_existing, v_total, v_loser, v_winner, v_table, v_per, NULL::numeric;
    RETURN;
  END IF;

  SELECT main_balance, COALESCE(backup_balance,0) INTO v_main, v_backup FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_main IS NULL OR v_main <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, COALESCE(v_main,0);
    RETURN;
  END IF;

  v_pre_hit_balance := v_main;
  v_total  := ROUND(v_main * (p_payout_total_percent / 100.0), 2);
  -- CLAMP TO MAIN ONLY. The backup jackpot is a reserve and is never a payout
  -- source (Dan, 2026-08-18). This replaces the earlier LEAST(v_total, main+backup),
  -- which had authorised spending the reserve.
  v_total  := LEAST(v_total, v_main);
  v_loser  := ROUND(v_total * 0.50, 2);
  v_winner := ROUND(v_total * 0.25, 2);
  v_table  := ROUND(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN v_per := ROUND(v_table / v_n_table, 2); ELSE v_per := 0; END IF;
  v_remainder := ROUND(v_table - (v_per * v_n_table), 2);
  v_loser := v_loser + v_remainder;
  v_table := v_per * v_n_table;

  -- THE HAND. Written before the payout by postHandTasks, so it is normally
  -- here. NULL when that step failed, which is exactly the case worth being
  -- able to see.
  SELECT h.id INTO v_hand_id FROM public.hand_history h
   WHERE h.table_id = p_table_id AND h.hand_number = p_hand_number
   ORDER BY h.created_at DESC LIMIT 1;

  INSERT INTO bbj_payouts (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
    total_amount, winner_share, loser_share, table_share, table_player_count, metadata)
  VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_loser_user_id, p_winner_user_id,
    v_total, v_winner, v_loser, v_table, v_n_table, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    RETURN QUERY SELECT false, true, false, NULL::uuid, 0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_main;
    RETURN;
  END IF;

  -- MAIN ONLY. backup_balance is deliberately absent from this statement: a
  -- jackpot payout must never touch the reserve.
  UPDATE bbj_pools
     SET main_balance   = GREATEST(0, main_balance - v_total),
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         hit_count      = COALESCE(hit_count, 0) + 1,
         last_hit_at    = now(), last_hit_amount = v_total,
         last_winner_id = p_loser_user_id, last_loser_id = p_winner_user_id, updated_at = now()
   WHERE id = p_pool_id RETURNING main_balance, club_id INTO v_main, v_club_id;

  -- RESEED (Dan 2026-08-18): the back-up jackpot exists so that when a hit
  -- takes 100% of main, the jackpot does not restart at zero. If main is now
  -- empty, TRANSFER the reserve into it. A transfer, not a payout: no player
  -- is ever paid from the reserve, and chips are conserved.
  IF v_main <= 0 THEN
    v_main := GREATEST(v_main, fn_bbj_reseed_main_from_backup(p_pool_id));
  END IF;


  PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser, p_loser_user_id = ANY(p_seated_ids));
  PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner, p_winner_user_id = ANY(p_seated_ids));
  FOREACH v_uid IN ARRAY v_table_ids LOOP
    PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per, v_uid = ANY(p_seated_ids));
  END LOOP;

  SELECT COALESCE(NULLIF(display_name,''), NULLIF(username,''), 'Player') INTO v_winner_name FROM profiles WHERE id = p_loser_user_id;
  SELECT COALESCE(NULLIF(display_name,''), NULLIF(username,''), 'Player') INTO v_loser_name FROM profiles WHERE id = p_winner_user_id;

  INSERT INTO bbj_winners (pool_id, club_id, winner_id, loser_id, winner_display_name, loser_display_name,
    winner_hand, loser_hand, winner_payout, loser_payout, table_share_payout, total_payout,
    pool_amount_at_hit, table_id, hand_number, awarded_at)
  VALUES (p_pool_id, v_club_id, p_loser_user_id, p_winner_user_id, v_winner_name, v_loser_name,
    COALESCE(p_metadata->>'winner_hand_name', 'Unknown'), COALESCE(p_metadata->>'loser_hand_name', 'Unknown'),
    v_loser, v_winner, v_table, v_total, v_pre_hit_balance, p_table_id, p_hand_number, now())
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT true, false, false, v_payout_id, v_total, v_loser, v_winner, v_table, v_per, v_main;
END;
$function$;

-- Backfill everything still resolvable. The 24 whose hand was pruned stay NULL.
UPDATE public.bbj_payouts bp
   SET hand_id = h.id
  FROM public.hand_history h
 WHERE bp.hand_id IS NULL
   AND h.table_id = bp.table_id
   AND h.hand_number = bp.hand_number;

DO $$
BEGIN
  -- Every payout whose hand we still hold must be linked. If one is not, the
  -- backfill predicate disagrees with the join fn_bbj_hand_detail uses, and the
  -- two would resolve different hands for the same payout.
  IF EXISTS (
    SELECT 1 FROM public.bbj_payouts bp
     WHERE bp.hand_id IS NULL
       AND EXISTS (SELECT 1 FROM public.hand_history h
                    WHERE h.table_id = bp.table_id AND h.hand_number = bp.hand_number)
  ) THEN
    RAISE EXCEPTION 'a payout whose hand still exists was left unlinked';
  END IF;
END $$;
