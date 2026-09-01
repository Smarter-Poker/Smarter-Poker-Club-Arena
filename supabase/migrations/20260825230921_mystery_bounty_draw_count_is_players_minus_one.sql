-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825230921; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $migrate$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_mystery_bounty_seed'
     AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid, p_players_remaining integer, p_chests jsonb';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_mystery_bounty_seed(uuid,integer,jsonb) not found - refusing to guess';
  END IF;

  v_new := replace(
    v_def,
    'IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining, 0) THEN',
    'IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining - 1, 0) THEN'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'chest-count check not found in fn_mystery_bounty_seed - refusing to patch blind';
  END IF;

  EXECUTE v_new;
END
$migrate$;

DO $verify$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_mystery_bounty_seed';

  IF position('GREATEST(p_players_remaining - 1, 0)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'patch did not take: chest count is not players-minus-one';
  END IF;
  IF position('mystery_bounty_activated_players = p_players_remaining' IN v_def) = 0 THEN
    RAISE EXCEPTION 'activated_players must still record the PLAYER count';
  END IF;
END
$verify$;
