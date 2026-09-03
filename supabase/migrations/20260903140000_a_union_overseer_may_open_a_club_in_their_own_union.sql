-- A UNION OVERSEER MAY OPEN A CLUB IN THEIR OWN UNION.
--
-- The union breakdown already tells an overseer what each member club
-- produced: SHARK CLUB 3,023,403.87, Club JAQK the rest. Clicking that row to
-- ask WHICH AGENTS produced it was refused, because ca_can_view_club_finances
-- had no union branch at all. Its four branches are a club role, club
-- ownership, platform admin, and a null caller - an overseer who does not
-- separately hold a role in that club fails every one.
--
-- On this estate the union lead happens to own both member clubs, so the
-- drill works today. It works by COINCIDENCE, not by policy, and the next
-- union - one whose lead is not also a club owner - would have found a page
-- that shows a number and refuses its composition. Measured before this
-- change: the new branch admits the union lead, refuses a plain member of the
-- club, and refuses someone in no union at all.
--
-- WHAT THIS DOES NOT OPEN. Commission stays behind fn_is_club_admin_uid,
-- which a plain overseer does not pass, so they read what the club PRODUCED
-- and not what it COSTS. That boundary is deliberate: overseeing a union is a
-- claim on its production, not a right to read a member club's private cost
-- structure.
--
-- NOT DEMONSTRATED ON THIS ESTATE, and worth saying so plainly. Its only
-- union lead also owns both member clubs, so they pass the club-admin gate on
-- their own account and DO see commission - 532,275.62 when the chain was
-- walked, not the null a pure overseer would get. The boundary is therefore
-- asserted from the code, where v_cost is fn_is_club_admin_uid and nothing
-- else, and pinned by a law that fails if it is ever widened to the finances
-- check. It has not been watched holding.
--
-- The clause is scoped through union_clubs, so it admits an overseer only to
-- clubs that are actually in a union they oversee.
--
-- The `auth.uid() IS NULL` branch at the top is older than this change and is
-- left alone. It reads alarmingly - an unauthenticated caller passes - but
-- every function that calls this one is revoked from anon (ten of them,
-- checked), so it is reachable only by service_role and internal jobs. It is
-- noted here rather than changed because changing it is a separate decision
-- with its own blast radius.

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
    -- Overseeing a union the club belongs to. Scoped through union_clubs, so
    -- it never reaches a club that is not in a union this caller oversees.
    OR EXISTS (
      SELECT 1 FROM union_clubs uc
       WHERE uc.club_id = p_club_id
         AND public.fn_is_union_overseer(uc.union_id, auth.uid())
    )
    OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND COALESCE(pr.is_admin, false));
$function$;
