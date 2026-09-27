-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820133039 "union_law_agent_backoffice_and_union_risk_view"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 917dfa43f6399d24c936c1ea58ec9dc3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- POKERBROS PARITY — AGENT BACK OFFICE + UNION RISK BY AGENT (2026-08-20)
--
-- Gaps found by comparing our implementation to the PokerBros union model:
--
-- 1. "Agents are sub-managers who can transfer chips between the Club and an
--    assigned group of players AS WELL AS ACCESS INFORMATION ON THESE PLAYERS'
--    WINS, LOSSES, AND RAKE." We had ZERO RLS granting an agent sight of their
--    own roster — the relationship existed in data but was invisible in the
--    product. Agents now see their roster (and only their roster).
--
-- 2. The union owner's integrity view in the PokerBros model is "risk by AGENT
--    rather than by player" — the agent is the accountable layer, because a
--    winning bot or a colluding ring has to be funded and settled by someone.
--    fn_union_agent_risk_report gives the union that view.
--
-- 3. A super-agent earns an override on downstream volume. The mechanism exists
--    (agents.parent_agent_id + the cascade in credit_agent_commission_from_rake)
--    but NO agent is linked to a super-agent, so overrides can never pay.
--    fn_assign_agent_to_super_agent makes that link settable and auditable —
--    who reports to whom is Dan's commercial decision, not something to invent.
-- ============================================================================

-- Is this user the agent of record for that player, in that club? ------------
CREATE OR REPLACE FUNCTION public.fn_is_agent_of_player(p_agent_user_id uuid, p_player_user_id uuid)
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_agent_user_id IS NOT NULL AND p_player_user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM club_members m
             WHERE m.user_id = p_player_user_id AND m.agent_id = p_agent_user_id)
    OR EXISTS (SELECT 1 FROM player_agent_assignments pa
                JOIN agents a ON a.id = pa.agent_id
               WHERE pa.player_id = p_player_user_id AND a.user_id = p_agent_user_id)
    -- super-agent sees the rosters of the agents beneath them
    OR EXISTS (SELECT 1 FROM club_members m
                JOIN agents child ON child.user_id = m.agent_id
                JOIN agents parent ON parent.id = child.parent_agent_id
               WHERE m.user_id = p_player_user_id AND parent.user_id = p_agent_user_id)
  );
$function$;

-- An agent may read their own roster's membership rows -----------------------
DROP POLICY IF EXISTS agent_reads_own_roster ON public.club_members;
CREATE POLICY agent_reads_own_roster ON public.club_members
  FOR SELECT TO authenticated
  USING (
    agent_id = (SELECT auth.uid())
    OR public.fn_is_agent_of_player((SELECT auth.uid()), user_id)
  );

