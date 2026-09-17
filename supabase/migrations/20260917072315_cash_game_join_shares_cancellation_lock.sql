-- Join and cancellation serialize before either reads the admission.
-- A concurrent cancellation used to retire a hold after join had read it;
-- join then refreshed that retired row and returned a nonexistent offer.
-- Change only the reviewed join's first game read. Keep its ACL and rules.
-- NO KEY UPDATE conflicts with cancellation/planning but permits the roster's
-- foreign-key read while a buy-in already holds the table-capacity lock.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure);
  v_before constant text := 'SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;';
  v_after constant text := 'SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR NO KEY UPDATE;';
  v_baseline constant text := '1b9173dde43a3e6d4e887843deeaa9e7';
BEGIN
  IF position(v_after IN v_definition) > 0
     AND md5(replace(v_definition, v_after, v_before)) = v_baseline THEN
    RETURN;
  END IF;
  IF md5(v_definition) <> v_baseline
     OR (length(v_definition) - length(replace(v_definition, v_before, ''))) <> length(v_before) THEN
    RAISE EXCEPTION 'Unreviewed cash game join baseline';
  END IF;
  EXECUTE replace(v_definition, v_before, v_after);
  IF pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure)
       <> replace(v_definition, v_before, v_after) THEN
    RAISE EXCEPTION 'Cash game join lock correction was not installed exactly';
  END IF;
END;
$migration$;
COMMIT;
