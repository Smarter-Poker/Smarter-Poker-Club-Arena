-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820142057 "union_law_w1c_tournament_paths_club_wallet_only"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3d9b8e0daed871f8123a624aa51c1fe9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- W1c — TOURNAMENT PATHS USE THE CLUB WALLET ONLY (2026-08-20)
-- Same rule as the cash paths: no global-wallet branch anywhere in Club Arena.
-- Entry, refund, rebuy, prize and cancellation all resolve a club wallet,
-- create it if missing, and fail loudly rather than pooling money.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.atomic_tournament_register(p_tournament_id uuid, p_user_id uuid, p_username text, p_total_cost numeric, p_current_bounty numeric, p_mystery_bounty_value numeric, p_is_bounty_tournament boolean, p_club_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_balance NUMERIC; v_player_id UUID; v_club uuid;
  v_t_club uuid; v_t_union uuid; v_ban uuid;
BEGIN
  SELECT t.club_id, t.union_id INTO v_t_club, v_t_union
    FROM tournaments t WHERE t.id = p_tournament_id;

  IF v_t_club IS NOT NULL OR v_t_union IS NOT NULL THEN
    SELECT id INTO v_ban FROM blacklists
     WHERE user_id = p_user_id AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_t_club OR (v_t_union IS NOT NULL AND union_id = v_t_union))
     LIMIT 1;
    IF v_ban IS NOT NULL THEN RAISE EXCEPTION 'Banned from this club'; END IF;
  END IF;

  v_club := public.fn_tournament_club_for_user(p_user_id, p_tournament_id, p_club_id);
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this tournament entry'
      USING HINT = 'The player must hold a membership in a club belonging to this tournament''s union.';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);

  SELECT chip_balance INTO v_balance FROM club_members
   WHERE user_id = p_user_id AND club_id = v_club FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_total_cost THEN
    RAISE EXCEPTION 'Insufficient club chips for tournament entry.';
  END IF;
  UPDATE club_members SET chip_balance = chip_balance - p_total_cost, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_club;

  IF p_is_bounty_tournament THEN
    INSERT INTO tournament_players (
      tournament_id, user_id, username, chips, status,
      current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings, club_id
    ) VALUES (
      p_tournament_id, p_user_id, p_username, 0, 'registered',
      p_current_bounty, p_mystery_bounty_value, 0, 0, v_club
    ) RETURNING id INTO v_player_id;
  ELSE
    INSERT INTO tournament_players (tournament_id, user_id, username, chips, status, club_id)
    VALUES (p_tournament_id, p_user_id, p_username, 0, 'registered', v_club)
    RETURNING id INTO v_player_id;
  END IF;

  RETURN v_player_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_refund_amount numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_deleted_count INT; v_tournament_name TEXT; v_club uuid;
BEGIN
  WITH deleted AS (
    DELETE FROM tournament_players
    WHERE tournament_id = p_tournament_id AND user_id = p_user_id AND status = 'registered'
    RETURNING id, club_id
  )
  SELECT COUNT(*), MAX(club_id::text)::uuid INTO v_deleted_count, v_club FROM deleted;

  IF v_deleted_count = 0 THEN RETURN FALSE; END IF;

  IF v_club IS NULL THEN v_club := public.fn_player_home_club(p_user_id, NULL); END IF;
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this refund';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance,0) + p_refund_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_club;

  SELECT name INTO v_tournament_name FROM tournaments WHERE id = p_tournament_id;

  PERFORM log_wallet_transaction(
    p_user_id, 'PLAYER', p_refund_amount, 'credit', 'refund',
    'Tournament unregister refund: ' || COALESCE(v_tournament_name, 'Unknown') || ' [club wallet]',
    NULL, NULL, p_tournament_id);

  RETURN TRUE;
END;
$function$;

