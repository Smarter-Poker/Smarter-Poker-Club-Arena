-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260824235643 "20260824_perf_replica_identity_halves_realtime_wal"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c71c951386f9fc6f2486965624242471 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PERFORMANCE 2026-08-24. Realtime WAL volume: remove the FULL-replica-identity
-- multiplier from the two highest-write published tables.
--
-- ============================================================================
-- EVIDENCE
-- ============================================================================
-- Realtime WAL decoding cost 4.30 core-hours of the 47.40 measured in a
-- 12h35m window (mean 355 ms per call, max 53.6 s), on a 2 vCPU instance
-- with 25.17 core-hours of capacity.
--
-- Writes to tables in the supabase_realtime publication, and their
-- replica identity BEFORE this migration:
--
--   table_hole_cards      529,269 writes   FULL      <-- fixed here
--   tournament_players    528,887 writes   FULL      <-- fixed here
--   tables                108,412 writes   DEFAULT
--   tournaments            59,419 writes   FULL      <-- left alone, see below
--   clubs                  45,970 writes   DEFAULT
--   ...everything else                     DEFAULT
--
-- REPLICA IDENTITY FULL makes Postgres write the ENTIRE OLD ROW into the WAL
-- on every UPDATE and DELETE, in addition to the new row, and forces the
-- logical decoder to parse both. The two tables fixed here are 1,058,156 of
-- the ~1.35M published writes - 78% - and every one was doing double work.
--
-- ============================================================================
-- WHY EACH CHANGE IS SAFE
-- ============================================================================
-- FULL is only required when a subscriber needs OLD-row column values: that
-- means DELETE payloads, or a realtime `filter:` that must be evaluated
-- against the old row on DELETE. Verified against every postgres_changes call
-- site in club-arena and Smarter-Poker-World-Hub.
--
-- table_hole_cards -> DEFAULT
--   Exactly ONE subscription exists platform-wide:
--     src/pages/TablePage.tsx:4058-4067
--     event: 'INSERT', filter: `table_id=eq.${tableId}`
--   An INSERT payload has no old row at all, so FULL was buying nothing.
--   DEFAULT (primary key only) is sufficient. No subscriber can regress.
--
-- tournament_players -> USING INDEX tournament_players_tournament_id_user_id_key
--   Subscriptions DO use event '*' (so DELETE matters) with
--   filter: `tournament_id=eq.${tournamentId}` -
--     TournamentRegistration.tsx:68, TournamentClock.tsx:222,
--     TournamentStandings.tsx:57, TournamentDetails.tsx:286,
--     TournamentResultsPage.tsx:270, TablePage.tsx:5111
--   so the old row must still carry tournament_id for the filter to match on
--   DELETE. Dropping to DEFAULT would silently stop delivering un-registration
--   and elimination events.
--   REPLICA IDENTITY USING INDEX gives us both: the old tuple in WAL carries
--   ONLY the indexed columns instead of the whole row, and tournament_id is
--   one of them, so every existing filter keeps working on DELETE.
--   tournament_players_tournament_id_user_id_key qualifies: UNIQUE, NOT
--   partial, NOT deferrable, and both tournament_id and user_id are NOT NULL
--   (all four are hard requirements Postgres enforces for USING INDEX).
--
-- tournaments -> DELIBERATELY LEFT ON FULL
--   Its subscriptions filter on club_id and union_id as well as id
--   (AdminDashboardPage.tsx:458, TournamentPage.tsx:364, ClubHomePage.tsx,
--   UnionDetailPage.tsx:526, UnionGamesPage.tsx:267) with event '*'. No
--   single unique non-partial index covers club_id or union_id, so USING
--   INDEX cannot preserve those DELETE filters, and DEFAULT would break them.
--   At 59,419 writes it is 4% of the volume - not worth the regression risk.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   ALTER TABLE public.table_hole_cards   REPLICA IDENTITY FULL;
--   ALTER TABLE public.tournament_players REPLICA IDENTITY FULL;
-- ============================================================================

ALTER TABLE public.table_hole_cards REPLICA IDENTITY DEFAULT;

ALTER TABLE public.tournament_players
  REPLICA IDENTITY USING INDEX tournament_players_tournament_id_user_id_key;

-- ============================================================================
-- POST-APPLY ASSERTIONS
-- ============================================================================
DO $$
DECLARE v_hc char; v_tp char;
BEGIN
  SELECT relreplident INTO v_hc FROM pg_class WHERE oid = 'public.table_hole_cards'::regclass;
  IF v_hc <> 'd' THEN
    RAISE EXCEPTION 'table_hole_cards replica identity is %, expected d (DEFAULT)', v_hc;
  END IF;

  SELECT relreplident INTO v_tp FROM pg_class WHERE oid = 'public.tournament_players'::regclass;
  IF v_tp <> 'i' THEN
    RAISE EXCEPTION 'tournament_players replica identity is %, expected i (USING INDEX)', v_tp;
  END IF;

  -- The index backing tournament_players identity must be the one carrying
  -- tournament_id, or every filtered DELETE subscription breaks silently.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
     WHERE ix.indrelid = 'public.tournament_players'::regclass
       AND ix.indisreplident
       AND i.relname = 'tournament_players_tournament_id_user_id_key'
  ) THEN
    RAISE EXCEPTION 'tournament_players identity index is not the tournament_id/user_id key';
  END IF;

  -- Both tables must still be published, or realtime stops entirely.
  IF (SELECT count(*) FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND tablename IN ('table_hole_cards','tournament_players')) <> 2 THEN
    RAISE EXCEPTION 'a table dropped out of the supabase_realtime publication';
  END IF;
END $$;

