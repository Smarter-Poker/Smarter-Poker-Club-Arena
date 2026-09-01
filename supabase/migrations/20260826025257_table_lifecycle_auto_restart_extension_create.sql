-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826025257; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE THREE LIFECYCLE TOGGLES
-- ───────────────────────────────────────────────────────────────────────────
-- Auto Restart, Auto Extension and Auto Create Table are three switches on the
-- table creation page with three tooltips and ZERO readers. `auto_restart` is
-- worse than dead: TableService.createTable hardcodes it to true while
-- TableConfigPage defaults it to false, so two writers disagree about a flag
-- nothing consumes.
--
-- Each one is given the meaning its tooltip already promises, anchored to
-- behaviour that already exists rather than invented:
--
--   AUTO RESTART      GameServer's boot comment is the anchor: "CLOSED IS A
--                     DECISION, NOT A STATE TO CLEAN UP ... The fleet still
--                     reopens the tables it OWNS." A host's table, once
--                     closed, stays closed forever. auto_restart is the host
--                     saying "reopen mine too."
--
--   AUTO EXTENSION    "Extend table automatically" -- extend its LIFE. An
--                     empty table is retired by HorseFleetManager; this
--                     exempts it, so it stays open for business instead of
--                     being closed for being quiet. Enforced on the TypeScript
--                     side, where the retirement is; the view below is what
--                     that query reads.
--
--   AUTO CREATE TABLE "Create new table when full" -- the overflow spawn the
--                     fleet's own tables already get (spawnOverflowTables),
--                     extended to a host's table. Within one seat of full, a
--                     sibling opens carrying the SAME configuration.
--
-- The clone shares its implementation with fn_launch_table_from_template: one
-- row-copy that overrides only identity and live state, so a column added
-- tomorrow is carried by both without anyone remembering either.

