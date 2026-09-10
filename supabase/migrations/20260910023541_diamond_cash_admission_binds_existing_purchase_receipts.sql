-- The shared cash purchase receipt owns Diamond seat admission too.
-- Closed by default. Platform release requires the programme accounting evidence.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $preflight$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure) IS DISTINCT FROM '3345c144970b939081aa60b8a00f9957' THEN RAISE EXCEPTION 'diamond_admission_prerequisite_changed:atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure) IS DISTINCT FROM '80d0929c3fab970b6ccd84b3510baf31' THEN RAISE EXCEPTION 'diamond_admission_prerequisite_changed:atomic_seat_cashout_locked(uuid,uuid,integer,text)'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)'::regprocedure) IS DISTINCT FROM 'b22cb8e338a816e8459700cb5e1d23bd' THEN RAISE EXCEPTION 'diamond_admission_prerequisite_changed:fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_poker_guard_chip_seat()'::regprocedure) IS DISTINCT FROM '0d9b56e33db8505997522238387fe4f7' THEN RAISE EXCEPTION 'diamond_admission_prerequisite_changed:fn_poker_guard_chip_seat()'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_log_seat_stack_exit()'::regprocedure) IS DISTINCT FROM '64a69b833333bcb25b8f236793865d04' THEN RAISE EXCEPTION 'diamond_admission_prerequisite_changed:fn_log_seat_stack_exit()'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trg_fn_close_session_when_seat_vacated()'::regprocedure) IS DISTINCT FROM '7b321b28f6c5ebb465036873ea7c56c6' THEN RAISE EXCEPTION 'diamond_admission_prerequisite_changed:trg_fn_close_session_when_seat_vacated()'; END IF;
END $preflight$;

ALTER TABLE public.ca_arena_settings ADD COLUMN cash_games_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.ca_arena_settings.cash_games_enabled IS
 'Public Diamond cash release switch. Platform operations may enable only after complete gameplay certification and seven consecutive clean accounting days, zero suspense and no open critical Diamond incident.';

