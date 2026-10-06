CREATE FUNCTION public.fixture_expect_browser_update_denied(
  p_relation text,
  p_id uuid,
  p_close boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $assertion$
BEGIN
  IF p_relation = 'tables' THEN
    IF p_close THEN
      UPDATE public.tables SET status = 'closed' WHERE id = p_id;
    ELSE
      UPDATE public.tables SET name = 'browser bypass' WHERE id = p_id;
    END IF;
  ELSE
    UPDATE public.tournaments SET name = 'browser bypass' WHERE id = p_id;
  END IF;
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END;
$assertion$;

GRANT EXECUTE ON FUNCTION public.fixture_expect_browser_update_denied(
  text, uuid, boolean
) TO authenticated;

INSERT INTO public.tables(id, name, status) VALUES
  ('10000000-0000-0000-0000-000000000001', 'empty table', 'open'),
  ('10000000-0000-0000-0000-000000000002', 'occupied table', 'open');
INSERT INTO public.tournaments(id, name, status) VALUES
  ('20000000-0000-0000-0000-000000000001', 'empty tournament', 'SCHEDULED'),
  ('20000000-0000-0000-0000-000000000002', 'registered tournament', 'SCHEDULED');
INSERT INTO public.table_seats(table_id, left_at) VALUES
  ('10000000-0000-0000-0000-000000000002', NULL);
INSERT INTO public.tournament_players(tournament_id) VALUES
  ('20000000-0000-0000-0000-000000000002');

SET ROLE authenticated;

DO $browser_denials$
BEGIN
  IF NOT public.fixture_expect_browser_update_denied(
    'tables', '10000000-0000-0000-0000-000000000001', false
  ) THEN
    RAISE EXCEPTION 'authenticated direct table update was not denied';
  END IF;
  IF NOT public.fixture_expect_browser_update_denied(
    'tables', '10000000-0000-0000-0000-000000000001', true
  ) THEN
    RAISE EXCEPTION 'authenticated direct empty-table close was not denied';
  END IF;
  IF NOT public.fixture_expect_browser_update_denied(
    'tournaments', '20000000-0000-0000-0000-000000000001', false
  ) THEN
    RAISE EXCEPTION 'authenticated direct tournament update was not denied';
  END IF;
END;
$browser_denials$;

DO $gateway_proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_execute_managed_game_command(
    '30000000-0000-0000-0000-000000000001',
    'table',
    '10000000-0000-0000-0000-000000000001',
    'close',
    1,
    '{}'::jsonb
  );
  IF v_result ->> 'ok' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'supported command did not close the empty table: %', v_result;
  END IF;
END;
$gateway_proof$;

RESET ROLE;

DO $receipt_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.managed_game_command_receipts
     WHERE command_id = '30000000-0000-0000-0000-000000000001'
       AND result ->> 'ok' = 'true'
  ) THEN
    RAISE EXCEPTION 'supported command did not persist its receipt';
  END IF;
END;
$receipt_proof$;

SET ROLE authenticated;

DO $occupied_and_registered_guards$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_execute_managed_game_command(
    '30000000-0000-0000-0000-000000000002',
    'table',
    '10000000-0000-0000-0000-000000000002',
    'close',
    1,
    '{}'::jsonb
  );
  IF v_result ->> 'reason' IS DISTINCT FROM 'players_seated' THEN
    RAISE EXCEPTION 'occupied table guard failed: %', v_result;
  END IF;

  v_result := public.fn_execute_managed_game_command(
    '30000000-0000-0000-0000-000000000003',
    'tournament',
    '20000000-0000-0000-0000-000000000002',
    'update',
    1,
    '{"name":"forbidden edit"}'::jsonb
  );
  IF v_result ->> 'reason' IS DISTINCT FROM 'players_registered' THEN
    RAISE EXCEPTION 'registered tournament guard failed: %', v_result;
  END IF;
END;
$occupied_and_registered_guards$;

RESET ROLE;

SET ROLE service_role;
UPDATE public.tables
   SET name = 'engine write retained'
 WHERE id = '10000000-0000-0000-0000-000000000002';
RESET ROLE;

DO $final_state$
BEGIN
  IF (SELECT status FROM public.tables
       WHERE id = '10000000-0000-0000-0000-000000000001') <> 'closed' THEN
    RAISE EXCEPTION 'supported empty-table close did not commit';
  END IF;
  IF (SELECT status FROM public.tables
       WHERE id = '10000000-0000-0000-0000-000000000002') <> 'open' THEN
    RAISE EXCEPTION 'occupied table was closed';
  END IF;
  IF (SELECT name FROM public.tournaments
       WHERE id = '20000000-0000-0000-0000-000000000002') <> 'registered tournament' THEN
    RAISE EXCEPTION 'registered tournament was modified';
  END IF;
  IF (SELECT name FROM public.tables
       WHERE id = '10000000-0000-0000-0000-000000000002') <> 'engine write retained' THEN
    RAISE EXCEPTION 'service_role update was not retained';
  END IF;
END;
$final_state$;

SELECT 'PASS managed game one-door native PostgreSQL regression' AS result;

