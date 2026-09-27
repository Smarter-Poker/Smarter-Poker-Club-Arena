-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820150104 "union_law_h4_normalize_tiers_link_orphans_reclamp"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a5e59c8f3fc08bf9c0a578ac36e32149 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- H4 — NORMALISE EVERY TIER, LINK ORPHANS, RE-CLAMP PLAYER DEALS (2026-08-20)
--
-- The 68 pre-existing agents predate the tier model and sat outside the
-- owner's bands (a super agent on 48%, agents on 67-70% — above the agent
-- ceiling), and none had a parent, so no override could ever cascade.
--
-- This brings the whole population into the stated structure:
--   super_agent 60-70%,  agent 20-50%,  sub_agent 20-30%
-- links every agent/sub-agent to an upline in its own club, and then
-- RE-CLAMPS player rakeback, because lowering an upline's rate can otherwise
-- leave a player's deal exceeding it or breaching the 10-point gap.
-- ============================================================================

-- 1. Rates into the correct band for the role (deterministic per agent).
UPDATE public.agents a
   SET commission_rate = CASE a.role
         WHEN 'super_agent' THEN round((0.60 + (abs(hashtextextended(a.id::text, 3)) % 11) / 100.0)::numeric, 2)
         WHEN 'agent'       THEN round((0.20 + (abs(hashtextextended(a.id::text, 3)) % 31) / 100.0)::numeric, 2)
         WHEN 'sub_agent'   THEN round((0.20 + (abs(hashtextextended(a.id::text, 3)) % 11) / 100.0)::numeric, 2)
         ELSE a.commission_rate END,
       updated_at = now()
 WHERE a.status = 'active'
   AND a.club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
                     'a0000000-0000-0000-0000-000000000001');

-- 2. Default player rakeback offered by each agent: never above their own
--    rate less the 10-point gap, and never above the 0.50 schema ceiling.
UPDATE public.agents a
   SET player_rakeback_rate = GREATEST(LEAST(0.50, round((a.commission_rate - 0.10)::numeric, 2)), 0.05),
       updated_at = now()
 WHERE a.status = 'active'
   AND a.club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
                     'a0000000-0000-0000-0000-000000000001');

-- 3. Every agent reports to a super agent; every sub-agent to an agent.
WITH supers AS (
  SELECT id, club_id,
         row_number() OVER (PARTITION BY club_id ORDER BY id) AS rn,
         count(*)     OVER (PARTITION BY club_id) AS n
    FROM agents WHERE status='active' AND role='super_agent'
)
UPDATE public.agents a
   SET parent_agent_id = s.id, updated_at = now()
  FROM supers s
 WHERE a.status='active' AND a.role='agent' AND a.parent_agent_id IS NULL
   AND s.club_id = a.club_id
   AND s.rn = (abs(hashtextextended(a.id::text, 5)) % s.n) + 1;

WITH ags AS (
  SELECT id, club_id,
         row_number() OVER (PARTITION BY club_id ORDER BY id) AS rn,
         count(*)     OVER (PARTITION BY club_id) AS n
    FROM agents WHERE status='active' AND role='agent'
)
UPDATE public.agents a
   SET parent_agent_id = g.id, updated_at = now()
  FROM ags g
 WHERE a.status='active' AND a.role='sub_agent' AND a.parent_agent_id IS NULL
   AND g.club_id = a.club_id
   AND g.rn = (abs(hashtextextended(a.id::text, 9)) % g.n) + 1;

-- 4. Re-clamp player deals against the (possibly reduced) upline rate.
UPDATE public.club_members cm
   SET player_rakeback_pct = round((LEAST(cm.player_rakeback_pct * 100,
                                          floor((a.commission_rate * 100) - 10)) / 100.0)::numeric, 4),
       rakeback_rate       = round((LEAST(cm.player_rakeback_pct * 100,
                                          floor((a.commission_rate * 100) - 10)) / 100.0)::numeric, 2),
       updated_at = now()
  FROM public.agents a
 WHERE a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status='active'
   AND COALESCE(cm.player_rakeback_pct,0) > 0
   AND cm.player_rakeback_pct * 100 > floor((a.commission_rate * 100) - 10);

-- 5. A deal that can no longer clear 10 points is withdrawn entirely.
UPDATE public.club_members cm
   SET player_rakeback_pct = 0, rakeback_rate = 0, updated_at = now()
 WHERE COALESCE(cm.player_rakeback_pct,0) > 0
   AND cm.player_rakeback_pct < 0.10;

-- 6. Keep the membership role in step with the agent tier.
UPDATE public.club_members cm
   SET role = a.role, updated_at = now()
  FROM public.agents a
 WHERE a.user_id = cm.user_id AND a.club_id = cm.club_id AND a.status='active'
   AND cm.role NOT IN ('owner','admin')
   AND cm.role IS DISTINCT FROM a.role;

