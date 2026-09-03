-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151345; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.player_leave_table(p_table_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_seat_number   integer;
  v_stack         numeric;
  v_tournament_id uuid;
  v_club_id       uuid;
BEGIN
  SELECT seat_number, stack
    INTO v_seat_number, v_stack
    FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT tournament_id, club_id
    INTO v_tournament_id, v_club_id
    FROM tables
   WHERE id = p_table_id;

  IF v_tournament_id IS NULL AND v_stack > 0 THEN
    IF v_club_id IS NULL THEN
      v_club_id := public.fn_player_home_club(p_user_id, NULL);
    END IF;

    IF v_club_id IS NULL THEN
      RAISE EXCEPTION
        'player_leave_table: refusing to close seat for user % on table % -- no club wallet resolved for a % chip stack',
        p_user_id, p_table_id, v_stack;
    END IF;

    PERFORM public.fn_add_chips(p_user_id, v_club_id, v_stack);

    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_stack, 'credit', 'cashout',
      'Tab-close auto-cashout', p_table_id, NULL, NULL
    );
  END IF;

  UPDATE table_seats
     SET left_at = NOW(), leave_pending = false
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

  UPDATE tables
     SET current_players = (
           SELECT COUNT(*) FROM table_seats
            WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_leave_table(uuid);
DROP FUNCTION IF EXISTS public.fn_leave_table(uuid, uuid);

DO $$
DECLARE
  v_body   text;
  v_stubs  int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'player_leave_table';

  IF v_body IS NULL THEN
    RAISE EXCEPTION 'assertion failed: player_leave_table disappeared';
  END IF;

  IF v_body ~* 'INSERT\s+INTO\s+wallets' THEN
    RAISE EXCEPTION 'assertion failed: player_leave_table still writes public.wallets';
  END IF;

  IF v_body !~* 'fn_add_chips' THEN
    RAISE EXCEPTION 'assertion failed: player_leave_table does not credit club_members via fn_add_chips';
  END IF;

  SELECT count(*) INTO v_stubs
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_leave_table';

  IF v_stubs <> 0 THEN
    RAISE EXCEPTION 'assertion failed: % fn_leave_table stub(s) survived the drop', v_stubs;
  END IF;

  RAISE NOTICE 'player_leave_table now settles to club_members.chip_balance; % fn_leave_table stubs remain', v_stubs;
END $$;
