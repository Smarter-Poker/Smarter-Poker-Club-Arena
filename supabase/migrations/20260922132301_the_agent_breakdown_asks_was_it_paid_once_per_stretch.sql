-- 20260922124212_the_agent_breakdown_asks_was_it_paid_once_per_stretch.sql
--
-- ============================================================================
-- THE AGENT BREAKDOWN ASKS "WAS IT PAID" ONCE PER STRETCH, NOT TWICE PER ROW
-- ============================================================================
--
-- Written 2026-09-22 for the Club Arena Data Console program from read-only
-- measurements against production the same day. An earlier draft with the
-- same diagnosis (2026-09-21) ran width_bucket() on every row and was never
-- applied. This file opens its own REPEATABLE READ transaction so the old and
-- the new answers it compares are read from one snapshot; apply it as
-- written, once, outside the :50-:03 UTC break window (CLAUDE.md 2, rule 8).
--
-- ----------------------------------------------------------------------------
-- WHAT IS WRONG
-- ----------------------------------------------------------------------------
--
-- The Rake Produced panel on the Club Data page is HTTP 500 for SHARK CLUB.
-- Its call to ca_rake_snapshot('club', ...) runs past the `authenticated`
-- role's 8 s statement_timeout and PostgREST reports the cancel as a 500.
-- Measured 2026-09-21 as the club owner, p_limit 200, sort 'rake', 69 rows:
--
--     day    2026-09-21..2026-09-21        131 ms
--     week   2026-09-15..2026-09-21     10,719 ms   (500)
--     month  2026-09-01..2026-09-21     42,092 ms   (500, and Month is the default chip)
--
-- pg_stat_statements holds no successful PostgREST call of the snapshot.
--
-- ----------------------------------------------------------------------------
-- WHERE THE TIME GOES (production, read only, 2026-09-22)
-- ----------------------------------------------------------------------------
--
-- Everything in the club branch reads a daily rollup except ONE CTE of
-- fn_ca_rake_by_agent, `commission`, which reads raw agent_commissions and
-- asks fn_agent_commission_paid_by_period twice for every open row:
--
--     SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL AND NOT
--         public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at))
--     SUM(ac.amount) FILTER (WHERE ac.settled_at IS NOT NULL OR
--         public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at))
--
--     SHARK CLUB                commission rows   open rows   predicate calls
--     day   2026-09-21                  6,179
--     week  2026-09-15..21            529,967
--     month 2026-09-01..21          3,036,381    2,012,281       4,024,562
--
--     week:  that CTE alone 10,245 ms of the 10,719. The same rows summed
--            without the predicate: 135 ms.
--     month: the same rows summed without the predicate: 967 ms.
--     the rest of the snapshot (both rake windows, the series, the
--     authorisation, data_updated_at): week 82 ms, month 307-425 ms.
--
-- The cost is linear in the commission rows the range holds, which is why
-- Day loads and Week and Month do not.
--
-- WHY IT IS A PER-ROW CALL. Postgres inlines a scalar SQL function only when
-- its body is a bare expression; inline_function() refuses a body with a
-- sublink (hasSubLinks), and `SELECT EXISTS (SELECT ...)` is one. So the
-- predicate is never inlined, SET clause or not: 20260908031445 removed its
-- SET so that it would inline, and it still cannot. EXPLAIN VERBOSE on
-- production (PG 17.6) prints the call inside both aggregate FILTERs, and
-- PG 16 prints it even in a plain WHERE. Each call is a full SQL-function
-- execution against agent_commission_settlements (111 rows). On 2026-09-05
-- this CTE was 425 ms for a month (20260905081020); 20260908025653 put the
-- predicate in it, and the panel has failed since the club's volume grew.
--
-- ----------------------------------------------------------------------------
-- THE FIX: SUM THE ROWS PER STRETCH, ASK THE SAME PREDICATE ONCE PER STRETCH
-- ----------------------------------------------------------------------------
--
-- For any agent, "paid" can only change where one of this club's paid periods
-- starts or ends. The new CTEs:
--
--   paid_cut         v_from, plus every period_start and period_end of this
--                    club's settlement rows that lies strictly inside
--                    [v_from, v_to). A handful of instants (SHARK CLUB's
--                    month: 3).
--   stretch          consecutive cuts as [lo, hi), the last one ending at
--                    v_to. They tile [v_from, v_to) exactly: no gap, no
--                    overlap, so every row the old WHERE selected falls in
--                    exactly one stretch.
--   commission_part  per stretch, one range read of the existing covering
--                    index idx_agent_commissions_club_created, summed per
--                    (agent, own settled_at set or not). No function call.
--   commission       the SAME predicate in the SAME two FILTERs, asked once
--                    per (agent, stretch) at the stretch's first instant lo.
--
-- Why asking at lo is the same answer for every row t of [lo, hi): for any
-- settlement period [ps, pe) of the club, ps <= t exactly when ps <= lo (a
-- ps above v_from and at or below t is a cut, and no cut lies in (lo, hi)),
-- and t < pe exactly when lo < pe (a pe below v_to and above lo is a cut, so
-- it is at least hi, which is above t). Overlapping, adjacent, empty,
-- inverted and open-ended periods need no special case; periods of other
-- clubs cannot matter because the predicate filters on the club.
--
-- Why the figures are identical: earned, outstanding and settled are each a
-- SUM over exactly the rows the old FILTER selected, only grouped first.
-- numeric addition is exact and keeps the largest input scale, and a SUM is
-- NULL exactly when no non-null amount qualifies, before and after (the
-- Unlisted Recipients row prints round(NULL, 2) as null, so that matters).
--
-- The rest of fn_ca_rake_by_agent is byte-identical; the diff is the one CTE.
-- Signature, STABLE, SECURITY DEFINER, SET search_path TO 'public', 'pg_temp',
-- owner and grants are unchanged. ca_rake_snapshot is not touched.
--
-- WHAT THIS DOES NOT DO. No index (the one it reads exists since
-- 20260905081020), no rollup table, no trigger, no cron, no sweeper, no
-- backfill, no change to the predicate or the settlement model, no change to
-- any other function. The same per-row call remains in
-- fn_union_settlement_preview, fn_get_agent_commission_summary,
-- fn_agent_downline_commission, fn_ca_gdpr_financial_precheck,
-- fn_club_set_member_role and trg_agent_commission_rollup_insert; they are
-- outside this panel and are named so the next agent does not rediscover
-- them.
--
-- ----------------------------------------------------------------------------
-- EVIDENCE, 2026-09-22
-- ----------------------------------------------------------------------------
--
-- Production, READ ONLY REPEATABLE READ transaction, as the club owner, the
-- new body run inline against production's rows next to the installed one:
--
--     fn_ca_rake_by_agent  2026-09-21 (day)              old    132 ms  new   103 ms  identical
--                          2026-09-14 (crosses the 07:00
--                                      period end)       old  2,568 ms  new   195 ms  identical
--                          2026-09-15..21 (week)         old 10,398 ms  new   212-261 ms  identical
--                          2026-09-01..21 (month)        old ~42 s      new 1,161-1,246 ms
--     (steady values from a repeat run; in the first run, right after the
--     old function's calls, the week read 2,501 ms and the month 1,997 ms.
--     EXPLAIN ANALYZE of the whole new statement for the week: 293 ms.)
--     so the snapshot is ~0.3 s for the week and ~1.5-1.7 s for the month.
--     EXPLAIN, month, the commission CTE: total cost 1,898,868 -> 161,231.
--
-- Isolated PG 16 fixture: all 21 production bodies on the path md5-identical
-- to production (the agent-scope downline walker is a declared stub; that
-- branch never reaches this helper). 3.26M synthetic commission rows shaped
-- like SHARK CLUB, production's own period edges plus overlapping, adjacent,
-- empty, inverted, open-ended, microsecond and other-club periods, rows on
-- every edge and one microsecond either side, NULL and mixed-scale amounts.
--
--     the commission relation itself, old vs new, compared as TEXT over 438
--     windows (start on, end on, straddle every edge; the page's ranges):
--     10,328 (agent, window) rows, 0 differ, scales 0/1/2/4/6 and NULL cells
--     in all three columns covered.
--     ca_rake_snapshot and the helper end to end, old then new in ONE
--     transaction: 675 cases (club, union and agent scopes; 20 ranges from a
--     day to the 730-day clamp; 7 sorts; 12 searches with LIKE
--     metacharacters; paging past the end; owner, admin, agent, union owner,
--     no caller; the error paths): 675 identical.
--     timing, owner: month 14,104 -> 770 ms, year 19,827 -> 1,252 ms,
--     two days across an edge 2,554 -> 97 ms. Same answer and timing under
--     plan_cache_mode = force_generic_plan.
--
-- Two things the repository's readers of this helper require were then added
-- to that qualified body: the half-open window stated outright on the
-- commission read (the stretches already tile it, so it removes nothing) and
-- the helper's grants restated after the replace (no-ops on production's
-- ACL). Re-run on the same fixture, 85 cases (every paid-period edge of the
-- busiest club from both sides, week, month, the whole history, today, an
-- empty month, owner, agent and no caller, five sorts, two searches, two
-- smaller clubs): the old body, the qualified body and this final body gave
-- 0 differing answers (65 distinct, 51 with an Unlisted Recipients row, 10
-- with a null outstanding cell); old 219.8 s in total, final 12.9 s. The
-- final body hashes to 434abb5ec88d41bd39a8893ac5e39b72, asserted below.
--
-- The first application, at 13:10 UTC, rolled back on this file's own gate:
-- the equality proof passed and a single 31-day snapshot read 10,128 ms for
-- SHARK CLUB and 5,686 ms for the other club with a paid period. Read-only
-- runs of this exact body minutes later, as the owner, over the same 31
-- days: SHARK CLUB 1,799-2,042 ms (custom and forced generic plans alike),
-- the other club 179-311 ms; the commission step alone 1.5-2.2 s over its
-- 3,842,350 rows; the snapshot's windows and series 309 ms together. The
-- gate now holds the best of three reads to the 6 s line.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE CHECKS, AND ABORTS ON
-- ----------------------------------------------------------------------------
--
--   guard   fn_ca_rake_by_agent, fn_agent_commission_paid_by_period and
--           ca_rake_snapshot hash to the bodies this was written and
--           qualified against; the helper's owner and grants are as
--           qualified; the transaction really is REPEATABLE READ.
--   proof   for every club with a paid period: the OLD function's answer as
--           the club's owner for the UTC day of its latest past period end
--           (both sides of an edge) and for yesterday is captured; the
--           function is replaced; the NEW answer must be the same text.
--           Then the page's own read, ca_rake_snapshot('club', ...) over
--           31 days, must finish inside 6 s for each of those clubs (the
--           best of three reads, so a moment of load is not mistaken for
--           the function).
--   assert  the installed body hashes to the qualified one and no longer
--           calls the predicate per row; STABLE, SECURITY DEFINER,
--           search_path, owner and grants unchanged; still not executable by
--           anon or authenticated; ca_rake_snapshot unchanged and still
--           executable by authenticated.
--
-- The proof calls the old function for SHARK CLUB's 2026-09-14 (~2.6 s
-- today) and reads each club's 31 days three times, so the whole transaction
-- is ~15 s. It takes no lock a writer waits on and writes nothing but the
-- function.
-- ============================================================================
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

