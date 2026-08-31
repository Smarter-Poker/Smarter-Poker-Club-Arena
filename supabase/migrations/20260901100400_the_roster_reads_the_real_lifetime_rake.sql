-- ═══════════════════════════════════════════════════════════════════════════
--  THE ROSTER READS THE REAL LIFETIME RAKE (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `club_members.total_rake_paid` is an abandoned lifetime mirror, and the club
-- roster has been showing it to members as if it were true.
--
-- MEASURED IN PRODUCTION 2026-08-31, read-only:
--
--   club_members                                  1,549 memberships
--   carrying a non-zero total_rake_paid              76 memberships
--   total stored across all of them             5,555.00 chips
--
--   the same memberships' REAL lifetime rake,
--   summed from club_rake_daily_user           3,520,325.33 chips
--   memberships with real rake                    1,471
--   memberships where stored = real                   0
--
-- Zero. Not one of the 1,471 members with real rake has a stored mirror that
-- agrees with it. The column is not stale, it is abandoned: its only writer,
-- `increment_rake_generated(uuid, uuid, numeric)`, has NO callers -- none in
-- any other database function, and none anywhere in this repository. It stopped
-- being written and nothing noticed, because nothing reads it for money.
--
-- ── FIX THE DISPLAY, DO NOT DROP THE COLUMN ────────────────────────────────
--
-- The brief allowed either. Fixing the display is the right call here:
--
--   * The NUMBER is wanted. The club roster, the admin member panel and the
--     admin CSV export all want to show what a member has raked. That is a
--     reasonable thing to show. The defect is the SOURCE, not the feature --
--     so drop the source, not the feature.
--   * A DROP COLUMN on club_members takes an AccessExclusiveLock on a hot
--     table, busts the PostgREST schema cache, and breaks five call sites
--     (ClubsService x3, StatsExport, ClubMemberManagement), a TypeScript type,
--     and two CI column manifests -- all to remove a number we would then have
--     to re-add from the right source anyway.
--   * A dropped column cannot be un-dropped if some reader outside these seven
--     repositories was relying on it. A column that stops being READ costs
--     nothing and can be dropped later, deliberately, once this has been live
--     for a while.
--
-- So the column stays, is documented as not-the-source, and the readers move
-- to `club_rake_daily_user` -- which is the same table the agent downline
-- (fn_agent_downline_rake) and the union rake ledger (fn_union_rake_by_club,
-- fn_union_rake_by_day, fn_union_rake_ledger_summary) already treat as the
-- truth about who raked what. 29,619 rows, 4,103,077.71 chips.
--
-- WHETHER TO BACKFILL the 5,555.00 into agreement with the 3,520,325.33, or to
-- drop the column outright, is Dan's call and is written up in the PR. Nothing
-- here writes a chip.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_club_member_lifetime_rake(uuid);
--   (and revert the ClubsService enrichment in the same commit)

SET lock_timeout = '4s';

-- ── THE REAL NUMBER ────────────────────────────────────────────────────────
--
-- Shaped exactly like fn_batch_club_member_counts, the enrichment RPC the club
-- roster already calls to replace the stale `clubs.member_count` denormal --
-- same problem, same answer, same call site.
--
-- SECURITY DEFINER because club_rake_daily_user carries RLS and an ordinary
-- member cannot read it. It therefore CONSULTS auth.uid() and answers only for
-- a club the caller is actually a member of: a definer function that trusts
-- its argument is how a member once rewrote a club's member_count.
CREATE OR REPLACE FUNCTION public.fn_club_member_lifetime_rake(p_club_id uuid)
RETURNS TABLE(user_id uuid, rake_amount numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_club_id IS NULL THEN RETURN; END IF;

  -- The caller must be in the club they are asking about. service_role (which
  -- has no auth.uid()) is trusted; a browser session is not.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.user_id = auth.uid()
       AND (cm.status IS NULL OR cm.status IN ('active','approved'))
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT d.user_id, round(SUM(d.rake_amount), 2)
      FROM public.club_rake_daily_user d
     WHERE d.club_id = p_club_id
     GROUP BY d.user_id;
END;
$$;

COMMENT ON FUNCTION public.fn_club_member_lifetime_rake(uuid) IS
  'Lifetime rake per member of one club, summed from club_rake_daily_user - the same source the agent downline and union rake ledger use. Read-only. Answers only for a club the caller belongs to. Replaces the abandoned club_members.total_rake_paid mirror as the roster display source.';

REVOKE ALL ON FUNCTION public.fn_club_member_lifetime_rake(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_member_lifetime_rake(uuid) TO authenticated, service_role;

COMMENT ON COLUMN public.club_members.total_rake_paid IS
  'ABANDONED MIRROR - DO NOT READ. Its only writer, increment_rake_generated(uuid,uuid,numeric), has no callers; on 2026-08-31 it held 5,555.00 chips against 3,520,325.33 of real lifetime rake and agreed with the truth on zero of 1,471 members. The source of truth is club_rake_daily_user; read it through fn_club_member_lifetime_rake(club_id).';

COMMENT ON FUNCTION public.increment_rake_generated(uuid, uuid, numeric) IS
  'DEAD WRITER. Updates club_members.total_rake_paid, an abandoned mirror nothing reads for money. No callers in the database or in any repository as of 2026-08-31. Kept only so an unknown service_role caller does not get a missing-function error; do not add new callers.';

-- ── POST-APPLY ASSERTIONS ──────────────────────────────────────────────────
DO $verify$
DECLARE v_acl text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_club_member_lifetime_rake') THEN
    RAISE EXCEPTION 'fn_club_member_lifetime_rake is not present';
  END IF;

  SELECT p.proacl::text INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_member_lifetime_rake';

  IF v_acl LIKE '%anon=X%' THEN
    RAISE EXCEPTION 'fn_club_member_lifetime_rake is executable by anon';
  END IF;
  IF v_acl NOT LIKE '%authenticated=X%' THEN
    RAISE EXCEPTION 'fn_club_member_lifetime_rake is not executable by authenticated - the roster cannot call it';
  END IF;

  -- It must be read-only. A definer function that can write is a different
  -- class of object and is gated by check-definer-authorization.mjs.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_club_member_lifetime_rake'
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'fn_club_member_lifetime_rake is not STABLE';
  END IF;
END
$verify$;
