\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END;
$roles$;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE
AS $function$
  SELECT NULLIF(current_setting('request.jwt.claim.role',true),'')
$function$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  variant text,
  tournament_type text,
  game_type text,
  max_players integer,
  table_size integer,
  starting_chips numeric NOT NULL
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  status text NOT NULL,
  max_players integer NOT NULL,
  current_players integer NOT NULL DEFAULT 0,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  status text NOT NULL,
  chips integer NOT NULL,
  table_id uuid,
  seat_number integer,
  UNIQUE (tournament_id,user_id)
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  user_id uuid NOT NULL,
  seat_number integer NOT NULL,
  stack numeric NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at timestamptz,
  UNIQUE (table_id,seat_number)
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_number bigint NOT NULL UNIQUE,
  hand_id uuid NOT NULL UNIQUE,
  stack_result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  post_commit_completed_at timestamptz,
  post_commit_result jsonb,
  PRIMARY KEY (table_id,hand_number)
);

CREATE TABLE public.settlement_idempotency_keys (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  hand_id uuid NOT NULL,
  status text NOT NULL,
  result jsonb,
  completed_at timestamptz,
  PRIMARY KEY (table_id,hand_id)
);

CREATE FUNCTION public.fn_caller_is_engine()
RETURNS boolean LANGUAGE sql STABLE
AS $function$
  SELECT COALESCE(NULLIF(current_setting('test.engine',true),''),'false')::boolean
$function$;

CREATE FUNCTION public.fn_entry_purchases_frozen()
RETURNS boolean LANGUAGE sql STABLE
AS $function$ SELECT false $function$;

CREATE FUNCTION public.fn_ca_lock_tournament_seat_acquisition(
  p_tournament_id uuid,p_table_id uuid,p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_status text;
BEGIN
  SELECT upper(status) INTO v_status FROM public.tournaments
   WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_seatable');
  END IF;
  RETURN jsonb_build_object('ok',true,'tournament_id',p_tournament_id);
END;
$function$;

CREATE FUNCTION public.fn_ca_tournament_seat_cap(p_tournament_id uuid)
RETURNS integer LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT CASE
    WHEN lower(COALESCE(variant,''))='spin'
      OR upper(COALESCE(tournament_type,''))='SPIN' THEN 3
    WHEN COALESCE(max_players,0)<=2 THEN 2
    ELSE LEAST(COALESCE(NULLIF(table_size,0),9),10)
  END FROM public.tournaments WHERE id=p_tournament_id
$function$;

CREATE FUNCTION public.fn_ensure_late_registration_capacity(
  p_tournament_id uuid,p_required_seats integer
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$ SELECT jsonb_build_object('ok',true) $function$;

CREATE FUNCTION public.fn_ca_choose_tournament_seat_locked(
  p_tournament_id uuid,
  p_user_id uuid,
  p_preferred_table_id uuid DEFAULT NULL,
  p_preferred_seat_number integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_capacity jsonb;
  v_table_id uuid;
  v_cap integer;
  v_seat_number integer;
BEGIN
  v_capacity:=public.fn_ensure_late_registration_capacity(p_tournament_id,0);
  v_cap:=public.fn_ca_tournament_seat_cap(p_tournament_id);
  SELECT tb.id INTO v_table_id
    FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id
     AND NOT COALESCE(tb.is_deleted,false)
     AND lower(tb.status) IN ('waiting','running','active')
     AND EXISTS (
       SELECT 1 FROM generate_series(1,LEAST(v_cap,tb.max_players)) legal(n)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.table_seats occupied
           WHERE occupied.table_id=tb.id AND occupied.seat_number=legal.n
             AND occupied.left_at IS NULL))
   ORDER BY (tb.id=p_preferred_table_id) DESC,tb.created_at,tb.id
   LIMIT 1
   FOR UPDATE OF tb;
  IF v_table_id IS NULL THEN
    RAISE EXCEPTION 'no legal tournament chair' USING ERRCODE='55000';
  END IF;
  IF v_table_id=p_preferred_table_id
     AND p_preferred_seat_number BETWEEN 1 AND v_cap
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats occupied
        WHERE occupied.table_id=v_table_id
          AND occupied.seat_number=p_preferred_seat_number
          AND occupied.left_at IS NULL) THEN
    v_seat_number:=p_preferred_seat_number;
  ELSE
    SELECT legal.n INTO v_seat_number
      FROM generate_series(1,v_cap) legal(n)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.table_seats occupied
        WHERE occupied.table_id=v_table_id AND occupied.seat_number=legal.n
          AND occupied.left_at IS NULL)
     ORDER BY legal.n LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'table_id',v_table_id,'seat_number',v_seat_number,
    'capacity',v_capacity);
