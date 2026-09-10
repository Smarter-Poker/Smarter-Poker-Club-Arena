-- 20260910051125_the_seat_move_door_the_engine_calls_exists
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-10 05:11:25 UTC.
--
-- WHAT HAPPENED (2026-09-10, second episode: 04:12-04:55 UTC, then again from 05:05)
--
-- After the settlement-lane fix (20260910035245) the fleet came back at
-- ~1,000 hands/min across ~400 tables. Twelve minutes into every container
-- it then bled tables - 400 -> 55 by 04:22 - and stayed there until the next
-- hourly restart, with the probe reporting handshake_timeout x5. The database
-- was IDLE for the whole slump (zero lock waits, ~30 log lines a minute) and
-- the engine's event loop was at p50 20 ms: nothing was saturated. The engine
-- log for the window is one loop, thousands of times over:
--
--     [Tournament.atomic_move_quarantine_unresolved]
--       Could not find the function
--       public.fn_move_tournament_player(p_destination_seat_number, ...)
--       in the schema cache  (PGRST202)
--       ... receipt-only resolution failed (404):
--       fn_resolve_committed_tournament_seat_move ... no matches
--     [GameServer.tournament_lease_lost_stop_failed]
--       Tournament <id> retained an unresolved seat-move UUID
--     [GameServer.tournament_lease_lost]
--       Lost the tournament lease on <id> to another engine instance
--
-- The seat-move door the engine calls DOES NOT EXIST in production. The stop
-- failure is thrown inside runOwnershipLeaseRenewalLoop - the loop that renews
-- every lease, cash tables included - so table leases starve too and the
-- whole fleet winds down. "Another engine instance" is the engine reading its
-- own expired leases; there was one instance the entire night.
--
-- HOW PRODUCTION GOT HERE
--
--   1. PR #3716 (merged 2026-09-09 20:10 UTC) made the engine call
--      fn_move_tournament_player(7 args) and carried
--      20260909014545_tournament_seat_exits_stay_inside_tournament_authority
--      (5,500 lines: freeze preflights, orphan cutover, 26 function rewrites,
--      12 drops). The engine half deployed at the 20:55 break. The database
--      half was NEVER applied - it is absent from schema_migrations and none
--      of its tables or functions exist. The archived engine logs show the
--      first "Could not find the function" in the container started 21:55.
--   2. 20260909230135_tournament_capacity_has_one_runtime_door (applied 23:01)
--      then DROPPED the previous mover, fn_ca_move_tournament_seat, on the
--      assumption that (1) was in place. Since 23:01 production has had no
--      tournament seat-move function at all.
--   3. PR #4066 (2026-09-10 00:54) added the resolver the engine now consults,
--      20260909182952_a_committed_tournament_move_receipt_survives_lease_loss,
--      whose own preflight requires (1). Also never applied.
--
-- WHY NOT JUST APPLY 20260909014545
--
-- It is a cutover, not a hotfix: it demands a live-seat-exit freeze, rewrites
-- fn_complete_tournament_terminal, atomic_cancel_tournament,
-- fn_ca_unregister_tournament_player_exact, fn_settle_satellite_tournament and
-- 22 others to bodies that every settlement-lane migration since (04:24 on
-- 09-09 through 20260910035245 tonight) has superseded, and drops
-- fn_reconcile_tournament_denormals, which cron job 133 calls every minute.
-- Applying it now would silently revert a day of money-path work. It still
-- deserves to land, but as its own planned cutover inside a break, by whoever
-- owns it - not at 00:20 from an incident.
--
-- WHAT THIS DOES INSTEAD
--
-- Installs exactly the door the deployed engine calls, VERBATIM from the two
-- merged migrations (the text below is copied by line range from origin/main,
-- not retyped):
--
--   public.tournament_seat_exit_authorizations      table   (014545 L2617-2632)
--   public.tournament_seat_move_receipts            table   (014545 L2634-2656)
--   fn_tournament_seat_move_receipts_append_only    + trigger (014545 L2657-2676)
--   fn_ca_open_tournament_seat_exit_authority       (014545 L2680-2738)
--   fn_ca_close_tournament_seat_exit_authority      (014545 L2858-2887)
--   fn_ca_tournament_seat_move_receipt              (014545 L3823-3851)
--   fn_move_tournament_player                       (014545 L3856-4139)
--   fn_resolve_committed_tournament_seat_move       (182952 L36-131, incl. its
--                                                    own verification block)
--
-- with exactly two deliberate edits to fn_move_tournament_player, both marked
-- "-- HOTFIX EDIT" inline:
--
--   a. It closes its seat-exit authority with p_require_consumed=false instead
--      of true. The authorization rows are consumed by the
--      zy_tournament_live_seat_exit_requires_authority trigger, which this
--      migration does NOT install: that trigger refuses every tournament seat
--      exit not wrapped in an authority, and the production versions of
--      elimination, unregistration, terminal close and zero-stack hand vacates
--      do not open one (the cutover rewrites them so they do). Installing the
--      guard without the cutover would break every one of those paths. Without
--      the guard, nothing consumes the rows, and require_consumed=true would
--      make every move fail with "left 1 live seat(s) unconsumed". The close
--      still deletes the rows either way; the authority bookkeeping stays
--      intact for the day the cutover lands.
--   b. It enters the settlement lane through
--      fn_ca_lock_settlement_lane_for_tournament(p_tournament_id) (G -> T)
--      instead of the raw global key, matching 20260910035245: a move is a
--      rolling per-tournament authority, and this way it excludes exactly the
--      hands of the tournament it is moving a seat in - which is what the raw
--      global key meant on the day it was written, when every hand shared it.
--      The trigger guards that verify G-held still pass (the helper takes G
--      first). fn_ca_open_tournament_seat_exit_authority and the resolver keep
--      their verbatim raw-G acquisitions: the opener is only ever entered with
--      G already held, and the resolver takes G purely as a read barrier
--      behind the writer, which holds G through commit.
--
-- Nothing existing is replaced, renamed or dropped. The DROP FUNCTION IF
-- EXISTS of the old six-argument fn_move_tournament_player is kept from the
-- source because it is a no-op here and keeps the block byte-identical.
--
-- WHEN THE FULL CUTOVER IS APPLIED, its CREATE TABLE statements for these two
-- tables will fail on "already exists" - that is the intended tripwire: the
-- owner of 20260909014545 must reconcile it against this migration (and
-- against every function the lane migrations rewrote since) rather than
-- apply it blind.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $preflight$
BEGIN
  IF to_regclass('public.tournament_seat_move_receipts') IS NOT NULL
     OR to_regclass('public.tournament_seat_exit_authorizations') IS NOT NULL
     OR to_regprocedure('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'seat-move door hotfix refused: the cutover (20260909014545) or this hotfix is already applied';
  END IF;
  IF to_regprocedure('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_caller_is_engine()') IS NULL THEN
    RAISE EXCEPTION 'seat-move door hotfix refused: 20260910035245 lane helpers or fn_caller_is_engine missing';
  END IF;
END;
$preflight$;

-- ===== 20260909014545 L2617-2632 =====
CREATE TABLE public.tournament_seat_exit_authorizations (
  token uuid NOT NULL,
  seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN (
    'unregister','cancel','satellite_finish','terminal_finish','move',
    'elimination','hand_settlement')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (token,seat_id),
  UNIQUE (token,tournament_id,user_id,seat_id,operation)
);

ALTER TABLE public.tournament_seat_exit_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_seat_exit_authorizations
  FROM PUBLIC,anon,authenticated,service_role;

-- ===== 20260909014545 L2634-2656 =====
CREATE TABLE public.tournament_seat_move_receipts (
  request_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  source_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  destination_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  source_seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  destination_seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  source_seat_number integer NOT NULL CHECK (source_seat_number BETWEEN 1 AND 10),
  destination_seat_number integer NOT NULL CHECK (destination_seat_number BETWEEN 1 AND 10),
  source_mode text NOT NULL CHECK (source_mode IN ('live_source','closed_orphan')),
  stack numeric NOT NULL CHECK (
    stack::text NOT IN ('NaN','Infinity','-Infinity') AND stack > 0),
  moved_at timestamptz NOT NULL,
  CHECK (source_table_id <> destination_table_id),
  CHECK (source_seat_id <> destination_seat_id),
  UNIQUE (tournament_id,user_id,request_id)
);

ALTER TABLE public.tournament_seat_move_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_seat_move_receipts
  FROM PUBLIC,anon,authenticated,service_role;

-- ===== 20260909014545 L2657-2676 =====
CREATE OR REPLACE FUNCTION public.fn_tournament_seat_move_receipts_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $move_receipt_immutable$
BEGIN
  RAISE EXCEPTION 'tournament seat move receipts are append-only'
    USING ERRCODE='55000';
END;
$move_receipt_immutable$;

REVOKE ALL ON FUNCTION public.fn_tournament_seat_move_receipts_append_only()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER tournament_seat_move_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_seat_move_receipts
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_seat_move_receipts_append_only();

-- ===== 20260909014545 L2680-2738 =====
CREATE OR REPLACE FUNCTION public.fn_ca_open_tournament_seat_exit_authority(
  p_tournament_id uuid,
  p_operation text,
  p_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $open_seat_exit_authority$
DECLARE
  v_token uuid:=gen_random_uuid();
BEGIN
  IF p_tournament_id IS NULL
     OR p_operation NOT IN (
       'unregister','cancel','satellite_finish','terminal_finish','move',
       'elimination') THEN
    RAISE EXCEPTION 'invalid tournament seat-exit authority scope'
      USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;

  -- Deterministic seat order matches hand settlement and terminal close.
  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id
   FOR UPDATE OF s;

  INSERT INTO public.tournament_seat_exit_authorizations(
    token,seat_id,tournament_id,user_id,operation)
  SELECT v_token,s.id,p_tournament_id,s.user_id,p_operation
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NULL
     AND s.user_id IS NOT NULL
     AND (p_user_id IS NULL OR s.user_id=p_user_id)
   ORDER BY s.id;

  PERFORM set_config('app.tournament_seat_exit_token',v_token::text,true);
  PERFORM set_config('app.tournament_seat_exit_operation',p_operation,true);
  RETURN v_token;
END;
$open_seat_exit_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_open_tournament_seat_exit_authority(
  uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- ===== 20260909014545 L2858-2887 =====
CREATE OR REPLACE FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  p_token uuid,
  p_require_consumed boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $close_seat_exit_authority$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  DELETE FROM public.tournament_seat_exit_authorizations a
   WHERE a.token=p_token;
  PERFORM set_config('app.tournament_seat_exit_token','',true);
  PERFORM set_config('app.tournament_seat_exit_operation','',true);
  IF COALESCE(p_require_consumed,true) AND v_remaining<>0 THEN
    RAISE EXCEPTION
      'tournament seat-exit authority left % live seat(s) unconsumed',v_remaining
      USING ERRCODE='P0404';
  END IF;
  RETURN v_remaining;
END;
$close_seat_exit_authority$;

REVOKE ALL ON FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- ===== 20260909014545 L3823-3851 =====
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_seat_move_receipt(
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $move_receipt$
  SELECT jsonb_build_object(
    'ok',true,
    'request_id',r.request_id,
    'tournament_id',r.tournament_id,
    'user_id',r.user_id,
    'source_table_id',r.source_table_id,
    'destination_table_id',r.destination_table_id,
    'source_seat_id',r.source_seat_id,
    'destination_seat_id',r.destination_seat_id,
    'source_seat_number',r.source_seat_number,
    'destination_seat_number',r.destination_seat_number,
    'source_mode',r.source_mode,
    'stack',r.stack,
    'moved_at',r.moved_at)
  FROM public.tournament_seat_move_receipts r
  WHERE r.request_id=p_request_id;
$move_receipt$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_seat_move_receipt(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- ===== 20260909014545 L3856-4139 (two HOTFIX EDITs, see header) =====
DROP FUNCTION IF EXISTS public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid);
CREATE OR REPLACE FUNCTION public.fn_move_tournament_player(
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_destination_table_id uuid,
  p_destination_seat_number integer,
  p_request_id uuid,
  p_source_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $atomic_tournament_move$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_tp public.tournament_players%ROWTYPE;
  v_source public.table_seats%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_destination_id uuid;
  v_token uuid;
  v_moved_at timestamptz;
  v_rows integer;
  v_live_count integer;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_move_tournament_player requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_request_id IS NULL OR p_source_table_id=p_destination_table_id
     OR p_source_mode NOT IN ('live_source','closed_orphan')
     OR p_destination_seat_number NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid tournament move identity' USING ERRCODE='22023';
  END IF;

  -- HOTFIX EDIT (b): G -> T via the 20260910035245 helper, not the raw global key.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('table_cap:'||p_user_id::text,0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NOT NULL THEN
    IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
       OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
       OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
       OR (v_result->>'destination_table_id')::uuid
            IS DISTINCT FROM p_destination_table_id
       OR v_result->>'source_mode' IS DISTINCT FROM p_source_mode
       OR (v_result->>'destination_seat_number')::integer
            IS DISTINCT FROM p_destination_seat_number THEN
      RAISE EXCEPTION 'tournament move request id belongs to another operation'
        USING ERRCODE='23505';
    END IF;
    RETURN v_result||jsonb_build_object('replayed',true);
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;
  IF upper(COALESCE(v_t.status,''))<>'RUNNING' THEN
    RAISE EXCEPTION 'tournament % is not RUNNING',p_tournament_id
      USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_tp FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_tp.status<>'playing'
     OR v_tp.table_id IS DISTINCT FROM p_source_table_id THEN
    RAISE EXCEPTION 'tournament move source roster is not exact'
      USING ERRCODE='P0404';
  END IF;

  PERFORM tb.id FROM public.tables tb
   WHERE tb.id IN (p_source_table_id,p_destination_table_id)
   ORDER BY tb.id FOR UPDATE;
  IF (SELECT count(*) FROM public.tables tb
       WHERE tb.id IN (p_source_table_id,p_destination_table_id)
         AND tb.tournament_id=p_tournament_id)<>2 THEN
    RAISE EXCEPTION 'tournament move tables do not share the event'
      USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_destination_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed'
         OR p_destination_seat_number>COALESCE(tb.max_players,9))) THEN
    RAISE EXCEPTION 'tournament move destination is not open'
      USING ERRCODE='55000';
  END IF;
  IF p_source_mode='closed_orphan' AND NOT EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_source_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed')) THEN
    RAISE EXCEPTION 'closed-orphan move source is not closed'
      USING ERRCODE='55000';
  END IF;
  IF p_source_mode='live_source' AND EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.id=p_source_table_id
       AND (COALESCE(tb.is_deleted,false)
         OR lower(COALESCE(tb.status,''))='closed')) THEN
    RAISE EXCEPTION 'live-source move source is closed'
      USING ERRCODE='55000';
  END IF;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL
   ORDER BY s.id FOR UPDATE OF s;
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL;
  IF v_live_count<>1 THEN
    RAISE EXCEPTION 'tournament move requires exactly one live source seat'
      USING ERRCODE='P0404';
  END IF;

  SELECT s.* INTO v_source FROM public.table_seats s
   WHERE s.table_id=p_source_table_id AND s.user_id=p_user_id
     AND s.left_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_source.seat_number IS DISTINCT FROM v_tp.seat_number
     OR v_source.stack IS NULL
     OR v_source.stack::text IN ('NaN','Infinity','-Infinity')
     OR v_source.stack<=0
     OR abs(v_source.stack-v_tp.chips::numeric)>0.5 THEN
    RAISE EXCEPTION 'tournament move source chips or coordinates are not exact'
      USING ERRCODE='P0404';
  END IF;

  SELECT s.* INTO v_destination FROM public.table_seats s
   WHERE s.table_id=p_destination_table_id
     AND s.seat_number=p_destination_seat_number FOR UPDATE;
  IF FOUND AND v_destination.left_at IS NULL THEN
    RAISE EXCEPTION 'tournament move destination seat is occupied'
      USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.user_id<>p_user_id
       AND tp.status IN ('registered','playing')
       AND tp.table_id=p_destination_table_id
       AND tp.seat_number=p_destination_seat_number) THEN
    RAISE EXCEPTION 'tournament move destination roster is occupied'
      USING ERRCODE='23505';
  END IF;

  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'move',p_user_id);
  v_moved_at:=clock_timestamp();
  BEGIN
    UPDATE public.table_seats s
       SET stack=0,left_at=v_moved_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
     WHERE s.id=v_source.id AND s.left_at IS NULL
       AND s.stack=v_source.stack;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'tournament move lost its locked source seat'
        USING ERRCODE='40001';
    END IF;

    IF v_destination.id IS NULL THEN
      INSERT INTO public.table_seats(
        table_id,seat_number,user_id,player_id,member_id,stack,
        is_sitting_out,is_away,joined_at,horse_id,scheduled_leave_hands,
        left_at,status,leave_pending,auto_rebuy,time_bank_remaining,
        time_bank_uses_remaining,sit_out_at,entry_hold,entry_post_agreed)
      VALUES(
        p_destination_table_id,p_destination_seat_number,p_user_id,
        v_source.player_id,v_source.member_id,v_source.stack,
        false,false,v_moved_at,v_source.horse_id,NULL,NULL,'active',false,
        v_source.auto_rebuy,v_source.time_bank_remaining,
        v_source.time_bank_uses_remaining,NULL,NULL,
        v_source.entry_post_agreed)
      RETURNING id INTO v_destination_id;
    ELSE
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=v_source.player_id,
             member_id=v_source.member_id,stack=v_source.stack,
             is_sitting_out=false,is_away=false,joined_at=v_moved_at,
             horse_id=v_source.horse_id,scheduled_leave_hands=NULL,
             left_at=NULL,status='active',leave_pending=false,
             auto_rebuy=v_source.auto_rebuy,
             time_bank_remaining=v_source.time_bank_remaining,
             time_bank_uses_remaining=v_source.time_bank_uses_remaining,
             sit_out_at=NULL,entry_hold=NULL,
             entry_post_agreed=v_source.entry_post_agreed
       WHERE s.id=v_destination.id AND s.left_at IS NOT NULL
       RETURNING id INTO v_destination_id;
      IF v_destination_id IS NULL THEN
        RAISE EXCEPTION 'tournament move could not reuse destination seat'
          USING ERRCODE='40001';
      END IF;
    END IF;

    UPDATE public.tournament_players tp
       SET table_id=p_destination_table_id,
           seat_number=p_destination_seat_number
     WHERE tp.id=v_tp.id AND tp.status='playing'
       AND tp.table_id=p_source_table_id
       AND tp.seat_number=v_source.seat_number;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'tournament move lost its locked roster row'
        USING ERRCODE='40001';
    END IF;

    UPDATE public.tables tb
       SET current_players=(
         SELECT count(*) FROM public.table_seats s
          WHERE s.table_id=tb.id AND s.left_at IS NULL),
           updated_at=now()
     WHERE tb.id IN (p_source_table_id,p_destination_table_id);

    IF (SELECT count(*) FROM public.table_seats s
        JOIN public.tables tb ON tb.id=s.table_id
       WHERE tb.tournament_id=p_tournament_id
         AND s.user_id=p_user_id AND s.left_at IS NULL)<>1
       OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_destination_id
            AND s.table_id=p_destination_table_id
            AND s.seat_number=p_destination_seat_number
            AND s.user_id=p_user_id AND s.left_at IS NULL
            AND s.stack=v_source.stack)
       OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_source.id AND s.left_at=v_moved_at AND s.stack=0)
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.id=v_tp.id AND tp.status='playing'
            AND tp.table_id=p_destination_table_id
            AND tp.seat_number=p_destination_seat_number) THEN
      RAISE EXCEPTION 'tournament move final proof is not exact'
        USING ERRCODE='P0404';
    END IF;

    INSERT INTO public.tournament_seat_move_receipts(
      request_id,tournament_id,user_id,source_table_id,destination_table_id,
      source_seat_id,destination_seat_id,source_seat_number,
      destination_seat_number,source_mode,stack,moved_at)
    VALUES(
      p_request_id,p_tournament_id,p_user_id,p_source_table_id,
      p_destination_table_id,v_source.id,v_destination_id,
      v_source.seat_number,p_destination_seat_number,p_source_mode,
      v_source.stack,v_moved_at);

    -- HOTFIX EDIT (a): the consuming guard trigger is not installed; rows are deleted, not counted.
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'tournament move receipt did not persist'
      USING ERRCODE='P0404';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',false);
