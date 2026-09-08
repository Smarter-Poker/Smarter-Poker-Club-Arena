-- Reserved by scripts/new-migration.mjs: 20260908214235.
-- Seat expiry previously locked the seat before the canonical user's lock.
-- A concurrent buy-in holds those in the opposite order. Preserve the wrapper
-- and its service-only permission, but acquire locks in the canonical order.
BEGIN;
DO $baseline$
BEGIN
  IF md5(pg_get_functiondef('public.player_leave_table(uuid,uuid)'::regprocedure))
     NOT IN ('0d16681a00b7515c40cbb053760af51e', 'cbab2d426b0ec091b5b09f3e76eec640') THEN
    RAISE EXCEPTION 'Seat-expiry baseline changed; review before applying lock order';
  END IF;
END $baseline$;
CREATE OR REPLACE FUNCTION public.player_leave_table(p_table_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_seat_number   integer;
  v_tournament_id uuid;
BEGIN
  -- The wrapper must not hold a seat while waiting for the canonical user
  -- lock. Buy-in/cashout take user -> tournament parent -> seat.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
  SELECT tournament_id INTO v_tournament_id FROM tables WHERE id = p_table_id;
  IF v_tournament_id IS NOT NULL THEN
    PERFORM 1 FROM tournaments WHERE id = v_tournament_id FOR NO KEY UPDATE;
  END IF;

  SELECT seat_number
    INTO v_seat_number
    FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_tournament_id IS NULL THEN
    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);
  END IF;

  -- CHIP CONTINUITY: this is the cron eviction / seat-expiry path (EXECUTE is
  -- service_role only). A system exit, never the player's choice.
  PERFORM public.atomic_seat_cashout_locked(p_user_id, p_table_id, v_seat_number, 'forced');
END;
$function$;

REVOKE ALL ON FUNCTION public.player_leave_table(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_leave_table(uuid,uuid) TO service_role;
COMMIT;