CREATE INDEX poker_diamond_custody_seat ON public.poker_diamond_custody(seat_id) WHERE seat_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_buyin(
 p_user_id uuid,p_table_id uuid,p_seat_number integer,p_amount numeric,
 p_auto_rebuy boolean,p_club_id uuid,p_idempotency_key uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 v_t public.tables%ROWTYPE;
 v_seat_id uuid:=gen_random_uuid();
 v_custody jsonb;
 v_taken integer;
 v_holds integer;
BEGIN
 IF p_idempotency_key IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
    OR p_seat_number IS NULL OR p_seat_number<1 OR p_auto_rebuy IS DISTINCT FROM false
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647
    OR p_amount<>trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_cash_purchase' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||p_user_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL AND a.cash_games_enabled
 FOR UPDATE OF t;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'diamond_cash_not_open' USING ERRCODE='55000';
 END IF;
 IF v_t.game_variant IS DISTINCT FROM 'nlh' OR v_t.tournament_id IS NOT NULL
    OR v_t.cluster_id IS NOT NULL
    OR coalesce(v_t.is_template,false) OR v_t.status NOT IN ('waiting','running','playing','active')
    OR coalesce(v_t.rake_percent,0)<>0 OR coalesce(v_t.bbj_percent,0)<>0
    OR coalesce(v_t.insurance_enabled,false) OR coalesce(v_t.bomb_pot_enabled,false)
    OR coalesce(v_t.run_it_twice_enabled,false) OR coalesce(v_t.run_it_twice,false)
    OR coalesce(v_t.allow_run_it_twice,false) OR coalesce(v_t.straddle_enabled,false)
    OR coalesce(v_t.seven_deuce_enabled,false) OR coalesce(v_t.nit_game,false)
    OR coalesce(v_t.all_in_or_fold,false) OR coalesce(v_t.pineapple_holdem,false)
    OR coalesce(v_t.cap_enabled,false) OR coalesce(v_t.auto_utg_straddle,false)
    OR coalesce(v_t.voluntary_straddle,false) THEN
   RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 -- Match the shared engine load boundary before reserving any Diamonds.
 IF EXISTS(SELECT 1 FROM (VALUES(v_t.small_blind),(v_t.big_blind),
      (v_t.min_buy_in),(v_t.max_buy_in)) AS amount(value)
      WHERE value IS NULL OR value NOT BETWEEN 1 AND 2147483647
        OR value<>trunc(value))
    OR COALESCE(v_t.ante,0) NOT BETWEEN 0 AND 9007199254740991
    OR COALESCE(v_t.ante,0)<>trunc(COALESCE(v_t.ante,0)) THEN
   RAISE EXCEPTION 'diamond_cash_requires_whole_amounts' USING ERRCODE='23514';
 END IF;
 IF p_club_id IS NOT NULL AND p_club_id<>v_t.club_id THEN
   RAISE EXCEPTION 'diamond_purchase_arena_mismatch' USING ERRCODE='22023';
 END IF;
 IF v_t.max_players IS NULL OR p_seat_number>v_t.max_players THEN
   RAISE EXCEPTION 'TABLE_SIZE: invalid Diamond seat' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.blacklists WHERE user_id=p_user_id
     AND club_id=v_t.club_id AND (expires_at IS NULL OR expires_at>now())) THEN
   RAISE EXCEPTION 'Banned from this club' USING ERRCODE='42501';
 END IF;
 IF coalesce(v_t.is_vip_only,false) AND NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=p_user_id AND p.is_vip IS TRUE
      AND (p.vip_expires_at IS NULL OR p.vip_expires_at>now())) THEN
   RAISE EXCEPTION 'VIP_ONLY: this table requires VIP membership' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL
           AND (user_id=p_user_id OR seat_number=p_seat_number)) THEN
   RAISE EXCEPTION 'Diamond seat or player is already seated' USING ERRCODE='23505';
 END IF;
 SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id=p_table_id AND left_at IS NULL;
 SELECT count(*) INTO v_holds FROM public.table_waitlist
   WHERE table_id=p_table_id AND status='notified' AND user_id<>p_user_id
     AND coalesce(hold_expires_at,notified_at+interval '60 seconds')>now();
 IF v_taken>=v_t.max_players OR v_taken+v_holds>=v_t.max_players THEN
   RAISE EXCEPTION 'SEAT_RESERVED: table capacity is taken or held' USING ERRCODE='55000';
 END IF;
 IF (SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL AND t.tournament_id IS NULL
       AND t.status NOT IN ('closed','deleted'))>=4 THEN
   RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at four cash tables' USING ERRCODE='55000';
 END IF;

 v_custody:=public.fn_poker_diamond_reserve(p_user_id,'cash_seat',p_table_id,
   'seat:'||v_seat_id,p_amount,p_idempotency_key);
 PERFORM set_config('app.money_path','atomic_table_buyin',true);
 DELETE FROM public.table_seats WHERE table_id=p_table_id
   AND seat_number=p_seat_number AND left_at IS NOT NULL;
 INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,auto_rebuy,club_id)
   VALUES(v_seat_id,p_table_id,p_seat_number,p_user_id,p_amount,'active',false,v_t.club_id);
 -- The after-insert binder sees the final occupancy stamped by the shared trigger.
 IF NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
     JOIN public.table_seats s ON s.id=c.seat_id AND s.joined_at=c.seat_joined_at
       AND s.occupancy_id=c.occupancy_id
     WHERE c.id=(v_custody->>'custody_id')::uuid AND c.state='active'
       AND s.id=v_seat_id AND s.left_at IS NULL AND s.stack=c.balance) THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 UPDATE public.table_waitlist SET status='seated'
   WHERE table_id=p_table_id AND user_id=p_user_id AND status IN ('waiting','notified');
 UPDATE public.tables SET current_players=(
   SELECT count(*) FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
   WHERE id=p_table_id;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_poker_guard_chip_seat()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' OR NOT EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
     JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
   WHERE c.user_id=NEW.user_id AND c.target_id=NEW.table_id AND c.purpose='cash_seat'
     AND c.entry_key='seat:'||NEW.id AND c.state='reserved' AND c.balance=NEW.stack
     AND c.seat_id IS NULL AND a.cash_games_enabled
 ) THEN
   RAISE EXCEPTION 'Diamond Seat Requires Atomic Custody Funding' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_guard_chip_seat() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.fn_poker_bind_diamond_seat()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_count integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NULL; END IF;
 UPDATE public.poker_diamond_custody
   SET seat_id=NEW.id,seat_joined_at=NEW.joined_at,occupancy_id=NEW.occupancy_id,state='active'
   WHERE user_id=NEW.user_id AND target_id=NEW.table_id AND purpose='cash_seat'
     AND entry_key='seat:'||NEW.id AND state='reserved' AND balance=NEW.stack AND seat_id IS NULL;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>1 THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_bind_diamond_seat() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER poker_bind_diamond_seat AFTER INSERT ON public.table_seats
 FOR EACH ROW EXECUTE FUNCTION public.fn_poker_bind_diamond_seat();

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_seat_keeps_custody()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_ids uuid[];
BEGIN
 IF TG_OP='INSERT' THEN v_ids:=ARRAY[NEW.id];
 ELSIF TG_OP='DELETE' THEN v_ids:=ARRAY[OLD.id];
 ELSE v_ids:=ARRAY[OLD.id,NEW.id]; END IF;
 IF EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
   WHERE c.seat_id=ANY(v_ids) AND c.state='active'
     AND NOT EXISTS(SELECT 1 FROM public.table_seats s
       WHERE s.id=c.seat_id AND s.joined_at=c.seat_joined_at
         AND s.occupancy_id=c.occupancy_id AND s.user_id=c.user_id
         AND s.table_id=c.target_id AND s.club_id=c.arena_id
         AND s.left_at IS NULL AND s.stack=c.balance)
 ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER zzz_diamond_seat_keeps_custody
 AFTER INSERT OR UPDATE OR DELETE ON public.table_seats DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_seat_keeps_custody();

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cashout(
 p_user_id uuid,p_table_id uuid,p_seat_number integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 v_s public.table_seats%ROWTYPE;
 v_c public.poker_diamond_custody%ROWTYPE;
 v_release jsonb;
 v_receipt jsonb;
 v_key text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN
   RAISE EXCEPTION 'Diamond cash-out is engine only' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||p_user_id,0));
 PERFORM 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL FOR UPDATE OF t;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_cash_table_required' USING ERRCODE='23514'; END IF;
 PERFORM id FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 SELECT * INTO v_s FROM public.table_seats
   WHERE user_id=p_user_id AND table_id=p_table_id AND left_at IS NULL
     AND (p_seat_number IS NULL OR seat_number=p_seat_number)
   ORDER BY joined_at DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'stack',0,'reason','no_active_seat'); END IF;
 SELECT * INTO v_c FROM public.poker_diamond_custody
   WHERE user_id=p_user_id AND target_id=p_table_id AND purpose='cash_seat'
     AND seat_id=v_s.id AND seat_joined_at=v_s.joined_at AND occupancy_id=v_s.occupancy_id
     AND state='active' FOR UPDATE;
 IF NOT FOUND OR v_c.balance IS DISTINCT FROM v_s.stack THEN
   RAISE EXCEPTION 'diamond_cashout_custody_mismatch' USING ERRCODE='23514';
 END IF;
 v_key:='cashout:occupancy:'||v_s.occupancy_id;
 UPDATE public.table_seats SET left_at=now(),leave_pending=false,status='left'
   WHERE id=v_s.id AND joined_at=v_s.joined_at AND occupancy_id=v_s.occupancy_id AND left_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_cashout_seat_not_vacated' USING ERRCODE='23514'; END IF;
 v_release:=public.fn_poker_diamond_release(v_c.id,md5(v_key)::uuid);
 IF (v_release->>'success')::boolean IS DISTINCT FROM true
    OR (v_release->>'amount')::bigint IS DISTINCT FROM v_c.balance
    OR (v_release->>'custody_balance')::bigint IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'diamond_cashout_release_not_verified' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables SET current_players=(
   SELECT count(*) FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
   WHERE id=p_table_id;
 v_receipt:=jsonb_build_object('ok',true,'asset','diamonds','stack',v_c.balance,
   'credited',v_c.balance>0,'seat_number',v_s.seat_number,'idempotency_key',v_key,
   'tournament_table',false,'occupancy_id',v_s.occupancy_id,
   'user_id',p_user_id,'table_id',p_table_id,'custody_receipt',v_release);
 INSERT INTO public.seat_cashout_receipts(occupancy_id,user_id,table_id,seat_id,seat_number,receipt)
   VALUES(v_s.occupancy_id,p_user_id,p_table_id,v_s.id,v_s.seat_number,v_receipt);
 RETURN v_receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_cashout(uuid,uuid,integer)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_replay jsonb;
BEGIN
  IF p_amount IS NULL
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Chips Move In Hundredths At Most' USING ERRCODE = '22003';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot buy in for another user' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object(
    'door', 'atomic_table_buyin',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'seat_number', p_seat_number,
    'amount', p_amount,
    'auto_rebuy', p_auto_rebuy,
    'club_id', p_club_id
  );
  v_replay := public.fn_claim_entry_purchase_receipt(
    'cash_transaction', p_idempotency_key::text, v_request
  );
  IF NOT COALESCE((v_replay->>'claimed')::boolean, false) THEN
    RETURN;
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transaction_idempotency_keys k
     WHERE k.key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical cash key does not prove its table and seat'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash buy-ins; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    PERFORM public.fn_poker_diamond_buyin(p_user_id,p_table_id,p_seat_number,
      p_amount,p_auto_rebuy,p_club_id,p_idempotency_key);
  ELSE
    PERFORM public.atomic_table_buyin_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_seat_number, p_amount, p_auto_rebuy,
    p_club_id, p_idempotency_key
  );
  END IF;
  PERFORM public.fn_record_entry_purchase_receipt(
    'cash_transaction',
    p_idempotency_key::text,
    v_request,
    jsonb_build_object('completed', true)
  );