END;
$atomic_tournament_move$;

REVOKE ALL ON FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid,text) TO service_role;

-- ===== 20260909182952 L36-131 =====
CREATE OR REPLACE FUNCTION public.fn_resolve_committed_tournament_seat_move(
  p_request_id uuid,
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_destination_table_id uuid,
  p_destination_seat_number integer,
  p_source_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $committed_move_receipt$
DECLARE
  v_actor text:=NULLIF(current_setting('app.smarter_data_actor',true),'');
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'committed tournament move receipt requires ordinary service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL OR p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_source_table_id=p_destination_table_id
     OR p_destination_seat_number NOT BETWEEN 1 AND 10
     OR p_source_mode NOT IN ('live_source','closed_orphan') THEN
    RAISE EXCEPTION 'invalid committed tournament move receipt identity'
      USING ERRCODE='22023';
  END IF;

  -- The writer takes this lock before its first receipt read and holds it
  -- through commit. Waiting here makes a receipt read observe any writer that
  -- already owns the settlement boundary. An absent receipt is deliberately
  -- not converted into proof that no write can still begin later.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;
  IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
     OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
     OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
     OR (v_result->>'destination_table_id')::uuid
          IS DISTINCT FROM p_destination_table_id
     OR (v_result->>'destination_seat_number')::integer
          IS DISTINCT FROM p_destination_seat_number
     OR v_result->>'source_mode' IS DISTINCT FROM p_source_mode THEN
    RAISE EXCEPTION 'tournament move request id belongs to another operation'
      USING ERRCODE='23505';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',true);
END;
$committed_move_receipt$;

REVOKE ALL ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) TO service_role;