/* 1. GUARD: production is what this was written and qualified against. */
DO $guard$
DECLARE
  bad text := '';
  v_oid constant oid := 'public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure;
BEGIN
  IF md5(pg_get_functiondef(v_oid)) <> '52bc064c6d6d53ac8e818051229b764b' THEN
    bad := bad || ' fn_ca_rake_by_agent';
  END IF;
  IF md5(pg_get_functiondef('public.fn_agent_commission_paid_by_period(uuid,uuid,timestamptz)'::regprocedure))
       <> 'bf3d7279f773b121cb8704ffc7e4b057' THEN
    bad := bad || ' fn_agent_commission_paid_by_period';
  END IF;
  IF md5(pg_get_functiondef('public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)'::regprocedure))
       <> '88ea972f7629aff56a3e6bf4d54e8606' THEN
    bad := bad || ' ca_rake_snapshot';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'RAKE_FAST_GUARD: not the body this migration was qualified against:%', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = v_oid
                    AND pg_get_userbyid(p.proowner) = 'postgres'
                    AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'RAKE_FAST_GUARD: fn_ca_rake_by_agent owner or grants are not the qualified ones';
  END IF;
  IF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'RAKE_FAST_GUARD: run this file as written; the proof needs one snapshot (isolation is %)',
      current_setting('transaction_isolation');
  END IF;
