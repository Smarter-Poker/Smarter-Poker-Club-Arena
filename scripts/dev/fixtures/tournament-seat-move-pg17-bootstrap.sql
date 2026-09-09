\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.digest(bytea, text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$ SELECT public.digest($1, $2) $function$;

CREATE SCHEMA realtime;
CREATE TABLE realtime.subscription (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
);

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END;
$roles$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  status text NOT NULL
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid REFERENCES public.tournaments(id),
  status text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  lifecycle text,
  max_players integer NOT NULL DEFAULT 9,
  current_players integer NOT NULL DEFAULT 0
);

CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  status text NOT NULL,
  table_id uuid REFERENCES public.tables(id),
  seat_number integer,
  chips integer,
  UNIQUE (tournament_id, user_id)
);

CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id),
  seat_number integer NOT NULL CHECK (seat_number BETWEEN 1 AND 10),
  user_id uuid,
  member_id uuid,
  stack numeric(15,2),
  is_sitting_out boolean DEFAULT false,
  is_away boolean DEFAULT false,
  joined_at timestamptz DEFAULT clock_timestamp(),
  horse_id uuid,
  left_at timestamptz,
  status text DEFAULT 'active',
  leave_pending boolean DEFAULT false,
  auto_rebuy boolean DEFAULT false,
  time_bank_remaining integer DEFAULT 30,
  time_bank_uses_remaining integer DEFAULT 4,
  club_id uuid,
  sit_out_at timestamptz,
  entry_hold text,
  entry_post_agreed boolean NOT NULL DEFAULT false,
  UNIQUE (table_id, seat_number)
);

CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT current_setting('probe.platform_frozen', true) = 'on'
$function$;

CREATE OR REPLACE FUNCTION public.fn_assert_tournament_manager_write_scope(
  p_tournament_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tournament_id uuid;
  v_generation uuid;
BEGIN
  BEGIN
    v_tournament_id := NULLIF(
      current_setting('app.smarter_tournament_id', true), ''
    )::uuid;
    v_generation := NULLIF(
      current_setting('app.smarter_tournament_lease_generation', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'malformed authority' USING ERRCODE = '22023';
  END;
  IF current_setting('app.smarter_data_actor', true)
       IS DISTINCT FROM 'tournament-manager'
     OR current_setting('app.smarter_manager_request_fenced', true)
          IS DISTINCT FROM 'protocol-2'
     OR v_generation IS NULL
     OR v_tournament_id IS DISTINCT FROM p_tournament_id THEN
    RAISE EXCEPTION 'manager authority required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_lock_tournament_launch_proof_parents(
  p_tournament_ids uuid[]
) RETURNS TABLE (
  tournament_id uuid,
  parent_status text,
  launch_id uuid,
  launch_lease_generation uuid,
  launch_completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM t.id FROM public.tournaments t
   WHERE t.id = ANY(p_tournament_ids)
   ORDER BY t.id FOR UPDATE;
  RETURN QUERY
    SELECT t.id, t.status, NULL::uuid, NULL::uuid, clock_timestamp()
      FROM public.tournaments t
     WHERE t.id = ANY(p_tournament_ids)
     ORDER BY t.id;
END;
$function$;

/* Adversarial rollback switch used only by the isolated probe database. */
CREATE OR REPLACE FUNCTION public.probe_reject_destination()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('probe.reject_destination', true) = 'on'
     AND NEW.table_id = '20000000-0000-4000-8000-000000000002'::uuid
     AND NEW.left_at IS NULL THEN
    RAISE EXCEPTION 'probe destination refused';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER z_probe_reject_destination
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.probe_reject_destination();