END;
$function$
;
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
  v_receipt   jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    RETURN public.fn_poker_diamond_cashout(p_user_id,p_table_id,p_seat_number);
  END IF;
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

  v_receipt := jsonb_build_object(
    'ok', true, 'stack', v_stack, 'credited', v_credited,
    'seat_number', v_seat.seat_number, 'idempotency_key', v_key,
    'tournament_table', v_tournament IS NOT NULL,
    'occupancy_id',v_seat.occupancy_id,'user_id',p_user_id,'table_id',p_table_id);
  -- Every ingress, including an older engine during adoption, records the
  -- original outcome in the transaction that moves the money and exits the seat.
  INSERT INTO public.seat_cashout_receipts
    (occupancy_id,user_id,table_id,seat_id,seat_number,receipt)
  VALUES(v_seat.occupancy_id,p_user_id,p_table_id,v_seat.id,v_seat.seat_number,v_receipt);
  RETURN v_receipt;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cashout_seat_occupancy(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_occupancy_id uuid, p_leave_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_tournament uuid;
  v_seat record;
  v_previous public.seat_cashout_receipts%ROWTYPE;
  v_result jsonb;
  v_effective_mode text;
  v_previous_authority text;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_seat_number IS NULL
     OR p_occupancy_id IS NULL THEN
    RAISE EXCEPTION 'CASHOUT_OCCUPANCY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- The engine owns the live-hand boundary. Knowing an occupancy UUID or
  -- owning the seat cannot authorize a direct browser cashout mid-hand.
  IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
    RAISE EXCEPTION 'Engine authority required' USING ERRCODE = '42501';
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
  -- Diamond hands lock table -> wallet -> seat. Retain that order for exits.
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
    PERFORM 1 FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  END IF;
  SELECT id,seat_number,occupancy_id INTO v_seat FROM public.table_seats
   WHERE occupancy_id=p_occupancy_id AND table_id=p_table_id AND user_id=p_user_id
     AND seat_number=p_seat_number AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_STALE_OCCUPANCY' USING ERRCODE = '22023';
  END IF;

  -- This lock and the canonical function's locks are in the same transaction.
  -- A concurrent seat replacement cannot cross the identity check.
  v_effective_mode := p_leave_mode;
  -- A forced request survives restart and cannot leak onto a later occupancy.
  IF p_leave_mode IS DISTINCT FROM 'vpip_evicted' AND EXISTS (SELECT 1 FROM public.seat_departure_requests
    WHERE occupancy_id=p_occupancy_id AND user_id=p_user_id AND table_id=p_table_id
      AND seat_number=p_seat_number AND leave_mode='forced') THEN
    v_effective_mode := 'forced';
  END IF;
  -- Classification is derived from retained, occupancy-bound authority.
  -- Never inherit another operation's transaction-local admin marker.
  v_previous_authority := current_setting('app.cash_exit_authority',true);
  PERFORM set_config('app.cash_exit_authority',
    CASE WHEN v_effective_mode='forced' AND EXISTS(
      SELECT 1 FROM public.seat_admin_departure_authorizations
       WHERE occupancy_id=p_occupancy_id AND user_id=p_user_id
         AND table_id=p_table_id AND seat_number=p_seat_number)
    THEN 'club_admin' ELSE '' END,true);
  v_result := public.atomic_seat_cashout_locked(
    p_user_id,p_table_id,p_seat_number,v_effective_mode);
  PERFORM set_config('app.cash_exit_authority',coalesce(v_previous_authority,''),true);
  IF v_result->>'ok' IS DISTINCT FROM 'true'
     OR v_result->>'reason' IS NOT NULL
     OR (v_result->>'seat_number')::integer IS DISTINCT FROM p_seat_number
     OR v_result->>'idempotency_key' IS DISTINCT FROM 'cashout:occupancy:'||p_occupancy_id::text THEN
    RAISE EXCEPTION 'CASHOUT_UNCONFIRMED_OUTCOME' USING ERRCODE = '22023';
  END IF;
  -- The canonical transaction writes this receipt for every ingress.
  -- The wrapper owns request identity and replay, never a second receipt write.
  RETURN v_result;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_log_seat_stack_exit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stack numeric;
  v_kind  text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=OLD.table_id AND c.asset='diamonds') THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- A departed seat being tidied up is not an exit: its stack left when
    -- left_at was stamped, and that is already recorded below.
    IF OLD.left_at IS NOT NULL THEN RETURN OLD; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'deleted';
  ELSE
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN RETURN NEW; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'left';
  END IF;

  IF v_stack <= 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- CASH ONLY. A tournament stack is play money inside the event -- it credits
  -- no wallet when the seat ends, so it cannot be lost in the sense this table
  -- exists to detect. Filtering HERE rather than in the report keeps ~2,000
  -- meaningless rows an hour out of the audit trail entirely.
  IF EXISTS (SELECT 1 FROM public.tables t
              WHERE t.id = OLD.table_id AND t.tournament_id IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.ca_seat_stack_exits
    (seat_id, table_id, user_id, club_id, seat_number, stack, exit_kind, db_role, app_name)
  VALUES (OLD.id, OLD.table_id, OLD.user_id, OLD.club_id, OLD.seat_number,
          v_stack, v_kind, current_user,
          NULLIF(current_setting('application_name', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_fn_close_session_when_seat_vacated()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  BEGIN
    IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
              WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NULL; END IF;
    /* A VACATED SEAT CLOSES ITS SESSION AT COMMIT (2026-09-10). Deferred: any
       proper close in this transaction has already run. Only a session that
       NOBODY closed is still open here, and that is the one this closes. */
    IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = NEW.table_id AND t.tournament_id IS NULL) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'seat_vacated'
       WHERE player_id = NEW.user_id AND scope_type = 'table'
         AND scope_id = NEW.table_id AND closed_at IS NULL;
    END IF;
    RETURN NULL;
  END $function$
;

REVOKE ALL ON FUNCTION public.atomic_seat_cashout_locked(uuid,uuid,integer,text)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)
 TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_log_seat_stack_exit() FROM PUBLIC,anon,authenticated;
-- Client access reflects the same authoritative admission switch; no public setter.
CREATE OR REPLACE FUNCTION public.fn_poker_arena_context(p_club_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_club public.clubs%ROWTYPE; v_role text; v_member boolean;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '28000';
  END IF;
  SELECT c.* INTO v_club FROM public.clubs c
  WHERE c.id::text = btrim(p_club_key) OR c.club_id::text = btrim(p_club_key)
     OR lower(c.slug) = lower(btrim(p_club_key))
  ORDER BY (c.id::text = btrim(p_club_key)) DESC LIMIT 1;
  IF NOT FOUND OR v_club.lifecycle_status = 'retired' THEN RETURN NULL; END IF;
  IF v_club.asset = 'diamonds' THEN
    IF v_club.is_platform IS DISTINCT FROM true OR v_club.union_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE club_id = v_club.id) THEN
      RAISE EXCEPTION 'Invalid Diamond Arena Identity' USING ERRCODE = '23514';
    END IF;
    v_member := true; v_role := 'player';
  ELSIF v_club.asset = 'chips' AND v_club.is_platform = false THEN
    SELECT m.role INTO v_role FROM public.club_members m
      WHERE m.club_id = v_club.id AND m.user_id = v_uid AND m.status IN ('active','approved');
    v_member := FOUND;
  ELSE RAISE EXCEPTION 'Invalid Arena Asset' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('arena',jsonb_build_object('id',v_club.id,'asset',v_club.asset,
    'is_platform',v_club.is_platform,'union_id',v_club.union_id), 'member',v_member,'role',v_role,
    'cashGamesEnabled',v_club.asset='diamonds' AND COALESCE(
      (SELECT s.cash_games_enabled FROM public.ca_arena_settings s WHERE s.club_id=v_club.id),false));
END $function$
;
REVOKE ALL ON FUNCTION public.fn_poker_arena_context(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_arena_context(text) TO authenticated;

-- Recover a displayed cash-out after response loss without reading a chip ledger.
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cashout_receipt(
 p_table_id uuid,p_occupancy_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp SET statement_timeout='5s' AS $fn$
DECLARE v_uid uuid:=auth.uid(); v_r public.seat_cashout_receipts%ROWTYPE;
BEGIN
 IF v_uid IS NULL OR NOT public.fn_caller_session_is_live() THEN
   RAISE EXCEPTION 'Authentication Required' USING ERRCODE='28000';
 END IF;
 IF p_table_id IS NULL OR p_occupancy_id IS NULL THEN
   RAISE EXCEPTION 'CASHOUT_OCCUPANCY_REQUIRED' USING ERRCODE='22023';
 END IF;
 SELECT * INTO v_r FROM public.seat_cashout_receipts
   WHERE occupancy_id=p_occupancy_id AND user_id=v_uid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF v_r.table_id IS DISTINCT FROM p_table_id
    OR v_r.receipt->>'asset' IS DISTINCT FROM 'diamonds'
    OR NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform AND c.union_id IS NULL) THEN
   RAISE EXCEPTION 'CASHOUT_OCCUPANCY_SCOPE_MISMATCH' USING ERRCODE='22023';
 END IF;
 RETURN jsonb_build_object('asset','diamonds','table_id',p_table_id,
   'occupancy_id',p_occupancy_id,'amount',(v_r.receipt->>'stack')::bigint);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_cashout_receipt(uuid,uuid)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_cashout_receipt(uuid,uuid) TO authenticated;

COMMIT;
