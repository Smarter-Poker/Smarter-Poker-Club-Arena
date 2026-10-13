-- Version reserved by scripts/new-migration.mjs. Never replay an installed migration.
-- Qualified earned totals minus sparse paid commissions preserve exact outstanding
-- balances without rereading every historical unpaid row. Overlapping settlement
-- periods are merged; NULL/nonfinite recipients retain the original raw reader.
-- The existing installer admits this concurrent index preamble outside the one
-- short function transaction. It never blocks active commission writers for a build.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure)) = '6487c0fa7553a063f7b20fa759950c35'
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_commissions_paid_report_idx ON public.agent_commissions USING btree (club_id, created_at) INCLUDE (user_id, amount) WHERE settled_at IS NOT NULL;
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $preimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure)) IS DISTINCT FROM '5871bca746d3170b09fb3a4274676985'
 OR md5(pg_get_functiondef('smarter_private.qualify_rake_agent_report_day(uuid,date)'::regprocedure)) IS DISTINCT FROM '0b733de335781420b914576889e3294b'
 OR md5(pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure)) IS DISTINCT FROM '1a07fad61faa37c4f9c1c78835fb7843'
 OR md5(pg_get_functiondef('smarter_private.invalidate_agent_commission_report_days()'::regprocedure)) IS DISTINCT FROM '2a1cde231f6a8036f51179d630fbbd2d'
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure AND proowner='postgres'::regrole AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public, pg_temp'])
 OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure AND a.grantee NOT IN('postgres'::regrole,'service_role'::regrole))
 THEN RAISE EXCEPTION 'RAKE_PAID_REPORT_PREIMAGE_CHANGED'; END IF;
