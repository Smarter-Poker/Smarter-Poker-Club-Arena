-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909012215; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909012215   (the stamp IS the apply time, UTC: 2026-09-09 01:22:15)
--   name        retire_the_stranded_half_chips_on_the_felt
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2522 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909012215 IS ALREADY IN
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
  v_before numeric;
  v_after  numeric;
  v_rows   integer;
  v_frac   integer;
  v_odd    integer;
BEGIN
  -- Take the row locks first (no window functions allowed alongside FOR UPDATE),
  -- then rank them. Measuring conservation over ONLY these rows is the point: a
  -- sum over every tournament seat on the platform is not a baseline, because
  -- live play moves it between the two reads - which is what made the first
  -- attempt abort with a -2000 delta that had nothing to do with this fix.
  CREATE TEMP TABLE zz_locked ON COMMIT DROP AS
  SELECT ts.id, ts.table_id, ts.seat_number, ts.stack AS stack_before,
         tb.tournament_id
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id IS NOT NULL
     AND ts.left_at IS NULL
     AND ts.stack <> trunc(ts.stack);

  PERFORM 1 FROM public.table_seats ts
    JOIN zz_locked l ON l.id = ts.id
   FOR UPDATE OF ts;

  CREATE TEMP TABLE zz_frac ON COMMIT DROP AS
  SELECT id, tournament_id, stack_before,
         row_number() OVER (PARTITION BY tournament_id ORDER BY table_id, seat_number) AS rn,
         count(*)     OVER (PARTITION BY tournament_id) AS per_tournament
    FROM zz_locked;

  -- Pairing is only chip-neutral where the count is even. A tournament holding
  -- an ODD number of halves cannot be squared without minting or burning half a
  -- chip, so it is left alone and reported rather than guessed at.
  SELECT count(*) INTO v_odd FROM zz_frac WHERE per_tournament % 2 = 1;
  DELETE FROM zz_frac WHERE per_tournament % 2 = 1;

  SELECT coalesce(sum(stack_before), 0) INTO v_before FROM zz_frac;

  UPDATE public.table_seats ts
     SET stack = CASE WHEN f.rn % 2 = 1 THEN ceil(f.stack_before) ELSE floor(f.stack_before) END
    FROM zz_frac f
   WHERE ts.id = f.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT coalesce(sum(ts.stack), 0),
         count(*) FILTER (WHERE ts.stack <> trunc(ts.stack))
    INTO v_after, v_frac
    FROM public.table_seats ts
    JOIN zz_frac f ON f.id = ts.id;

  IF v_after <> v_before THEN
    RAISE EXCEPTION
      'refusing to commit: the seats this touched moved from % to % (delta %)',
      v_before, v_after, v_after - v_before;
  END IF;
  IF v_frac <> 0 THEN
    RAISE EXCEPTION 'refusing to commit: % of the seats this touched are still fractional', v_frac;
  END IF;

  RAISE NOTICE 'retired % half-chip seat(s), total unchanged at %; % left alone in odd-count tournaments',
    v_rows, v_after, v_odd;
END;
$migration$;
