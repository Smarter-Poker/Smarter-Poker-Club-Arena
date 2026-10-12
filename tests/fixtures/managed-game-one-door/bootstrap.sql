CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open'
);

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED'
);

CREATE TABLE public.table_seats (
  table_id uuid NOT NULL REFERENCES public.tables(id),
  left_at timestamptz
);

CREATE TABLE public.tournament_players (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id)
);

CREATE TABLE public.managed_game_command_receipts (
  command_id uuid PRIMARY KEY,
  game_kind text NOT NULL,
  game_id uuid NOT NULL,
  result jsonb NOT NULL
);

ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournaments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Club admins can update tables"
  ON public.tables FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY tables_update
  ON public.tables FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY tournaments_update_fixture
  ON public.tournaments FOR UPDATE USING (true) WITH CHECK (true);

GRANT SELECT, UPDATE ON public.tables, public.tournaments
  TO anon, authenticated, service_role;
GRANT SELECT ON public.table_seats, public.tournament_players
  TO authenticated, service_role;
GRANT SELECT, INSERT ON public.managed_game_command_receipts TO service_role;

CREATE FUNCTION public.fixture_managed_game_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fixture_guard$
BEGIN
  IF TG_TABLE_NAME = 'tables'
     AND lower(NEW.status) = 'closed'
     AND lower(OLD.status) <> 'closed'
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = NEW.id AND s.left_at IS NULL
     ) THEN
    RAISE EXCEPTION 'players_seated' USING ERRCODE = 'P0001';
  END IF;

  IF TG_TABLE_NAME = 'tournaments'
     AND EXISTS (
       SELECT 1 FROM public.tournament_players p
        WHERE p.tournament_id = NEW.id
     )
     AND (
       NEW.name IS DISTINCT FROM OLD.name
       OR upper(NEW.status) IN ('CANCELLED', 'CANCELED')
     ) THEN
    RAISE EXCEPTION 'players_registered' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$fixture_guard$;

CREATE TRIGGER fixture_table_guard
BEFORE UPDATE ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fixture_managed_game_guard();

CREATE TRIGGER fixture_tournament_guard
BEFORE UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fixture_managed_game_guard();

CREATE FUNCTION public.fn_execute_managed_game_command(
  p_command_id uuid,
  p_kind text,
  p_game_id uuid,
  p_action text,
  p_expected_version integer,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fixture_gateway$
DECLARE
  v_result jsonb;
BEGIN
  IF p_action = 'close' AND p_kind = 'table' THEN
    BEGIN
      UPDATE public.tables SET status = 'closed' WHERE id = p_game_id;
      v_result := jsonb_build_object('ok', true, 'reason', null);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'players_seated');
    END;
  ELSIF p_action = 'update' AND p_kind = 'tournament' THEN
    BEGIN
      UPDATE public.tournaments
         SET name = p_payload ->> 'name'
       WHERE id = p_game_id;
      v_result := jsonb_build_object('ok', true, 'reason', null);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'players_registered');
    END;
  ELSE
    v_result := jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  INSERT INTO public.managed_game_command_receipts(
    command_id, game_kind, game_id, result
  ) VALUES (p_command_id, p_kind, p_game_id, v_result);
  RETURN v_result;
END;
$fixture_gateway$;

REVOKE ALL ON FUNCTION public.fn_execute_managed_game_command(
  uuid, text, uuid, text, integer, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_execute_managed_game_command(
  uuid, text, uuid, text, integer, jsonb
) TO authenticated, service_role;

