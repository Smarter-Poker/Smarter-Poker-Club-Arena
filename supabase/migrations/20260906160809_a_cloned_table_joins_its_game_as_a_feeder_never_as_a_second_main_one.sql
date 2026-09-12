-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906160809; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906160809   (the stamp IS the apply time, UTC: 2026-09-06 16:08:09)
--   name        a_cloned_table_joins_its_game_as_a_feeder_never_as_a_second_main_one
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4793 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906160809 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_clone_table_row
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260906160550_a_cloned_table_joins_its_game_as_a_feeder_never_as_a_second_.sql
-- fn_clone_table_row carried over cluster_id/role/main_index/lifecycle, so a
-- clone of Main 1 was a second Main 1 (the 3,000-tables-on-one-game shape), and
-- it inserted with SELECT * into a table with FOUR GENERATED columns, so every
-- call had been raising 428C9 - breaking fn_launch_table_from_template too.
-- Both fixed. Full reasoning in the repo file of the same name. One transaction.
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
  -- `cluster_id` stays (tables_cash_needs_a_game refuses an open cash table
  -- without one), but role / main_index / lifecycle and their timestamps are
  -- the answer to "which table of this game are you", and the clone is a NEW
  -- one. Copying them made a clone of Main 1 a second Main 1. It joins as an
  -- opening feeder, the shape the controller's OPEN rule creates and already
  -- knows how to promote, break or abandon.
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

COMMIT;
