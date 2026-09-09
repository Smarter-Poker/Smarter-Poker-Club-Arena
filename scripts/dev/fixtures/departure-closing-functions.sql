-- Read-only production function export, used only in the disposable PostgreSQL harness.
CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN
    RETURN NEW; -- tournament tables settle via prizes, not seat cashout
  END IF;

  FOR r IN
    SELECT ts.user_id, ts.seat_number
    FROM table_seats ts
    WHERE ts.table_id = NEW.id
      AND ts.left_at IS NULL
      /* `AND ts.horse_id IS NULL` was here until 2026-09-05. It read as "do
         not cash out horses", it never fired (the column was never written),
         and the moment the column WAS written it would have stranded every
         horse's chips on every closing table. CLAUDE.md 10.5: a horse is paid
         everything a human is paid. Every seat holding chips is cashed out. */
      AND COALESCE(ts.stack,0) > 0
  LOOP
    BEGIN
      PERFORM public.atomic_table_cashout(r.user_id, NEW.id, r.seat_number);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'auto-cashout failed for user % on table %: %', r.user_id, NEW.id, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text DEFAULT 'table closed'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_tournament boolean;
  v_seat          record;
  v_club          uuid;
  v_res           jsonb;
  v_count         int := 0;
  v_total         numeric := 0;
BEGIN
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'p_table_id required');
  END IF;

  SELECT (t.tournament_id IS NOT NULL) INTO v_is_tournament
    FROM public.tables t WHERE t.id = p_table_id;

  IF v_is_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF v_is_tournament THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'tournament_table');
  END IF;

  FOR v_seat IN
    SELECT id, user_id, seat_number, stack, club_id
      FROM public.table_seats
     WHERE table_id = p_table_id
       AND left_at IS NULL
       AND user_id IS NOT NULL
       AND COALESCE(stack, 0) > 0
     FOR UPDATE
  LOOP
    v_club := v_seat.club_id;
    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(v_seat.user_id, NULL);
    END IF;

    IF v_club IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM public.fn_ensure_club_wallet(v_seat.user_id, v_club);

    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);

    -- CHIP CONTINUITY: a table close is a system exit, never the player's choice.
    v_res := public.atomic_seat_cashout_locked(v_seat.user_id, p_table_id, v_seat.seat_number, 'forced');

    IF COALESCE((v_res->>'credited')::boolean, false) THEN
      v_count := v_count + 1;
      v_total := v_total + COALESCE((v_res->>'stack')::numeric, 0);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'players_paid', v_count, 'chips_returned', v_total,
                            'reason_text', COALESCE(p_reason, 'table closed'));
END;
$function$;
