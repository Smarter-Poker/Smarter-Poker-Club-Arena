-- 20261004173704_union_ops_risk_and_preview_stay_inside_the_request_budget.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Two signed-in Union Ops readers still exceeded PostgREST's request budget.
-- fn_union_agent_risk_report materialized every selected rake_records JSON
-- value and expanded each contribution map twice, then joined chip_ledger
-- through an OR that could not stay on either entity index. The settlement
-- preview retained two independent scans of agent_commissions and two of
-- rakeback_periods; its commission scans also called the paid-period predicate
-- once per row instead of spelling out the indexed anti-join used by the
-- settlement path itself.
--
-- This is a reader-only, contract-preserving repair. Risk expands each signed
-- contribution map once and reads inbound and outbound table-stack movements
-- through the existing (club, entity, created_at) indexes. Preview computes
-- each active (club, agent) amount once through agent_commissions_open_idx,
-- skips a pair already covered for the whole requested period, uses the
-- settlement-ledger anti-join for partial coverage, and derives both totals
-- and shortages from that small pair set. Its rakeback rows are grouped once
-- and reused for both the player total and agent-shortfall view.
--
-- No money moves. Authorization, signatures, period boundaries, signed-rake
-- allocation, settlement semantics, rounding, JSON keys and result columns
-- remain unchanged. ca_club_rake_daily_user and ca_club_player_daily cannot
-- replace the Risk source: they are fed by non-negative rake_attributions and
-- therefore do not carry the signed rake_records cancellation lineage this
-- report is required to preserve.
--
-- Isolated PostgreSQL 17 qualification: exact small-data parity plus 1,000,000
-- selected six-way contribution rows and 300,000 chip movements completed the
-- Risk read in 788 ms; 2,200,000 commission rows (1.7M fully covered, 0.5M
-- open) completed Preview in 92 ms. Each call ran with work_mem=4MB and
-- statement_timeout=8s.
--
-- The production PostgreSQL 17 service has JIT unavailable and disabled. The
-- PGDG qualification runner can expose LLVM, and this high-estimate JSON plan
-- crossed the hosted budget despite its no-JIT qualification. Pinning JIT off
-- on this one short-lived reader removes that ambient planning/code-generation
-- variable; PostgreSQL restores the caller setting on return.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure)) = '992fd2f4e0d37df3ff418a00eb7f620b' AND md5(pg_get_functiondef('public.fn_union_settlement_preview(uuid,timestamptz,timestamptz)'::regprocedure)) = 'd0d194d412da011936c4c4b62297f921'

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
BEGIN
  IF md5(pg_get_functiondef(
       'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure))
       IS DISTINCT FROM '4df1d2e6919b4027429c859530922b54' THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_PREIMAGE_CHANGED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_SECURITY_PREIMAGE_CHANGED';
  END IF;

  IF md5(pg_get_functiondef(
       'public.fn_union_settlement_preview(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))
       IS DISTINCT FROM '67d01730fd29d53ba0c04fd2d2637c31' THEN
    RAISE EXCEPTION 'UNION_SETTLEMENT_PREVIEW_PREIMAGE_CHANGED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid =
       'public.fn_union_settlement_preview(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'UNION_SETTLEMENT_PREVIEW_SECURITY_PREIMAGE_CHANGED';
  END IF;

  IF (SELECT count(*)
        FROM pg_index i
       WHERE i.indexrelid IN (
         to_regclass('public.idx_chip_ledger_club_to_created'),
         to_regclass('public.idx_chip_ledger_club_from_created'),
         to_regclass('public.agent_commissions_open_idx'),
         to_regclass('public.agent_commission_settlements_pair_idx'))
         AND i.indisvalid AND i.indisready AND i.indislive) IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'UNION_OPS_REQUEST_BUDGET_INDEX_UNUSABLE';
  END IF;

  IF pg_get_indexdef('public.idx_chip_ledger_club_to_created'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_chip_ledger_club_to_created ON public.chip_ledger USING btree (club_id, to_entity_id, created_at)'
     OR pg_get_indexdef('public.idx_chip_ledger_club_from_created'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX idx_chip_ledger_club_from_created ON public.chip_ledger USING btree (club_id, from_entity_id, created_at)'
     OR pg_get_indexdef('public.agent_commissions_open_idx'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX agent_commissions_open_idx ON public.agent_commissions USING btree (club_id, user_id, created_at) INCLUDE (amount, id) WHERE (settled_at IS NULL)'
     OR pg_get_indexdef('public.agent_commission_settlements_pair_idx'::regclass)
       IS DISTINCT FROM
       'CREATE INDEX agent_commission_settlements_pair_idx ON public.agent_commission_settlements USING btree (club_id, user_id, period_start, period_end)' THEN
    RAISE EXCEPTION 'UNION_OPS_REQUEST_BUDGET_INDEX_CONTRACT_CHANGED';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_union_agent_risk_report(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001',
  p_since timestamptz DEFAULT NULL)
RETURNS TABLE(
  agent_user_id uuid,
  agent_name text,
  club_name text,
  role text,
  players integer,
  seated_now integer,
  rake_generated numeric,
  player_net numeric,
  commission_accrued numeric,
  credit_extended numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET jit TO 'off'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_clubs uuid[];
BEGIN
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id, auth.uid())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT COALESCE(array_agg(x.club_id), '{}'::uuid[])
    INTO v_clubs
    FROM (
      SELECT p_union_id AS club_id
      UNION
      SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id = p_union_id
    ) x;

  RETURN QUERY
  WITH roster AS MATERIALIZED (
    SELECT m.agent_id AS agent_user_id,
           m.user_id AS player_id,
           m.club_id,
           m.joined_at,
           COALESCE(m.credit_used, 0) AS credit_used
      FROM public.club_members m
     WHERE m.club_id = ANY(v_clubs)
       AND m.agent_id IS NOT NULL
  ),
  rake_roster AS MATERIALIZED (
    -- Keep the canonical attribution rule: real union membership wins over
    -- the union-house fallback, then oldest membership and club id break ties.
    SELECT DISTINCT ON (r.player_id)
           r.player_id, r.club_id
      FROM roster r
     ORDER BY r.player_id, (r.club_id = p_union_id),
              r.joined_at ASC NULLS LAST, r.club_id
  ),
  rake AS (
    SELECT allocation.player_id, allocation.club_id,
           SUM(rr.rake_amount * allocation.contribution
               / NULLIF(allocation.total, 0)) AS rake_generated
      FROM public.rake_records rr
      CROSS JOIN LATERAL (
        SELECT r.player_id, r.club_id,
               expanded.contribution, expanded.total
          FROM (
            -- One expansion supplies both each player's numerator and the
            -- row's denominator. The preimage parsed this object twice.
            SELECT (e.key)::uuid AS player_id,
                   e.value::numeric AS contribution,
                   SUM(e.value::numeric) OVER () AS total
              FROM jsonb_each_text(rr.player_contributions) e(key, value)
          ) expanded
          JOIN rake_roster r ON r.player_id = expanded.player_id
         WHERE expanded.total > 0
         -- Keep the tiny roster join inside the parameterized subplan. This
         -- emits only roster matches instead of six allocations per record,
         -- while remaining bounded when every contribution map is unique.
         OFFSET 0
      ) allocation
     WHERE rr.club_id = ANY(v_clubs)
       AND rr.created_at >= v_from
       AND rr.player_contributions IS NOT NULL
     GROUP BY allocation.player_id, allocation.club_id
  ),
  flows AS (
    SELECT r.player_id, r.club_id,
           COALESCE(inflow.amount, 0) - COALESCE(outflow.amount, 0) AS net
      FROM roster r
      LEFT JOIN LATERAL (
        SELECT SUM(l.amount) AS amount
          FROM public.chip_ledger l
         WHERE l.club_id = r.club_id
           AND l.to_entity_id = r.player_id
           AND l.to_type = 'player_wallet'
           AND l.from_type = 'table_stack'
           AND l.status = 'posted'
           AND l.created_at >= v_from
      ) inflow ON true
      LEFT JOIN LATERAL (
        SELECT SUM(l.amount) AS amount
          FROM public.chip_ledger l
         WHERE l.club_id = r.club_id
           AND l.from_entity_id = r.player_id
           AND l.from_type = 'player_wallet'
           AND l.to_type = 'table_stack'
           AND l.status = 'posted'
           AND l.created_at >= v_from
      ) outflow ON true
  ),
  comm AS (
    SELECT ac.user_id AS agent_user_id, ac.club_id, SUM(ac.amount) AS amt
      FROM (SELECT DISTINCT rr.agent_user_id, rr.club_id FROM roster rr) r
      JOIN public.agent_commissions ac
        ON ac.user_id = r.agent_user_id AND ac.club_id = r.club_id
     WHERE ac.created_at >= v_from
     GROUP BY ac.user_id, ac.club_id
  )
  SELECT r.agent_user_id,
         pr.username,
         cl.name,
         COALESCE(a.role, 'agent'),
         COUNT(DISTINCT r.player_id)::int,
         COUNT(DISTINCT r.player_id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM public.table_seats ts
              WHERE ts.user_id = r.player_id
                AND ts.club_id = r.club_id
                AND ts.left_at IS NULL))::int,
         ROUND(COALESCE(SUM(rk.rake_generated), 0), 2),
         ROUND(COALESCE(SUM(fl.net), 0), 2),
         ROUND(COALESCE(MAX(cm.amt), 0), 2),
         ROUND(COALESCE(SUM(r.credit_used), 0), 2)
    FROM roster r
    LEFT JOIN public.profiles pr ON pr.id = r.agent_user_id
    LEFT JOIN public.clubs cl ON cl.id = r.club_id
    LEFT JOIN public.agents a ON a.user_id = r.agent_user_id AND a.club_id = r.club_id
    LEFT JOIN rake rk ON rk.player_id = r.player_id AND rk.club_id = r.club_id
    LEFT JOIN flows fl ON fl.player_id = r.player_id AND fl.club_id = r.club_id
    LEFT JOIN comm cm ON cm.agent_user_id = r.agent_user_id AND cm.club_id = r.club_id
   GROUP BY r.agent_user_id, pr.username, cl.name, a.role
   ORDER BY 8 DESC NULLS LAST;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_preview(
  p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
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

  SELECT EXISTS (
    SELECT 1 FROM public.union_rakeback_log
     WHERE union_id = p_union_id
       AND period_start = v_from AND period_end = v_to)
    INTO v_r1_done;

  SELECT COALESCE(rake_wallet, 0)
    INTO v_rake_wallet
    FROM public.union_wallets
   WHERE union_id = p_union_id;

  -- ROUND 2. One parameterized partial-index scan per active pair, not two
  -- whole-ledger scans and not one paid-period function call per ledger row.
  WITH active_pairs AS MATERIALIZED (
    SELECT uc.club_id, a.user_id
      FROM public.union_clubs uc
      JOIN public.agents a
        ON a.club_id = uc.club_id AND a.status = 'active'
     WHERE uc.union_id = p_union_id
       -- A single settlement row covering this whole preview interval means
       -- every candidate row for the pair is already paid.
       AND NOT EXISTS (
         SELECT 1 FROM public.agent_commission_settlements covered
          WHERE covered.club_id = uc.club_id
            AND covered.user_id = a.user_id
            AND covered.period_start <= v_from
            AND covered.period_end >= v_to)
     GROUP BY uc.club_id, a.user_id
  ),
  owed AS MATERIALIZED (
    SELECT p.club_id, p.user_id, pair_sum.amt
      FROM active_pairs p
      CROSS JOIN LATERAL (
        SELECT SUM(ac.amount) AS amt
          FROM public.agent_commissions ac
         WHERE ac.club_id = p.club_id
           AND ac.user_id = p.user_id
           AND ac.created_at >= v_from
           AND ac.created_at < v_to
           AND ac.settled_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.agent_commission_settlements s
              WHERE s.club_id = ac.club_id
                AND s.user_id = ac.user_id
                AND ac.created_at >= s.period_start
                AND ac.created_at < s.period_end)
      ) pair_sum
     WHERE pair_sum.amt IS NOT NULL
  ),
  byclub AS MATERIALIZED (
    SELECT o.club_id, SUM(o.amt) AS club_owed,
           COALESCE(c.chip_treasury, 0) AS treasury, c.name
      FROM owed o
      JOIN public.clubs c ON c.id = o.club_id
     GROUP BY o.club_id, c.chip_treasury, c.name
  ),
  short_clubs AS MATERIALIZED (
    SELECT b.club_id,
           jsonb_build_object(
             'club_id', b.club_id, 'club', b.name,
             'owed', b.club_owed, 'treasury', b.treasury,
             'short_by', round(b.club_owed - b.treasury, 2)) AS detail,
           b.club_owed - b.treasury AS short_by
      FROM byclub b
     WHERE b.treasury < b.club_owed
  )
  SELECT COALESCE((SELECT SUM(o.amt) FROM owed o WHERE o.amt > 0), 0),
         COALESCE((SELECT COUNT(*) FROM owed o WHERE o.amt > 0), 0)::int,
         COALESCE((SELECT jsonb_agg(s.detail ORDER BY s.club_id) FROM short_clubs s),
                  '[]'::jsonb),
         COALESCE((SELECT SUM(s.short_by) FROM short_clubs s), 0)
    INTO v_r2_total, v_r2_payees, v_r2_short, v_r2_short_amt;

  -- ROUND 3. The player grouping is the common exact fact set. Positive
  -- player totals feed payees; all player totals feed each paying agent's
  -- shortage, preserving the two preimage aggregates without two base scans.
  WITH owed AS MATERIALIZED (
    SELECT rp.user_id AS player_id, rp.club_id, cm.agent_id AS agent_user,
           SUM(rp.rakeback_amount) AS amt
      FROM public.rakeback_periods rp
      JOIN public.union_clubs uc
        ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
      JOIN public.club_members cm
        ON cm.user_id = rp.user_id AND cm.club_id = rp.club_id
     WHERE rp.status = 'pending'
       AND rp.period_start >= v_from::date
       AND rp.period_start < v_to::date + 1
       AND cm.agent_id IS NOT NULL
     GROUP BY rp.user_id, rp.club_id, cm.agent_id
  ),
  byagent AS MATERIALIZED (
    SELECT o.club_id, o.agent_user, SUM(o.amt) AS agent_owed,
           COALESCE(am.chip_balance, 0) AS agent_balance,
           public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                pr.first_name, pr.last_name, pr.full_name) AS agent_name
      FROM owed o
      LEFT JOIN public.club_members am
        ON am.user_id = o.agent_user AND am.club_id = o.club_id
      LEFT JOIN public.profiles pr ON pr.id = o.agent_user
     GROUP BY o.club_id, o.agent_user, am.chip_balance,
              pr.alias, pr.username, pr.display_name,
              pr.first_name, pr.last_name, pr.full_name
  ),
  short_agents AS MATERIALIZED (
    SELECT a.club_id, a.agent_user,
           jsonb_build_object(
             'agent_user_id', a.agent_user,
             'agent', a.agent_name,
             'club_id', a.club_id, 'owed', a.agent_owed,
             'agent_balance', a.agent_balance,
             'short_by', round(a.agent_owed - a.agent_balance, 2)) AS detail,
           a.agent_owed - a.agent_balance AS short_by
      FROM byagent a
     WHERE a.agent_balance < a.agent_owed
  )
  SELECT COALESCE((SELECT SUM(o.amt) FROM owed o WHERE o.amt > 0), 0),
         COALESCE((SELECT COUNT(*) FROM owed o WHERE o.amt > 0), 0)::int,
         COALESCE((SELECT jsonb_agg(s.detail ORDER BY s.club_id, s.agent_user)
                     FROM short_agents s), '[]'::jsonb),
         COALESCE((SELECT SUM(s.short_by) FROM short_agents s), 0)
    INTO v_r3_total, v_r3_payees, v_r3_short, v_r3_short_amt;

  RETURN jsonb_build_object(
    'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to,
    'round1', jsonb_build_object(
      'already_executed', v_r1_done,
      'rake_treasury_available', v_rake_wallet),
    'round2', jsonb_build_object(
      'payees', v_r2_payees, 'amount', round(v_r2_total, 2),
      'clubs_short', jsonb_array_length(v_r2_short),
      'short_by', round(v_r2_short_amt, 2), 'detail', v_r2_short),
    'round3', jsonb_build_object(
      'payees', v_r3_payees, 'amount', round(v_r3_total, 2),
      'agents_short', jsonb_array_length(v_r3_short),
      'short_by', round(v_r3_short_amt, 2), 'detail', v_r3_short),
    'total_to_move', round(v_r2_total + v_r3_total, 2),
    'has_blockers',
      (jsonb_array_length(v_r2_short) + jsonb_array_length(v_r3_short)) > 0);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_union_agent_risk_report(uuid, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_agent_risk_report(uuid, timestamptz)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_settlement_preview(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_preview(uuid, timestamptz, timestamptz)
  TO authenticated, service_role;

DO $postimage$
DECLARE
  v_risk text := pg_get_functiondef(
    'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure);
  v_preview text := pg_get_functiondef(
    'public.fn_union_settlement_preview(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
BEGIN
  IF md5(v_risk) IS DISTINCT FROM '992fd2f4e0d37df3ff418a00eb7f620b'
     OR position('scoped_rake_records AS MATERIALIZED' IN v_risk) > 0
     OR position('GROUP BY rr.player_contributions' IN v_risk) > 0
     OR position('JOIN rake_roster r ON r.player_id = expanded.player_id' IN v_risk) = 0
     OR position('OFFSET 0' IN v_risk) = 0
     OR position('GROUP BY allocation.player_id, allocation.club_id' IN v_risk) = 0
     OR position('SUM(e.value::numeric) OVER ()' IN v_risk) = 0
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_union_agent_risk_report(uuid,timestamp with time zone)'::regprocedure
          AND pg_get_userbyid(p.proowner) = 'postgres'
          AND p.prosecdef
          AND p.provolatile = 's'
          AND p.proconfig IS NOT DISTINCT FROM
              ARRAY['search_path=public','jit=off']::text[]
          AND p.proacl::text IS NOT DISTINCT FROM
              '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
     OR position('idx_chip_ledger_club_to_created' IN
          pg_get_indexdef('public.idx_chip_ledger_club_to_created'::regclass)) = 0
     OR position('idx_chip_ledger_club_from_created' IN
          pg_get_indexdef('public.idx_chip_ledger_club_from_created'::regclass)) = 0 THEN
    RAISE EXCEPTION 'UNION_AGENT_RISK_REPORT_POSTIMAGE_INVALID';
  END IF;
  IF md5(v_preview) IS DISTINCT FROM 'd0d194d412da011936c4c4b62297f921'
     OR position('fn_agent_commission_paid_by_period' IN v_preview) > 0
     OR position('agent_commission_settlements' IN v_preview) = 0
     OR position('CROSS JOIN LATERAL' IN v_preview) = 0
     OR position('owed AS MATERIALIZED' IN v_preview) = 0
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_union_settlement_preview(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure
          AND pg_get_userbyid(p.proowner) = 'postgres'
          AND p.prosecdef
          AND p.provolatile = 's'
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
          AND p.proacl::text IS NOT DISTINCT FROM
              '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'UNION_SETTLEMENT_PREVIEW_POSTIMAGE_INVALID';
  END IF;
  IF (SELECT count(*)
        FROM pg_index i
       WHERE i.indexrelid IN (
         to_regclass('public.idx_chip_ledger_club_to_created'),
         to_regclass('public.idx_chip_ledger_club_from_created'),
         to_regclass('public.agent_commissions_open_idx'),
         to_regclass('public.agent_commission_settlements_pair_idx'))
         AND i.indisvalid AND i.indisready AND i.indislive) IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'UNION_OPS_REQUEST_BUDGET_INDEX_POSTIMAGE_UNUSABLE';
  END IF;
END
$postimage$;

COMMENT ON FUNCTION public.fn_union_agent_risk_report(uuid, timestamptz) IS
  'Union Ops agent risk; signed contribution JSON is expanded once and wallet/table flows use separate indexed directions.';
COMMENT ON FUNCTION public.fn_union_settlement_preview(uuid, timestamptz, timestamptz) IS
  'Read-only union settlement preview; commission and rakeback bases are each read once and paid periods use the explicit settlement anti-join.';

COMMIT;
