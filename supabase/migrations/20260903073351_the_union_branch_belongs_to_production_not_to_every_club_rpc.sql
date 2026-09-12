-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260903073351; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260903073351   (the stamp IS the apply time, UTC: 2026-09-03 07:33:51)
--   name        the_union_branch_belongs_to_production_not_to_every_club_rpc
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3225 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260903073351 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.ca_can_view_club_finances, public.ca_can_read_club_production
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
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

-- THE UNION BRANCH BELONGS TO PRODUCTION, NOT TO EVERY CLUB RPC.
--
-- An hour ago I added a union-overseer branch to ca_can_view_club_finances so
-- that a union lead could open a member club from the union breakdown. That
-- was the right ENTITLEMENT and the wrong PLACE.
--
-- ca_can_view_club_finances is not the rake snapshot's gate. It is the gate
-- for nine other RPCs as well:
--
--   ca_club_data_snapshot        ca_club_player_breakdown
--   ca_club_data_export_page     ca_club_player_page
--   ca_club_game_page            ca_club_player_export_start
--   ca_club_game_export_start    ca_club_union_invoices
--   ca_club_insurance_report
--
-- So widening it did not open one row on one page. It handed every union
-- overseer the whole club data page for every member club - the game ledger,
-- the per-player breakdown, the insurance report and the CSV exports - and the
-- commit that did it described the change as opening a drill-down. On this
-- estate the difference is invisible, because its only union lead already owns
-- both member clubs; on the next union it would be a silent expansion of one
-- operator's visibility into another's business.
--
-- The gate goes back to what it was. The wider claim gets its own name and
-- reaches only the two places that need it: the club scope of the rake
-- snapshot, and the can_drill flag that predicts it.
--
-- PRODUCTION IS NOT THE SAME CLAIM AS FINANCES. Reading what a club produced
-- is what a union bills against and already sees in aggregate on the union
-- page. Reading its player list, its hands and its cost structure is not, and
-- is left exactly where it was.

-- ---------------------------------------------------- the gate, as it was ---
CREATE OR REPLACE FUNCTION public.ca_can_view_club_finances(p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    auth.uid() IS NULL
    OR EXISTS (
      SELECT 1 FROM club_members cm
       WHERE cm.club_id = p_club_id
         AND cm.user_id = auth.uid()
         AND COALESCE(cm.status, 'active') NOT IN ('banned', 'suspended')
         AND cm.role IN ('owner', 'co_owner', 'admin', 'super_agent')
    )
    OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND COALESCE(pr.is_admin, false));
$function$;

-- ------------------------------------------ the narrower claim, by itself ---
CREATE OR REPLACE FUNCTION public.ca_can_read_club_production(p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    public.ca_can_view_club_finances(p_club_id)
    -- Overseeing a union the club belongs to. Scoped through union_clubs, so
    -- it never reaches a club that is not in a union this caller oversees.
    OR EXISTS (
      SELECT 1 FROM union_clubs uc
       WHERE uc.club_id = p_club_id
         AND public.fn_is_union_overseer(uc.union_id, auth.uid())
    );
$function$;

REVOKE ALL ON FUNCTION public.ca_can_read_club_production(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_can_read_club_production(uuid) TO authenticated, service_role;
