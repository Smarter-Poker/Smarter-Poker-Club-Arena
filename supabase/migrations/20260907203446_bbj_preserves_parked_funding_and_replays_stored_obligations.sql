-- Preserve money owed to parked BBJ recipients in its original bank.
-- Replay reads durable obligations, not a mutable caller recipient list.
-- Main/Mini payout, bank transfer, reseed and union-join paths are corrected.
-- No historical player balance adjustment or repair sweep is introduced.
BEGIN;
CREATE OR REPLACE FUNCTION public.fn_bbj_parked_reserve(p_pool_id uuid,p_bank text)
RETURNS numeric LANGUAGE sql VOLATILE SET search_path TO 'public' AS $function$
  -- A parked refund remains in this bank but is already owed, not spendable.
  -- Financial callers must hold bbj_pools FOR UPDATE before reading it.
  SELECT COALESCE(sum(u.amount),0) FROM public.bbj_unclaimed_shares u
  JOIN public.bbj_payouts p ON p.id=u.payout_id
  WHERE u.pool_id=p_pool_id AND u.paid_at IS NULL
    AND (CASE WHEN p.kind='mini' THEN 'backup' ELSE 'main' END)=p_bank;
$function$;
CREATE OR REPLACE FUNCTION public.bbj_atomic_payout_v2(p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_payout_total_percent numeric, p_loser_user_id uuid, p_winner_user_id uuid, p_dealt_in_ids uuid[], p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(applied boolean, already_paid boolean, recovered boolean, payout_id uuid, total_payout numeric, loser_share numeric, winner_share numeric, table_share numeric, per_player_share numeric, balance_after numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_main numeric; v_backup numeric;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric;
  v_per numeric; v_remainder numeric; v_payout_id uuid; v_existing uuid;
  v_club_id uuid; v_pre_hit_balance numeric; v_winner_name text; v_loser_name text;
  v_table_ids uuid[]; v_n_table integer; v_recovered boolean := false; v_uid uuid;
  v_hand_id uuid; v_pending record; v_reserved numeric;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'bbj_atomic_payout_v2 is service only' USING ERRCODE = '42501';
  END IF;
  IF p_payout_total_percent IS NULL OR p_payout_total_percent <= 0 OR p_payout_total_percent > 100 THEN
    RAISE EXCEPTION 'bbj payout percent % out of range (0,100]', p_payout_total_percent;
  END IF;
  /* PHASE 6.2 (2026-09-05): the kill switch. An open freeze on jackpot payouts
     refuses the payout with a message the engine's queue retries (it retries
     everything but 'out of range', 'service only' and 42501), so a jackpot
     hit during a freeze is paid the moment the freeze is cleared. */
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'bbj_payouts' AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: jackpot payouts are frozen by the kill switch (ca_payout_freeze scope bbj_payouts); the engine retries when it is cleared'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x IS NOT NULL AND x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  IF p_pool_id IS NULL OR p_table_id IS NULL OR p_hand_number IS NULL
     OR p_loser_user_id IS NULL OR p_winner_user_id IS NULL
     OR p_loser_user_id = p_winner_user_id THEN
    RAISE EXCEPTION 'main jackpot requires a hand and two distinct recipients' USING ERRCODE='22023';
  END IF;
  -- Allocation and replay share the pool lock before reading the hand key.
  PERFORM 1 FROM public.bbj_pools WHERE id=p_pool_id FOR UPDATE;
  SELECT id INTO v_existing FROM bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;

  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share, bp.table_player_count
      INTO v_total, v_loser, v_winner, v_table, v_n_table FROM bbj_payouts bp WHERE bp.id=v_existing;
    v_per := CASE WHEN v_n_table>0 THEN v_table/v_n_table ELSE 0 END;
    -- Only durable unpaid obligations can authorize a recovery credit.
    -- Caller-supplied players/amounts never create recipients on replay.
    FOR v_pending IN SELECT u.user_id,u.amount FROM public.bbj_unclaimed_shares u
      WHERE u.payout_id=v_existing AND u.paid_at IS NULL ORDER BY u.user_id
    LOOP
      IF public.bbj_credit_one_recipient(v_existing,p_table_id,v_pending.user_id,v_pending.amount,
        EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id
          AND s.user_id=v_pending.user_id AND s.left_at IS NULL)) THEN v_recovered:=true; END IF;
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
  v_reserved := public.fn_bbj_parked_reserve(p_pool_id,'main');
  v_main := v_main-v_reserved;
  IF v_main IS NULL OR v_main <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, COALESCE(v_main,0);
    RETURN;
  END IF;

  v_pre_hit_balance := v_main;
  v_total  := ROUND(v_main * (p_payout_total_percent / 100.0), 2);
  -- CLAMP TO MAIN ONLY. The backup jackpot is a reserve and is never a payout
  -- source (Dan, 2026-08-18). This replaces the earlier LEAST(v_total,
  -- main+backup), which had authorised spending the reserve.
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

  /* THE PAYOUT IS DECLARED (chip standard Phase 4.3, 2026-09-04): the main
     jackpot pays the felt of the hitting table. Seated recipients hold their
     share on that felt; a departed recipient's share leaves the felt for the
     wallet in bbj_credit_one_recipient, declared there. Before today this
     debit fell to settlement_suspense. */
  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL,
                                      'bbj_payout:' || v_payout_id::text, NULL);
  -- MAIN ONLY. backup_balance is deliberately absent from this statement: a
  -- jackpot payout must never touch the reserve.
  UPDATE bbj_pools
     SET main_balance   = GREATEST(0, main_balance - v_total),
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         hit_count      = COALESCE(hit_count, 0) + 1,
         last_hit_at    = now(), last_hit_amount = v_total,
         last_winner_id = p_loser_user_id, last_loser_id = p_winner_user_id, updated_at = now()
   WHERE id = p_pool_id RETURNING main_balance, club_id INTO v_main, v_club_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  -- RESEED (Dan 2026-08-18): the back-up jackpot exists so that when a hit
  -- takes 100% of main, the jackpot does not restart at zero. If main is now
  -- empty, TRANSFER the reserve into it. A transfer, not a payout: no player
  -- is ever paid from the reserve, and chips are conserved. Recorded as a
  -- bank move; an empty reserve raises an incident (Phase 4.3).
  IF v_main <= v_reserved THEN
    v_main := GREATEST(v_main, public.fn_bbj_reseed_main_from_backup(p_pool_id));
  END IF;

  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser, p_loser_user_id = ANY(p_seated_ids));
  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner, p_winner_user_id = ANY(p_seated_ids));
  FOREACH v_uid IN ARRAY v_table_ids LOOP
    PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per, v_uid = ANY(p_seated_ids));
  END LOOP;

  SELECT public.fn_arena_name(alias, username, display_name, first_name, last_name, full_name) INTO v_winner_name FROM profiles WHERE id = p_loser_user_id;
  SELECT public.fn_arena_name(alias, username, display_name, first_name, last_name, full_name) INTO v_loser_name FROM profiles WHERE id = p_winner_user_id;

  /* THE CLUB THE HAND WAS PLAYED IN (BBJ audit 2026-09-05). A union pool has
     no club_id of its own, so v_club_id from the pool row above is NULL for
     every union hit and the Previous Winners row said the jackpot happened
     nowhere. The hitting table always knows its club. */
  SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = p_table_id AND t.club_id IS NOT NULL;
  IF v_club_id IS NULL THEN
    SELECT bp2.club_id INTO v_club_id FROM public.bbj_pools bp2 WHERE bp2.id = p_pool_id;
  END IF;
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
CREATE OR REPLACE FUNCTION public.fn_bbj_mini_payout(p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_tier_id text, p_loser_user_id uuid, p_winner_user_id uuid, p_dealt_in_ids uuid[], p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(applied boolean, already_paid boolean, refused text, payout_id uuid, total_payout numeric, loser_share numeric, winner_share numeric, table_share numeric, per_player_share numeric, backup_after numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_backup numeric; v_floor numeric; v_amount numeric; v_enabled boolean;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric; v_per numeric;
  v_payout_id uuid; v_existing uuid; v_table_ids uuid[]; v_n_table integer;
  v_club_id uuid; v_uid uuid; v_remainder numeric; v_hand_id uuid;
  v_loser_name text; v_winner_name text; v_pending record;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_mini_payout is service only' USING ERRCODE = '42501';
  END IF;

  /* The same kill switch the main jackpot honours, and the same error class,
     so the engine's queue retries a mini frozen mid-flight exactly as it
     retries a main one. */
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
              WHERE f.scope = 'bbj_payouts' AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: jackpot payouts are frozen by the kill switch (ca_payout_freeze scope bbj_payouts); the engine retries when it is cleared'
      USING ERRCODE = 'P0404';
  END IF;

  IF p_pool_id IS NULL OR p_table_id IS NULL OR p_hand_number IS NULL
     OR p_loser_user_id IS NULL OR p_winner_user_id IS NULL
     OR p_loser_user_id = p_winner_user_id THEN
    RAISE EXCEPTION 'mini jackpot requires a hand and two distinct recipients'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize the decision before inspecting its idempotency record. A
  -- concurrent second caller must see the first caller's committed payout.
  SELECT COALESCE(backup_balance,0), COALESCE(mini_reserve_floor, 0), club_id
    INTO v_backup, v_floor, v_club_id
    FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'pool_not_found'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* IDEMPOTENT ON THE HAND, and it shares the key with the main jackpot on
     purpose: bbj_payouts_pool_table_hand_uidx means one hand can produce one
     payout of either kind and never both. A mini only ever runs when
     detectBBJHit refused the main, so the two cannot race for the same hand -
     and if that ever stops being true, this is where it stops, not a second
     row nobody reconciles. */
  SELECT id INTO v_existing FROM public.bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;
  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share, bp.table_player_count
      INTO v_total, v_loser, v_winner, v_table, v_n_table
      FROM public.bbj_payouts bp WHERE bp.id = v_existing;
    FOR v_pending IN SELECT u.user_id,u.amount FROM public.bbj_unclaimed_shares u
      WHERE u.payout_id=v_existing AND u.paid_at IS NULL ORDER BY u.user_id
    LOOP
      PERFORM public.bbj_credit_one_recipient(v_existing,p_table_id,v_pending.user_id,v_pending.amount,
        EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id
          AND s.user_id=v_pending.user_id AND s.left_at IS NULL));
    END LOOP;
    SELECT COALESCE(backup_balance,0) INTO v_backup FROM public.bbj_pools WHERE id = p_pool_id;
    RETURN QUERY SELECT false, true, NULL::text, v_existing, v_total, v_loser, v_winner,
      v_table, CASE WHEN v_n_table > 0 THEN v_table / v_n_table ELSE 0::numeric END, v_backup;
    RETURN;
  END IF;

  SELECT amount, enabled INTO v_amount, v_enabled
    FROM public.bbj_mini_tiers WHERE tier_id = p_tier_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'no_mini_amount_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;
  IF NOT v_enabled THEN
    RETURN QUERY SELECT false, false, 'mini_disabled_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* THE FLOOR IS NOT NEGOTIABLE AND THE MINI IS NOT SHRUNK TO FIT.
     Paying a partial mini would publish one number to the player and pay
     another; a mini that cannot be paid in full is simply not owed. */
  IF v_backup - public.fn_bbj_parked_reserve(p_pool_id,'backup') - v_amount < v_floor THEN
    RETURN QUERY SELECT false, false, 'reserve_at_floor'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x IS NOT NULL AND x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  v_total  := round(v_amount, 2);
  v_loser  := round(v_total * 0.50, 2);
  v_winner := round(v_total * 0.25, 2);
  v_table  := round(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN
    v_per := round(v_table / v_n_table, 2);
    -- Preserve the main jackpot's signed residual rule, BEFORE the loser is
    -- credited. A second credit is deduplicated; ignoring a negative residual
    -- creates chips. Persist the actual table allocation shown to clients.
    v_remainder := v_table - v_per * v_n_table;
    v_loser := v_loser + v_remainder;
    v_table := v_per * v_n_table;
  ELSE
    /* Nobody else was dealt in: the table quarter goes to the player who took
       the beat rather than staying in a bank nobody can see. */
    v_per := 0;
    v_loser := round(v_loser + v_table, 2);
    v_table := 0;
  END IF;

  IF v_loser < 0 OR v_winner < 0 OR v_table < 0
     OR v_loser + v_winner + v_table <> v_total THEN
    RAISE EXCEPTION 'mini jackpot allocation does not conserve its funded total';
  END IF;

  SELECT id INTO v_hand_id FROM public.hand_history
   WHERE table_id = p_table_id AND hand_number = p_hand_number
   ORDER BY created_at DESC LIMIT 1;

  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'bbj_pool', p_pool_id, NULL,
            'bbj_mini:' || p_pool_id::text || ':' || p_table_id::text || ':' || p_hand_number::text, NULL);
  UPDATE public.bbj_pools
     SET backup_balance = GREATEST(0, COALESCE(backup_balance,0) - v_total),
         /* The pool's own paid-out counter moves with every payout of either
            kind. fn_bbj_conservation_check compares that counter against the
            bbj_payouts rows (phase 5.3); a mini that wrote a row and left the
            counter behind would take `paid_without_a_payout_row_since`
            negative and the lifetime verdict false. */
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         updated_at = now()
   WHERE id = p_pool_id
   RETURNING COALESCE(backup_balance,0) INTO v_backup;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  INSERT INTO public.bbj_payouts
    (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
     total_amount, winner_share, loser_share, table_share, table_player_count, kind, metadata)
  VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_winner_user_id, p_loser_user_id,
          v_total, v_winner, v_loser, v_table, v_n_table, 'mini',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('tier_id', p_tier_id, 'funded_from', 'backup_reserve'))
  RETURNING id INTO v_payout_id;

  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser,
            p_loser_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner,
            p_winner_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  IF v_n_table > 0 AND v_per > 0 THEN
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per,
                v_uid = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
    END LOOP;

  END IF;

  /* THE ARENA NAME, through the platform's own helper. The first cut of this
     function read `profiles.arena_name`, a column that does not exist, and a
     rolled-back probe (CLAUDE.md 11.5) found it before a single real hand
     could. fn_arena_name is what fn_bbj_recent_hits and the rest of the arena
     already use, and reusing it is why the mini ticker will show the same name
     the main one does. */
  SELECT COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name),
                  pr.username, 'Player')
    INTO v_loser_name FROM public.profiles pr WHERE pr.id = p_loser_user_id;
  SELECT COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name),
                  pr.username, 'Player')
    INTO v_winner_name FROM public.profiles pr WHERE pr.id = p_winner_user_id;

  INSERT INTO public.bbj_winners
    (club_id, pool_id, loser_id, winner_id, loser_payout, winner_payout,
     table_share_payout, total_payout, pool_amount_at_hit, stakes_tier,
     table_id, hand_number, awarded_at, winner_display_name, loser_display_name, kind)
  VALUES (v_club_id, p_pool_id, p_loser_user_id, p_winner_user_id, v_loser, v_winner,
          v_table, v_total, v_backup + v_total, p_tier_id,
          p_table_id, p_hand_number, now(), v_winner_name, v_loser_name, 'mini')
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING;

  RETURN QUERY SELECT true, false, NULL::text, v_payout_id, v_total, v_loser, v_winner,
    v_table, v_per, v_backup;
