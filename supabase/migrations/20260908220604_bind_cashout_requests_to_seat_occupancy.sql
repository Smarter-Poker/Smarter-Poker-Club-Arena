-- Reserved version 20260908220604. Permanent occupancy identity and atomic receipts.
-- This is a coordinated protocol migration. Legacy entrypoint retirement follows
-- verified engine/client adoption; this file alone does not close Phase 2.
BEGIN;
DO $baseline$
DECLARE v_hash text;
BEGIN
  SELECT md5(pg_get_functiondef('public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure))
    INTO v_hash;
  IF v_hash NOT IN ('9dba1ae69cb2c842c449ba90682dc3bc','27b0dea6d857963fe0fd4ac5857c1f1f') THEN
    RAISE EXCEPTION 'Unreviewed cashout baseline: %', v_hash;
  END IF;
END $baseline$;
ALTER TABLE public.table_seats
  ADD COLUMN IF NOT EXISTS occupancy_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS table_seats_occupancy_id_unique
  ON public.table_seats(occupancy_id);

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_occupancy()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public,pg_temp AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.table_id IS DISTINCT FROM NEW.table_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
     OR (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id THEN
    RAISE EXCEPTION 'SEAT_OCCUPANCY_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS zzz_stamp_seat_occupancy ON public.table_seats;
CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats
FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_seat_occupancy();
REVOKE ALL ON FUNCTION public.fn_stamp_seat_occupancy() FROM PUBLIC,anon,authenticated,service_role;

-- No FK to a live seat: buy-in may delete and recreate that physical seat.
-- The original outcome must survive that deletion and remain replayable.
CREATE TABLE IF NOT EXISTS public.seat_cashout_receipts (
  occupancy_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  seat_number integer NOT NULL,
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.seat_cashout_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.seat_cashout_receipts FROM PUBLIC,anon,authenticated,service_role;

-- The table DDL lock is held until commit. No in-flight seat writer can
-- straddle the key transition. Refuse any active occupancy with prior credit
-- rather than infer a balance repair or risk crediting it again.
DO $credit_transition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.table_seats s
    JOIN public.tables t ON t.id=s.table_id
    JOIN public.wallet_credit_idempotency w
      ON split_part(w.key,':',2)=s.id::text
    WHERE s.left_at IS NULL AND t.tournament_id IS NULL
      AND split_part(w.key,':',1)='cashout'
      AND CASE
        WHEN w.key='cashout:'||s.id::text THEN true
        WHEN pg_input_is_valid(substring(w.key FROM length('cashout:'||s.id::text||':')+1),
                               'timestamp with time zone') THEN
          substring(w.key FROM length('cashout:'||s.id::text||':')+1)::timestamptz
            IS NOT DISTINCT FROM s.joined_at
        ELSE true -- A malformed matching legacy key requires proof too.
      END
  ) THEN
    RAISE EXCEPTION 'Active occupancy has legacy cashout credit; transaction proof required before key transition';
  END IF;
END $credit_transition$;
CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer, p_leave_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_seat      record;
  v_stack     numeric;
  v_key       text;
  v_credited  boolean := false;
  v_seat_rows integer;
  v_tournament uuid;
  v_engine    boolean;
  v_mode      text;
  v_admin_forced boolean;
  v_enforce   boolean;
  v_chk       jsonb;
BEGIN
  v_engine := coalesce(public.fn_caller_is_engine(),false);
  -- H6: the mode is one of two words or nothing. 'vpip_evicted' (Dan
  -- 2026-09-05) is a system exit for the clock (a forced one) that closes
  -- the session with its own reason, so the two-hour bar is written.
  v_mode := CASE WHEN p_leave_mode IN ('voluntary', 'forced') THEN p_leave_mode
                 WHEN p_leave_mode = 'vpip_evicted' THEN 'forced' ELSE NULL END;
  -- H2: a club admin's kick, marked by fn_admin_kick_player in THIS transaction
  -- only, after is_club_admin() passed. A browser cannot set a GUC through
  -- PostgREST; one request is one function call in one transaction.
  v_admin_forced := (v_mode = 'forced')
                    AND COALESCE(current_setting('app.cash_exit_authority', true), '') = 'club_admin';

  IF NOT v_engine AND NOT v_admin_forced
     AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  -- H1: the same lock atomic_table_buyin holds while it reads the floor, taken
  -- BEFORE the seat row so the two functions lock in one order.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  /* THE GAME BEFORE THE SEAT (20260906). A seat change on a seat-first game
     (spin, SNG, heads-up) fires trg_seat_change_syncs_seat_first_count, which
     writes tournaments.current_players - a lock on the game's row taken AFTER
     the seat row. The engine finishing that same game does the reverse: its
     UPDATE tournaments ... status holds the game row and its trigger
     fn_clear_seats_on_game_end then locks every seat. 131 deadlocks a day,
     every one this pair, every one at the end of a spin or heads-up. Parent
     before child: take the game row first, in the mode the trigger's UPDATE
     needs, so a cashout racing a finish waits for it instead of dying.
     Cash tables have no game row and skip this. */
  SELECT t.tournament_id INTO v_tournament FROM tables t WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    PERFORM 1 FROM tournaments WHERE id = v_tournament FOR NO KEY UPDATE;
  END IF;

  IF p_seat_number IS NOT NULL THEN
    SELECT id, stack, joined_at, seat_number, occupancy_id INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id
       AND seat_number = p_seat_number AND left_at IS NULL
     FOR UPDATE;
  ELSE
    SELECT id, stack, joined_at, seat_number, occupancy_id INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     ORDER BY joined_at DESC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'stack', 0, 'reason', 'no_active_seat');
  END IF;

  -- Cash amounts must be valid BEFORE the credit, idempotency record and
  -- seat exit. A receipt rejected after commit cannot roll those writes back.
  -- Tournament stacks are play chips and still return zero below.
  IF v_tournament IS NULL AND (
    v_seat.stack IS NULL OR
    v_seat.stack::text IN ('NaN', 'Infinity', '-Infinity') OR
    v_seat.stack < 0 OR v_seat.stack <> trunc(v_seat.stack, 2)
  ) THEN
    RAISE EXCEPTION 'CASHOUT_INVALID_STACK' USING ERRCODE = '22003';
  END IF;
  v_stack := v_seat.stack;

  /* CHIP CONTINUITY (OPORD 1.3 s6.4 / I5). A browser caller is always checked
     unless it is a club admin's kick (H2); the engine is checked when it says
     the exit is the player's own choice. Raised BEFORE any credit. */
  v_enforce := v_tournament IS NULL
               AND ((NOT v_engine AND NOT v_admin_forced) OR (v_engine AND v_mode = 'voluntary'));
  IF v_enforce THEN
    v_chk := public.fn_cash_leave_check(p_user_id, p_table_id);
    IF NOT COALESCE((v_chk->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'LEAVE_LOCKED:%', COALESCE(v_chk->>'stay_remaining_ms', '0')
        USING HINT = 'Leave available when the stay clock reaches zero';
    END IF;
  END IF;

  -- The database renews this identity on every new occupancy, even when
  -- a physical row or seniority timestamp is reused.
  v_key := 'cashout:occupancy:' || v_seat.occupancy_id::text;

  /* ZERO-DRIFT (2026-09-01): a tournament-table stack is play chips. */
  IF v_tournament IS NOT NULL THEN
    v_stack := 0;
    v_credited := false;
  ELSIF v_stack > 0 THEN
    PERFORM public.atomic_credit_wallet_and_log(
      p_user_id, v_stack, 'cashout', 'Cash-out from table',
      p_table_id, NULL, NULL, v_key
    );
    v_credited := true;
  END IF;

  UPDATE table_seats
     SET left_at = NOW(), leave_pending = false
   WHERE table_id = p_table_id AND user_id = p_user_id
     AND seat_number = v_seat.seat_number AND left_at IS NULL;
  GET DIAGNOSTICS v_seat_rows = ROW_COUNT;

  IF v_seat_rows = 0 THEN
    RAISE EXCEPTION
      'Cash-out could not vacate the locked seat (table %, player %, seat %)',
      p_table_id, p_user_id, v_seat.seat_number;
  END IF;

  IF v_tournament IS NULL THEN
    PERFORM public.fn_cash_session_close(
      p_user_id, p_table_id, v_stack,
      CASE WHEN v_mode = 'voluntary' THEN 'voluntary'
           WHEN p_leave_mode = 'vpip_evicted' THEN 'vpip_evicted'
           WHEN v_admin_forced THEN 'kicked'
           ELSE 'system' END);
  END IF;

  UPDATE tables
     SET current_players = (
       SELECT count(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;

  RETURN jsonb_build_object(
    'ok', true, 'stack', v_stack, 'credited', v_credited,
    'seat_number', v_seat.seat_number, 'idempotency_key', v_key,
    'tournament_table', v_tournament IS NOT NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashout_seat_occupancy(
  p_user_id uuid, p_table_id uuid, p_seat_number integer,
  p_occupancy_id uuid, p_leave_mode text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_engine boolean;
  v_admin boolean;
  v_tournament uuid;
  v_seat record;
  v_previous public.seat_cashout_receipts%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_seat_number IS NULL
     OR p_occupancy_id IS NULL THEN
    RAISE EXCEPTION 'CASHOUT_OCCUPANCY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  v_engine := coalesce(public.fn_caller_is_engine(),false);
  v_admin := p_leave_mode = 'forced'
    AND coalesce(current_setting('app.cash_exit_authority',true),'') = 'club_admin';
  IF NOT v_engine AND NOT coalesce(v_admin,false)
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot cash out for another user' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text,0));
  SELECT * INTO v_previous FROM public.seat_cashout_receipts
   WHERE occupancy_id = p_occupancy_id;
  IF FOUND THEN
    IF v_previous.user_id <> p_user_id OR v_previous.table_id <> p_table_id
       OR v_previous.seat_number <> p_seat_number THEN
      RAISE EXCEPTION 'CASHOUT_OCCUPANCY_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN v_previous.receipt;
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    PERFORM 1 FROM public.tournaments WHERE id=v_tournament FOR NO KEY UPDATE;
  END IF;
  SELECT id,seat_number,occupancy_id INTO v_seat FROM public.table_seats
   WHERE occupancy_id=p_occupancy_id AND table_id=p_table_id AND user_id=p_user_id
     AND seat_number=p_seat_number AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_STALE_OCCUPANCY' USING ERRCODE = '22023';
  END IF;

  -- This lock and the canonical function's locks are in the same transaction.
  -- A concurrent seat replacement cannot cross the identity check.
  v_result := public.atomic_seat_cashout_locked(
    p_user_id,p_table_id,p_seat_number,p_leave_mode);
  IF v_result->>'ok' IS DISTINCT FROM 'true'
     OR v_result->>'reason' IS NOT NULL
     OR (v_result->>'seat_number')::integer IS DISTINCT FROM p_seat_number
     OR v_result->>'idempotency_key' IS DISTINCT FROM 'cashout:occupancy:'||p_occupancy_id::text THEN
    RAISE EXCEPTION 'CASHOUT_UNCONFIRMED_OUTCOME' USING ERRCODE = '22023';
  END IF;
  v_result := v_result || jsonb_build_object(
    'occupancy_id',p_occupancy_id,'user_id',p_user_id,'table_id',p_table_id);
  INSERT INTO public.seat_cashout_receipts
    (occupancy_id,user_id,table_id,seat_id,seat_number,receipt)
  VALUES(p_occupancy_id,p_user_id,p_table_id,v_seat.id,p_seat_number,v_result);
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)
 TO authenticated,service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_cashout_seat_occupancy','approved',
  'Occupancy-bound cashout, canonical credit/seat exit and immutable request outcome in one transaction. Legacy retirement is a separate release gate.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
COMMIT;