END $guard$;

/* 2. PROOF, BEFORE: the old function's answers, on production's own rows. */
CREATE TEMP TABLE _rake_fast_proof (
  n int PRIMARY KEY, club_id uuid NOT NULL, caller uuid, p_start date NOT NULL, p_end date NOT NULL,
  p_sort text NOT NULL, before text, before_ms int, after text, after_ms int
) ON COMMIT DROP;

DO $before$
DECLARE
  r record; v_t0 timestamptz; v jsonb; v_n int := 0;
  v_today constant date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  FOR r IN
    WITH c AS (
      SELECT s.club_id,
             max(s.period_end) FILTER (WHERE isfinite(s.period_end) AND s.period_end < now()) AS last_end
        FROM public.agent_commission_settlements s
       GROUP BY s.club_id
    )
    SELECT c.club_id,
           (SELECT cm.user_id FROM public.club_members cm
             WHERE cm.club_id = c.club_id
               AND cm.role IN ('owner', 'co_owner', 'admin')
               AND COALESCE(cm.status, 'active') = 'active'
             ORDER BY (cm.role = 'owner') DESC, cm.user_id
             LIMIT 1) AS caller,
           x.p_start, x.p_end, x.p_sort
      FROM c
     CROSS JOIN LATERAL (VALUES
             -- both sides of the latest paid-period end (the day before too
             -- when the end is a midnight, so the range still straddles it)
             ((c.last_end AT TIME ZONE 'UTC')::date
                - CASE WHEN (c.last_end AT TIME ZONE 'UTC')::time = '00:00' THEN 1 ELSE 0 END,
              (c.last_end AT TIME ZONE 'UTC')::date, 'cost'),
             -- a whole closed day
             (v_today - 1, v_today - 1, 'rake')) x(p_start, p_end, p_sort)
     WHERE c.last_end IS NOT NULL
     ORDER BY c.club_id, x.p_start, x.p_sort
  LOOP
    v_n := v_n + 1;
    PERFORM set_config('request.jwt.claims',
              CASE WHEN r.caller IS NULL THEN ''
                   ELSE json_build_object('sub', r.caller, 'role', 'authenticated')::text END, true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(r.caller::text, ''), true);
    v_t0 := clock_timestamp();
    v := public.fn_ca_rake_by_agent(r.club_id, r.p_start, r.p_end, 200, 0, NULL, r.p_sort);
    INSERT INTO _rake_fast_proof (n, club_id, caller, p_start, p_end, p_sort, before, before_ms)
    VALUES (v_n, r.club_id, r.caller, r.p_start, r.p_end, r.p_sort, v::text,
            (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int);
  END LOOP;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'RAKE_FAST_PROOF: no club has a paid period, there is nothing to compare';
  END IF;
END $before$;

/* 3. THE FUNCTION. Byte-identical to production except the commission CTE. */
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
  ), paid_cut AS MATERIALIZED (
    -- EVERY INSTANT IN [v_from, v_to) AT WHICH "PAID" CAN CHANGE, AND v_from.
    -- fn_agent_commission_paid_by_period is SELECT EXISTS (...), and a SQL
    -- body with a sublink is never inlined, so asking it inside the FILTERs
    -- below made it a function call, twice for every open commission row in
    -- the range: 4,024,562 calls and 42 s for SHARK CLUB's month. For any
    -- agent the answer can only change where one of this club's paid periods
    -- starts or ends. Between two consecutive cuts it is constant, so it is
    -- asked once per stretch, at the stretch's first instant.
    SELECT v_from AS cut
    UNION
    SELECT s.period_start FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_start > v_from AND s.period_start < v_to
    UNION
    SELECT s.period_end FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.period_end > v_from AND s.period_end < v_to
  ), stretch AS MATERIALIZED (
    -- [lo, hi) stretches that tile [v_from, v_to) exactly: no gap, no overlap.
    SELECT c.cut AS lo, COALESCE(lead(c.cut) OVER (ORDER BY c.cut), v_to) AS hi
      FROM paid_cut c
  ), commission_part AS (
    -- One range read of idx_agent_commissions_club_created per stretch, summed
    -- per (agent, own settled_at set or not). No function call per row. The
    -- half-open window of fn_club_commission_accrued (>= since, < until) is
    -- stated outright as well: the stretches tile it exactly, so it removes
    -- nothing, and no stretch can ever widen what is summed.
    SELECT st.lo, x.user_id, x.open, x.amount
      FROM stretch st
      CROSS JOIN LATERAL (
        SELECT ac.user_id, ac.settled_at IS NULL AS open, SUM(ac.amount) AS amount
          FROM public.agent_commissions ac
         WHERE ac.club_id = p_club_id
           AND ac.created_at >= v_from AND ac.created_at < v_to
           AND ac.created_at >= st.lo AND ac.created_at < st.hi
         GROUP BY ac.user_id, ac.settled_at IS NULL) x
  ), commission AS (
    -- The same predicate and the same two FILTERs, asked once per stretch.
    -- Every sum covers exactly the rows it did (numeric addition is exact and
    -- keeps the largest input scale), and is NULL exactly when it was.
    SELECT cp.user_id,
           SUM(cp.amount)                                          AS earned,
           SUM(cp.amount) FILTER (WHERE cp.open AND NOT public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS outstanding,
           SUM(cp.amount) FILTER (WHERE NOT cp.open OR public.fn_agent_commission_paid_by_period(p_club_id, cp.user_id, cp.lo)) AS settled
      FROM commission_part cp
     GROUP BY cp.user_id
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

/* The grants CREATE OR REPLACE kept, restated so this file says what the helper
   may be called by: never a browser role, only the door (ca_rake_snapshot) and
   service_role. Both statements are no-ops on the ACL production has. */
REVOKE ALL ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(uuid, date, date, integer, integer, text, text) TO service_role;

/* 4. PROOF, AFTER: the same questions give the same text, and the page fits. */
DO $after$
DECLARE
  r record; v_t0 timestamptz; v jsonb; v_ms int; v_best int; v_try int; v_tries text;
  bad text := ''; v_worst int := 0; v_note text := '';
  v_today constant date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  FOR r IN SELECT * FROM _rake_fast_proof ORDER BY n LOOP
    PERFORM set_config('request.jwt.claims',
              CASE WHEN r.caller IS NULL THEN ''
                   ELSE json_build_object('sub', r.caller, 'role', 'authenticated')::text END, true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(r.caller::text, ''), true);
    v_t0 := clock_timestamp();
    v := public.fn_ca_rake_by_agent(r.club_id, r.p_start, r.p_end, 200, 0, NULL, r.p_sort);
    v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int;
    UPDATE _rake_fast_proof SET after = v::text, after_ms = v_ms WHERE n = r.n;
    IF v::text IS DISTINCT FROM r.before THEN
      bad := bad || format(' [club %s %s..%s sort %s]', r.club_id, r.p_start, r.p_end, r.p_sort);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'RAKE_FAST_PROOF: the new breakdown differs from the old on%', bad;
  END IF;

  -- The page's own read at the Month chip's longest: 31 days, first page, rake
  -- sort. The best of three reads is what is held to the 6 s line: one read
  -- measures the database's load at that instant as much as the function (the
  -- first application of this file rolled back on a single 10.1 s read that
  -- read-only runs minutes later put at 1.8-2.0 s).
  FOR r IN SELECT DISTINCT club_id, caller FROM _rake_fast_proof ORDER BY club_id LOOP
    PERFORM set_config('request.jwt.claims',
              CASE WHEN r.caller IS NULL THEN ''
                   ELSE json_build_object('sub', r.caller, 'role', 'authenticated')::text END, true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(r.caller::text, ''), true);
    v_best := NULL; v_tries := '';
    FOR v_try IN 1..3 LOOP
      v_t0 := clock_timestamp();
      v := public.ca_rake_snapshot('club', r.club_id, NULL, v_today - 30, v_today, NULL, 200, 0, NULL, 'rake');
      v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int;
      v_best := LEAST(COALESCE(v_best, v_ms), v_ms);
      v_tries := v_tries || CASE WHEN v_try > 1 THEN '/' ELSE '' END || v_ms;
    END LOOP;
    v_worst := GREATEST(v_worst, v_best);
    v_note := v_note || format(' [club %s, 31 days: %s ms (reads %s), %s rows]', r.club_id, v_best, v_tries,
                               jsonb_array_length(v->'breakdown'));
  END LOOP;
  IF v_worst > 6000 THEN
    RAISE EXCEPTION 'RAKE_FAST_PROOF: the 31-day club snapshot still takes % ms:%', v_worst, v_note;
  END IF;

  SELECT v_note || string_agg(format(' [club %s %s..%s %s: old %s ms, new %s ms, identical]',
                                     club_id, p_start, p_end, p_sort, before_ms, after_ms), '' ORDER BY n)
    INTO v_note FROM _rake_fast_proof;
  RAISE NOTICE 'RAKE_FAST_PROOF passed:%', v_note;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $after$;

/* 5. ASSERT: installed as qualified, and still behind its one door. */
DO $assert$
DECLARE
  v_oid  constant oid := 'public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure;
  v_snap constant oid := 'public.ca_rake_snapshot(text,uuid,uuid,date,date,uuid,integer,integer,text,text)'::regprocedure;
BEGIN
  IF md5(pg_get_functiondef(v_oid)) <> '434abb5ec88d41bd39a8893ac5e39b72' THEN
    RAISE EXCEPTION 'RAKE_FAST_ASSERT: installed body is not the qualified one (md5 %)', md5(pg_get_functiondef(v_oid));
  END IF;
  IF position('fn_agent_commission_paid_by_period(ac.' IN pg_get_functiondef(v_oid)) > 0 THEN
    RAISE EXCEPTION 'RAKE_FAST_ASSERT: the per-row predicate call is still in the body';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = v_oid AND p.prosecdef AND p.provolatile = 's'
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND pg_get_userbyid(p.proowner) = 'postgres'
                    AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'RAKE_FAST_ASSERT: STABLE, SECURITY DEFINER, search_path, owner or grants changed';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'RAKE_FAST_ASSERT: the helper is reachable from a browser role';
  END IF;
  IF md5(pg_get_functiondef(v_snap)) <> '88ea972f7629aff56a3e6bf4d54e8606'
     OR NOT has_function_privilege('authenticated', v_snap, 'EXECUTE') THEN
    RAISE EXCEPTION 'RAKE_FAST_ASSERT: ca_rake_snapshot changed or lost its authenticated grant';
  END IF;
END $assert$;

COMMIT;

