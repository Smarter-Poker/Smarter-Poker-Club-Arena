-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909035821; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909035821   (the stamp IS the apply time, UTC: 2026-09-09 03:58:21)
--   name        status_follows_lifecycle_without_stealing_the_row_count
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3001 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909035821 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
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

DO $migration$
DECLARE
  v_src text;
  v_new text;
  -- What the previous apply left: my block sits BETWEEN the lifecycle-follows-
  -- status UPDATE and its own GET DIAGNOSTICS, so that event now reports MY
  -- row count instead of its own. Move it below the pair it split.
  v_wrong CONSTANT text :=
'  UPDATE public.tables SET status = ''closed'', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND lifecycle = ''closed'' AND status <> ''closed''
     AND coalesce(is_deleted, false) = false
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = public.tables.id AND ts.left_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (g.id, ''status_followed_lifecycle'', jsonb_build_object(''tables'', v_n));
  END IF;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, ''lifecycle_followed_status'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''lifecycle_followed_status'', v_n);
  END IF;';
  v_right CONSTANT text :=
'  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, ''lifecycle_followed_status'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''lifecycle_followed_status'', v_n);
  END IF;

  UPDATE public.tables SET status = ''closed'', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND lifecycle = ''closed'' AND status <> ''closed''
     AND coalesce(is_deleted, false) = false
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = public.tables.id AND ts.left_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (g.id, ''status_followed_lifecycle'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''status_followed_lifecycle'', v_n);
  END IF;';
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  IF position(v_wrong in v_src) = 0 THEN
    RAISE EXCEPTION 'the block this migration corrects is not present in the shape expected';
  END IF;

  v_new := replace(v_src, v_wrong, v_right);

  -- The lifecycle-follows-status UPDATE must now be immediately followed by its
  -- OWN GET DIAGNOSTICS, with nothing between them.
  IF position('AND NOT (g.enabled AND role = ''main'' AND main_index = 1)' in v_new) = 0 THEN
    RAISE EXCEPTION 'the lifecycle-follows-status guard went missing';
  END IF;
  IF position('status_followed_lifecycle' in v_new) = 0
     OR position('lifecycle_followed_status' in v_new) = 0
     OR position('fn_platform_frozen' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;
