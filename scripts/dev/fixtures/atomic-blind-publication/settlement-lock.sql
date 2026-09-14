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
$function$