END;
 $function$;
CREATE OR REPLACE FUNCTION public.fn_bbj_move_between_banks(p_pool_id uuid, p_from_bank text, p_to_bank text, p_amount numeric, p_reason text, p_op_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amt numeric := round(COALESCE(p_amount, 0), 2);
  v_pool public.bbj_pools%ROWTYPE; v_have numeric; v_prior public.ca_bbj_bucket_moves%ROWTYPE;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_move_between_banks is service only' USING ERRCODE = '42501';
  END IF;
  IF p_from_bank NOT IN ('main', 'backup', 'promo') OR p_to_bank NOT IN ('main', 'backup', 'promo') OR p_from_bank = p_to_bank THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'banks_must_be_two_of_main_backup_promo');
  END IF;
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 OR COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'a_bank_move_needs_a_reason_and_an_op_id');
  END IF;
  SELECT * INTO v_pool FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_found');
  END IF;
  SELECT * INTO v_prior FROM public.ca_bbj_bucket_moves WHERE op_id = p_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'move_id', v_prior.id, 'amount', v_prior.amount);
  END IF;
  v_have := CASE p_from_bank WHEN 'main' THEN v_pool.main_balance WHEN 'backup' THEN v_pool.backup_balance ELSE v_pool.promo_balance END;
  v_have := v_have-public.fn_bbj_parked_reserve(p_pool_id,p_from_bank);
  IF COALESCE(v_have, 0) < v_amt THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_bank_cannot_cover_it', 'available', COALESCE(v_have, 0), 'requested', v_amt);
  END IF;
  -- Declared as bbj_pool -> bbj_pool: the chips change bank, not account. The
  -- autoledger writes one leg per bucket column with its label, which is what
  -- the per-bank reconcile reads.
  PERFORM public.fn_ca_declare_ledger('adjustment', 'bbj_pool', p_pool_id, NULL, NULL, NULL);
  UPDATE public.bbj_pools
     SET main_balance   = main_balance   + CASE WHEN p_to_bank = 'main'   THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'main'   THEN v_amt ELSE 0 END,
         backup_balance = backup_balance + CASE WHEN p_to_bank = 'backup' THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'backup' THEN v_amt ELSE 0 END,
         promo_balance  = promo_balance  + CASE WHEN p_to_bank = 'promo'  THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'promo'  THEN v_amt ELSE 0 END,
         updated_at = now()
   WHERE id = p_pool_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  INSERT INTO public.ca_bbj_bucket_moves (pool_id, from_bank, to_bank, amount, reason, op_id, performed_by)
  VALUES (p_pool_id, p_from_bank, p_to_bank, v_amt, btrim(p_reason), p_op_id, auth.uid())
  RETURNING * INTO v_prior;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'move_id', v_prior.id, 'amount', v_amt,
                            'from_bank', p_from_bank, 'to_bank', p_to_bank);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_bbj_reseed_main_from_backup(p_pool_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_main numeric; v_backup numeric; v_res jsonb; v_union uuid; v_club uuid;
BEGIN
  SELECT COALESCE(main_balance, 0), COALESCE(backup_balance, 0), union_id, club_id
    INTO v_main, v_backup, v_union, v_club
    FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND OR v_main > public.fn_bbj_parked_reserve(p_pool_id,'main') THEN
    RETURN COALESCE(v_main, 0);
  END IF;
  v_backup := v_backup-public.fn_bbj_parked_reserve(p_pool_id,'backup');
  IF v_backup <= 0 THEN
    -- The reserve is empty: the jackpot restarts at zero. Not refused (the
    -- hit has been paid and the pool is what it is), but never silent.
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_bbj_reseed_main_from_backup', 'bbj_error', 'warning',
      'bbj-reserve-empty:' || p_pool_id::text || ':' || to_char(now(), 'YYYY-MM-DD-HH24'),
      0, NULL, 0, 'ledger', 'bbj_pools', p_pool_id, v_club, v_union, NULL, NULL, NULL, NULL, NULL, NULL,
      'a 100% hit drained the main jackpot and the backup reserve was empty, so the jackpot restarts at 0; fund the reserve (fn_union_fund_bbj_pool) or accept the restart',
      true, jsonb_build_object('pool_id', p_pool_id));
    RETURN COALESCE(v_main,0);
  END IF;
  v_res := public.fn_bbj_move_between_banks(p_pool_id, 'backup', 'main', v_backup,
             'reseed: a hit took 100% of main; the reserve becomes the new main jackpot',
             'reseed:' || p_pool_id::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
  IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'reseed failed: %', v_res;
  END IF;
  RETURN v_main+v_backup;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_close_club_wallets_on_union_join(p_club_id uuid, p_union_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_spin jsonb;
  v_bbj_main numeric := 0; v_bbj_backup numeric := 0; v_bbj_promo numeric := 0;
  v_bbj_total numeric := 0; v_club_promo numeric := 0;
  v_keep_main numeric; v_keep_backup numeric; v_pool_id uuid; v_union_pool uuid; v_after numeric; v_treasury numeric;
BEGIN
  IF p_club_id IS NULL OR p_union_id IS NULL OR p_club_id = p_union_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'nothing_to_close');
  END IF;

  v_spin := public.fn_spin_absorb_club_pool_into_union(p_club_id, p_union_id);

  SELECT id, COALESCE(main_balance,0), COALESCE(backup_balance,0), COALESCE(promo_balance,0)
    INTO v_pool_id, v_bbj_main, v_bbj_backup, v_bbj_promo
    FROM public.bbj_pools
   WHERE club_id = p_club_id AND union_id IS NULL
   FOR UPDATE;

  IF v_pool_id IS NOT NULL THEN
    v_keep_main := public.fn_bbj_parked_reserve(v_pool_id,'main');
    v_keep_backup := public.fn_bbj_parked_reserve(v_pool_id,'backup');
    v_bbj_main := v_bbj_main-v_keep_main;
    v_bbj_backup := v_bbj_backup-v_keep_backup;
    IF v_bbj_main<0 OR v_bbj_backup<0 THEN
      RAISE EXCEPTION 'club jackpot bank cannot cover its parked obligations';
    END IF;
    v_bbj_total := v_bbj_main + v_bbj_backup + v_bbj_promo;
    SELECT id INTO v_union_pool FROM public.bbj_pools WHERE union_id = p_union_id LIMIT 1;

    IF v_bbj_total > 0 THEN
      v_after := public.fn_spin_move_owner_wallet(p_club_id, 'club', 'chip_treasury', v_bbj_total);
      IF v_after IS NULL THEN
        RAISE EXCEPTION 'cannot pay the % BBJ balance of club % into its treasury', v_bbj_total, p_club_id;
      END IF;

      -- bbj_promo_sweep so fn_bbj_conservation_check counts this as OUTFLOW.
      -- Without this row the gap moves by exactly v_bbj_total and a correct
      -- transfer reads as a money leak.
      INSERT INTO public.chip_transactions
        (id, club_id, amount, transaction_type, notes, balance_after, metadata)
      VALUES (gen_random_uuid(), p_club_id, v_bbj_total, 'bbj_promo_sweep',
              format('BBJ, backup and promo closed into the club main bank on joining union %s - the club keeps these funds. Play moves to the union pool; this money does not.', p_union_id),
              v_after,
              jsonb_build_object('reason','union_join','union_id',p_union_id,
                                 'bbj_main',v_bbj_main,'bbj_backup',v_bbj_backup,
                                 'bbj_promo',v_bbj_promo,'club_pool_id',v_pool_id));
    END IF;

    UPDATE public.bbj_pools
       SET main_balance = v_keep_main, backup_balance = v_keep_backup, promo_balance = 0,
           status = 'retired',
           merged_into_pool_id = COALESCE(merged_into_pool_id, v_union_pool),
           updated_at = now()
     WHERE id = v_pool_id;
  END IF;

  SELECT COALESCE(promo_balance,0) INTO v_club_promo
    FROM public.clubs WHERE id = p_club_id FOR UPDATE;

  IF v_club_promo > 0 THEN
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) + v_club_promo,
           promo_balance = 0
     WHERE id = p_club_id
     RETURNING chip_treasury INTO v_treasury;

    INSERT INTO public.chip_transactions
      (id, club_id, amount, transaction_type, notes, balance_after, metadata)
    VALUES (gen_random_uuid(), p_club_id, v_club_promo, 'promo_closed_on_union_join',
            format('Club promo float closed into the main bank on joining union %s - the club keeps these funds to disburse at its own discretion', p_union_id),
            v_treasury,
            jsonb_build_object('reason','union_join','union_id',p_union_id));
  END IF;

  RETURN jsonb_build_object('ok', true, 'club_id', p_club_id, 'union_id', p_union_id,
    'spins', v_spin, 'bbj_swept', v_bbj_total, 'club_promo_swept', v_club_promo,
    'club_treasury_after', COALESCE(v_treasury, v_after));
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_union_bbj_backup_transfer(p_union_id uuid, p_amount numeric, p_destination text, p_op_id uuid, p_created_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_amt     numeric := round(COALESCE(p_amount, 0), 2);
  v_pool_id uuid;
  v_backup  numeric;
  v_main    numeric;
  v_promo_after numeric;
  v_res jsonb;
BEGIN
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF p_destination NOT IN ('main', 'promo') THEN
    RETURN jsonb_build_object('success', false, 'error', 'destination must be main or promo');
  END IF;
  IF p_op_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'op_id_required');
  END IF;

  SELECT id, COALESCE(backup_balance,0), COALESCE(main_balance,0)
    INTO v_pool_id, v_backup, v_main
    FROM bbj_pools
   WHERE union_id = p_union_id AND status = 'active'
   FOR UPDATE;

  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active BBJ pool for this union');
  END IF;
  IF v_backup-public.fn_bbj_parked_reserve(v_pool_id,'backup') < v_amt THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient backup balance',
                              'available', v_backup-public.fn_bbj_parked_reserve(v_pool_id,'backup'), 'requested', v_amt);
  END IF;

  IF p_destination = 'main' THEN
    -- A bank move inside the pool: declared, recorded, idempotent on the op id.
    v_res := public.fn_bbj_move_between_banks(v_pool_id, 'backup', 'main', v_amt,
               COALESCE(NULLIF(p_notes, ''), 'union owner: BBJ backup -> main jackpot'),
               'union-backup-transfer:' || p_op_id::text);
    IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
      RETURN jsonb_build_object('success', false, 'error', COALESCE(v_res->>'reason', 'move refused'));
    END IF;
    IF (v_res->>'replayed')::boolean THEN
      RETURN jsonb_build_object('success', false, 'duplicate', true, 'error', 'operation already processed');
    END IF;

    -- 'bbj_wallet', not 'bbj_pool': the CHECK constraint on this table lists
    -- six wallet names and bbj_pool is not one of them. The chips never left
    -- the BBJ system, they changed bank inside it.
    INSERT INTO union_wallet_transactions
      (union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
    VALUES
      (p_union_id, 'bbj_wallet', 'debit', v_amt, v_main + v_amt, 'bbj_backup_to_main', p_op_id,
       COALESCE(NULLIF(p_notes, ''), 'BBJ backup -> main jackpot'), p_created_by);

    RETURN jsonb_build_object('success', true, 'destination', 'main', 'amount', v_amt,
                              'pool_id', v_pool_id,
                              'backup_after', v_backup - v_amt,
                              'main_after', v_main + v_amt);
  END IF;

  /* DECLARED (Phase 4.3): the reserve leaves the pool for the union's promo
     wallet. The pool debit is journalled bbj_pool -> union_wallet; the wallet
     credit is autoskipped so the one move is one leg. */
  PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', p_union_id, NULL,
                                      'bbj_backup_to_promo:' || p_op_id::text, ARRAY['union_wallets']);
  UPDATE bbj_pools
     SET backup_balance = COALESCE(backup_balance,0) - v_amt, updated_at = now()
   WHERE id = v_pool_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  INSERT INTO union_wallets (union_id, promo_wallet)
  VALUES (p_union_id, v_amt)
  ON CONFLICT (union_id) DO UPDATE
    SET promo_wallet = COALESCE(union_wallets.promo_wallet, 0) + EXCLUDED.promo_wallet,
        updated_at = now()
  RETURNING promo_wallet INTO v_promo_after;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

  IF v_promo_after IS NULL THEN
    RAISE EXCEPTION 'promo wallet credit failed for union %', p_union_id;
  END IF;

  INSERT INTO union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
  VALUES
    (p_union_id, 'promo_wallet', 'credit', v_amt, v_promo_after, 'bbj_backup_to_promo', p_op_id,
     COALESCE(NULLIF(p_notes, ''), 'BBJ backup -> promo wallet'), p_created_by);

  RETURN jsonb_build_object('success', true, 'destination', 'promo', 'amount', v_amt,
                            'pool_id', v_pool_id,
                            'backup_after', v_backup - v_amt,
                            'promo_after', v_promo_after);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_parked_reserve(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_parked_reserve(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.bbj_atomic_payout_v2(uuid,uuid,bigint,numeric,uuid,uuid,uuid[],uuid[],jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_atomic_payout_v2(uuid,uuid,bigint,numeric,uuid,uuid,uuid[],uuid[],jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_move_between_banks(uuid,text,text,numeric,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_reseed_main_from_backup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_reseed_main_from_backup(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_close_club_wallets_on_union_join(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_club_wallets_on_union_join(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text) TO service_role;
COMMIT;
