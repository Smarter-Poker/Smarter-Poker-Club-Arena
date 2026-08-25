-- is_club_admin(uuid) was VOLATILE. It is a pure read:
--
--   RETURN EXISTS (SELECT 1 FROM club_members
--                   WHERE club_id = p_club_id AND user_id = auth.uid()
--                     AND role IN ('owner','admin','manager','agent'));
--
-- Nothing is written, and auth.uid() reads a GUC that cannot change part-way
-- through a statement. VOLATILE is simply what plpgsql defaults to when nobody
-- writes a volatility category, and nobody did. Its own two-argument sibling,
-- is_club_admin(uuid, uuid), is already declared STABLE - so the hot READ path
-- got the mislabelled one and the UPDATE/DELETE paths got the correct one.
--
-- HONESTY ABOUT WHAT THIS BUYS: nothing measurable, on its own. The hope was
-- that STABLE would let the planner fold `is_club_admin(club_id)` into a single
-- InitPlan, since every roster query filters `club_id = <one club>` and the
-- argument is therefore constant. It does not. Measured before and after on the
-- same query as the same user, the plan is byte-for-byte identical - the call
-- stays inline in the RLS Filter - and buffers are identical at 584. Postgres
-- does not hoist a function whose argument is a column reference merely because
-- an equality predicate makes it constant, and the STABLE sibling
-- fn_union_oversees_club(club_id, ...) sits inline in that same filter proving
-- it.
--
-- It lands anyway because VOLATILE is WRONG, not merely slow. A VOLATILE
-- function is barred from index expressions, cannot be used where the planner
-- needs a stable result, and misleads the next person reading the policy about
-- what this function does. Declaring it accurately costs nothing and removes a
-- false statement from the schema.
--
-- The real cost in that filter was measured elsewhere and fixed elsewhere: see
-- 20260825460000, which stops the roster count from going through RLS at all.
ALTER FUNCTION public.is_club_admin(uuid) STABLE;

DO $$
BEGIN
  IF (SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'is_club_admin'
         AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid') <> 's' THEN
    RAISE EXCEPTION 'is_club_admin(uuid) is not STABLE.';
  END IF;
END $$;
