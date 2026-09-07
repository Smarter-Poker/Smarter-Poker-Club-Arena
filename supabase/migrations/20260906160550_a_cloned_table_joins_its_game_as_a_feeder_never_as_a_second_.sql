-- 20260906160550_a_cloned_table_joins_its_game_as_a_feeder_never_as_a_second_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- A CLONED TABLE JOINS ITS GAME AS A FEEDER, NEVER AS A SECOND MAIN 1
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_clone_table_row` says in its own comment that "identity and live state
-- are the ONLY things that do not carry over", and then carries over the four
-- columns that say WHICH TABLE OF WHICH GAME this is: `cluster_id`, `role`,
-- `main_index` and `lifecycle`, plus the lifecycle timestamps. So a clone of
-- Main 1 is a second Main 1 of the same game.
--
-- That is not a hypothetical shape. `docs/HANDOFF-TABLE-STAKES-CURRENT-STATE.md`
-- section 6 records it as one of the traps this programme has already paid
-- for: "Main 1 was the OLDEST row, not the live one. That opened 3,000 tables
-- on one game before it was caught." The repair then was to look Main 1 up on
-- the live board (`20260905194329`); nothing stopped a duplicate being MADE.
--
-- Two callers reach it: `fn_table_lifecycle_pass`'s AUTO CREATE arm (deleted
-- from the fleet in this same PR - it acted on zero rows and was the dangerous
-- one) and `fn_launch_table_from_template`, which is live and legitimate.
-- Fixing the cloner covers both, and covers the third caller nobody has
-- written yet.
--
-- WHAT A CLONE IS NOW. `cluster_id` is KEPT - `tables_cash_needs_a_game`
-- refuses an open cash table without one, so stripping it would break the
-- template launcher for every cash game. What is reset is the table's PLACE in
-- that game: it joins as a `feeder` in `opening` with no `main_index` and no
-- lifecycle timestamps, which is exactly the shape the controller's OPEN rule
-- creates (OPORD 1.4 s18.3) and a shape the controller already knows how to
-- promote, break or abandon. A clone can therefore never be a second Main 1,
-- and it can never inherit a `live` lifecycle it did not earn by seating two.
--
-- A UNIQUE INDEX WAS CONSIDERED AND REJECTED, deliberately, so nobody adds it
-- later thinking it was missed. `CREATE UNIQUE INDEX ... ON tables
-- (cluster_id, main_index) WHERE role = 'main' AND lifecycle <> 'closed'` is
-- the structural guarantee, and production is clean enough to build it today
-- (zero duplicate groups, read 2026-09-06). But the controller RENUMBERS mains
-- when it promotes and demotes, and a renumber that swaps two indices in two
-- separate UPDATE statements inside one transaction violates a unique index on
-- the first statement. Breaking the tick to prevent a duplicate the cloner can
-- no longer create is the wrong trade. If the renumber is ever made a single
-- statement, or the constraint deferrable, add the index then.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL
-- policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_clone_table_row(p_source_id uuid, p_name text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_row jsonb;
  v_new uuid := gen_random_uuid();
  v_cols text;
BEGIN
  SELECT to_jsonb(t) INTO v_row FROM public.tables t WHERE t.id = p_source_id LIMIT 1;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'TABLE_NOT_FOUND: %', p_source_id;
  END IF;

  -- Identity and live state do not carry over.
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

  -- ── NOR DOES ITS PLACE IN THE GAME (2026-09-06) ──────────────────────────
  -- `cluster_id` stays (tables_cash_needs_a_game), but role / main_index /
  -- lifecycle and their timestamps are the answer to "which table of this game
  -- are you", and the clone is a NEW one. Copying them made a clone of Main 1
  -- a second Main 1. It joins as an opening feeder, the shape the controller's
  -- OPEN rule creates and already knows how to promote, break or abandon.
  IF (v_row -> 'cluster_id') IS NOT NULL AND jsonb_typeof(v_row -> 'cluster_id') <> 'null' THEN
    v_row := v_row || jsonb_build_object(
      'role',                 'feeder',
      'main_index',           NULL,
      'lifecycle',            'opening',
      'opened_at',            now(),
      'live_at',              NULL,
      'break_started_at',     NULL,
      'break_eligible_since', NULL,
      'promote_pending',      false
    );
  END IF;

  IF p_name IS NOT NULL THEN
    v_row := v_row || jsonb_build_object('name', p_name);
  END IF;

  -- ── AND IT COULD NOT INSERT AT ALL (2026-09-06) ──────────────────────────
  -- This was `INSERT INTO public.tables SELECT * FROM jsonb_populate_record(
  -- NULL::public.tables, v_row)`, and `public.tables` has FOUR GENERATED
  -- columns - `min_buyin`, `max_buyin`, `min_buy_in_bb`, `max_buy_in_bb`, all
  -- derived from min/max_buy_in and big_blind. `SELECT *` names them, and
  -- Postgres refuses a non-DEFAULT value for a generated column:
  --
  --   428C9 cannot insert a non-DEFAULT value into column "min_buy_in_bb"
  --
  -- So every call has raised since those columns were added, and BOTH callers
  -- were broken: `fn_launch_table_from_template` (a live operator feature) and
  -- `fn_table_lifecycle_pass`'s AUTO CREATE arm - whose only handler is
  -- `EXCEPTION WHEN unique_violation`, which does not catch 428C9, so the
  -- whole pass aborted. Found by the rolled-back probe for this migration; the
  -- clone path has no test and no caller that reports, so nothing said so.
  --
  -- The column list is read from the catalogue rather than written down, so a
  -- FIFTH generated column cannot break it again the way the first four did.
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'tables'
     AND c.is_generated = 'NEVER'
     AND c.is_identity <> 'YES';

  EXECUTE format(
    'INSERT INTO public.tables (%s) SELECT %s FROM jsonb_populate_record(NULL::public.tables, $1)',
    v_cols, v_cols
  ) USING v_row;

  RETURN v_new;
END;
$function$;

COMMENT ON FUNCTION public.fn_clone_table_row(uuid, text) IS
  'Clones a table row. Identity, live state, bomb-pot live state AND the table''s place in its game (role/main_index/lifecycle) are reset: a clustered clone joins as an opening feeder, never as a second Main 1. Inserts by explicit column list read from the catalogue, because public.tables has generated columns that SELECT * cannot write (2026-09-06).';

-- NOBODY IN A BROWSER CALLS THIS. It is a SECURITY DEFINER writer that CREATES
-- TABLE ROWS and takes no actor, so it must never be reachable from a browser
-- role. CREATE OR REPLACE preserves the ACL and production already holds
-- exactly this (postgres + service_role, read 2026-09-06), so these two lines
-- change nothing live - they make the FILE say what the database has, which is
-- what check-definer-authorization reads. GRANT/REVOKE fire no schema-cache
-- reload (production DDL policy, rule 5).
--
-- `fn_launch_table_from_template` keeps its `authenticated` grant and still
-- calls this one: it is SECURITY DEFINER itself, so it runs as the owner and
-- the caller's grant on the inner function is never consulted.
REVOKE ALL ON FUNCTION public.fn_clone_table_row(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_clone_table_row(uuid, text) TO service_role;

COMMIT;
