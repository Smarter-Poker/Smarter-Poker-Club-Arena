-- Late registration creates capacity through its existing canonical owner,
-- preserving current blinds, tournament format and the manager's durable receipt.
-- Union entry receipts read the member-club wallet the debit actually charged.
-- No historical receipt or balance is rewritten.
-- Version reserved by scripts/new-migration.mjs.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $dependencies$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure)
      IS DISTINCT FROM 'b36dd36a9348d29be1092c7d42954c03'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_tournament_club_for_user(uuid,uuid,uuid)'::regprocedure)
      IS DISTINCT FROM 'f80eff4c311820670f1b71d15c29452d' THEN
  RAISE EXCEPTION 'Late entry dependencies changed; review current capacity and wallet authority' USING ERRCODE='55000';
 END IF;
END $dependencies$;
DO $patch_0$
DECLARE
 v_oid oid := 'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure;
 v_before jsonb; v_after jsonb; v_def text; v_src text;
BEGIN
 SELECT to_jsonb(p)-'prosrc',p.prosrc,pg_get_functiondef(p.oid)
  INTO v_before,v_src,v_def FROM pg_proc p WHERE p.oid=v_oid;
 IF md5(v_src) IS DISTINCT FROM 'd2970964d6eedb9babfd6c47ebe66e9b'
    OR position(v_src IN v_def)=0 THEN
  RAISE EXCEPTION 'Late entry source changed: fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(v_def,v_src,$replacement_0$
DECLARE
  v_status text;
  v_start_chips integer;
  v_club uuid;
  v_bonus integer;
  v_chips integer;
  v_table uuid;
  v_cap int;
  v_seat int;
  v_taken int;
  v_opened boolean := false;
  v_capacity jsonb;
BEGIN
  PERFORM set_config('app.money_path', 'fn_seat_late_registrant', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  SELECT status, COALESCE(starting_chips, 0), club_id
    INTO v_status, v_start_chips, v_club
    FROM public.tournaments WHERE id = p_tournament_id;

  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_running');
  END IF;

  SELECT COALESCE(chips, 0) INTO v_bonus
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = p_user_id
     AND table_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = p_tournament_id
         AND s.user_id = p_user_id
         AND s.left_at IS NULL
     )
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_seated_or_missing');
  END IF;

  v_chips := v_start_chips + GREATEST(v_bonus, 0);

  SELECT tb.id, COALESCE(tb.max_players, 9)
    INTO v_table, v_cap
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running', 'active')
     AND COALESCE(tb.is_deleted,false)=false
     AND (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) < COALESCE(tb.max_players, 9)
   ORDER BY (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) DESC, tb.created_at ASC
   LIMIT 1
     FOR UPDATE OF tb;

  -- Capacity owns the table format, current blinds, legal chairs and durable
  -- manager receipt. The entry already exists here, so reserve no second entry.
  IF v_table IS NULL THEN
    v_capacity := public.fn_ensure_late_registration_capacity(p_tournament_id,0);
    v_table := NULLIF(v_capacity->>'table_id','')::uuid;
    IF COALESCE((v_capacity->>'ok')::boolean,false) IS NOT TRUE
       OR v_table IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','no_open_seat');
    END IF;
    SELECT tb.max_players INTO STRICT v_cap FROM public.tables tb
     WHERE tb.id=v_table AND tb.tournament_id=p_tournament_id
       AND tb.status IN ('waiting','running','active')
       AND COALESCE(tb.is_deleted,false)=false FOR UPDATE;
    v_opened := COALESCE((v_capacity->>'created')::boolean,false);
  END IF;

  SELECT g.n INTO v_seat
    FROM generate_series(1, v_cap) AS g(n)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats s
      WHERE s.table_id = v_table AND s.seat_number = g.n AND s.left_at IS NULL
   )
   ORDER BY g.n LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_open_seat');
  END IF;

  UPDATE public.table_seats
     SET user_id        = p_user_id,
         stack          = v_chips,
         left_at        = NULL,
         joined_at      = now(),
         is_sitting_out = false,
         is_away        = false,
         club_id        = COALESCE(club_id, v_club)
   WHERE table_id = v_table AND seat_number = v_seat AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack, club_id)
      VALUES (v_table, p_user_id, v_seat, v_chips, v_club);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'seat_race');
    END;
  END IF;

  UPDATE public.tournament_players
     SET status      = 'playing',
         chips       = v_chips,
         table_id    = v_table,
         seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  SELECT count(*) INTO v_taken
    FROM public.table_seats WHERE table_id = v_table AND left_at IS NULL;
  UPDATE public.tables SET current_players = v_taken WHERE id = v_table;

  RETURN jsonb_build_object('ok', true, 'table_id', v_table,
    'seat_number', v_seat, 'chips', v_chips, 'opened_table', v_opened);
