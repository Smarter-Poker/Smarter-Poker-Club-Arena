-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828184254; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_clone_table_row(p_source_id uuid, p_name text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row jsonb;
  v_new uuid := gen_random_uuid();
BEGIN
  SELECT to_jsonb(t) INTO v_row FROM public.tables t WHERE t.id = p_source_id LIMIT 1;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'TABLE_NOT_FOUND: %', p_source_id;
  END IF;

  -- Identity and live state are the ONLY things that do not carry over.
  v_row := v_row || jsonb_build_object(
    'id',              v_new,
    'is_template',     false,
    'status',          'waiting',
    'current_players', 0,
    'hands_dealt',     0,
    'avg_pot',         0,
    'live_state',      NULL,
    'is_deleted',      false,
    'created_at',      now(),
    'updated_at',      now(),
    -- BOMB POT LIVE STATE (2026-08-28). Engine-written, per-table, and NOT
    -- part of the template: a clone that inherited these would deal a bomb
    -- pot it never earned. The bomb CONFIG columns are untouched on purpose.
    'bomb_pot_sched_state',    NULL,
    'bomb_pot_next_due_at',    NULL,
    'bomb_pot_manual_pending', false
  );
  IF p_name IS NOT NULL THEN
    v_row := v_row || jsonb_build_object('name', p_name);
  END IF;

  INSERT INTO public.tables
  SELECT * FROM jsonb_populate_record(NULL::public.tables, v_row);

  RETURN v_new;
END;
$function$;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'fn_clone_table_row' AND n.nspname = 'public';

  IF v_def NOT LIKE '%bomb_pot_sched_state%'
     OR v_def NOT LIKE '%bomb_pot_next_due_at%'
     OR v_def NOT LIKE '%bomb_pot_manual_pending%' THEN
    RAISE EXCEPTION 'assertion failed: clone does not reset the bomb live-state columns';
  END IF;

  IF v_def LIKE '%''bomb_pot_board_count''%' OR v_def LIKE '%''bomb_pot_trigger_mode''%' THEN
    RAISE EXCEPTION 'assertion failed: clone is resetting bomb CONFIG, which must travel with a template';
  END IF;
END $$;
