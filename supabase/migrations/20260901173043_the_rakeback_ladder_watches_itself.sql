-- =============================================================================
-- the_rakeback_ladder_watches_itself
-- Applied to production via Supabase MCP 2026-09-01 17:30 UTC.
--
-- Dan's rakeback law: every immediate upline keeps at least 10 percentage
-- points over its immediate downline, nobody sits below 10%, a super agent's
-- direct player never exceeds 50%, and every player has exactly one upline.
-- Those held at funding time because a human checked. Nothing watched them
-- SINCE. fn_club_rakeback_margin_violations(club) returns one row per
-- violation; zero rows = healthy ladder. It reads agents.commission_rate for
-- manager edges and club_members.rakeback_rate for player edges, exactly the
-- columns credit_agent_commission_from_rake consumes.
-- Asserted on apply: zero violations on Deep Stack's verified-healthy ladder.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_club_rakeback_margin_violations(p_club_id uuid)
RETURNS TABLE (
  rule text,
  upline_user_id uuid,
  upline_role text,
  upline_rate numeric,
  downline_user_id uuid,
  downline_role text,
  downline_rate numeric
)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 'manager_margin_under_10'::text,
         p.user_id, p.role, p.commission_rate,
         c.user_id, c.role, c.commission_rate
    FROM agents c JOIN agents p ON p.id = c.parent_agent_id
   WHERE c.club_id = p_club_id AND p.club_id = p_club_id
     AND (p.commission_rate - c.commission_rate) < 0.10
  UNION ALL
  SELECT 'player_margin_under_10',
         a.user_id, a.role, a.commission_rate,
         cm.user_id, cm.role, cm.rakeback_rate
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id
   WHERE cm.club_id = p_club_id AND cm.role = 'player'
     AND (a.commission_rate - cm.rakeback_rate) < 0.10
  UNION ALL
  SELECT 'player_below_10_percent',
         a.user_id, a.role, a.commission_rate,
         cm.user_id, cm.role, cm.rakeback_rate
    FROM club_members cm
    LEFT JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id
   WHERE cm.club_id = p_club_id AND cm.role = 'player'
     AND cm.rakeback_rate < 0.10
  UNION ALL
  SELECT 'sa_direct_player_over_50',
         a.user_id, a.role, a.commission_rate,
         cm.user_id, cm.role, cm.rakeback_rate
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id
   WHERE cm.club_id = p_club_id AND cm.role = 'player'
     AND a.role = 'super_agent' AND cm.rakeback_rate > 0.50
  UNION ALL
  SELECT 'player_without_upline',
         NULL::uuid, NULL::text, NULL::numeric,
         cm.user_id, cm.role, cm.rakeback_rate
    FROM club_members cm
   WHERE cm.club_id = p_club_id AND cm.role = 'player'
     AND (cm.agent_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM agents a
            WHERE a.user_id = cm.agent_id AND a.club_id = cm.club_id))
$function$;

REVOKE ALL ON FUNCTION public.fn_club_rakeback_margin_violations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_rakeback_margin_violations(uuid) TO authenticated, service_role;