END;
$replacement_0$);
 SELECT to_jsonb(p)-'prosrc' INTO v_after FROM pg_proc p WHERE p.oid=v_oid;
 IF v_after IS DISTINCT FROM v_before
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM '9311ef4ed0c2fa6fbb0f1d8fa169137f' THEN
  RAISE EXCEPTION 'Late entry source or privileges failed verification: fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)' USING ERRCODE='55000';
 END IF;
END $patch_0$;
DO $patch_1$
DECLARE
 v_oid oid := 'public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)'::regprocedure;
 v_before jsonb; v_after jsonb; v_def text; v_src text;
BEGIN
 SELECT to_jsonb(p)-'prosrc',p.prosrc,pg_get_functiondef(p.oid)
  INTO v_before,v_src,v_def FROM pg_proc p WHERE p.oid=v_oid;
 IF md5(v_src) IS DISTINCT FROM 'f9d423ecda16d49d698a1b3735baf7cb'
    OR position(v_src IN v_def)=0 THEN
  RAISE EXCEPTION 'Late entry source changed: log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(v_def,v_src,$replacement_1$
DECLARE v_bal NUMERIC; v_club uuid; v_entry boolean := false;
BEGIN
  /* ZERO-DRIFT (2026-08-31): club members' live balance is
     club_members.chip_balance; public.wallets has been frozen since
     2026-08-21, so reading it stamped a stale balance_after on every row. */
  IF p_wallet_type = 'PLAYER' THEN
    -- Use the debit's union-aware resolver and preferred ledger club. A host
    -- club balance is not the balance of the member wallet actually charged.
    IF p_type = 'debit'
       AND p_related_entity_id IS NOT NULL
       AND lower(COALESCE(p_category, '')) IN
         ('tournament_buyin', 'tournament_rebuy', 'rebuy', 'reentry', 'addon') THEN
      v_entry := true;
      v_club := public.fn_tournament_club_for_user(
        p_user_id,p_related_entity_id,
        NULLIF(current_setting('app.ledger_club_id',true),'')::uuid);
      IF v_club IS NULL THEN
        RAISE EXCEPTION 'Tournament entry receipt has no charged club wallet'
          USING ERRCODE='55000';
      END IF;
    ELSE
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;
    IF v_club IS NOT NULL THEN
      SELECT chip_balance INTO v_bal FROM club_members
       WHERE user_id = p_user_id AND club_id = v_club;
    END IF;
  END IF;
  IF v_entry AND v_bal IS NULL THEN
    RAISE EXCEPTION 'Tournament entry receipt cannot read its charged club wallet'
      USING ERRCODE='55000';
  END IF;
  IF v_bal IS NULL THEN
    SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  END IF;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, table_id, hand_id, related_entity_id, balance_after, created_at)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, p_table_id, p_hand_id, p_related_entity_id, COALESCE(v_bal, 0), NOW());
END;
$replacement_1$);
 SELECT to_jsonb(p)-'prosrc' INTO v_after FROM pg_proc p WHERE p.oid=v_oid;
 IF v_after IS DISTINCT FROM v_before
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM 'd1dd7af2ba51d15355f05d10057ec04a' THEN
  RAISE EXCEPTION 'Late entry source or privileges failed verification: log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)' USING ERRCODE='55000';
 END IF;
END $patch_1$;
COMMIT;
