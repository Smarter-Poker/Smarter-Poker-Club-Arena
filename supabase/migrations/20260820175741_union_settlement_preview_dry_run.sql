-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820175741 "union_settlement_preview_dry_run"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d1c5a619fa81b03271a8452b0e9c450f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SETTLEMENT PREVIEW (read-only dry run).
--
-- Running the cascade moves money across every club, agent and player in the
-- union, and until now the only way to find out what it would do was to do it.
-- There was no confirmation step either — one click paid the whole union.
--
-- This reports exactly what each round WOULD move, including which payers
-- cannot cover their obligation, so a shortfall is visible before it happens
-- rather than as a count in the round log afterwards.

CREATE OR REPLACE FUNCTION public.fn_union_settlement_preview(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end   timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, date_trunc('week', now()) - interval '7 days');
  v_to   timestamptz := COALESCE(p_period_end,   date_trunc('week', now()));
  v_r1_done boolean;
  v_rake_wallet numeric;
  v_r2_total numeric := 0; v_r2_payees int := 0;
  v_r3_total numeric := 0; v_r3_payees int := 0;
  v_r2_short jsonb := '[]'::jsonb;
  v_r3_short jsonb := '[]'::jsonb;
  v_r2_short_amt numeric := 0; v_r3_short_amt numeric := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.fn_is_union_overseer(p_union_id, auth.uid()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT EXISTS (SELECT 1 FROM union_rakeback_log
                  WHERE union_id = p_union_id
                    AND period_start = v_from AND period_end = v_to)
    INTO v_r1_done;

  SELECT COALESCE(rake_wallet,0) INTO v_rake_wallet
    FROM union_wallets WHERE union_id = p_union_id;

  -- ROUND 2 — unsettled agent commission, and whether the club treasury covers it.
  WITH owed AS (
    SELECT ac.club_id, ac.user_id, SUM(ac.amount) AS amt
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status='active'
     WHERE ac.created_at >= v_from AND ac.created_at < v_to
       AND ac.settled_at IS NULL
     GROUP BY ac.club_id, ac.user_id
    HAVING SUM(ac.amount) > 0
  ), byclub AS (
    SELECT o.club_id, SUM(o.amt) AS club_owed,
           COALESCE(c.chip_treasury,0) AS treasury, c.name
      FROM owed o JOIN clubs c ON c.id = o.club_id
     GROUP BY o.club_id, c.chip_treasury, c.name
  )
  SELECT COALESCE(SUM(o.amt),0), COUNT(*)::int
    INTO v_r2_total, v_r2_payees FROM owed o;

  WITH owed AS (
    SELECT ac.club_id, SUM(ac.amount) AS amt
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status='active'
     WHERE ac.created_at >= v_from AND ac.created_at < v_to AND ac.settled_at IS NULL
     GROUP BY ac.club_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'club_id', o.club_id, 'club', c.name,
           'owed', o.amt, 'treasury', COALESCE(c.chip_treasury,0),
           'short_by', round(o.amt - COALESCE(c.chip_treasury,0), 2))), '[]'::jsonb),
         COALESCE(SUM(o.amt - COALESCE(c.chip_treasury,0)), 0)
    INTO v_r2_short, v_r2_short_amt
    FROM owed o JOIN clubs c ON c.id = o.club_id
   WHERE COALESCE(c.chip_treasury,0) < o.amt;

  -- ROUND 3 — pending player rakeback, and whether the paying agent covers it.
  WITH owed AS (
    SELECT rp.user_id AS player_id, rp.club_id, cm.agent_id AS agent_user,
           SUM(rp.rakeback_amount) AS amt
      FROM rakeback_periods rp
      JOIN union_clubs uc ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
      JOIN club_members cm ON cm.user_id = rp.user_id AND cm.club_id = rp.club_id
     WHERE rp.status = 'pending'
       AND rp.period_start >= v_from::date
       AND rp.period_start <  v_to::date + 1
       AND cm.agent_id IS NOT NULL
     GROUP BY rp.user_id, rp.club_id, cm.agent_id
    HAVING SUM(rp.rakeback_amount) > 0
  )
  SELECT COALESCE(SUM(amt),0), COUNT(*)::int INTO v_r3_total, v_r3_payees FROM owed;

  WITH owed AS (
    SELECT rp.club_id, cm.agent_id AS agent_user, SUM(rp.rakeback_amount) AS amt
      FROM rakeback_periods rp
      JOIN union_clubs uc ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
      JOIN club_members cm ON cm.user_id = rp.user_id AND cm.club_id = rp.club_id
     WHERE rp.status = 'pending'
       AND rp.period_start >= v_from::date AND rp.period_start < v_to::date + 1
       AND cm.agent_id IS NOT NULL
     GROUP BY rp.club_id, cm.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_user_id', o.agent_user,
           'agent', COALESCE(pr.display_name, pr.username),
           'club_id', o.club_id, 'owed', o.amt,
           'agent_balance', COALESCE(am.chip_balance,0),
           'short_by', round(o.amt - COALESCE(am.chip_balance,0), 2))), '[]'::jsonb),
         COALESCE(SUM(o.amt - COALESCE(am.chip_balance,0)), 0)
    INTO v_r3_short, v_r3_short_amt
    FROM owed o
    LEFT JOIN club_members am ON am.user_id = o.agent_user AND am.club_id = o.club_id
    LEFT JOIN profiles pr ON pr.id = o.agent_user
   WHERE COALESCE(am.chip_balance,0) < o.amt;

  RETURN jsonb_build_object(
    'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to,
    'round1', jsonb_build_object(
      'already_executed', v_r1_done,
      'rake_treasury_available', v_rake_wallet),
    'round2', jsonb_build_object(
      'payees', v_r2_payees, 'amount', round(v_r2_total,2),
      'clubs_short', jsonb_array_length(v_r2_short),
      'short_by', round(v_r2_short_amt,2), 'detail', v_r2_short),
    'round3', jsonb_build_object(
      'payees', v_r3_payees, 'amount', round(v_r3_total,2),
      'agents_short', jsonb_array_length(v_r3_short),
      'short_by', round(v_r3_short_amt,2), 'detail', v_r3_short),
    'total_to_move', round(v_r2_total + v_r3_total, 2),
    'has_blockers', (jsonb_array_length(v_r2_short) + jsonb_array_length(v_r3_short)) > 0
  );
END $$;

REVOKE ALL ON FUNCTION public.fn_union_settlement_preview(uuid,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_union_settlement_preview(uuid,timestamptz,timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_preview(uuid,timestamptz,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_preview(uuid,timestamptz,timestamptz) TO service_role;
