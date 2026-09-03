-- ============================================================================
--  The BBJ money path enters version control
-- ============================================================================
--
--  AUDIT 2026-08-27 (Dan: "run a thorough deep dive and audit to make sure
--  that this functionality exists to auto update and capture this info when a
--  BBJ does hit").
--
--  `bbj_atomic_payout_v2` and `bbj_credit_one_recipient` are the two functions
--  that move the jackpot. Between them they debit the pool, write bbj_payouts,
--  credit EVERY recipient (bad beat, hand winner, and each other player dealt
--  in), and write bbj_winners. They are called on every real hit, from
--  server/src/services/supabase/bbj.ts:334.
--
--  NEITHER OF THEM EXISTED IN THIS REPOSITORY. `grep -rn bbj_atomic_payout_v2
--  --include=*.sql` returned one comment. The only payout DDL in
--  supabase/migrations/ was the superseded v1
--  (20260724b_rake_audit_sweep2_db_fixes.sql:42), which does not write
--  recipients and does not credit a seat or a wallet at all. So a rebuild of
--  this database from the repository would have produced a jackpot that debits
--  the pool and pays nobody, and nothing in CI would have said a word — the
--  functions were tracked only by NAME in
--  scripts/ci/supabase-schema-manifest.json:956.
--
--  This is a verbatim capture of what production is running today, taken with
--  pg_get_functiondef. It is CREATE OR REPLACE and byte-equivalent to the live
--  bodies, so applying it against production changes nothing; its whole job is
--  to make the money path reconstructible.
--
--  Read the two comments the live bodies already carry — the main-only clamp
--  and the reseed — before changing either. They are Dan's 2026-08-18 rulings
--  and they are the reason the backup jackpot is never a payout source.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bbj_credit_one_recipient(p_payout_id uuid, p_table_id uuid, p_user_id uuid, p_amount numeric, p_seated boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_claimed integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN false;
  END IF;

  INSERT INTO bbj_payout_recipients (payout_id, user_id, amount)
  VALUES (p_payout_id, p_user_id, p_amount)
  ON CONFLICT (payout_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN false;  -- already credited under this payout
  END IF;

  IF p_seated THEN
    UPDATE table_seats
       SET stack = COALESCE(stack, 0) + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    IF FOUND THEN
      RETURN true;  -- seat credited durably; engine syncStacks writes same value
    END IF;
    -- Seat vanished since the engine snapshot: fall through to wallet credit.
  END IF;

  -- Departed recipient (or seat gone): credit the real-money wallet via the
  -- whitelisted RPC so the Phase 4.1.6a guard permits the write.
  PERFORM credit_player_wallet(p_user_id, p_amount);
  RETURN true;
END;
$function$;

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

  INSERT INTO bbj_payouts (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
    total_amount, winner_share, loser_share, table_share, table_player_count, metadata)
  VALUES (p_pool_id, NULL, p_table_id, p_hand_number, p_loser_user_id, p_winner_user_id,
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