COMMENT ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) IS 'Service-only exact lookup for a committed immutable tournament seat-move receipt after a manager response becomes ambiguous. It performs no tournament mutation.';

DO $verify$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid='public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'::regprocedure;
  IF v_source NOT LIKE '%app.smarter_data_actor%'
     OR v_source NOT LIKE '%auth.role() IS DISTINCT FROM ''service_role''%'
     OR v_source NOT LIKE '%ca:tournament-terminal-settlement:v1%'
     OR v_source NOT LIKE '%fn_ca_tournament_seat_move_receipt(p_request_id)%'
     OR v_source NOT LIKE '%RETURN NULL%'
     OR v_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M'
     OR has_function_privilege('anon',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE')
     OR NOT has_function_privilege('service_role',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE') THEN
    RAISE EXCEPTION 'committed tournament move receipt resolver verification failed';
  END IF;
END;
$verify$;

DO $postcondition$
DECLARE
  v_move text;
BEGIN
  IF to_regclass('public.tournament_seat_move_receipts') IS NULL
     OR to_regclass('public.tournament_seat_exit_authorizations') IS NULL
     OR to_regprocedure('public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)') IS NULL
     OR to_regprocedure('public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)') IS NULL
     OR to_regprocedure('public.fn_ca_tournament_seat_move_receipt(uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'seat-move door hotfix postcondition failed: an object is missing';
  END IF;

  SELECT p.prosrc INTO v_move FROM pg_proc p
   WHERE p.oid = 'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'::regprocedure;
  IF v_move NOT LIKE '%fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)%'
     OR v_move LIKE '%hashtextextended(''ca:tournament-terminal-settlement:v1'',0)%'
     OR v_move NOT LIKE '%fn_ca_close_tournament_seat_exit_authority(v_token,false);%'
     OR v_move LIKE '%fn_ca_close_tournament_seat_exit_authority(v_token,true)%' THEN
    RAISE EXCEPTION 'seat-move door hotfix postcondition failed: the two HOTFIX EDITs are not both present';
  END IF;

  -- The enforcing guard must NOT have come along.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zy_tournament_live_seat_exit_requires_authority') THEN
    RAISE EXCEPTION 'seat-move door hotfix postcondition failed: the seat-exit guard trigger must not be installed by this migration';
  END IF;

  IF has_function_privilege('anon', 'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'seat-move door hotfix postcondition failed: fn_move_tournament_player grants are wrong';
  END IF;
END;
$postcondition$;
