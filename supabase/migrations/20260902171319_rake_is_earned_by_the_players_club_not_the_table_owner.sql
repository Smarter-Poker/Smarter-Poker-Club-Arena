-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902171319; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- Dan 2026-09-02, restating how a union works: "ALL GAME PLAY IS STILL 100%
-- PLAYED INSIDE AND TRACKED THROUGH THE CLUB THEY ARE IN, ALL GAMES ARE JUST
-- NOW HOSTED BY THE MIDWAY UNION... THE UNION PAYS 90% RAKE BACK WEEKLY TO THE
-- CLUBS ATTACHED TO THEM."
--
-- Attribution did not follow the player. It followed the TABLE, and every live
-- Midway table is owned by the Midway Union club row, so every raked hand was
-- credited to the union and nothing to the member clubs. Measured 2026-09-02,
-- one hour of non-tournament play:
--
--   Midway Union   169.85        live seats: Club JAQK 212
--   Club JAQK        0.00                    Shark Club 201
--   Shark Club       0.00
--
-- Four hundred and thirteen seats belonging to the two member clubs, and both
-- clubs earned zero. That is not a reporting nicety: the weekly payback is 90%
-- OF a per-club figure, so with every club at zero there is nothing to pay 90%
-- of and the settlement has no basis to run on. It was not always broken -
-- the week of 08-17 credited Shark 441,953.73 and JAQK 13,986.95 - and the
-- change tracks table ownership migrating onto the union row.
--
-- WHAT THIS CHANGES: exactly one column, on one audit table. The per-player
-- rows in rake_attributions now carry the club of the SEAT the player occupied
-- rather than the club that owns the table. Everything else is untouched.
--
-- WHAT THIS DOES NOT CHANGE, deliberately:
--   - No chips move. This is an attribution stamp, not a transfer.
--   - The union still holds 100% of cash rake. That is Dan's model and it is
--     already correct; rake_records.club_id and the union_wallet_transactions
--     credit both still carry the host club, because the money genuinely does
--     go to the union.
--   - The 90% rate, the wallets, and the BBJ and spins treasuries are all
--     already correct and are not touched.
--
-- WHY THE SEAT RATHER THAN RE-OWNING THE TABLE: a single table seats players
-- from BOTH member clubs at once (212 JAQK and 201 Shark are interleaved
-- across the same floor). Rotating tables.club_id across clubs - the other
-- obvious route - would credit one club for the other club's players on every
-- mixed table. Per-seat is the only attribution that survives a mixed table,
-- and it is also what "tracked through the club they are in" literally says.
-- rake_attributions already carries player_id and a per-player
-- weighted_rake_credit, so the split existed; only the club stamped beside it
-- was wrong.
--
-- FALLBACK IS THE OLD BEHAVIOUR: if no seat row can be found for the player at
-- that table - a seat purged before settlement, or a tournament path - the
-- COALESCE returns p_club_id, exactly what was stamped before. So the worst
-- case of this change is the status quo, never a NULL club on a money row.
--
-- The seat is read newest-first rather than filtered on left_at IS NULL,
-- because settlement runs AFTER the hand and a player who busted or stood up
-- has a left_at by then. Filtering on an open seat would send exactly the
-- players who just lost their stack down the fallback path.
--
-- PATCHED, NOT RETYPED: 10,552 characters of money path. The body is read from
-- the catalog, one unique anchor is replaced, and the result is asserted -
-- nothing else can drift. Dry-run first inside a rolled-back transaction to
-- prove it compiles.
--
-- ROLLBACK (paste and run):
--
--   DO $rb$
--   DECLARE v_def text; v_new text;
--   BEGIN
--     SELECT pg_get_functiondef(p.oid) INTO v_def
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake';
--     v_new := regexp_replace(v_def,
--       'v_rr_id, p_table_id,\s*COALESCE\(\(SELECT ts\.club_id[\s\S]*?p_club_id\),',
--       'v_rr_id, p_table_id, p_club_id,');
--     IF v_new = v_def THEN RAISE EXCEPTION 'rollback anchor not found'; END IF;
--     EXECUTE v_new;
--   END $rb$;
--
DO $mig$
DECLARE
  v_def  text;
  v_new  text;
  v_hits int;
  v_ok   int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'atomic_distribute_rake not found - refusing to guess';
  END IF;

  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_def, 'v_rr_id, p_table_id, p_club_id,', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 attribution anchor, found % - refusing to patch', v_hits;
  END IF;

  v_new := replace(v_def,
    'v_rr_id, p_table_id, p_club_id,',
    'v_rr_id, p_table_id,' || chr(10) ||
    '           COALESCE((SELECT ts.club_id FROM public.table_seats ts' || chr(10) ||
    '                      WHERE ts.table_id = p_table_id AND ts.user_id = a.user_id' || chr(10) ||
    '                      ORDER BY ts.joined_at DESC NULLS LAST LIMIT 1), p_club_id),');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'replacement was a no-op - refusing to claim success';
  END IF;

  EXECUTE v_new;

  SELECT count(*) INTO v_ok
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake'
     AND p.prosrc LIKE '%ORDER BY ts.joined_at DESC NULLS LAST LIMIT 1), p_club_id)%';
  IF v_ok <> 1 THEN
    RAISE EXCEPTION 'post-apply check failed: attribution still uses the table club';
  END IF;

  RAISE NOTICE 'rake_attributions.club_id now follows the seat, not the table owner';
END $mig$;
