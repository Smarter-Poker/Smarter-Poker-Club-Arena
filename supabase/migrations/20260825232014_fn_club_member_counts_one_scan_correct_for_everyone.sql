-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825232014; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- MembershipService.getMemberCounts fired THREE exact counts over the same
-- club_members partition - total, active, pending - and every one of them was
-- RLS-filtered, so all three returned 0 to anyone who is not a member of the
-- club. Same defect as fn_get_club_member_count (20260825460000), three more
-- times, on the club-home path.
--
-- A 2026-08-24 note already sits on that code observing that three sequential
-- exact counts were expensive and making them parallel. Parallel was the right
-- call and it did not touch either real problem: there are still three scans,
-- and the numbers are still the viewer's view rather than the club's.
--
-- MEASURED, as the club owner who can see all 588 rows, three runs:
--   the three counts .......... 174.5 ms
--   this function ............. see below
-- and for a non-member all three read 0 against a true 588.
--
-- One pass with FILTER gives all three from a single scan, and SECURITY DEFINER
-- makes them the club's numbers instead of the caller's.
--
-- `active` adopts the RPC family's rule, `status IS NULL OR status IN
-- ('active','approved')`, where the client used only the IN list. There are 0
-- rows with a NULL status platform-wide so the two agree today; adopting the
-- family's rule makes them agree tomorrow too, and the assertion below pins
-- that against fn_get_club_member_count rather than trusting it.
--
-- `total` is deliberately unfiltered, matching the call site it replaces.

CREATE OR REPLACE FUNCTION public.fn_club_member_counts(p_club_id uuid)
RETURNS TABLE (total bigint, active bigint, pending bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT
    count(*)                                                                   AS total,
    count(*) FILTER (WHERE status IS NULL OR status IN ('active','approved'))  AS active,
    count(*) FILTER (WHERE status = 'pending')                                 AS pending
  FROM club_members
  WHERE club_id = p_club_id;
$function$;

COMMENT ON FUNCTION public.fn_club_member_counts(uuid) IS
  'Total / active / pending member counts for one club, from a single scan. SECURITY DEFINER because a club''s member count is a property of the club, not of who is asking - a direct count is RLS-filtered and returns 0 to non-members.';

REVOKE ALL ON FUNCTION public.fn_club_member_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_club_member_counts(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_club_member_counts(uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public' AND p.proname='fn_club_member_counts') THEN
    RAISE EXCEPTION 'fn_club_member_counts is not SECURITY DEFINER; it would return 0 to non-members.';
  END IF;

  -- Its `active` must equal what the rest of the family already answers, on
  -- EVERY club, or this has introduced a fourth definition of "active member".
  IF EXISTS (
    SELECT 1 FROM (SELECT club_id FROM club_members GROUP BY club_id) c
    WHERE (SELECT f.active FROM fn_club_member_counts(c.club_id) f)
          IS DISTINCT FROM fn_get_club_member_count(c.club_id)
  ) THEN
    RAISE EXCEPTION 'fn_club_member_counts.active disagrees with fn_get_club_member_count on at least one club.';
  END IF;

  -- And total must never be less than active, which would mean the filter is
  -- counting rows the unfiltered count does not see.
  IF EXISTS (
    SELECT 1 FROM (SELECT club_id FROM club_members GROUP BY club_id) c
    CROSS JOIN LATERAL fn_club_member_counts(c.club_id) f
    WHERE f.total < f.active OR f.total < f.pending
  ) THEN
    RAISE EXCEPTION 'fn_club_member_counts returned a total smaller than one of its own subsets.';
  END IF;
END $$;
