-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825223043; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- is_club_admin(uuid) was VOLATILE. It is a pure read:
--
--   RETURN EXISTS (SELECT 1 FROM club_members
--                   WHERE club_id = p_club_id AND user_id = auth.uid()
--                     AND role IN ('owner','admin','manager','agent'));
--
-- Nothing is written, and auth.uid() reads a GUC that cannot change part-way
-- through a statement. VOLATILE is simply what plpgsql defaults to when nobody
-- writes a volatility category, and nobody did. Its own two-argument sibling,
-- is_club_admin(uuid, uuid), is already declared STABLE - so the READ path got
-- the slow one and the UPDATE/DELETE paths got the fast one, which is exactly
-- backwards from what matters.
--
-- WHY IT COSTS. This function is in the `Club staff can read club rosters`
-- SELECT policy on club_members, so it is in the RLS filter of every roster read
-- the Club Arena footer pages make - Players, Profile, Cashier and Data all read
-- that table. A VOLATILE function must be re-evaluated for every row and can
-- never be folded, hoisted or cached.
--
-- The waste is specific and visible in the plan. Every roster query filters
-- `club_id = <one club>`, so `is_club_admin(club_id)` has a CONSTANT argument
-- and should collapse to a single InitPlan evaluated once. The other policy
-- functions on the same table are STABLE and do exactly that - the plan shows
-- them as InitPlan 2..6. `is_club_admin(club_id)` stayed inline in the Filter,
-- alone, because VOLATILE forbids the transformation.
--
-- Measured before, as the club owner, 11 visible rows:
--   Index Scan ... Filter: (... OR is_club_admin(club_id) OR ...)
--   Buffers: shared hit=584     Execution Time: 26.8 ms
--
-- In production this statement shape ran 591 times at a 253 ms mean and a
-- 1,882 ms max - 150 seconds of database time - and it returns ONE row per call,
-- because PostgREST also computes an exact count(*) over the same predicate for
-- the pagination header.
--
-- STABLE is the correct category, not merely the faster one: the function's
-- result genuinely cannot change within a statement.
ALTER FUNCTION public.is_club_admin(uuid) STABLE;

DO $$
BEGIN
  IF (SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'is_club_admin'
         AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid') <> 's' THEN
    RAISE EXCEPTION 'is_club_admin(uuid) is not STABLE; the RLS filter will still be evaluated per row.';
  END IF;
END $$;
