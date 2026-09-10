\set ON_ERROR_STOP on

CREATE SCHEMA realtime;
CREATE TABLE realtime.subscription (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
);

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
CREATE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  current_players integer NOT NULL DEFAULT 0
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  status text NOT NULL,
  table_id uuid REFERENCES public.tables(id),
  seat_number integer,
  chips numeric NOT NULL DEFAULT 1
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES public.tables(id),
  user_id uuid NOT NULL,
  seat_number integer NOT NULL,
  stack numeric NOT NULL DEFAULT 1,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at timestamptz
);

CREATE TABLE public.tournament_seat_exit_authorizations (
  token uuid NOT NULL,
  seat_id uuid NOT NULL,
  operation text NOT NULL,
  PRIMARY KEY(token,seat_id)
);

CREATE TABLE public.tournament_seat_move_receipts (
  request_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  source_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  destination_table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  source_seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  destination_seat_id uuid NOT NULL REFERENCES public.table_seats(id) ON DELETE RESTRICT,
  source_seat_number integer NOT NULL CHECK(source_seat_number BETWEEN 1 AND 10),
  destination_seat_number integer NOT NULL CHECK(destination_seat_number BETWEEN 1 AND 10),
  source_mode text NOT NULL CHECK(source_mode IN ('live_source','closed_orphan')),
  stack numeric NOT NULL CHECK(
    stack::text NOT IN ('NaN','Infinity','-Infinity') AND stack>0),
  moved_at timestamptz NOT NULL,
  CHECK(source_table_id<>destination_table_id),
  CHECK(source_seat_id<>destination_seat_id),
  UNIQUE(tournament_id,user_id,request_id)
);

ALTER TABLE public.tournament_seat_move_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_seat_move_receipts
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_tournament_seat_move_receipts_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $immutable$
BEGIN
  RAISE EXCEPTION 'tournament seat move receipts are append-only'
    USING ERRCODE='55000';
END;
$immutable$;
REVOKE ALL ON FUNCTION public.fn_tournament_seat_move_receipts_append_only()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER tournament_seat_move_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_seat_move_receipts
  FOR EACH ROW EXECUTE FUNCTION
    public.fn_tournament_seat_move_receipts_append_only();

CREATE FUNCTION public.fn_caller_is_engine()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

CREATE FUNCTION public.fn_ca_open_tournament_seat_exit_authority(
  uuid,text,uuid DEFAULT NULL
) RETURNS uuid LANGUAGE sql SECURITY DEFINER
AS $$ SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid $$;

CREATE FUNCTION public.fn_ca_close_tournament_seat_exit_authority(
  uuid,boolean
) RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 0 $$;

CREATE FUNCTION public.fn_ca_tournament_seat_move_receipt(p_request_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $receipt$
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
  WHERE r.request_id=p_request_id
$receipt$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_seat_move_receipt(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_move_tournament_player(
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_destination_table_id uuid,
  p_destination_seat_number integer,
  p_request_id uuid,
  p_source_mode text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $writer$
DECLARE
  v_source public.table_seats%ROWTYPE;
  v_tp public.tournament_players%ROWTYPE;
  v_result jsonb;
  v_token uuid;
  v_moved_at timestamptz:=clock_timestamp();
  v_live_count integer;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_move_tournament_player requires service authority';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('table_cap:'||p_user_id::text,0));
  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  SELECT count(*) INTO v_live_count
    FROM public.table_seats s
   WHERE s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_count<>1 THEN
    RAISE EXCEPTION 'tournament move requires exactly one live source seat';
  END IF;
  SELECT * INTO STRICT v_source FROM public.table_seats s
   WHERE s.table_id=p_source_table_id AND s.user_id=p_user_id
     AND s.left_at IS NULL;
  SELECT * INTO STRICT v_tp FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
  IF abs(v_source.stack-v_tp.chips::numeric)>0.5 THEN
    RAISE EXCEPTION 'tournament move source chips or coordinates are not exact';
  END IF;
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'move',p_user_id);
  UPDATE public.table_seats
     SET stack=0,left_at=v_moved_at
   WHERE id=v_source.id;
  UPDATE public.tournament_players
     SET table_id=p_destination_table_id,
         seat_number=p_destination_seat_number
   WHERE id=v_tp.id;
  UPDATE public.tables
     SET current_players=(
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id=public.tables.id AND s.left_at IS NULL)
   WHERE id IN(p_source_table_id,p_destination_table_id);
  INSERT INTO public.tournament_seat_move_receipts(
    request_id,tournament_id,user_id,source_table_id,destination_table_id,
    source_seat_id,destination_seat_id,source_seat_number,
    destination_seat_number,source_mode,stack,moved_at)
  VALUES(
    p_request_id,p_tournament_id,p_user_id,p_source_table_id,
    p_destination_table_id,v_source.id,gen_random_uuid(),
    v_source.seat_number,p_destination_seat_number,p_source_mode,
    v_source.stack,v_moved_at);
  PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,true);
  RETURN v_result;
END;
$writer$;

REVOKE ALL ON FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid,text)
  TO service_role;

CREATE FUNCTION public.fn_resolve_committed_tournament_seat_move(
  p_request_id uuid,
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_destination_table_id uuid,
  p_destination_seat_number integer,
  p_source_mode text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $resolver$
DECLARE
  v_actor text:=NULLIF(current_setting('app.smarter_data_actor',true),'');
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'ordinary service authority required';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN RETURN NULL; END IF;
  RETURN v_result||jsonb_build_object('replayed',true);
END;
$resolver$;

REVOKE ALL ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text)
  TO service_role;

CREATE FUNCTION public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid
) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

CREATE FUNCTION public.fn_move_tournament_player_atomic(
  uuid,uuid,uuid,uuid,integer,uuid,timestamptz,integer,uuid,integer
) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

CREATE FUNCTION public.fn_move_tournament_player_atomic(
  uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer
) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