END;$preimage$;
CREATE OR REPLACE FUNCTION public.fn_ca_rake_by_agent(p_club_id uuid, p_start date, p_end date, p_limit integer, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'rake'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now  timestamptz := now();
  v_from timestamptz := p_start::timestamptz;
  v_to   timestamptz := LEAST((p_end + 1)::timestamptz, v_now);
  v_uid  uuid    := auth.uid();
  v_cost boolean := public.fn_is_club_admin_uid(p_club_id);
  v_over boolean := EXISTS (SELECT 1 FROM public.union_clubs uc
                             WHERE uc.club_id = p_club_id
                               AND public.fn_is_union_overseer(uc.union_id, v_uid));
  v_q    text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_sort text := lower(COALESCE(NULLIF(btrim(p_sort),''),'rake'));
  v_out  jsonb;
BEGIN
  v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);
  IF v_to <= v_from THEN
    RETURN jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL);
  END IF;

  WITH RECURSIVE ok_days AS MATERIALIZED (
    SELECT rc.day FROM public.club_rake_rollup_complete rc
     WHERE rc.club_id = p_club_id
       AND rc.day >= date_trunc('day', v_from)::date
       AND rc.day <  date_trunc('day', v_to)::date
  ), from_rollup AS (
    SELECT rd.user_id, SUM(rd.rake_amount) AS rake, SUM(rd.hands)::bigint AS hands
      FROM public.club_rake_daily_user rd
      JOIN ok_days o ON o.day = rd.day
     WHERE rd.club_id = p_club_id
     GROUP BY rd.user_id
  ), from_live AS (
    -- THE DAYS NOT YET SEALED, read from the incremental rollup the triggers
    -- on rake_attributions keep exact. This used to scan the attributions
    -- themselves, which is fine at 04:00 and a third of a million rows by
    -- midnight - the panel healed every morning and failed every evening.
    -- Same cents, same rounding, same source table as the sealed days.
    SELECT du.user_id,
           du.rake_cents::numeric / 100 AS rake,
           du.hands
      FROM public.ca_club_rake_daily_user du
     WHERE du.club_id = p_club_id
       AND du.day >= date_trunc('day', v_from)::date
       -- A DAY IS IN RANGE WHEN ITS OWN MIDNIGHT IS BEFORE THE EXCLUSIVE END,
       -- never `<= date_trunc('day', v_to)`. v_to is either a midnight (ask
       -- for a range ending yesterday and it is TODAY's midnight) or now()
       -- itself (ask for a range ending today). The inclusive form got the
       -- second case right and the first case wrong, and put TODAY's rake into
       -- a report for YESTERDAY. Caught by comparing old against new under one
       -- snapshot before this shipped; four ranges agreed and that one did not.
       AND du.day::timestamptz < v_to
       AND NOT EXISTS (SELECT 1 FROM ok_days o WHERE o.day = du.day)
  ), earned AS MATERIALIZED (
    SELECT COALESCE(a.user_id,b.user_id) AS user_id,
           COALESCE(a.rake,0)+COALESCE(b.rake,0)   AS rake,
           COALESCE(a.hands,0)+COALESCE(b.hands,0) AS hands
      FROM from_rollup a FULL OUTER JOIN from_live b ON b.user_id = a.user_id
  ), commission_days AS MATERIALIZED (
    SELECT g::date AS day,
           (m.complete IS TRUE OR (m.club_id IS NULL AND g::date >= f.first_complete_day)) AS complete
      FROM generate_series((v_from AT TIME ZONE 'UTC')::date,(v_to AT TIME ZONE 'UTC')::date,interval '1 day') g
      LEFT JOIN smarter_private.agent_commission_report_days m ON m.club_id=p_club_id AND m.day=g::date
      LEFT JOIN smarter_private.agent_commission_report_frontiers f ON f.club_id=p_club_id
     WHERE (g::date::timestamp AT TIME ZONE 'UTC') < v_to
  ), qualified_commission_days AS MATERIALIZED (
    SELECT day FROM commission_days WHERE complete IS TRUE
       AND (day::timestamp AT TIME ZONE 'UTC') >= v_from
       AND ((day+1)::timestamp AT TIME ZONE 'UTC') <= v_to
  ), commission_earned_parts AS (
    SELECT d.user_id,d.amount FROM smarter_private.agent_commission_report_daily d
      JOIN qualified_commission_days q ON q.day=d.day WHERE d.club_id=p_club_id
    UNION ALL
    SELECT a.user_id,a.amount FROM commission_days d CROSS JOIN LATERAL (
      SELECT ac.user_id,ac.amount FROM public.agent_commissions ac
       WHERE ac.club_id=p_club_id AND ac.user_id IS NOT NULL
         AND ac.created_at>=GREATEST(v_from,d.day::timestamp AT TIME ZONE 'UTC')
         AND ac.created_at<LEAST(v_to,(d.day+1)::timestamp AT TIME ZONE 'UTC')
         AND NOT EXISTS(SELECT 1 FROM qualified_commission_days q WHERE q.day=d.day)
       OFFSET 0) a
    UNION ALL
    SELECT ac.user_id,ac.amount FROM public.agent_commissions ac
     WHERE ac.club_id=p_club_id AND ac.user_id IS NULL AND ac.created_at>=v_from AND ac.created_at<v_to
  ), commission_earned AS MATERIALIZED (
    SELECT user_id,SUM(amount) amount FROM commission_earned_parts GROUP BY user_id
  ), commission_covered AS MATERIALIZED (
    SELECT s.user_id,s.period_start,s.period_end,
           max(s.period_end) OVER(PARTITION BY s.user_id ORDER BY s.period_start,s.period_end
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) reach
      FROM public.agent_commission_settlements s
     WHERE s.club_id=p_club_id AND s.period_start<s.period_end
       AND s.period_end>v_from AND s.period_start<v_to
  ), commission_unpaid_ranges AS MATERIALIZED (
    SELECT c.user_id,GREATEST(COALESCE(c.reach,v_from),v_from) lo,LEAST(c.period_start,v_to) hi
      FROM commission_covered c WHERE c.period_start>COALESCE(c.reach,v_from)
    UNION ALL
    SELECT e.user_id,GREATEST(COALESCE((SELECT max(c.period_end) FROM commission_covered c
      WHERE c.user_id=e.user_id),v_from),v_from),v_to FROM commission_earned e
  ), commission_outstanding_raw AS MATERIALIZED (
    SELECT g.user_id,SUM(ac.amount) amount FROM commission_unpaid_ranges g
      CROSS JOIN LATERAL (SELECT a.amount FROM public.agent_commissions a
       WHERE a.club_id=p_club_id AND a.user_id=g.user_id
         AND a.settled_at IS NULL AND a.created_at>=g.lo AND a.created_at<g.hi OFFSET 0) ac
     WHERE g.lo<g.hi AND g.user_id IS NOT NULL AND EXISTS(SELECT 1 FROM commission_fallback z WHERE z.user_id=g.user_id) GROUP BY g.user_id
    UNION ALL
    SELECT NULL::uuid,SUM(a.amount) FROM public.agent_commissions a
     WHERE a.club_id=p_club_id AND a.user_id IS NULL AND a.settled_at IS NULL
       AND a.created_at>=v_from AND a.created_at<v_to AND EXISTS(SELECT 1 FROM commission_fallback z WHERE z.user_id IS NULL) HAVING count(*)>0
  ), covered_islands AS MATERIALIZED (
 SELECT c.*,SUM(CASE WHEN reach IS NULL OR period_start>reach THEN 1 ELSE 0 END)
 OVER(PARTITION BY user_id ORDER BY period_start,period_end ROWS UNBOUNDED PRECEDING) island
 FROM commission_covered c
), covered_unions AS MATERIALIZED (
 SELECT user_id,GREATEST(min(period_start),v_from) lo,LEAST(max(period_end),v_to) hi
 FROM covered_islands GROUP BY user_id,island
), commission_paid_parts AS (
 SELECT a.user_id,a.amount FROM public.agent_commissions a
 WHERE a.club_id=p_club_id AND a.user_id IS NOT NULL AND a.settled_at IS NOT NULL
 AND a.created_at>=v_from AND a.created_at<v_to
 UNION ALL
 SELECT g.user_id,a.amount FROM covered_unions g CROSS JOIN LATERAL (
 SELECT ac.amount FROM public.agent_commissions ac WHERE ac.club_id=p_club_id AND ac.user_id=g.user_id
 AND ac.settled_at IS NULL AND ac.created_at>=g.lo AND ac.created_at<g.hi OFFSET 0) a WHERE g.lo<g.hi
), commission_paid AS MATERIALIZED (
 SELECT user_id,SUM(amount) amount FROM commission_paid_parts GROUP BY user_id
), commission_fallback AS MATERIALIZED (
 SELECT e.user_id FROM commission_earned e LEFT JOIN commission_paid p ON p.user_id=e.user_id WHERE e.user_id IS NULL OR e.amount::text IN ('Infinity','-Infinity','NaN') OR p.amount::text IN ('Infinity','-Infinity','NaN')
), commission_outstanding AS MATERIALIZED (
 SELECT e.user_id,CASE WHEN e.user_id IS NULL OR e.amount::text IN ('Infinity','-Infinity','NaN')
 OR p.amount::text IN ('Infinity','-Infinity','NaN') THEN
 (SELECT r.amount FROM commission_outstanding_raw r WHERE r.user_id IS NOT DISTINCT FROM e.user_id)
 WHEN NOT EXISTS(SELECT 1 FROM commission_unpaid_ranges g CROSS JOIN LATERAL (SELECT 1 FROM public.agent_commissions a WHERE a.club_id=p_club_id AND a.user_id=g.user_id AND a.settled_at IS NULL AND a.created_at>=g.lo AND a.created_at<g.hi AND a.amount IS NOT NULL LIMIT 1) hit WHERE g.user_id=e.user_id AND g.lo<g.hi) THEN NULL ELSE e.amount-COALESCE(p.amount,0) END amount
 FROM commission_earned e LEFT JOIN commission_paid p ON p.user_id=e.user_id
), commission AS (
    SELECT e.user_id,e.amount earned,o.amount outstanding,
      CASE WHEN e.amount::text IN ('Infinity','-Infinity','NaN') OR o.amount::text IN ('Infinity','-Infinity','NaN') THEN
        (SELECT SUM(a.amount) FROM public.agent_commissions a
          WHERE a.club_id=p_club_id AND a.user_id IS NOT DISTINCT FROM e.user_id
            AND a.created_at>=v_from AND a.created_at<v_to
            AND (a.settled_at IS NOT NULL OR public.fn_agent_commission_paid_by_period(p_club_id,a.user_id,a.created_at)))
      WHEN e.amount=COALESCE(o.amount,0)
        AND NOT EXISTS(SELECT 1 FROM public.agents a WHERE a.club_id=p_club_id AND a.status='active' AND a.user_id=e.user_id)
        AND NOT EXISTS(
          SELECT 1 FROM public.agent_commissions a
           WHERE a.club_id=p_club_id AND a.user_id IS NOT DISTINCT FROM e.user_id
             AND a.created_at>=v_from AND a.created_at<v_to
             AND a.amount IS NOT NULL AND a.settled_at IS NOT NULL
        )
        AND NOT EXISTS(
          SELECT 1 FROM commission_covered c
            CROSS JOIN LATERAL(SELECT 1 FROM public.agent_commissions a
             WHERE a.club_id=p_club_id AND a.user_id=c.user_id
               AND a.created_at>=GREATEST(v_from,c.period_start)
               AND a.created_at<LEAST(v_to,c.period_end)
               AND a.amount IS NOT NULL LIMIT 1) paid
           WHERE c.user_id=e.user_id
        ) THEN NULL ELSE e.amount-COALESCE(o.amount,0) END settled
      FROM commission_earned e LEFT JOIN commission_outstanding o ON o.user_id IS NOT DISTINCT FROM e.user_id
  ), club_agents AS (
    SELECT a.id, a.user_id, a.parent_agent_id, a.role, a.commission_rate
      FROM public.agents a WHERE a.club_id = p_club_id AND a.status='active'
  ), direct AS (
    SELECT cm.agent_id, COUNT(*) AS players,
           COUNT(*) FILTER (WHERE COALESCE(e.rake,0) <> 0) AS active,
           COALESCE(SUM(e.rake),0) AS rake, COALESCE(SUM(e.hands),0)::bigint AS hands
      FROM public.club_members cm
      LEFT JOIN earned e ON e.user_id = cm.user_id
     WHERE cm.club_id = p_club_id
     GROUP BY cm.agent_id
  ), tree AS (
    SELECT ca.id AS root_id, ca.id AS node_id, 0 AS depth FROM club_agents ca
    UNION ALL
    SELECT t.root_id, c.id, t.depth+1
      FROM tree t JOIN club_agents c ON c.parent_agent_id = t.node_id
     WHERE t.depth < 12
  ), network AS (
    SELECT t.root_id, COALESCE(SUM(d.rake),0) AS rake,
           COALESCE(SUM(d.players),0) AS players,
           COUNT(*) FILTER (WHERE t.node_id <> t.root_id) AS sub_agents
      FROM (SELECT DISTINCT root_id, node_id FROM tree) t
      JOIN club_agents n ON n.id = t.node_id
      LEFT JOIN direct d ON d.agent_id = n.user_id
     GROUP BY t.root_id
  ), unlisted AS (
    SELECT SUM(cs.earned) AS earned, SUM(cs.outstanding) AS outstanding,
           SUM(cs.settled) AS settled, count(*)::int AS recipients
      FROM commission cs
     WHERE NOT EXISTS (SELECT 1 FROM club_agents ca WHERE ca.user_id = cs.user_id)
  ), listed AS (
    SELECT ca.user_id AS agent_user_id,
           COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                         pr.first_name, pr.last_name, pr.full_name),
                    pr.username, 'Agent') AS name,
           pr.avatar_url, ca.role, ca.commission_rate,
           COALESCE(dr.players,0) AS direct_players,
           COALESCE(dr.active,0)  AS direct_active,
           round(COALESCE(dr.rake,0),2) AS direct_rake,
           COALESCE(dr.hands,0) AS direct_hands,
           COALESCE(nw.players,0) AS network_players,
           round(COALESCE(nw.rake,0),2) AS network_rake,
           COALESCE(nw.sub_agents,0) AS sub_agents,
           CASE WHEN v_cost THEN round(COALESCE(cs.earned,0),2)      END AS commission_earned,
           CASE WHEN v_cost THEN round(COALESCE(cs.outstanding,0),2) END AS commission_outstanding,
           CASE WHEN v_cost THEN round(COALESCE(cs.settled,0),2)     END AS commission_settled,
           -- The same three conditions the downline walker enforces.
           (v_cost OR v_over OR ca.user_id = v_uid
            OR public.fn_is_agent_ancestor(v_uid, ca.user_id, p_club_id)) AS can_drill,
           false AS is_unassigned, false AS is_residual
      FROM club_agents ca
      LEFT JOIN direct dr ON dr.agent_id = ca.user_id
      LEFT JOIN network nw ON nw.root_id = ca.id
      LEFT JOIN commission cs ON cs.user_id = ca.user_id
      LEFT JOIN public.profiles pr ON pr.id = ca.user_id
    UNION ALL
    SELECT NULL,'Unassigned',NULL,'none',NULL,
           d.players,d.active,round(d.rake,2),d.hands,
           d.players,round(d.rake,2),0,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           CASE WHEN v_cost THEN 0::numeric END,
           false, true, false
      FROM direct d WHERE d.agent_id IS NULL AND d.players > 0
    UNION ALL
    SELECT NULL,'Unlisted Recipients',NULL,'none',NULL,
           0,0,0::numeric,0::bigint,
           u.recipients,0::numeric,0,
           round(u.earned,2), round(u.outstanding,2), round(u.settled,2),
           false, true, true
      FROM unlisted u
     WHERE v_cost AND COALESCE(u.earned,0) <> 0
  ), totals AS (
    -- Before the filter. The denominator is the club, not the search result.
    SELECT COALESCE(SUM(l.direct_rake),0) AS total_direct,
           SUM(l.commission_earned)       AS total_commission
      FROM listed l
  ), filtered AS (
    SELECT l.* FROM listed l
     WHERE v_q IS NULL OR l.name ILIKE '%' || public.fn_like_escape(v_q) || '%' ESCAPE '\'
  ), ranked AS (
    SELECT f.*, row_number() OVER (
             ORDER BY f.is_unassigned,
               CASE WHEN v_sort = 'name'    THEN f.name END ASC,
               CASE WHEN v_sort = 'cost'    THEN f.commission_earned END DESC NULLS LAST,
               CASE WHEN v_sort = 'players' THEN f.network_players END DESC,
               CASE WHEN v_sort NOT IN ('name','cost','players')
                    THEN f.network_rake END DESC NULLS LAST,
               f.name ASC,
               f.agent_user_id::text ASC NULLS LAST) AS rn
      FROM filtered f
  ), sliced AS (
    SELECT r.* FROM ranked r ORDER BY r.rn
     OFFSET GREATEST(COALESCE(p_offset,0),0)
      LIMIT GREATEST(LEAST(COALESCE(p_limit,50),200),1)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg((to_jsonb(s) - 'rn') ORDER BY s.rn) FROM sliced s), '[]'::jsonb),
    -- Counted, not taken from a window over the page: ask for an offset past
    -- the end and a windowed count would answer "nothing matches".
    'total', (SELECT count(*) FROM filtered),
    'total_direct', (SELECT t.total_direct FROM totals t),
    'total_commission', (SELECT t.total_commission FROM totals t))
    INTO v_out;

  RETURN COALESCE(v_out,
    jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL));
END;
$function$;



ALTER FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) TO service_role;
DO $postimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure)) IS DISTINCT FROM '6487c0fa7553a063f7b20fa759950c35'
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure AND proowner='postgres'::regrole AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public, pg_temp'])
 OR NOT has_function_privilege('service_role','public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)','EXECUTE')
 OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure AND a.grantee NOT IN('postgres'::regrole,'service_role'::regrole))
 OR NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.oid=to_regclass('public.agent_commissions_paid_report_idx') AND i.indisvalid AND i.indisready AND i.indislive AND c.relowner='postgres'::regrole AND pg_get_indexdef(c.oid)='CREATE INDEX agent_commissions_paid_report_idx ON public.agent_commissions USING btree (club_id, created_at) INCLUDE (user_id, amount) WHERE (settled_at IS NOT NULL)')
 THEN RAISE EXCEPTION 'RAKE_PAID_REPORT_POSTIMAGE_CHANGED'; END IF;
END;$postimage$;
COMMIT;