-- ── THE SHARED ROW COPY ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_clone_table_row(p_source_id uuid, p_name text DEFAULT NULL)
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
    'updated_at',      now()
  );
  IF p_name IS NOT NULL THEN
    v_row := v_row || jsonb_build_object('name', p_name);
  END IF;

  INSERT INTO public.tables
  SELECT * FROM jsonb_populate_record(NULL::public.tables, v_row);

  RETURN v_new;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_clone_table_row(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_clone_table_row(uuid, text) TO service_role;

-- fn_launch_table_from_template keeps its own auth and its own status, and
-- delegates the copy. Its behaviour is unchanged: staff-only, status 'active'.
CREATE OR REPLACE FUNCTION public.fn_launch_table_from_template(p_template_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_club uuid;
  v_new  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_launch_table_from_template requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT t.club_id INTO v_club FROM public.tables t
   WHERE t.id = p_template_id AND COALESCE(t.is_template, false) = true LIMIT 1;
  IF v_club IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.tables t
     WHERE t.id = p_template_id AND COALESCE(t.is_template, false) = true) THEN
    RAISE EXCEPTION 'TEMPLATE_NOT_FOUND: % is not a table template', p_template_id;
  END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM public.club_members cm
             WHERE cm.club_id = v_club AND cm.user_id = v_uid
               AND cm.role IN ('owner', 'admin', 'manager', 'agent'))
    OR EXISTS (SELECT 1 FROM public.clubs c
                WHERE c.id = v_club AND c.owner_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'NOT_CLUB_STAFF: only club staff may launch a table';
  END IF;

  v_new := public.fn_clone_table_row(p_template_id, NULL);
  UPDATE public.tables SET status = 'active', created_by = v_uid WHERE id = v_new;
  RETURN v_new;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_launch_table_from_template(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_launch_table_from_template(uuid) TO authenticated;

-- ── THE PASS ───────────────────────────────────────────────────────────────
-- Idempotent, and safe to run on every fleet cycle. Returns what it did so the
-- caller can log it rather than guess.
CREATE OR REPLACE FUNCTION public.fn_table_lifecycle_pass()
 RETURNS TABLE(action text, table_id uuid, table_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r      record;
  v_new  uuid;
  v_n    integer;
  v_name text;
BEGIN
  -- ── AUTO RESTART: reopen a closed table whose host asked for it ──────────
  -- Never a tournament table (those close on purpose, at the end of a game),
  -- never a deleted one, and never a template.
  FOR r IN
    SELECT t.id, t.name FROM public.tables t
     WHERE COALESCE(t.auto_restart, false)
       AND t.status = 'closed'
       AND t.tournament_id IS NULL
       AND COALESCE(t.is_deleted, false) = false
       AND COALESCE(t.is_template, false) = false
     LIMIT 50
  LOOP
    UPDATE public.tables
       SET status = 'waiting', current_players = 0, updated_at = now()
     WHERE id = r.id AND status = 'closed';
    action := 'restarted'; table_id := r.id; table_name := r.name; RETURN NEXT;
  END LOOP;

  -- ── AUTO CREATE TABLE: a sibling when this one is within a seat of full ──
  -- Capped at 3 in a family, the same ceiling spawnOverflowTables uses, so a
  -- busy night cannot fill the lobby with clones. The name is suffixed rather
  -- than duplicated, so the family is recognisable on the board.
  FOR r IN
    SELECT t.id, t.name, t.club_id, t.max_players,
           (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id = t.id AND s.left_at IS NULL) AS taken
      FROM public.tables t
     WHERE COALESCE(t.auto_create_table, false)
       AND t.tournament_id IS NULL
       AND COALESCE(t.is_deleted, false) = false
       AND COALESCE(t.is_template, false) = false
       AND t.status IN ('active', 'waiting', 'running')
       AND COALESCE(t.max_players, 0) > 0
     LIMIT 50
  LOOP
    CONTINUE WHEN r.taken < GREATEST(r.max_players - 1, 1);

    -- The family is this table and anything already spawned from it.
    SELECT count(*)::int INTO v_n FROM public.tables f
     WHERE f.club_id = r.club_id
       AND COALESCE(f.is_deleted, false) = false
       AND f.status IN ('active', 'waiting', 'running')
       AND (f.name = split_part(r.name, ' #', 1)
            OR f.name LIKE split_part(r.name, ' #', 1) || ' #%');
    CONTINUE WHEN v_n >= 3;

    -- Only spawn when EVERY table in the family is near full. One quiet
    -- sibling means the demand is already served.
    IF EXISTS (
      SELECT 1 FROM public.tables f
       WHERE f.club_id = r.club_id
         AND COALESCE(f.is_deleted, false) = false
         AND f.status IN ('active', 'waiting', 'running')
         AND (f.name = split_part(r.name, ' #', 1)
              OR f.name LIKE split_part(r.name, ' #', 1) || ' #%')
         AND (SELECT count(*) FROM public.table_seats s
               WHERE s.table_id = f.id AND s.left_at IS NULL)
             < GREATEST(COALESCE(f.max_players, 0) - 1, 1)
    ) THEN
      CONTINUE;
    END IF;

    v_name := split_part(r.name, ' #', 1) || ' #' || (v_n + 1)::text;
    BEGIN
      v_new := public.fn_clone_table_row(r.id, v_name);
      UPDATE public.tables SET status = 'waiting' WHERE id = v_new;
      action := 'created'; table_id := v_new; table_name := v_name; RETURN NEXT;
    EXCEPTION WHEN unique_violation THEN
      -- Two cycles racing for the same name is expected and harmless.
      NULL;
    END;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_table_lifecycle_pass() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_table_lifecycle_pass() TO service_role;

DO $$
DECLARE v_def text;
BEGIN
  PERFORM public.fn_table_lifecycle_pass();
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_launch_table_from_template';
  IF position('NOT_CLUB_STAFF' in v_def) = 0 THEN
    RAISE EXCEPTION 'the staff check was lost when the launcher was refactored';
  END IF;
  IF position('fn_clone_table_row' in v_def) = 0 THEN
    RAISE EXCEPTION 'the launcher is not sharing the row copy';
  END IF;
END $$;
