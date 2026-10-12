INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES ('fn_assign_tournament_player_seat_atomic','approved','Service-only tournament seat+roster+table-count assignment. It derives the locked roster stack and enters through the terminal/mission/launch parent lock root; callers cannot choose chips.') ON CONFLICT(proname) DO NOTHING;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES ('fn_ca_assign_tournament_player_seat_locked','system','Owner-only implementation beneath the canonical assignment and tournament chip-purchase roots. It commits one locked seat, roster mirror and exact table count or rolls the transaction back.') ON CONFLICT(proname) DO NOTHING;
CREATE OR REPLACE FUNCTION public.fn_assign_tournament_player_seat_atomic(p_tournament_id uuid, p_user_id uuid, p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_assign_tournament_player_seat_atomic requires service authority'
      USING ERRCODE='28000';
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,p_table_id,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_ca_assign_tournament_player_seat_locked(
    p_tournament_id,p_user_id,p_table_id,p_seat_number);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_assign_tournament_player_seat_locked(p_tournament_id uuid, p_user_id uuid, p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_tp public.tournament_players%ROWTYPE;
  v_table public.tables%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_live_count integer;
  v_stack numeric;
  v_felt_stack numeric;
  v_live_total numeric;
  v_own_live numeric;
  v_cap_chips numeric;
  v_cap integer;
  v_seat_id uuid;
  v_current_players integer;
  v_rows integer;
  v_assigned_at timestamptz;
  v_expected_club_id uuid;
  v_expected_horse_id uuid;
  -- Fresh tournament-seat defaults. A rebuy that keeps its live chair keeps
  -- its own persisted bank; only a newly inserted/revived occupant starts the
  -- same 30-second/four-use state as a physical INSERT.
  v_time_bank_uses integer:=4;
  v_time_bank_seconds integer:=30;
  v_previous_money_path text:=current_setting('app.money_path',true);
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
     OR p_seat_number IS NULL OR p_seat_number NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'tournament, player, table and legal seat are required'
      USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_assignable',
      'status',upper(COALESCE(v_t.status::text,'')));
  END IF;
  v_cap:=public.fn_ca_tournament_seat_cap(p_tournament_id);

  -- Lock the beneficiary and every roster row claiming the requested
  -- coordinate before any table/seat row. This matches terminal settlement's
  -- tournament -> roster -> tables -> seats child order.
  PERFORM tp.id
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND (tp.user_id=p_user_id
       OR (tp.table_id=p_table_id AND tp.seat_number=p_seat_number))
   ORDER BY tp.id
   FOR UPDATE;

  SELECT * INTO v_tp FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_registered');
  END IF;
  IF v_tp.status::text NOT IN ('registered','playing') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','player_not_assignable','status',v_tp.status::text);
  END IF;

  IF v_tp.status::text='registered' THEN
    v_stack:=COALESCE(v_t.starting_chips,0)
             +GREATEST(COALESCE(v_tp.chips,0),0);
  ELSE
    /* THE FELT IS THE BANK ON A MOVE (2026-09-10). This took the new
       seat's stack from tournament_players.chips, a MIRROR, rather than
       from the seat the player is leaving. In the ordinary case the two
       agree - measured 1,540 of 1,541 live tournament seats. When they
       do not, this statement silently minted or destroyed the gap.
       Night Owl Special b84f312f: the engine's own hands show 256,000 +
       128,000 = 384,000 at 18:01, exactly the 48 x 8,000 bought in; a
       move at 22:34:25 wrote 448,000 over a felt of 256,000 and the
       tournament has held 64,000 chips nobody bought ever since.
       The seat is where the engine settles every hand, so the seat is
       the witness; the mirror is a projection. Read the felt first and
       fall back to the mirror only when the player holds no live seat. */
    SELECT ts.stack INTO v_felt_stack
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id=ts.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND ts.user_id=p_user_id
       AND ts.left_at IS NULL
     ORDER BY ts.joined_at DESC, ts.id
     LIMIT 1;
    v_stack:=COALESCE(v_felt_stack,COALESCE(v_tp.chips,0));
  END IF;

  /* A SEAT ASSIGNMENT NEVER MINTS TOURNAMENT CHIPS (2026-09-10).
     Whatever corrupts an input, this gate makes the class impossible:
     an assignment may move chips between chairs but may never RAISE the
     tournament's live total above what was bought in. A normal move
     cannot trip it - the player's own live seat is subtracted before
     v_stack is added back, so the total is unchanged. It fires only when
     seating a player would ADD chips beyond the cap. An existing overage
     is tolerated (history) and refused only from growing (the future),
     the same shape as this estate's NOT VALID constraints. */
  IF v_tp.status::text<>'registered' THEN
    SELECT COALESCE(sum(ts.stack),0) INTO v_live_total
      FROM public.table_seats ts JOIN public.tables tb ON tb.id=ts.table_id
     WHERE tb.tournament_id=p_tournament_id AND ts.left_at IS NULL;
    SELECT COALESCE(sum(ts.stack),0) INTO v_own_live
      FROM public.table_seats ts JOIN public.tables tb ON tb.id=ts.table_id
     WHERE tb.tournament_id=p_tournament_id AND ts.user_id=p_user_id
       AND ts.left_at IS NULL;
    SELECT (count(*)*COALESCE(v_t.starting_chips,0))
           +(COALESCE(sum(tp2.rebuys),0)*COALESCE(v_t.rebuy_chips,0))
           +(count(*) FILTER (WHERE tp2.add_on)*COALESCE(v_t.addon_chips,0))
      INTO v_cap_chips
      FROM public.tournament_players tp2
     WHERE tp2.tournament_id=p_tournament_id;
    IF (v_live_total-v_own_live+v_stack)>v_live_total
       AND (v_live_total-v_own_live+v_stack)>v_cap_chips
       -- Only the private original-purchase transaction may transfer a
       -- proved, unconsumed off-felt stack. This is not a cap increase:
       -- ordinary callers, later transactions and other coordinates retain
       -- the same conservation refusal. The deferred receipt must complete.
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
          WHERE r.transaction_id=pg_current_xact_id() AND r.state='reserved'
            AND r.tournament_id=p_tournament_id AND r.user_id=p_user_id
            AND r.destination_table_id=p_table_id AND r.destination_seat_number=p_seat_number
            AND r.grant_chips=v_stack AND r.live_chips_before=v_live_total
            AND r.funded_supply=v_cap_chips AND v_own_live=0
            AND v_tp.status='playing' AND v_tp.table_id IS NULL AND v_tp.seat_number IS NULL
            AND v_tp.rebuy_prompt_until IS NULL
            AND EXISTS(SELECT 1 FROM public.tournament_knockout_candidates c
              WHERE c.id=r.candidate_id AND c.state='rebought' AND c.resolved_at IS NOT NULL
                AND c.tournament_id=p_tournament_id AND c.eliminated_user_id=p_user_id)
       ) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','tournament_chip_conservation',
        'live_total',v_live_total,'own_live',v_own_live,
        'proposed_stack',v_stack,'bought_in_cap',v_cap_chips);
    END IF;
  END IF;
  IF v_stack::text IN ('NaN','Infinity','-Infinity')
     OR v_stack<=0 OR v_stack<>trunc(v_stack)
     OR v_stack>2147483647 THEN
    RETURN jsonb_build_object('ok',false,'reason','player_stack_invalid');
  END IF;

  SELECT * INTO v_table FROM public.tables tb
   WHERE tb.id=p_table_id
   FOR UPDATE;
  IF NOT FOUND OR v_table.tournament_id IS DISTINCT FROM p_tournament_id THEN
    RETURN jsonb_build_object('ok',false,'reason','table_tournament_mismatch');
  END IF;
  IF lower(COALESCE(v_table.status::text,'')) NOT IN
       ('waiting','running','active')
     OR COALESCE(v_table.is_deleted,false)
     OR p_seat_number>LEAST(
          v_cap,GREATEST(2,COALESCE(NULLIF(v_table.max_players,0),v_cap))) THEN
    RETURN jsonb_build_object('ok',false,'reason','table_not_assignable');
  END IF;

  -- A physical row is reusable, but none of its former occupant's identity or
  -- per-session state is. Resolve every derived value while the tournament,
  -- roster and table rows are locked, then write the same complete shape for a
  -- new row and a revived row. Passing the old club_id through the seat stamp
  -- trigger would make it the preferred club and could attribute this entry to
  -- the departed occupant.
  v_expected_club_id:=public.fn_seat_club_for_user(
    p_user_id,p_table_id,v_tp.club_id);
  SELECT CASE WHEN COALESCE(p.is_horse,false) THEN p.id ELSE NULL END
    INTO v_expected_horse_id
    FROM public.profiles p
   WHERE p.id=p_user_id;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL
   ORDER BY s.id
   FOR UPDATE OF s;
  SELECT count(*)::integer INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RAISE EXCEPTION 'tournament player already owns multiple live seats'
      USING ERRCODE='P0404';
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
     FOR UPDATE OF s;
    IF v_live.table_id IS DISTINCT FROM p_table_id
       OR v_live.seat_number IS DISTINCT FROM p_seat_number THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','player_already_seated_elsewhere',
        'table_id',v_live.table_id,'seat_number',v_live.seat_number);
    END IF;
    SELECT count(*)::integer INTO v_current_players
      FROM public.table_seats s
     WHERE s.table_id=p_table_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM v_stack
       OR v_tp.status::text<>'playing'
       OR v_tp.chips IS DISTINCT FROM v_stack::integer
       OR v_tp.table_id IS DISTINCT FROM p_table_id
       OR v_tp.seat_number IS DISTINCT FROM p_seat_number
       OR v_table.current_players IS DISTINCT FROM v_current_players
       OR v_live.joined_at IS NULL THEN
      RAISE EXCEPTION 'existing tournament assignment is not an exact receipt'
        USING ERRCODE='P0404';
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'replayed',true,'tournament_id',p_tournament_id,
      'user_id',p_user_id,'table_id',p_table_id,
      'seat_id',v_live.id,'seat_number',p_seat_number,'stack',v_stack,
      'current_players',v_current_players,'assigned_at',v_live.joined_at);
  END IF;

  SELECT * INTO v_destination FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.seat_number=p_seat_number
   FOR UPDATE;
  IF FOUND AND v_destination.left_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_taken');
  END IF;

  -- A departed occupant can still carry a stale roster coordinate. Correct
  -- that link inside this assignment transaction; never overwrite a live
  -- seat or leave two active roster rows claiming one chair.
  UPDATE public.tournament_players tp
     SET table_id=NULL,seat_number=NULL
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id<>p_user_id
     AND tp.table_id=p_table_id AND tp.seat_number=p_seat_number;

  v_assigned_at:=clock_timestamp();
  PERFORM set_config(
    'app.money_path','fn_assign_tournament_player_seat_atomic',true);
  BEGIN
    IF v_destination.id IS NULL THEN
      INSERT INTO public.table_seats(
        table_id,user_id,player_id,member_id,seat_number,stack,status,
        joined_at,left_at,is_sitting_out,is_away,leave_pending,
        scheduled_leave_hands,horse_id,auto_rebuy,time_bank_remaining,
        time_bank_uses_remaining,club_id,sit_out_at,entry_hold,
        entry_post_agreed)
      VALUES(
        p_table_id,p_user_id,NULL,NULL,p_seat_number,v_stack,'active',
        v_assigned_at,NULL,false,false,false,NULL,v_expected_horse_id,false,
        v_time_bank_seconds,v_time_bank_uses,v_expected_club_id,NULL,NULL,
        false)
      RETURNING id INTO v_seat_id;
    ELSE
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=NULL,member_id=NULL,stack=v_stack,
             status='active',joined_at=v_assigned_at,left_at=NULL,
             is_sitting_out=false,is_away=false,leave_pending=false,
             sit_out_at=NULL,scheduled_leave_hands=NULL,
             horse_id=v_expected_horse_id,entry_hold=NULL,
             entry_post_agreed=false,auto_rebuy=false,
             time_bank_remaining=v_time_bank_seconds,
             time_bank_uses_remaining=v_time_bank_uses,
             club_id=v_expected_club_id
       WHERE s.id=v_destination.id AND s.left_at IS NOT NULL
       RETURNING id INTO v_seat_id;
      IF v_seat_id IS NULL THEN
        RAISE EXCEPTION 'vacated tournament seat changed during assignment'
          USING ERRCODE='40001';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config(
      'app.money_path',COALESCE(v_previous_money_path,''),true);
    RAISE;
  END;
  PERFORM set_config(
    'app.money_path',COALESCE(v_previous_money_path,''),true);

  UPDATE public.tournament_players tp
     SET status='playing',chips=v_stack::integer,
         table_id=p_table_id,seat_number=p_seat_number
   WHERE tp.id=v_tp.id AND tp.status::text IN ('registered','playing');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament roster changed during seat assignment'
      USING ERRCODE='40001';
  END IF;

  SELECT count(*)::integer INTO v_current_players
    FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.left_at IS NULL;
  UPDATE public.tables tb
     SET current_players=v_current_players,updated_at=now()
   WHERE tb.id=p_table_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament table vanished during seat assignment'
      USING ERRCODE='40001';
  END IF;

  IF (SELECT count(*) FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL)<>1
     OR NOT EXISTS(
       SELECT 1 FROM public.table_seats s
        WHERE s.id=v_seat_id AND s.table_id=p_table_id
          AND s.user_id=p_user_id AND s.seat_number=p_seat_number
          AND s.left_at IS NULL AND s.stack=v_stack
          AND s.player_id IS NULL AND s.member_id IS NULL
          AND s.horse_id IS NOT DISTINCT FROM v_expected_horse_id
          AND s.club_id IS NOT DISTINCT FROM v_expected_club_id
          AND s.time_bank_remaining=v_time_bank_seconds
          AND s.time_bank_uses_remaining=v_time_bank_uses
          AND NOT COALESCE(s.is_sitting_out,false)
          AND NOT COALESCE(s.is_away,false)
          AND NOT COALESCE(s.leave_pending,false)
          AND NOT COALESCE(s.auto_rebuy,false)
          AND s.sit_out_at IS NULL
          AND s.scheduled_leave_hands IS NULL
          AND s.entry_hold IS NULL
          AND NOT s.entry_post_agreed)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.id=v_tp.id AND tp.status::text='playing'
          AND tp.chips=v_stack::integer AND tp.table_id=p_table_id
          AND tp.seat_number=p_seat_number)
     OR NOT EXISTS(
       SELECT 1 FROM public.tables tb
        WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id
          AND tb.current_players=v_current_players) THEN
    RAISE EXCEPTION 'atomic tournament seat assignment final proof is not exact'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'tournament_id',p_tournament_id,
    'user_id',p_user_id,'table_id',p_table_id,'seat_id',v_seat_id,
    'seat_number',p_seat_number,'stack',v_stack,
    'current_players',v_current_players,'assigned_at',v_assigned_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid:=p_tournament_id;
  v_table_tournament_id uuid;
  v_status text;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, p_table_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  -- DIAMOND PHASE 11: every seat's player takes the table-cap lock before the
  -- Daily Missions lock, which locks the player's profile row. Every cash seat
  -- door, chip and Diamond, takes table_cap first; for a Diamond player the
  -- profile row is the wallet, and one player's chip entry, Diamond entry and
  -- Diamond cash seat meet on these two locks, so the order is one for every
  -- event whatever its asset. The roster trigger's own table_cap is re-entrant.
  IF p_user_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_table_tournament_id
      FROM public.tables tb
     WHERE tb.id=p_table_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','table_not_found');
    END IF;
    IF v_table_tournament_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_a_tournament_table');
    END IF;
    IF v_tournament_id IS NOT NULL
       AND v_tournament_id IS DISTINCT FROM v_table_tournament_id THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','table_tournament_mismatch');
    END IF;
    v_tournament_id:=v_table_tournament_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_or_table_required');
  END IF;

  -- Launch completion already owns receipt -> tournament. Re-entering these
  -- locks from every seat root makes the historical aa_ launch-proof trigger
  -- a no-op lock acquisition rather than a late inversion.
  PERFORM r.tournament_id
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=v_tournament_id
   ORDER BY r.tournament_id
   FOR UPDATE;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t
   WHERE t.id=v_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_seatable','status',v_status);
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',v_tournament_id,
    'table_id',p_table_id,'status',v_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid; v_table_club uuid;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_table_club
    FROM public.tables t WHERE t.id = p_table_id;
  -- A DIAMOND TOURNAMENT CHAIR SITS IN THE ARENA (2026-09-29). A Diamond
  -- chair's money is custody held by the arena, and the deferred seat guard
  -- (zzz_diamond_seat_keeps_custody: P0812 and its cash arm) matches that
  -- custody to the chair's club at COMMIT. Diamond membership is automatic
  -- and has no club_members row, so the lookups below never find the arena:
  -- they answered a chip club or none, and every Diamond chair was refused.
  -- A table whose club plays in Diamonds seats every player in that club.
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.id = v_table_club AND c.asset = 'diamonds') THEN
    RETURN v_table_club;
  END IF;
  IF v_union IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.user_id = p_user_id AND cm.club_id = v_table_club
         AND cm.status IN ('active','approved')
    ) THEN RETURN v_table_club; END IF;
    RETURN public.fn_player_home_club(p_user_id, p_preferred_club);
  END IF;
  RETURN public.fn_seat_club_for_user_membership_unchecked(
    p_user_id, p_table_id, p_preferred_club
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
  v_tournament_id uuid;
  v_variant text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id, t.variant, t.max_players, t.starting_chips
    INTO v_tournament_id, v_variant, v_max_players, v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack <= 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack
        USING ERRCODE = 'check_violation',
              HINT = 'Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF public.fn_ca_tournament_recorded_seat_first(v_tournament_id, false) THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips <= 0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id, v_starting_chips
          USING ERRCODE = 'check_violation';
      END IF;
      -- A retained original hand revives its exact already-paid chair.
      -- This capability exists only in the same transaction as the private
      -- original recovery receipt; no new seat or changed stack is admitted.
      IF NEW.stack IS DISTINCT FROM v_starting_chips AND NOT (
        TG_OP='UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL
        AND NEW.status IS NOT DISTINCT FROM 'active' AND auth.role() IS NOT DISTINCT FROM 'service_role'
        AND (to_jsonb(NEW)-'left_at'-'status')=(to_jsonb(OLD)-'left_at'-'status')
        AND EXISTS (
          SELECT 1 FROM smarter_private.retirement_original_hand_restorations r
          JOIN smarter_private.retirement_original_hand_qualification c USING(submission_id)
          JOIN smarter_private.hand_submissions s USING(submission_id)
          JOIN public.engine_tournament_leases l ON l.tournament_id=c.tournament_id
          CROSS JOIN LATERAL jsonb_array_elements(c.expected->'rows') e
          WHERE r.transaction_id=txid_current()
            AND c.tournament_id=v_tournament_id AND c.table_id=OLD.table_id
            AND r.request_hash=c.request_hash AND s.request_hash=c.request_hash
            AND r.qualification_hash=md5(c.expected::text)
            AND r.original_generation=s.lease_generation
            AND r.successor_generation=l.lease_generation AND r.instance_id=l.instance_id
            AND l.protocol_version=2
            AND r.restored_players=jsonb_array_length(c.expected->'rows')
            AND (e->>'user_id')::uuid=OLD.user_id
            AND (e->'seat'->>'id')::uuid=OLD.id
            AND to_jsonb(OLD) @> (e->'seat')
            AND (e->'stack'->>'stack_before')::numeric=OLD.stack
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks') x
                       WHERE x=e->'stack')
        )
      ) THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack, v_starting_chips
          USING ERRCODE = 'check_violation',
                HINT = 'The paid seat transaction is the only starting-stack authority; no later top-up exists.';
      END IF;
    END IF;
  END IF;

  -- Cash seats with no funded stack preserve their existing reservation path.
  IF COALESCE(NEW.stack,0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_assign_tournament_player_seat_atomic',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- Resolve the tournament before any lock, so G's mode can depend on it.
  -- tables.tournament_id is fixed for the life of a table: reading it here
  -- gives the answer reading it under G did.
  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to: the whole lane, as it always was - G exclusive,
    -- then B exclusive (the shape of fn_ca_lock_settlement_lane_global).
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, terminal authorities (G exclusive)
  -- and nothing else. Rolling authorities of different tournaments run side
  -- by side; the trigger guards take T(id) held exclusively as their proof.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  -- T(id) EXCLUSIVE: one rolling authority per tournament at a time, and
  -- this tournament's hand settlements (T(id) shared) wait for it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_refuse_restricted_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_scope    text := coalesce(tg_argv[0], 'account');
  v_user     uuid;
  v_enforced boolean := false;
  v_tourney  uuid;
  v_row      public.ca_player_restrictions;
begin
  begin
    v_user := new.user_id;
    if v_user is null then
      return new;
    end if;

    -- THE HOT PATH, and the only thing that runs for a player nobody has
    -- restricted: one probe of the partial index
    -- ca_player_restrictions_active_by_user, which on a platform with no
    -- restrictions is a handful of pages. Everything below it - the
    -- table lookup, the policy read, the observation write - happens
    -- only for a player who genuinely carries a live restriction.
    if not exists (
      select 1 from public.ca_player_restrictions r
       where r.user_id = v_user
         and r.status = 'active'
         and (r.expires_at is null or r.expires_at > now())
    ) then
      return new;
    end if;

    -- THE SCOPE THIS WRITE ACTUALLY BELONGS TO. table_seats carries both
    -- cash and tournament seats and 97.8% of its rows are tournament
    -- ones, so the trigger argument is a DEFAULT, not an answer.
    if tg_table_name = 'table_seats' then
      select t.tournament_id into v_tourney
        from public.tables t where t.id = new.table_id;
      v_scope := case when v_tourney is not null then 'tournaments' else 'cash' end;
    end if;

    if not public.fn_ca_player_restricted(v_user, v_scope) then
      return new;
    end if;

    select restrictions_enforced into v_enforced
      from public.ca_operator_policy limit 1;
    v_enforced := coalesce(v_enforced, false);

    v_row := public.fn_ca_player_restriction_for(v_user, v_scope);

    if not v_enforced then
      insert into public.ca_restriction_observations
        (user_id, scope, restriction_id, table_name, op, would_refuse, detail)
      values (
        v_user, v_scope, v_row.id, tg_table_name, tg_op, true,
        jsonb_build_object(
          'reason_code', v_row.reason_code,
          'restriction_scope', v_row.scope,
          'applied_at', v_row.applied_at,
          'expires_at', v_row.expires_at,
          -- Which of the two ways in this was, so the evidence says
          -- whether the revive path is being used at all.
          'seating_op', tg_op,
          'tournament_id', v_tourney));
      return new;
    end if;

    raise exception
      'PLAYER_RESTRICTED: this account is restricted (%) and cannot % on %.',
      v_row.reason_code, tg_op, tg_table_name
      using errcode = '42501',
            hint = 'An operator applied this restriction. It can be lifted from the Players tab in the operator console.';

  exception
    when insufficient_privilege then
      raise;
    when others then
      return new;
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_reentry_with_pending_bounty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status='eliminated' AND NEW.status='playing'
     AND EXISTS (SELECT 1 FROM public.tournament_bounty_obligations o
                  WHERE o.tournament_id=NEW.tournament_id
                    AND o.eliminated_user_id=NEW.user_id AND o.state='pending') THEN
    RAISE EXCEPTION 'prior bounty obligation is still pending for tournament %, player %',
      NEW.tournament_id, NEW.user_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_tournament_status text;
  v_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_tournament_key bigint;
  v_owns_authority boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL
       OR (OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
         AND OLD.seat_number IS NOT DISTINCT FROM NEW.seat_number) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,''))
    INTO v_tournament_id,v_tournament_status
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Proof of authority (2026-09-10): this backend holds, exclusively, either
  -- T(the seat's tournament) - that tournament's rolling lane - or G - a
  -- terminal authority. A shared hold of either key proves nothing: hand
  -- settlements hold T shared and rolling authorities hold G shared.
  v_tournament_key:=hashtextextended(
    'ca:tournament-terminal-settlement:v1:'||v_tournament_id::text,0);
  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.pid=pg_backend_pid()
       AND l.locktype='advisory'
       AND l.database=(
         SELECT d.oid FROM pg_catalog.pg_database d
          WHERE d.datname=current_database())
       AND ((l.classid=(((v_key>>32)&4294967295)::oid)
             AND l.objid=((v_key&4294967295)::oid))
         OR (l.classid=(((v_tournament_key>>32)&4294967295)::oid)
             AND l.objid=((v_tournament_key&4294967295)::oid)))
       AND l.objsubid=1
       AND l.mode='ExclusiveLock'
       AND l.granted)
    INTO v_owns_authority;
  IF NOT COALESCE(v_owns_authority,false) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
      USING ERRCODE='55000',
            HINT='Use a canonical tournament seat purchase, registration, move, or assignment RPC.';
  END IF;
  -- A BAGGED event takes back its bagged players only inside its stage
  -- resume (multi-day, 20260924043224): exact marker, incomplete receipt.
  IF v_tournament_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING')
     AND NOT (v_tournament_status = 'BAGGED'
              AND EXISTS (
                SELECT 1
                  FROM public.tournament_stage_resume_receipts r
                 WHERE r.tournament_id = v_tournament_id
                   AND r.completed_at IS NULL
                   AND current_setting('app.atomic_stage_resume', true)
                       = v_tournament_id::text || ':' || r.resume_id::text)) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_CLOSED: tournament %, status %',
      v_tournament_id,v_tournament_status
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
