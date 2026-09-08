-- Installed player_leave_table baseline: 0d16681a00b7515c40cbb053760af51e.
-- Disposable fixture only. No production write is performed by this file.
CREATE FUNCTION fn_ca_declare_ledger(text,text,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE OR REPLACE FUNCTION public.player_leave_table(p_table_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_seat_number   integer;
  v_tournament_id uuid;
BEGIN
  SELECT seat_number
    INTO v_seat_number
    FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT tournament_id INTO v_tournament_id FROM tables WHERE id = p_table_id;

  IF v_tournament_id IS NULL THEN
    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);
  END IF;

  -- CHIP CONTINUITY: this is the cron eviction / seat-expiry path (EXECUTE is
  -- service_role only). A system exit, never the player's choice.
  PERFORM public.atomic_seat_cashout_locked(p_user_id, p_table_id, v_seat_number, 'forced');
END;
$function$;
