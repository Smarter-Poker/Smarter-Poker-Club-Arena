-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820135503 "union_law_p8_integrity_sweep_by_agent"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8ccaf87fe0c288da28ea3ec0a8631e6e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P8 — UNION INTEGRITY SWEEP, SCORED BY AGENT (2026-08-20)
--
-- detect_collusion_pairs exists but requires auth.uid() and is scoped to a
-- single club, so it can only ever be run by hand by a club admin — it has no
-- cron and had never run unattended.
--
-- PokerBros' structural insight is that integrity is an AGENT problem, not a
-- player problem: a bot or a colluding ring has to be funded by an agent and
-- must be explained by that agent every settlement cycle. So the sweep scores
-- the accountable layer.
--
-- Three signals, all computable from existing data:
--   * agent_roster_winning  — an agent's players winning far more than the rake
--     they generate (the "why does this account keep winning" question).
--   * direct_chip_transfer  — player-to-player chip movement, the clearest
--     chip-dump signature.
--   * co_seating            — pairs of players who almost only ever sit
--     together, which is how ring collusion looks in seat data.
-- Findings are written to financial_alerts, de-duplicated per day.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001', p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := now() - make_interval(hours => GREATEST(p_hours,1));
  v_agent_flags jsonb := '[]'::jsonb;
  v_dump_flags jsonb := '[]'::jsonb;
  v_coseat_flags jsonb := '[]'::jsonb;
  v_total int := 0;
BEGIN
  -- 1. Agents whose roster is winning heavily relative to the rake it makes.
  WITH roster AS (
    SELECT m.agent_id, m.user_id AS player_id
      FROM club_members m
      JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = p_union_id
     WHERE m.agent_id IS NOT NULL
  ),
  net AS (
    SELECT r.agent_id,
           SUM(CASE WHEN wt.type='credit' AND wt.category IN ('cashout','prize','bounty') THEN wt.amount ELSE 0 END)
         - SUM(CASE WHEN wt.type='debit'  AND wt.category IN ('buyin','rebuy','addon','tournament_buyin') THEN wt.amount ELSE 0 END) AS player_net,
           COUNT(DISTINCT r.player_id) AS players
      FROM roster r
      JOIN wallet_transactions wt ON wt.user_id = r.player_id AND wt.created_at >= v_from
     GROUP BY r.agent_id
  ),
  rake AS (
    SELECT r.agent_id,
           SUM(rr.rake_amount * (e.value::numeric) / NULLIF(c.total,0)) AS rake
      FROM rake_records rr
      CROSS JOIN LATERAL (SELECT SUM(t.value::numeric) AS total
                            FROM jsonb_each_text(rr.player_contributions) t(key,value)) c
      CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) e(key,value)
      JOIN roster r ON r.player_id = (e.key)::uuid
     WHERE rr.created_at >= v_from AND rr.player_contributions IS NOT NULL AND c.total > 0
     GROUP BY r.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_user_id', n.agent_id, 'players', n.players,
           'player_net', round(n.player_net,2), 'rake_generated', round(COALESCE(k.rake,0),2),
           'win_to_rake_ratio', round(n.player_net / NULLIF(COALESCE(k.rake,0),0), 2))), '[]'::jsonb)
    INTO v_agent_flags
    FROM net n LEFT JOIN rake k ON k.agent_id = n.agent_id
   WHERE n.player_net > 0
     AND n.player_net > 10 * GREATEST(COALESCE(k.rake,0), 1);

  -- 2. Direct player-to-player chip movement (neither side an agent).
  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_dump_flags FROM (
    SELECT jsonb_build_object(
             'from_user', ct.from_user_id, 'to_user', ct.to_user_id,
             'transfers', count(*), 'total', round(sum(ct.amount),2)) AS x
      FROM chip_transactions ct
     WHERE ct.created_at >= v_from
       AND ct.from_user_id IS NOT NULL AND ct.to_user_id IS NOT NULL
       AND ct.transaction_type NOT IN ('agent_to_player_transfer','rakeback','buyin','cashout')
       AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = ct.from_user_id)
     GROUP BY ct.from_user_id, ct.to_user_id
    HAVING sum(ct.amount) > 0
  ) s;

  -- 3. Pairs who essentially only ever sit together.
  SELECT COALESCE(jsonb_agg(y), '[]'::jsonb) INTO v_coseat_flags FROM (
    SELECT jsonb_build_object('player_a', a.user_id, 'player_b', b.user_id,
                              'shared_tables', count(DISTINCT a.table_id)) AS y
      FROM table_seats a
      JOIN table_seats b ON b.table_id = a.table_id AND b.user_id > a.user_id
      JOIN tables t ON t.id = a.table_id AND t.union_id = p_union_id
     WHERE a.joined_at >= v_from AND b.joined_at >= v_from
     GROUP BY a.user_id, b.user_id
    HAVING count(DISTINCT a.table_id) >= 8
     ORDER BY count(DISTINCT a.table_id) DESC
     LIMIT 20
  ) s2;

  v_total := jsonb_array_length(v_agent_flags)
           + jsonb_array_length(v_dump_flags)
           + jsonb_array_length(v_coseat_flags);

  IF v_total > 0
     AND NOT EXISTS (SELECT 1 FROM financial_alerts
                      WHERE source = 'fn_union_integrity_sweep'
                        AND created_at > now() - interval '20 hours') THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_union_integrity_sweep',
            'Union integrity sweep raised ' || v_total || ' signal(s) — review by agent',
            jsonb_build_object('union_id', p_union_id, 'window_hours', p_hours,
                               'agent_roster_winning', v_agent_flags,
                               'direct_chip_transfer', v_dump_flags,
                               'co_seating', v_coseat_flags));
  END IF;

  RETURN jsonb_build_object(
    'union_id', p_union_id, 'window_hours', p_hours, 'signals', v_total,
    'agent_roster_winning', v_agent_flags,
    'direct_chip_transfer', v_dump_flags,
    'co_seating', v_coseat_flags);
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_union_integrity_sweep(uuid, integer) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'union-integrity-sweep') THEN
    PERFORM cron.unschedule('union-integrity-sweep');
  END IF;
  PERFORM cron.schedule('union-integrity-sweep', '35 * * * *',
                        'SELECT public.fn_union_integrity_sweep();');
END $$;

