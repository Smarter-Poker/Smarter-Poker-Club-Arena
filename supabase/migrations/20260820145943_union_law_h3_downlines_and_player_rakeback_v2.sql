-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820145943 "union_law_h3_downlines_and_player_rakeback_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 908440efd8f38d7d37f78bad7eea6ad2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- H3 — DOWNLINES AND PLAYER RAKEBACK (2026-08-20)
--
-- Assigns unassigned club members to an agent-tier upline in their own club,
-- then gives a share of them an individual rakeback deal.
--
-- Owner's rule for player rakeback: random 10-50%, never more than the upline
-- receives, and almost always leaving at least a 10-point gap. So the rate is
-- random(10..50) clamped to (upline_rate - 10); a player whose upline is too
-- thin to leave the gap gets no deal at all rather than one that would invert
-- the economics. About 55% of players get a deal — not everyone negotiates.
--
-- Rates are stored as FRACTIONS to match the rest of the schema
-- (fn_create_agent validates commission 0-0.7 and player rakeback 0-0.5, and
-- club_members.player_rakeback_pct is numeric(5,4)).
-- ============================================================================

DO $$
DECLARE v_assigned int := 0; v_with_deal int := 0;
BEGIN
  WITH uplines AS (
    SELECT a.user_id AS agent_user_id, a.club_id,
           row_number() OVER (PARTITION BY a.club_id
                              ORDER BY public.fn_role_rank(a.role), a.id) AS slot,
           count(*)     OVER (PARTITION BY a.club_id) AS slots
      FROM agents a
     WHERE a.status = 'active'
       AND a.club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
                         'a0000000-0000-0000-0000-000000000001')
  ),
  targets AS (
    SELECT cm.user_id, cm.club_id,
           (abs(hashtextextended(cm.user_id::text, 7))
             % (SELECT max(slots) FROM uplines u2 WHERE u2.club_id = cm.club_id)) + 1 AS pick
      FROM club_members cm
     WHERE cm.agent_id IS NULL
       AND cm.role = 'player'
       AND cm.club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
                          'a0000000-0000-0000-0000-000000000001')
  )
  UPDATE club_members cm
     SET agent_id = u.agent_user_id, updated_at = now()
    FROM targets t
    JOIN uplines u ON u.club_id = t.club_id AND u.slot = t.pick
   WHERE cm.user_id = t.user_id AND cm.club_id = t.club_id;
  GET DIAGNOSTICS v_assigned = ROW_COUNT;

  WITH deals AS (
    SELECT cm.user_id, cm.club_id,
           -- random 10..50 points, clamped so the upline keeps >= 10 points
           LEAST(
             10 + (abs(hashtextextended(cm.user_id::text, 11)) % 41),
             floor((a.commission_rate * 100) - 10)
           )::numeric AS pts
      FROM club_members cm
      JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status='active'
     WHERE cm.role = 'player'
       AND cm.agent_id IS NOT NULL
       AND COALESCE(cm.player_rakeback_pct, 0) = 0
       AND (abs(hashtextextended(cm.user_id::text, 13)) % 100) < 55
  )
  UPDATE club_members cm
     SET player_rakeback_pct = round((d.pts / 100.0)::numeric, 4),
         rakeback_rate       = round((d.pts / 100.0)::numeric, 2),
         updated_at = now()
    FROM deals d
   WHERE cm.user_id = d.user_id AND cm.club_id = d.club_id
     AND d.pts >= 10;
  GET DIAGNOSTICS v_with_deal = ROW_COUNT;

  RAISE NOTICE 'assigned % players, % rakeback deals', v_assigned, v_with_deal;
END $$;

UPDATE public.agents a
   SET total_players = (SELECT count(*) FROM club_members cm
                         WHERE cm.agent_id = a.user_id AND cm.club_id = a.club_id),
       updated_at = now()
 WHERE a.status = 'active';