-- …and their own commission rows --------------------------------------------
DROP POLICY IF EXISTS agent_reads_own_commissions ON public.agent_commissions;
CREATE POLICY agent_reads_own_commissions ON public.agent_commissions
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- AGENT BACK OFFICE: wins, losses, rake and credit for my players ------------
CREATE OR REPLACE FUNCTION public.fn_agent_roster_report(p_agent_user_id uuid DEFAULT NULL, p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL)
 RETURNS TABLE(
   player_id uuid, username text, club_id uuid, club_name text,
   buyins numeric, cashouts numeric, net_result numeric,
   rake_generated numeric, agent_commission numeric,
   chip_balance numeric, credit_used numeric, currently_seated boolean
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from  timestamptz := COALESCE(p_since, date_trunc('week', now()));
  v_to    timestamptz := COALESCE(p_until, now());
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'no_agent_context'; END IF;
  -- A caller may only pull their OWN roster unless they oversee the union.
  IF auth.uid() IS NOT NULL AND auth.uid() <> v_agent
     AND NOT public.fn_is_any_union_overseer(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  WITH roster AS (
    SELECT DISTINCT m.user_id, m.club_id, m.chip_balance, m.credit_used
      FROM club_members m
     WHERE m.agent_id = v_agent
        OR EXISTS (SELECT 1 FROM agents child
                    JOIN agents parent ON parent.id = child.parent_agent_id
                   WHERE child.user_id = m.agent_id AND parent.user_id = v_agent)
  ),
  flows AS (
    SELECT wt.user_id,
           SUM(CASE WHEN wt.type='debit'  AND wt.category IN ('buyin','rebuy','addon') THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type='credit' AND wt.category='cashout' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN roster r ON r.user_id = wt.user_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
     GROUP BY wt.user_id
  ),
  rake AS (
    SELECT (e.key)::uuid AS user_id,
           SUM(rr.rake_amount * (e.value::numeric) / NULLIF(c.total,0)) AS rake_generated
      FROM rake_records rr
      CROSS JOIN LATERAL (SELECT SUM(t.value::numeric) AS total
                            FROM jsonb_each_text(rr.player_contributions) t(key,value)) c
      CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) e(key,value)
     WHERE rr.created_at >= v_from AND rr.created_at < v_to
       AND rr.player_contributions IS NOT NULL AND c.total > 0
       AND EXISTS (SELECT 1 FROM roster r WHERE r.user_id = (e.key)::uuid)
     GROUP BY 1
  ),
  comm AS (
    SELECT ac.club_id, SUM(ac.amount) AS amt
      FROM agent_commissions ac
     WHERE ac.user_id = v_agent AND ac.created_at >= v_from AND ac.created_at < v_to
     GROUP BY ac.club_id
  )
  SELECT r.user_id, pr.username, r.club_id, cl.name,
         COALESCE(f.buyins,0), COALESCE(f.cashouts,0),
         COALESCE(f.cashouts,0) - COALESCE(f.buyins,0),
         ROUND(COALESCE(rk.rake_generated,0),2),
         ROUND(COALESCE(cm2.amt,0),2),
         COALESCE(r.chip_balance,0), COALESCE(r.credit_used,0),
         EXISTS (SELECT 1 FROM table_seats ts WHERE ts.user_id = r.user_id AND ts.left_at IS NULL)
    FROM roster r
    LEFT JOIN profiles pr ON pr.id = r.user_id
    LEFT JOIN clubs cl ON cl.id = r.club_id
    LEFT JOIN flows f ON f.user_id = r.user_id
    LEFT JOIN rake rk ON rk.user_id = r.user_id
    LEFT JOIN comm cm2 ON cm2.club_id = r.club_id
   ORDER BY 8 DESC NULLS LAST;
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_agent_roster_report(uuid, timestamptz, timestamptz) TO authenticated;

-- UNION OWNER: risk by AGENT, the accountable layer --------------------------
CREATE OR REPLACE FUNCTION public.fn_union_agent_risk_report(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001', p_since timestamptz DEFAULT NULL)
 RETURNS TABLE(
   agent_user_id uuid, agent_name text, club_name text, role text,
   players integer, seated_now integer,
   rake_generated numeric, player_net numeric,
   commission_accrued numeric, credit_extended numeric
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz := COALESCE(p_since, date_trunc('week', now()));
BEGIN
  IF NOT public.fn_is_any_union_overseer(auth.uid()) AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  WITH union_clubs_all AS (
    SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = p_union_id
    UNION SELECT p_union_id
  ),
  roster AS (
    SELECT m.agent_id AS agent_user_id, m.user_id AS player_id, m.club_id,
           COALESCE(m.credit_used,0) AS credit_used
      FROM club_members m
      JOIN union_clubs_all u ON u.club_id = m.club_id
     WHERE m.agent_id IS NOT NULL
  ),
  rake AS (
    SELECT (e.key)::uuid AS player_id,
           SUM(rr.rake_amount * (e.value::numeric) / NULLIF(c.total,0)) AS rake_generated
      FROM rake_records rr
      CROSS JOIN LATERAL (SELECT SUM(t.value::numeric) AS total
                            FROM jsonb_each_text(rr.player_contributions) t(key,value)) c
      CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) e(key,value)
     WHERE rr.created_at >= v_from
       AND rr.player_contributions IS NOT NULL AND c.total > 0
     GROUP BY 1
  ),
  flows AS (
    SELECT wt.user_id AS player_id,
           SUM(CASE WHEN wt.type='credit' AND wt.category='cashout' THEN wt.amount ELSE 0 END)
         - SUM(CASE WHEN wt.type='debit'  AND wt.category IN ('buyin','rebuy','addon') THEN wt.amount ELSE 0 END) AS net
      FROM wallet_transactions wt
     WHERE wt.created_at >= v_from
     GROUP BY 1
  ),
  comm AS (
    SELECT ac.user_id AS agent_user_id, SUM(ac.amount) AS amt
      FROM agent_commissions ac
     WHERE ac.created_at >= v_from
     GROUP BY 1
  )
  SELECT r.agent_user_id,
         pr.username,
         cl.name,
         COALESCE(a.role,'agent'),
         COUNT(DISTINCT r.player_id)::int,
         COUNT(DISTINCT r.player_id) FILTER (
           WHERE EXISTS (SELECT 1 FROM table_seats ts
                          WHERE ts.user_id = r.player_id AND ts.left_at IS NULL))::int,
         ROUND(COALESCE(SUM(rk.rake_generated),0),2),
         ROUND(COALESCE(SUM(fl.net),0),2),
         ROUND(COALESCE(MAX(cm2.amt),0),2),
         ROUND(COALESCE(SUM(r.credit_used),0),2)
    FROM roster r
    LEFT JOIN profiles pr ON pr.id = r.agent_user_id
    LEFT JOIN clubs cl ON cl.id = r.club_id
    LEFT JOIN agents a ON a.user_id = r.agent_user_id AND a.club_id = r.club_id
    LEFT JOIN rake rk ON rk.player_id = r.player_id
    LEFT JOIN flows fl ON fl.player_id = r.player_id
    LEFT JOIN comm cm2 ON cm2.agent_user_id = r.agent_user_id
   GROUP BY r.agent_user_id, pr.username, cl.name, a.role
   ORDER BY 8 DESC NULLS LAST;
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_union_agent_risk_report(uuid, timestamptz) TO authenticated;

-- Make the super-agent hierarchy settable and auditable ----------------------
CREATE OR REPLACE FUNCTION public.fn_assign_agent_to_super_agent(p_agent_user_id uuid, p_super_agent_user_id uuid, p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_agent uuid; v_super uuid;
BEGIN
  IF NOT public.fn_is_any_union_overseer(auth.uid()) AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT id INTO v_agent FROM agents WHERE user_id = p_agent_user_id AND club_id = p_club_id;
  SELECT id INTO v_super FROM agents WHERE user_id = p_super_agent_user_id AND club_id = p_club_id;
  IF v_agent IS NULL OR v_super IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_or_super_agent_not_found');
  END IF;
  IF v_agent = v_super THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_cannot_report_to_itself');
  END IF;
  -- No cycles: the proposed parent must not already sit beneath this agent.
  IF EXISTS (
    WITH RECURSIVE up AS (
      SELECT id, parent_agent_id FROM agents WHERE id = v_super
      UNION ALL
      SELECT a.id, a.parent_agent_id FROM agents a JOIN up ON up.parent_agent_id = a.id
    ) SELECT 1 FROM up WHERE id = v_agent
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'would_create_cycle');
  END IF;

  UPDATE agents SET parent_agent_id = v_super, updated_at = now() WHERE id = v_agent;
  UPDATE agents SET role = 'super_agent', updated_at = now()
   WHERE id = v_super AND COALESCE(role,'agent') <> 'super_agent';

  RETURN jsonb_build_object('success', true, 'agent_id', v_agent, 'super_agent_id', v_super);
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_assign_agent_to_super_agent(uuid, uuid, uuid) TO authenticated;

