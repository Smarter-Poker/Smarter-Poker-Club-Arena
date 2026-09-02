-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830212857; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- A TOURNAMENT REBUY NEEDS NO SEAT (Dan, 2026-08-30, verbatim):
-- "REBUYS IN A TOURNAMENT SHOULD NOT PAUSE THE ACTION, IT SHOUD TRIGGER THE
--  REBUY OFFER, THEN SIT THE PLAYER REBUYING AT ANY TABLE THAT NEEDS TO BE
--  BALANCED, OR AT ANY SEAT THAT IS OPEN OR WHERE A PLAYER IS NEEDED FIRST,
--  IF THEY TRULY SHOULD BE IN THE SAME TABLE, SAME SEAT, ITS ALLOWED."
--
-- The live-seat requirement (added to stop the seat sync erasing chips) made
-- the rebuy race fatal: once the sweep vacated the seat, the player could
-- never buy back in at all. Now:
--   - 'rebuy' WITH a live seat: unchanged — chips land on the seat (same
--     table, same seat: allowed).
--   - 'rebuy' WITHOUT a seat: chips land on the tournament_players row,
--     status returns to 'playing', elimination stamps are cleared (guarded:
--     never resurrects a finisher already paid a prize), and the engine's
--     ensureLateRegSeated sweep seats them at the table that most needs a
--     player within one 5s cycle. That row-not-seat state is the normal
--     late-reg shape, which the seat sync already respects.
--   - 'addon' still requires a live seat (mid-play purchase by definition).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_t record; v_p record; v_balance numeric; v_ratio numeric;
  v_is_bounty boolean; v_bounty_head numeric;
  v_base numeric; v_fee numeric; v_total numeric;
  v_add integer; v_new_chips integer; v_seat record;
  v_key text; v_inserted integer; v_cap integer; v_level integer; v_cat text;
  v_club uuid; v_legacy_ratio numeric; v_legacy_total numeric;
  v_stack_after numeric; v_expected numeric; v_fee_ratio numeric;
