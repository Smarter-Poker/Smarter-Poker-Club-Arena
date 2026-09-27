-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820150755 "union_law_h6_expand_sub_agents_and_link_tiers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b0aa068411c51bb6ab5450b84e1f250c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- H6 — SUB-AGENTS UNDER AGENTS, AND EVERY TIER LINKED (2026-08-20)
--
-- Two gaps after H4:
--   * Only 4 sub-agents existed across 75 agents, so "agents with sub agents
--     under them" was barely represented.
--   * club_members.agent_id was set for players but NOT for the agent tiers,
--     so a sub-agent's or agent's membership row did not show their upline
--     even though agents.parent_agent_id did. Two views of the same hierarchy
--     disagreeing is how reporting drifts.
--
-- This promotes more horses to sub_agent (spread across DIFFERENT agents so
-- the tier is genuinely represented), moves a slice of each new sub-agent's
-- upline players beneath them so sub-agents have real downlines, and mirrors
-- the tier hierarchy onto club_members.agent_id.
--
-- Owners and super agents are top of chain and correctly keep no upline.
-- ============================================================================

DO $$
DECLARE
  v_club uuid;
  v_clubs uuid[] := ARRAY['a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
                          'a0000000-0000-0000-0000-000000000001'::uuid];
  v_agent record;
  v_uid uuid; v_new_id uuid; v_rate numeric; v_pb numeric;
  v_made int := 0; v_moved int := 0; v_n int;
BEGIN
  FOREACH v_club IN ARRAY v_clubs LOOP
    -- Give roughly every third agent a sub-agent beneath them.
    FOR v_agent IN
      SELECT a.id, a.user_id, a.commission_rate,
             row_number() OVER (ORDER BY a.id) AS rn
        FROM agents a
       WHERE a.status='active' AND a.role='agent' AND a.club_id = v_club
    LOOP
      CONTINUE WHEN (v_agent.rn % 3) <> 1;      -- ~1 in 3 agents gets one

      SELECT cm.user_id INTO v_uid
        FROM club_members cm
        JOIN profiles p ON p.id = cm.user_id AND p.is_horse
       WHERE cm.club_id = v_club
         AND cm.role = 'player'
         AND NOT EXISTS (SELECT 1 FROM agents a2 WHERE a2.user_id = cm.user_id AND a2.club_id = v_club)
       ORDER BY md5(cm.user_id::text || 'subx' || v_agent.id::text)
       LIMIT 1;
      CONTINUE WHEN v_uid IS NULL;

      -- Sub-agent 20-30%, and never above their own agent's rate less the gap.
      v_rate := LEAST(
                  round((0.20 + (abs(hashtextextended(v_uid::text, 17)) % 11) / 100.0)::numeric, 2),
                  GREATEST(round((v_agent.commission_rate - 0.10)::numeric, 2), 0.20));
      v_pb   := GREATEST(LEAST(0.50, round((v_rate - 0.10)::numeric, 2)), 0.05);

      INSERT INTO agents (user_id, club_id, role, status, commission_rate,
                          player_rakeback_rate, parent_agent_id, is_prepaid, credit_limit, joined_at)
      VALUES (v_uid, v_club, 'sub_agent', 'active', v_rate, v_pb, v_agent.id, true, 0, now())
      RETURNING id INTO v_new_id;

      UPDATE club_members
         SET role = 'sub_agent', agent_id = v_agent.user_id, updated_at = now()
       WHERE user_id = v_uid AND club_id = v_club;
      v_made := v_made + 1;

      -- Move a slice of that agent's players under the new sub-agent.
      WITH pick AS (
        SELECT cm.user_id
          FROM club_members cm
         WHERE cm.club_id = v_club AND cm.role = 'player'
           AND cm.agent_id = v_agent.user_id
         ORDER BY md5(cm.user_id::text || v_new_id::text)
         LIMIT 6
      )
      UPDATE club_members cm
         SET agent_id = v_uid, updated_at = now()
        FROM pick WHERE cm.user_id = pick.user_id AND cm.club_id = v_club;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_moved := v_moved + v_n;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'created % sub-agents, moved % players beneath them', v_made, v_moved;
END $$;

-- Mirror the tier hierarchy onto the membership row so both views agree.
UPDATE public.club_members cm
   SET agent_id = parent.user_id, updated_at = now()
  FROM public.agents a
  JOIN public.agents parent ON parent.id = a.parent_agent_id
 WHERE a.user_id = cm.user_id AND a.club_id = cm.club_id
   AND a.status = 'active'
   AND a.role IN ('agent','sub_agent')
   AND cm.agent_id IS DISTINCT FROM parent.user_id;

-- Re-clamp any player deal that now sits under a thinner sub-agent.
UPDATE public.club_members cm
   SET player_rakeback_pct = round((floor((a.commission_rate*100) - 10) / 100.0)::numeric, 4),
       rakeback_rate       = round((floor((a.commission_rate*100) - 10) / 100.0)::numeric, 2),
       updated_at = now()
  FROM public.agents a
 WHERE a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status='active'
   AND COALESCE(cm.player_rakeback_pct,0) > 0
   AND cm.player_rakeback_pct * 100 > floor((a.commission_rate * 100) - 10);

UPDATE public.club_members
   SET player_rakeback_pct = 0, rakeback_rate = 0, updated_at = now()
 WHERE COALESCE(player_rakeback_pct,0) > 0 AND player_rakeback_pct < 0.10;

UPDATE public.agents a
   SET total_players = (SELECT count(*) FROM club_members cm
                         WHERE cm.agent_id = a.user_id AND cm.club_id = a.club_id),
       sub_agent_count = (SELECT count(*) FROM agents s
                           WHERE s.parent_agent_id = a.id AND s.status='active'),
       updated_at = now()
 WHERE a.status = 'active';

