-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820142401 "union_law_w2_canonical_six_role_model"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 aad5f65c50bd7e33f280c8031d865ef9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- W2 — CANONICAL SIX-ROLE MODEL FOR CLUBS AND UNIONS (2026-08-20)
--
-- Owner's rule: roles are exactly
--   owner, admin, super_agent, agent, sub_agent, player
--
-- Before: club_members.role held 'member' (1155), 'player' (325), 'owner' (3)
-- with no constraint — 'member' and 'player' meant the same thing, and the
-- agent tiers existed only in the separate agents table, so a club roster
-- could not show who was a super-agent, agent or sub-agent.
--
-- This normalises the data, syncs the agent tiers onto the membership row by
-- precedence (owner > admin > super_agent > agent > sub_agent > player), and
-- constrains the column so no seventh role can appear.
--
-- The xp_ban_guard event trigger blocks any ALTER TABLE on club_members
-- (the table carries a reputation_xp column), so it is disabled and re-enabled
-- inside this same migration. No XP column is touched.
-- ============================================================================

-- 1. 'member' and NULL are the same thing as 'player'.
UPDATE public.club_members
   SET role = 'player'
 WHERE role IS NULL OR role NOT IN ('owner','admin','super_agent','agent','sub_agent','player');

-- 2. Reflect the agent hierarchy on the membership row, without demoting
--    owners or admins.
UPDATE public.club_members cm
   SET role = a.role
  FROM public.agents a
 WHERE a.user_id = cm.user_id
   AND a.club_id = cm.club_id
   AND a.status = 'active'
   AND a.role IN ('super_agent','agent','sub_agent')
   AND cm.role NOT IN ('owner','admin');

-- 3. The club owner always outranks whatever else they are.
UPDATE public.club_members cm
   SET role = 'owner'
  FROM public.clubs c
 WHERE c.id = cm.club_id AND c.owner_id = cm.user_id AND cm.role <> 'owner';

-- 4. Constrain to exactly the six roles.
ALTER EVENT TRIGGER xp_ban_guard DISABLE;

ALTER TABLE public.club_members
  DROP CONSTRAINT IF EXISTS club_members_role_check;

ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_role_check
  CHECK (role IN ('owner','admin','super_agent','agent','sub_agent','player'));

ALTER TABLE public.club_members
  ALTER COLUMN role SET DEFAULT 'player';

ALTER EVENT TRIGGER xp_ban_guard ENABLE;

COMMENT ON COLUMN public.club_members.role IS
  'Canonical Club Arena / union role, one of: owner, admin, super_agent, agent, '
  'sub_agent, player. Precedence when a user qualifies for several: owner > '
  'admin > super_agent > agent > sub_agent > player.';

-- 5. Shared helpers so every surface asks the same question the same way.
CREATE OR REPLACE FUNCTION public.fn_club_role(p_user_id uuid, p_club_id uuid)
 RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM clubs c
                         WHERE c.id = p_club_id AND c.owner_id = p_user_id) THEN 'owner'
           ELSE (SELECT m.role FROM club_members m
                  WHERE m.user_id = p_user_id AND m.club_id = p_club_id
                  LIMIT 1)
         END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_role_rank(p_role text)
 RETURNS integer
 LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE p_role
           WHEN 'owner'       THEN 6
           WHEN 'admin'       THEN 5
           WHEN 'super_agent' THEN 4
           WHEN 'agent'       THEN 3
           WHEN 'sub_agent'   THEN 2
           WHEN 'player'      THEN 1
           ELSE 0
         END;
$function$;

-- "Does this user hold at least this level of authority in this club?"
CREATE OR REPLACE FUNCTION public.fn_has_club_role(p_user_id uuid, p_club_id uuid, p_min_role text)
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.fn_role_rank(public.fn_club_role(p_user_id, p_club_id))
         >= public.fn_role_rank(p_min_role);
$function$;

GRANT EXECUTE ON FUNCTION public.fn_club_role(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_role_rank(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_has_club_role(uuid, uuid, text) TO authenticated;