BEGIN
  IF NOT (COALESCE(auth.role(), 'service_role') = 'service_role')
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE = '42501';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %', p_rebuy_type;
  END IF;

  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee, starting_chips,
         is_rebuy, is_reentry, add_on_available, addon_period_triggered,
         rebuy_cost, rebuy_chips, rebuy_levels, late_reg_levels, max_rebuys,
         max_reentries, addon_cost, addon_chips, addon_levels, current_level, prize_pool,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount
    INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)', v_t.status;
  END IF;

  SELECT id, chips, status, prize, rebuys, add_on, table_id, club_id INTO v_p
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not registered in this tournament'; END IF;
  IF v_p.status = 'eliminated' AND COALESCE(v_p.prize, 0) > 0 THEN
    RAISE EXCEPTION 'Finishing place already paid — a rebuy cannot resurrect a settled result';
  END IF;
  v_club := COALESCE(v_p.club_id, public.fn_player_home_club(p_user_id, NULL));
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this tournament purchase';
  END IF;

  v_level := COALESCE(v_t.current_level, COALESCE(p_current_level, 0));
  v_cat   := CASE WHEN p_rebuy_type = 'addon' THEN 'addon' ELSE 'rebuy' END;

  -- Only an ADD-ON demands a live seat (a mid-play purchase by definition).
  -- A rebuy without a seat is now the normal race-recovery shape: the chips
  -- land on the player row and the seating sweep places them.
  IF p_rebuy_type = 'addon' THEN
    PERFORM 1 FROM table_seats s
      JOIN tables tb ON tb.id = s.table_id
     WHERE s.user_id = p_user_id AND s.left_at IS NULL
       AND tb.tournament_id = p_tournament_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No live seat for this % — refusing to charge for chips that would be overwritten by the seat sync', p_rebuy_type;
    END IF;
  END IF;

  IF p_rebuy_type = 'addon' THEN
    v_key := 'tourney:' || p_tournament_id || ':addon:' || p_user_id;
  ELSIF p_client_token IS NOT NULL AND length(btrim(p_client_token)) > 0 THEN
    v_key := 'tourney:' || p_tournament_id || ':' || p_rebuy_type || ':'
             || p_user_id || ':tok:' || btrim(p_client_token);
  ELSE
    v_key := 'tourney:' || p_tournament_id || ':' || p_rebuy_type || ':'
             || p_user_id || ':#' || COALESCE(v_p.rebuys, 0);
  END IF;

  IF p_rebuy_type <> 'addon' AND p_client_token IS NULL AND EXISTS (
      SELECT 1 FROM wallet_transactions w
       WHERE w.user_id = p_user_id AND w.related_entity_id = p_tournament_id
         AND w.category = v_cat
         AND w.created_at > now() - interval '1500 milliseconds') THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
                              'reason', 'double_submit_collapsed',
                              'new_stack', v_p.chips, 'rebuy_type', p_rebuy_type);
  END IF;

  INSERT INTO wallet_credit_idempotency (key, user_id, amount)
  VALUES (v_key, p_user_id, COALESCE(p_cost, 0)) ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true,
                              'new_stack', v_p.chips, 'rebuy_type', p_rebuy_type);
  END IF;

  IF p_rebuy_type = 'addon' THEN
    IF NOT COALESCE(v_t.add_on_available,false) THEN
      RAISE EXCEPTION 'Add-ons are not offered in this tournament'; END IF;
    IF COALESCE(v_p.add_on,false) THEN RAISE EXCEPTION 'Add-on already taken'; END IF;
    v_cap := COALESCE(NULLIF(v_t.late_reg_levels,0), NULLIF(v_t.rebuy_levels,0), 0)
             + COALESCE(v_t.addon_levels,1);
    IF v_cap > 0 AND v_level >= v_cap THEN
      RAISE EXCEPTION 'Add-on period has closed (level % of %)', v_level, v_cap; END IF;
    v_base := COALESCE(NULLIF(v_t.addon_cost,0), v_t.buy_in_amount, 0);
    v_add  := COALESCE(NULLIF(v_t.addon_chips,0), v_t.starting_chips, 0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament'; END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament'; END IF;
    v_cap := COALESCE(NULLIF(v_t.rebuy_levels,0), NULLIF(v_t.late_reg_levels,0), 0);
    IF v_cap > 0 AND COALESCE(v_t.add_on_available,false) THEN
      v_cap := v_cap + COALESCE(NULLIF(v_t.addon_levels,0),1); END IF;
    IF v_cap > 0 AND v_level >= v_cap THEN
      RAISE EXCEPTION 'Rebuy period has closed (level % of %)', v_level, v_cap; END IF;
    IF p_rebuy_type='rebuy' AND v_t.max_rebuys IS NOT NULL
       AND COALESCE(v_p.rebuys,0) >= v_t.max_rebuys THEN
      RAISE EXCEPTION 'Rebuy limit reached (% of %)', v_p.rebuys, v_t.max_rebuys; END IF;
    IF p_rebuy_type='reentry' AND v_t.max_reentries IS NOT NULL
       AND COALESCE(v_p.rebuys,0) >= v_t.max_reentries THEN
      RAISE EXCEPTION 'Re-entry limit reached (% of %)', v_p.rebuys, v_t.max_reentries; END IF;
    IF p_rebuy_type='rebuy' AND COALESCE(v_p.chips,0) > COALESCE(v_t.starting_chips,0) THEN
      RAISE EXCEPTION 'Stack too high for a rebuy'; END IF;
    v_base := COALESCE(NULLIF(v_t.rebuy_cost,0), v_t.buy_in_amount, 0);
    v_add  := COALESCE(NULLIF(v_t.rebuy_chips,0), v_t.starting_chips, 0)::integer;
  END IF;

  v_legacy_ratio := CASE WHEN COALESCE(v_t.buy_in_amount,0) > 0 AND COALESCE(v_t.buy_in_fee,0) > 0
                         THEN v_t.buy_in_fee / v_t.buy_in_amount ELSE 0.1 END;
  v_fee_ratio := CASE WHEN COALESCE(v_t.buy_in_amount,0) + COALESCE(v_t.buy_in_fee,0) > 0
                           AND COALESCE(v_t.buy_in_fee,0) > 0
                      THEN v_t.buy_in_fee / (v_t.buy_in_amount + v_t.buy_in_fee)
                      ELSE 0.1 END;
  v_ratio := CASE WHEN p_rebuy_type = 'addon' THEN 0 ELSE v_fee_ratio END;

  v_total := round(v_base::numeric);
  v_fee := CASE WHEN v_ratio > 0 AND v_total > 0
                THEN LEAST(trunc(v_total * v_ratio * 100 + 0.000001) / 100,
                           trunc(v_total * 0.1 * 100 + 0.000001) / 100)
                ELSE 0 END;
  v_base := round(v_total - v_fee, 2);
  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
                 OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type <> 'addon' THEN
    v_bounty_head := LEAST(GREATEST(0, round(COALESCE(v_t.bounty_amount,0))), v_base);
    v_base := v_base - v_bounty_head;
  ELSE
    v_bounty_head := 0;
  END IF;

  IF p_cost IS NOT NULL AND abs(p_cost - v_total) > 0.01 THEN
    v_legacy_total := v_total + round(v_total * v_legacy_ratio, 2);
    IF abs(p_cost - v_legacy_total) > 0.01 THEN
      RAISE EXCEPTION 'Price mismatch: client quoted %, server computed % (base % + fee %)',
        p_cost, v_total, v_base, v_fee;
    END IF;
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
  SELECT chip_balance INTO v_balance FROM club_members
   WHERE user_id = p_user_id AND club_id = v_club FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need % (incl. % fee), have %',
      v_total, v_fee, COALESCE(v_balance,0);
  END IF;
  UPDATE club_members SET chip_balance = chip_balance - v_total, updated_at = now()
   WHERE user_id = p_user_id AND club_id = v_club;

  IF p_rebuy_type='reentry' THEN
    UPDATE tournament_players SET chips=v_add, status='playing', eliminated_at=NULL,
           position=NULL, rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    UPDATE tournament_players SET chips=COALESCE(chips,0)+v_add, add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSE
    -- 2026-08-30: a rebuy also clears an elimination stamp the bust sweep may
    -- have raced onto the row (guarded above: never with a paid prize).
    UPDATE tournament_players SET chips=COALESCE(chips,0)+v_add, status='playing',
           eliminated_at=NULL, position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  END IF;

  IF v_bounty_head > 0 THEN
    UPDATE tournament_players
       SET current_bounty = CASE WHEN p_rebuy_type = 'reentry' THEN v_bounty_head
                                 ELSE COALESCE(current_bounty, 0) + v_bounty_head END
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id;
  END IF;

  SELECT s.id, s.stack INTO v_seat
    FROM table_seats s JOIN tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
   ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC, s.joined_at DESC NULLS LAST, s.id DESC
   LIMIT 1;
  IF FOUND THEN
    UPDATE table_seats
       SET stack = CASE WHEN p_rebuy_type='reentry' THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id
    RETURNING stack INTO v_stack_after;

    v_expected := CASE WHEN p_rebuy_type='reentry' THEN v_add
                       ELSE COALESCE(v_seat.stack,0) + v_add END;
    IF v_stack_after IS NULL OR v_stack_after <> v_expected THEN
      RAISE EXCEPTION
        'Chip grant did not land: % expected stack % (% + %), seat % holds % — aborting so no charge is made',
        p_rebuy_type, v_expected, COALESCE(v_seat.stack,0), v_add, v_seat.id, v_stack_after;
    END IF;

    UPDATE tournament_players
       SET chips=(SELECT stack FROM table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type = 'addon' THEN
    RAISE EXCEPTION 'Seat disappeared during % — aborting so no charge is made', p_rebuy_type;
  END IF;
  -- 'rebuy'/'reentry' with no seat: the chips stand on the player row and
  -- ensureLateRegSeated seats them at the table that most needs a player.

  UPDATE tournaments
     SET prize_pool  = COALESCE(prize_pool, 0) + v_base,
         bounty_pool = COALESCE(bounty_pool, 0) + v_bounty_head
   WHERE id = p_tournament_id;

  IF v_fee > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
      bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL,NULL,v_t.club_id,v_fee,v_fee,1,0,true,p_tournament_id,'process_tournament_rebuy',
      jsonb_build_object('kind','tournament_'||p_rebuy_type||'_fee','user_id',p_user_id,
                         'entry_club_id', v_club));
    UPDATE tournaments SET total_rake=COALESCE(total_rake,0)+v_fee WHERE id=p_tournament_id;
  END IF;

  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description,
    related_entity_id, balance_after)
  VALUES (p_user_id,'PLAYER','debit',v_total,v_cat,
    'Tournament '||p_rebuy_type||': '||COALESCE(v_t.name,'tournament')
      ||' ('||v_base||' + '||v_fee||' fee) [club wallet]',
    p_tournament_id, v_balance-v_total);

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_chips,
    'rebuy_type', p_rebuy_type, 'chips_added', v_add, 'cost', v_total, 'fee', v_fee,
    'seated', FOUND, 'bounty_head_funded', v_bounty_head);
END;
$function$;

DO $$
BEGIN
  IF position('addon''' in 'x') = 1 THEN NULL; END IF; -- no-op
  IF position('Only an ADD-ON demands a live seat' in
      pg_get_functiondef('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'seatless-rebuy redefinition did not land';
  END IF;
END $$;

