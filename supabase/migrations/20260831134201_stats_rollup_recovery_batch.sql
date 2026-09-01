-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831134201; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- proved that was still too large for the management/API request boundary: a
-- five-hour backlog timed out before checkpointing. Three thousand is twice a
-- normal 15-minute interval and lets a missed window drain progressively.

BEGIN;

DO $resize$
DECLARE v_source text;
BEGIN
  SELECT pg_get_functiondef('public.ca_roll_hand_stats_forward()'::regprocedure) INTO v_source;
  IF position('v_max_hands constant int := 15000;' IN v_source) = 0 THEN
    RAISE EXCEPTION 'unexpected stat-rollup batch declaration; refusing blind resize';
  END IF;
  v_source := replace(
    v_source,
    'v_max_hands constant int := 15000;',
    'v_max_hands constant int := 3000;'
  );
  EXECUTE v_source;

  SELECT pg_get_functiondef('public.ca_refresh_hand_player_index(integer)'::regprocedure)
  INTO v_source;
  IF position(
    'v_limit int := least(greatest(coalesce(p_max_hands, 50000), 1), 100000);'
    IN v_source
  ) = 0 THEN
    RAISE EXCEPTION 'unexpected hand-index batch declaration; refusing blind resize';
  END IF;
  v_source := replace(
    v_source,
    'v_limit int := least(greatest(coalesce(p_max_hands, 50000), 1), 100000);',
    'v_limit int := least(greatest(coalesce(p_max_hands, 3000), 1), 3000);'
  );
  EXECUTE v_source;
END;
$resize$;

DO $assert$
BEGIN
  IF position(
    'v_max_hands constant int := 3000;'
    IN pg_get_functiondef('public.ca_roll_hand_stats_forward()'::regprocedure)
  ) = 0 THEN
    RAISE EXCEPTION 'stat rollup is not capped at the recovery batch';
  END IF;
  IF position(
    'v_limit int := least(greatest(coalesce(p_max_hands, 3000), 1), 3000);'
    IN pg_get_functiondef('public.ca_refresh_hand_player_index(integer)'::regprocedure)
  ) = 0 THEN
    RAISE EXCEPTION 'hand index is not capped at the recovery batch';
  END IF;
END;
$assert$;


