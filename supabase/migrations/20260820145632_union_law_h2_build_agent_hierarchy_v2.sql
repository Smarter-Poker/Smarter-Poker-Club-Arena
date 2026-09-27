-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820145632 "union_law_h2_build_agent_hierarchy_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d42d09313f3a4bdb28018044e5730e96 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- H2 — BUILD THE AGENT HIERARCHY FROM HORSES (2026-08-20)
--
--   super_agent  60-70%   2 per club
--   agent        20-50%   5 per club, reporting to a super agent
--   sub_agent    20-30%   2 per club, reporting to an agent
--
-- The agent's DEFAULT player rakeback is set to LEAST(0.50, own rate - 0.10):
-- it can never exceed what the agent themselves receives, always leaves at
-- least a 10-point gap, and respects the existing 0.50 schema ceiling on
-- player rakeback (agents_player_rakeback_rate_check).
--
-- Deterministic (setseed) and idempotent (only horses that are not already
-- agents are promoted), so re-running cannot duplicate the structure.
-- ============================================================================

DO $$
DECLARE
  v_club uuid;
  v_clubs uuid[] := ARRAY['a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
                          'a0000000-0000-0000-0000-000000000001'::uuid];
  v_super uuid[]; v_agent uuid[];
  v_uid uuid; v_agent_id uuid; v_parent uuid;
  v_rate numeric; v_pb numeric; i int; j int;
BEGIN
  PERFORM setseed(0.42);

  FOREACH v_club IN ARRAY v_clubs LOOP
    v_super := ARRAY[]::uuid[];
    v_agent := ARRAY[]::uuid[];

    FOR i IN 1..2 LOOP
      SELECT cm.user_id INTO v_uid
        FROM club_members cm JOIN profiles p ON p.id = cm.user_id AND p.is_horse
       WHERE cm.club_id = v_club
         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = cm.user_id AND a.club_id = v_club)
       ORDER BY md5(cm.user_id::text || 'super' || i::text) LIMIT 1;
      CONTINUE WHEN v_uid IS NULL;

      v_rate := round((0.60 + random() * 0.10)::numeric, 2);
      v_pb   := GREATEST(LEAST(0.50, round((v_rate - 0.10)::numeric, 2)), 0.05);
      INSERT INTO agents (user_id, club_id, role, status, commission_rate,
                          player_rakeback_rate, is_prepaid, credit_limit, joined_at)
      VALUES (v_uid, v_club, 'super_agent', 'active', v_rate, v_pb, false, 500000, now())
      RETURNING id INTO v_agent_id;

      v_super := array_append(v_super, v_agent_id);
      UPDATE club_members SET role='super_agent', updated_at=now()
       WHERE user_id=v_uid AND club_id=v_club AND role NOT IN ('owner','admin');
    END LOOP;

    FOR i IN 1..5 LOOP
      SELECT cm.user_id INTO v_uid
        FROM club_members cm JOIN profiles p ON p.id = cm.user_id AND p.is_horse
       WHERE cm.club_id = v_club
         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = cm.user_id AND a.club_id = v_club)
       ORDER BY md5(cm.user_id::text || 'agent' || i::text) LIMIT 1;
      CONTINUE WHEN v_uid IS NULL;

      v_parent := v_super[1 + (i % GREATEST(array_length(v_super,1),1))];
      v_rate := round((0.20 + random() * 0.30)::numeric, 2);
      v_pb   := GREATEST(LEAST(0.50, round((v_rate - 0.10)::numeric, 2)), 0.05);
      INSERT INTO agents (user_id, club_id, role, status, commission_rate,
                          player_rakeback_rate, parent_agent_id, is_prepaid, credit_limit, joined_at)
      VALUES (v_uid, v_club, 'agent', 'active', v_rate, v_pb, v_parent, false, 150000, now())
      RETURNING id INTO v_agent_id;

      v_agent := array_append(v_agent, v_agent_id);
      UPDATE club_members SET role='agent', updated_at=now()
       WHERE user_id=v_uid AND club_id=v_club AND role NOT IN ('owner','admin','super_agent');
    END LOOP;

    FOR j IN 1..2 LOOP
      SELECT cm.user_id INTO v_uid
        FROM club_members cm JOIN profiles p ON p.id = cm.user_id AND p.is_horse
       WHERE cm.club_id = v_club
         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = cm.user_id AND a.club_id = v_club)
       ORDER BY md5(cm.user_id::text || 'sub' || j::text) LIMIT 1;
      CONTINUE WHEN v_uid IS NULL;

      v_parent := v_agent[1 + (j % GREATEST(array_length(v_agent,1),1))];
      v_rate := round((0.20 + random() * 0.10)::numeric, 2);
      v_pb   := GREATEST(LEAST(0.50, round((v_rate - 0.10)::numeric, 2)), 0.05);
      INSERT INTO agents (user_id, club_id, role, status, commission_rate,
                          player_rakeback_rate, parent_agent_id, is_prepaid, credit_limit, joined_at)
      VALUES (v_uid, v_club, 'sub_agent', 'active', v_rate, v_pb, v_parent, true, 0, now())
      RETURNING id INTO v_agent_id;

      UPDATE club_members SET role='sub_agent', updated_at=now()
       WHERE user_id=v_uid AND club_id=v_club
         AND role NOT IN ('owner','admin','super_agent','agent');
    END LOOP;
  END LOOP;
END $$;