END;
$function$;

CREATE FUNCTION public.fn_ca_assign_tournament_player_seat_locked(
  p_tournament_id uuid,p_user_id uuid,p_table_id uuid,p_seat_number integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_player public.tournament_players%ROWTYPE;
  v_seat public.table_seats%ROWTYPE;
  v_stack numeric;
  v_count integer;
  v_assigned_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO STRICT v_player FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id FOR UPDATE;
  SELECT s.* INTO v_seat FROM public.table_seats s
   JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
     AND s.left_at IS NULL FOR UPDATE OF s;
  IF FOUND THEN
    SELECT count(*)::integer INTO v_count FROM public.table_seats
     WHERE table_id=v_seat.table_id AND left_at IS NULL;
    RETURN jsonb_build_object(
      'ok',true,'replayed',true,'tournament_id',p_tournament_id,
      'user_id',p_user_id,'table_id',v_seat.table_id,'seat_id',v_seat.id,
      'seat_number',v_seat.seat_number,'stack',v_seat.stack,
      'current_players',v_count,'assigned_at',v_seat.joined_at);
  END IF;
  v_stack:=CASE WHEN v_player.status='registered'
                THEN (SELECT starting_chips FROM public.tournaments
                       WHERE id=p_tournament_id)
                ELSE v_player.chips END;
  PERFORM set_config('app.money_path','fn_assign_tournament_player_seat_atomic',true);
  INSERT INTO public.table_seats(table_id,user_id,seat_number,stack,joined_at,left_at)
  VALUES(p_table_id,p_user_id,p_seat_number,v_stack,v_assigned_at,NULL)
  ON CONFLICT (table_id,seat_number) DO UPDATE
    SET user_id=EXCLUDED.user_id,stack=EXCLUDED.stack,
        joined_at=EXCLUDED.joined_at,left_at=NULL
    WHERE table_seats.left_at IS NOT NULL
  RETURNING * INTO STRICT v_seat;
  UPDATE public.tournament_players
     SET status='playing',chips=v_stack::integer,
         table_id=p_table_id,seat_number=p_seat_number
   WHERE id=v_player.id;
  SELECT count(*)::integer INTO v_count FROM public.table_seats
   WHERE table_id=p_table_id AND left_at IS NULL;
  UPDATE public.tables SET current_players=v_count WHERE id=p_table_id;
  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'tournament_id',p_tournament_id,
    'user_id',p_user_id,'table_id',p_table_id,'seat_id',v_seat.id,
    'seat_number',p_seat_number,'stack',v_stack,
    'current_players',v_count,'assigned_at',v_assigned_at);
END;
$function$;

CREATE FUNCTION public.fn_ca_guard_seat_creation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$ BEGIN RETURN NEW; END $function$;

CREATE TRIGGER trg_ca_guard_seat_creation
BEFORE INSERT OR UPDATE ON public.table_seats
FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_seat_creation();

REVOKE ALL ON FUNCTION public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_seat_cap(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ensure_late_registration_capacity(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_guard_seat_creation()
  FROM PUBLIC,anon,authenticated,service_role;
