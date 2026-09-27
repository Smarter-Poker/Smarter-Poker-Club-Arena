-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724032546 "ca_secure_club_members_rls_no_self_escalation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 eb6f9d27577db367e283fa009f936bcc of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SECURITY FIX (sweep #5): close club_members self-escalation → club takeover.
-- Before: INSERT with_check only required user_id = auth.uid() (no role constraint),
-- and UPDATE had NO with_check at all — so any authenticated user could self-insert
-- OR self-update their own row to role='owner'/'admin', which is_club_admin() then
-- honored, granting full control (UPDATE/DELETE) over every member of any club.
-- After: a self-serve insert/update may only result in a NON-privileged row
-- (role member/player, no credit grant, no agent linkage). Privileged rows are
-- allowed only when the actor is already a club admin/owner (is_club_admin, which
-- trusts clubs.owner_id) — this preserves createClub's owner self-insert (clubs.owner_id
-- is set first) and all legitimate admin actions. Agent/owner promotions continue to
-- flow through SECURITY DEFINER RPCs / service_role, which bypass RLS.

DROP POLICY IF EXISTS "Users can join clubs" ON public.club_members;
CREATE POLICY "Users can join clubs" ON public.club_members
  FOR INSERT
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND coalesce(credit_limit, 0) = 0
    AND coalesce(credit_used, 0) = 0
    AND agent_id IS NULL
    AND parent_agent_id IS NULL
    AND (
      role IN ('member', 'player')
      OR is_club_admin(club_id, (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS "club_members_update" ON public.club_members;
CREATE POLICY "club_members_update" ON public.club_members
  FOR UPDATE
  USING (
    user_id = (SELECT auth.uid())
    OR is_club_admin(club_id, (SELECT auth.uid()))
  )
  WITH CHECK (
    is_club_admin(club_id, (SELECT auth.uid()))
    OR (
      user_id = (SELECT auth.uid())
      AND role IN ('member', 'player')
      AND coalesce(credit_limit, 0) = 0
      AND coalesce(credit_used, 0) = 0
      AND agent_id IS NULL
      AND parent_agent_id IS NULL
    )
  );
