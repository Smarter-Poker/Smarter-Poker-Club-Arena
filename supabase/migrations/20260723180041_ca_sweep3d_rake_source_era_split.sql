-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723180041 "ca_sweep3d_rake_source_era_split"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 127dafb82d3213b58c8fa65006fe0a05 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.
-- unqualified-write-ok: _scope_clubs because it is a temporary table the same function builds and
--   empties; this file records SQL production already executed as 20260723180041, and no live
--   function body carries this statement any more (pg_proc read 2026-09-27).

-- Sweep #3d: rake_history stopped receiving writes 2026-05-01; the engine now
-- writes rake_records (live). The two overlap (double-written) from
-- rake_records' first row until rake_history's last, so rake is summed as:
--   rake_records rows in-window  +  rake_history rows in-window BEFORE rake_records began.
CREATE OR REPLACE FUNCTION public.generate_period_settlements(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_period record;
  v_club record;
  v_rr_start timestamptz;
  v_rake numeric; v_hands integer; v_bbj numeric; v_agent_comm numeric;
  v_players integer; v_rakeback numeric; v_platform_fee numeric;
  v_rake2 numeric; v_hands2 integer;
  v_inv_status text; v_club_status text;
  v_tot_rake numeric := 0; v_tot_bbj numeric := 0; v_tot_hands integer := 0;
  v_tot_fee numeric := 0; v_tot_comm numeric := 0; v_tot_rakeback numeric := 0;
  v_clubs jsonb := '[]'::jsonb;
  v_wires jsonb := '[]'::jsonb;
  v_agents jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  SELECT * INTO v_period FROM settlement_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'settlement period % not found', p_period_id;
  END IF;

  SELECT min(created_at) INTO v_rr_start FROM rake_records;
  v_rr_start := COALESCE(v_rr_start, 'infinity'::timestamptz);

  CREATE TEMP TABLE IF NOT EXISTS _scope_clubs (id uuid PRIMARY KEY, name text, union_id uuid) ON COMMIT DROP;
  DELETE FROM _scope_clubs;

  INSERT INTO _scope_clubs (id, name, union_id)
  SELECT c.id, c.name, c.union_id
    FROM clubs c
   WHERE (v_period.club_id IS NULL OR c.id = v_period.club_id)
     AND (
       c.owner_id = v_caller
       OR EXISTS (SELECT 1 FROM club_members cm
                   WHERE cm.club_id = c.id AND cm.user_id = v_caller
                     AND cm.role IN ('owner','co_owner','admin'))
       OR EXISTS (SELECT 1 FROM unions u
                   WHERE u.id = c.union_id AND u.owner_id = v_caller)
       OR EXISTS (SELECT 1 FROM union_admins ua
                   WHERE ua.union_id = c.union_id AND ua.user_id = v_caller)
     );

  IF NOT EXISTS (SELECT 1 FROM _scope_clubs) THEN
    RAISE EXCEPTION 'not authorized for this settlement period';
  END IF;

  FOR v_club IN SELECT * FROM _scope_clubs ORDER BY name LOOP
    -- Live rake source
    SELECT COALESCE(SUM(rake_amount),0), COUNT(*) INTO v_rake, v_hands
      FROM rake_records
     WHERE club_id = v_club.id
       AND created_at >= v_period.start_at AND created_at < v_period.end_at;

    -- Legacy rake source, pre-rake_records era only (avoids the double-write overlap)
    SELECT COALESCE(SUM(rake_amount),0), COUNT(*) INTO v_rake2, v_hands2
      FROM rake_history
     WHERE club_id = v_club.id
       AND COALESCE(collected_at, created_at) >= v_period.start_at
       AND COALESCE(collected_at, created_at) <  v_period.end_at
       AND COALESCE(collected_at, created_at) <  v_rr_start;

    v_rake := v_rake + v_rake2;
    v_hands := v_hands + v_hands2;

    SELECT COALESCE(SUM(amount),0) INTO v_bbj
      FROM bbj_contributions
     WHERE club_id = v_club.id
       AND created_at >= v_period.start_at AND created_at < v_period.end_at;

    SELECT COALESCE(SUM(amount),0) INTO v_agent_comm
      FROM agent_commissions
     WHERE club_id = v_club.id
       AND created_at >= v_period.start_at AND created_at < v_period.end_at;

    SELECT COUNT(DISTINCT user_id), COALESCE(SUM(rakeback_amount),0)
      INTO v_players, v_rakeback
      FROM rakeback_periods
     WHERE club_id = v_club.id
       AND period_start >= v_period.start_at::date
       AND period_start <= v_period.end_at::date;

    v_platform_fee := round(v_rake * 0.10, 2);

    SELECT status INTO v_inv_status
      FROM settlement_invoices
     WHERE period_id = p_period_id AND club_id = v_club.id
     ORDER BY created_at DESC LIMIT 1;

    v_club_status := CASE
      WHEN v_inv_status = 'paid' THEN 'finalized'
      WHEN v_period.status = 'disputed' THEN 'disputed'
      ELSE 'pending' END;

    v_clubs := v_clubs || jsonb_build_object(
      'id', v_club.id,
      'periodId', v_period.id,
      'clubId', v_club.id,
      'clubName', COALESCE(v_club.name, 'Club'),
      'totalRakeCollected', v_rake,
      'totalJackpotContributions', v_bbj,
      'totalPromoCosts', 0,
      'uniquePlayers', v_players,
      'totalHandsDealt', v_hands,
      'platformFee', v_platform_fee,
      'agentCommissions', v_agent_comm,
      'grossRevenue', v_rake,
      'netRevenue', round(v_rake - v_platform_fee - v_agent_comm, 2),
      'status', v_club_status
    );

    v_wires := v_wires || jsonb_build_object(
      'clubId', v_club.id,
      'clubName', COALESCE(v_club.name, 'Club'),
      'netPlayerPL', 0,
      'grossRake', v_rake,
      'unionTax', v_platform_fee,
      'finalWire', round(v_rake - v_platform_fee, 2),
      'action', CASE WHEN (v_rake - v_platform_fee) >= 0 THEN 'COLLECT_FROM_UNION' ELSE 'PAY_TO_UNION' END
    );

    v_tot_rake := v_tot_rake + v_rake;
    v_tot_bbj := v_tot_bbj + v_bbj;
    v_tot_hands := v_tot_hands + v_hands;
    v_tot_fee := v_tot_fee + v_platform_fee;
    v_tot_comm := v_tot_comm + v_agent_comm;
    v_tot_rakeback := v_tot_rakeback + v_rakeback;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'periodId', p_period_id,
      'agentId', a.id,
      'agentName', COALESCE(NULLIF(pr.display_name,''), NULLIF(pr.username,''), NULLIF(pr.full_name,''), 'Agent ' || left(a.id::text, 8)),
      'totalRakeGenerated', COALESCE(a.weekly_rake_generated, 0),
      'commissionRate', a.commission_rate,
      'commissionEarned', COALESCE(ac.earned, 0),
      'creditExtended', a.credit_used,
      'creditRepaid', 0,
      'netSettlement', COALESCE(ac.earned, 0),
      'activePlayers', a.active_player_count,
      'status', 'pending',
      'updatedAt', a.updated_at
    ) ORDER BY COALESCE(ac.earned,0) DESC), '[]'::jsonb)
    INTO v_agents
    FROM agents a
    JOIN _scope_clubs sc ON sc.id = a.club_id
    LEFT JOIN profiles pr ON pr.id = a.user_id
    LEFT JOIN LATERAL (
      SELECT SUM(c.amount) AS earned
        FROM agent_commissions c
       WHERE c.user_id = a.user_id AND c.club_id = a.club_id
         AND c.created_at >= v_period.start_at AND c.created_at < v_period.end_at
    ) ac ON true
   WHERE a.status = 'active';

  RETURN jsonb_build_object(
    'period', jsonb_build_object(
      'id', v_period.id,
      'periodNumber', v_period.period_number,
      'year', v_period.year,
      'startAt', v_period.start_at,
      'endAt', v_period.end_at,
      'status', v_period.status,
      'totalRakeCollected', v_tot_rake,
      'totalBBJContributions', v_tot_bbj,
      'totalPlayerWinnings', COALESCE(v_period.total_player_winnings, 0),
      'totalPlayerLosses', COALESCE(v_period.total_player_losses, 0),
      'totalHandsDealt', v_tot_hands,
      'settledAt', v_period.settled_at,
      'settledBy', v_period.settled_by
    ),
    'clubSettlements', v_clubs,
    'agentSettlements', v_agents,
    'unionWires', v_wires,
    'totalPlatformRevenue', v_tot_fee,
    'totalAgentPayouts', v_tot_comm,
    'totalPlayerRakeback', v_tot_rakeback
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_period_settlements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_period_settlements(uuid) TO authenticated, service_role;