-- Prize / bounty credits ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_player_wallet(p_user_id uuid, p_amount numeric, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer; v_tourn uuid; v_club uuid; v_balance numeric;
BEGIN
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN RETURN; END IF;
    END IF;

    IF p_idempotency_key IS NOT NULL AND p_idempotency_key LIKE 'tourney:%' THEN
      BEGIN
        v_tourn := (split_part(p_idempotency_key, ':', 2))::uuid;
      EXCEPTION WHEN OTHERS THEN v_tourn := NULL;
      END;
      IF v_tourn IS NOT NULL THEN
        SELECT tp.club_id INTO v_club FROM tournament_players tp
         WHERE tp.tournament_id = v_tourn AND tp.user_id = p_user_id LIMIT 1;
      END IF;
    END IF;

    -- CLUB ARENA RULE: money lands in a club wallet, always.
    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;
    IF v_club IS NULL THEN
      RAISE EXCEPTION 'No club wallet resolves for player % — Club Arena credits cannot go to a global wallet', p_user_id;
    END IF;

    PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_club
     RETURNING chip_balance INTO v_balance;
END;
$function$;

-- Cancellation refunds ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_tournament RECORD; v_player RECORD;
    v_refund_amount NUMERIC; v_fee NUMERIC;
    v_refunded_count INT := 0; v_total_refunded NUMERIC := 0; v_fees_reversed NUMERIC := 0;
    v_club uuid;
BEGIN
    SELECT * INTO v_tournament FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
    IF v_tournament.status IN ('completed','canceled','CANCELLED') THEN
        RAISE EXCEPTION 'Tournament is already %', v_tournament.status;
    END IF;
    v_refund_amount := COALESCE(v_tournament.buy_in_amount,0) + COALESCE(v_tournament.buy_in_fee,0);
    v_fee := COALESCE(v_tournament.buy_in_fee, 0);
    UPDATE tournaments SET status='CANCELLED', ended_at=NOW(), updated_at=NOW() WHERE id=p_tournament_id;

    IF v_refund_amount > 0 THEN
        FOR v_player IN (
          SELECT tp.user_id, tp.id, tp.club_id FROM tournament_players tp
           WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
        )
        LOOP
            v_club := COALESCE(v_player.club_id, public.fn_player_home_club(v_player.user_id, NULL));
            IF v_club IS NULL THEN
              INSERT INTO financial_alerts (severity, source, message, context)
              VALUES ('critical','atomic_cancel_tournament',
                      'Cancellation refund skipped: no club wallet resolves for player',
                      jsonb_build_object('user_id',v_player.user_id,'tournament_id',p_tournament_id,
                                         'amount',v_refund_amount));
              CONTINUE;
            END IF;

            PERFORM public.fn_ensure_club_wallet(v_player.user_id, v_club);
            UPDATE club_members
               SET chip_balance = COALESCE(chip_balance,0) + v_refund_amount, updated_at = NOW()
             WHERE user_id = v_player.user_id AND club_id = v_club;

            PERFORM log_wallet_transaction(v_player.user_id, 'PLAYER', v_refund_amount, 'credit', 'refund',
                'Tournament cancellation refund: ' || COALESCE(v_tournament.name,'Unknown') || ' [club wallet]',
                NULL, NULL, p_tournament_id);
            v_refunded_count := v_refunded_count + 1;
            v_total_refunded := v_total_refunded + v_refund_amount;

            IF v_fee > 0 THEN
                INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
                  bbj_contribution, is_tournament, tournament_id, source, metadata)
                VALUES (NULL, p_tournament_id, v_tournament.club_id, -v_fee, v_fee, 1, 0, true,
                  p_tournament_id, 'atomic_cancel_tournament',
                  jsonb_build_object('kind','tournament_fee_refund','user_id',v_player.user_id,
                                     'entry_club_id', v_club));
                v_fees_reversed := v_fees_reversed + v_fee;
            END IF;
        END LOOP;
    END IF;

    IF v_fees_reversed > 0 THEN
        UPDATE tournaments SET total_rake = GREATEST(0, COALESCE(total_rake,0) - v_fees_reversed)
         WHERE id = p_tournament_id;
        UPDATE unions SET total_rake = GREATEST(0, COALESCE(total_rake,0) - v_fees_reversed)
         WHERE id = v_tournament.union_id AND v_tournament.union_id IS NOT NULL;
    END IF;

    DELETE FROM tournament_players WHERE tournament_id = p_tournament_id;
    UPDATE tables SET status='closed', current_players=0 WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count,
      'total_refunded', v_total_refunded, 'fees_reversed', v_fees_reversed);
END; $function$;

