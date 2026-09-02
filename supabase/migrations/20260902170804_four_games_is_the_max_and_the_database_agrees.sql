-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902170804; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Dan 2026-09-02: "WELL CHANGE IT TO 4, FOUR IS SUPPOSED TO BE THE MAX."
--
-- Three layers enforce the concurrent-cash-table cap and only one of them can
-- not be raced around. Until now they disagreed:
--
--   client device cap            4
--   HorseFleetManager seat pick  4   (MAX_TABLES_PER_HORSE, advisory)
--   atomic_table_buyin           6   <- the authoritative guard
--
-- The engine's filter is explicitly advisory - its own comment says so, because
-- it is computed from an in-memory seat map and is raceable across concurrent
-- seeding cycles. TABLE_CAP_REACHED from this function is the backstop that
-- actually holds, and it was set two higher than the rule it is backstopping.
-- So a race, a second device, or a direct API caller could reach five or six.
--
-- PATCHED, NOT RETYPED. The body is 8,552 characters of money path. Re-emitting
-- it by hand to change one integer risks a transcription error in code that
-- debits wallets, so this reads the live definition, replaces exactly one
-- anchor string, asserts the replacement happened, and executes the result.
-- Nothing else in the function can drift.
--
-- SAFE FOR SEATED PLAYERS. Checked immediately before applying: the busiest
-- player on the platform holds 2 concurrent cash seats (19 players at 2, 314 at
-- 1, none above). Lowering the ceiling refuses a FUTURE fifth buy-in; it never
-- touches an existing seat, so nobody is stranded mid-hand.
--
-- ROLLBACK (paste and run to restore the previous behaviour):
--
--   DO $rb$
--   DECLARE v_def text; v_new text;
--   BEGIN
--     SELECT pg_get_functiondef(p.oid) INTO v_def
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin';
--     v_new := replace(v_def, 'v_max_tables CONSTANT INT := 4;',
--                             'v_max_tables CONSTANT INT := 6;');
--     IF v_new = v_def THEN RAISE EXCEPTION 'rollback anchor not found'; END IF;
--     EXECUTE v_new;
--   END $rb$;
--
DO $mig$
DECLARE
  v_def   text;
  v_new   text;
  v_hits  int;
  v_check int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'atomic_table_buyin not found - refusing to guess';
  END IF;

  -- Exactly one declaration of the constant, or the anchor is not what we think.
  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_def, 'v_max_tables CONSTANT INT := 6;', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 cap declaration, found % - refusing to patch', v_hits;
  END IF;

  v_new := replace(v_def, 'v_max_tables CONSTANT INT := 6;',
                          'v_max_tables CONSTANT INT := 4;');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'replacement was a no-op - refusing to claim success';
  END IF;

  EXECUTE v_new;

  -- Read it back from the catalog rather than trusting the write.
  SELECT count(*) INTO v_check
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin'
     AND p.prosrc LIKE '%v_max_tables CONSTANT INT := 4;%';
  IF v_check <> 1 THEN
    RAISE EXCEPTION 'post-apply check failed: cap is not 4';
  END IF;

  RAISE NOTICE 'atomic_table_buyin concurrent cash table cap is now 4';
END $mig$;
