-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831115313; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $mig$
DECLARE
  v_src      text;
  v_old_expr text := 'CASE WHEN COALESCE(p_config->>''type'', ''mtt'') = ''sng'' THEN 0.05 ELSE 0.1 END';
  v_new_expr text := 'CASE WHEN COALESCE((p_config->>''maxPlayers'')::int, 0) BETWEEN 1 AND 2 THEN 0.05 ELSE 0.1 END';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_create_tournament'
     AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_config jsonb';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_create_tournament(uuid, jsonb) not found - nothing to rewrite';
  END IF;

  IF (length(v_src) - length(replace(v_src, v_old_expr, ''))) / length(v_old_expr) <> 1 THEN
    RAISE EXCEPTION
      'fn_create_tournament no longer contains the label-keyed fee expression exactly once; it has changed since this migration was written. Re-read it before rewriting.';
  END IF;

  EXECUTE replace(v_src, v_old_expr, v_new_expr);
END
$mig$;

DO $verify$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_create_tournament'
     AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_config jsonb';

  IF v_src NOT LIKE '%BETWEEN 1 AND 2 THEN 0.05 ELSE 0.1 END%' THEN
    RAISE EXCEPTION 'the seat-keyed fee expression is not present after the rewrite';
  END IF;

  IF v_src LIKE '%= ''sng'' THEN 0.05%' THEN
    RAISE EXCEPTION 'the label-keyed fee expression survived the rewrite';
  END IF;
END
$verify$;
