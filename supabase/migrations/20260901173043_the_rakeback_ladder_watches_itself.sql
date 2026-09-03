-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901173043; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =============================================================================
-- the_rakeback_ladder_watches_itself
--
-- Dan's rakeback law (Deep Stack directive): every immediate upline keeps at
-- least 10 percentage points over its immediate downline, nobody sits below
-- 10%, a super agent's direct player never exceeds 50%, and every player has
-- exactly one upline. Those held at funding time because a human checked.
-- Nothing has watched them SINCE - a promotion, a rate edit, or a hierarchy
-- move could silently break the ladder and the first symptom would be a
-- wrong commission payout.
--
-- fn_club_rakeback_margin_violations(club) returns one row per violation,
-- with the edge, both rates, and the rule broken. Zero rows = healthy
-- ladder. Read-only, service_role + authenticated bank roles can call it;
-- it inspects agents.commission_rate for manager edges and
-- club_members.rakeback_rate for player edges, exactly the columns the live
-- commission function (credit_agent_commission_from_rake) consumes.
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
  -- manager -> manager edges (agents table is what commissions read)
  SELECT 'manager_margin_under_10'::text,
         p.user_id, p.role, p.commission_rate,
         c.user_id, c.role, c.commission_rate
    FROM agents c JOIN agents p ON p.id = c.parent_agent_id
   WHERE c.club_id = p_club_id AND p.club_id = p_club_id
     AND (p.commission_rate - c.commission_rate) < 0.10

  UNION ALL
  -- manager -> player edges
  SELECT 'player_margin_under_10',
         a.user_id, a.role, a.commission_rate,
         cm.user_id, cm.role, cm.rakeback_rate
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id
   WHERE cm.club_id = p_club_id AND cm.role = 'player'
     AND (a.commission_rate - cm.rakeback_rate) < 0.10

  UNION ALL
  -- nobody below the 10% floor
  SELECT 'player_below_10_percent',
         a.user_id, a.role, a.commission_rate,
         cm.user_id, cm.role, cm.rakeback_rate
    FROM club_members cm
    LEFT JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id
   WHERE cm.club_id = p_club_id AND cm.role = 'player'
     AND cm.rakeback_rate < 0.10

  UNION ALL
  -- super agent direct players capped at 50%
  SELECT 'sa_direct_player_over_50',
         a.user_id, a.role, a.commission_rate,
         cm.user_id, cm.role, cm.rakeback_rate
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id
   WHERE cm.club_id = p_club_id AND cm.role = 'player'
     AND a.role = 'super_agent' AND cm.rakeback_rate > 0.50

  UNION ALL
  -- a player with no resolvable upline is outside the ladder entirely
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

-- assertion: Deep Stack's ladder is healthy right now, so the watchdog must
-- return zero rows; if it returns any, either the ladder broke or the
-- watchdog lies, and both stop this migration.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM fn_club_rakeback_margin_violations('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'watchdog reports % violations on a ladder verified healthy', v_n;
  END IF;
END $$;
