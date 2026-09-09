BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 7 OF 8 - THE PREDICATE MUST INLINE, OR IT IS A PER-ROW FUNCTION CALL.
   ---------------------------------------------------------------------------
   20260908025653 gave every reader one predicate,
   fn_agent_commission_paid_by_period, and declared it
   LANGUAGE sql STABLE SET search_path TO 'public'.

   THE SET CLAUSE IS THE DEFECT. Postgres will not inline a SQL function that
   carries a SET, so the predicate stopped being a semi-join the planner could
   fold into the scan and became a function call PER ROW. On a scoped read
   (one pair, one club-week) that is invisible. On the two readers that walk
   every unsettled row it is fatal: fn_club_unclaimable_commission(NULL) scans
   2,851,735 rows and timed out at 150 s in the verification probe that
   followed the migration - a read that answered in seconds an hour earlier.

   THE FIX, in three parts.
     1. The three helpers lose the SET and keep fully-qualified names, so they
        inline. They are SECURITY INVOKER, every reference is public.<table>,
        so resolution is deterministic without the SET. (ALTER ... RESET is
        issued too: CREATE OR REPLACE is not guaranteed to clear proconfig.)
     2. The two readers that scan the whole ledger - and the
        agent_commissions_unsettled view they read through - spell the
        anti-join out as NOT EXISTS rather than relying on inlining. The
        planner then has a hash anti-join against a 0-row (today) settlement
        table instead of 2.85M correlated lookups.
     3. Proven below by timing all three against production, in a transaction
        that is rolled back, and by asserting the figures they return are
        unchanged.

   Nothing about the MODEL changes here. Round 2 still records the period it
   paid; no commission row is stamped. */

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_agent_commission_paid_by_period'
                   AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'the predicate is missing - 20260908025653 has not been applied';
  END IF;
END $guard$;

/* 1. the helpers, inlinable */
CREATE OR REPLACE FUNCTION public.fn_agent_commission_paid_by_period(p_club_id uuid, p_user_id uuid, p_created_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                  WHERE s.club_id = p_club_id AND s.user_id = p_user_id
                    AND p_created_at >= s.period_start AND p_created_at < s.period_end);
$function$;
ALTER FUNCTION public.fn_agent_commission_paid_by_period(uuid, uuid, timestamptz) RESET search_path;

CREATE OR REPLACE FUNCTION public.fn_agent_commission_open_intervals(p_club_id uuid, p_user_id uuid)
RETURNS TABLE(lo timestamptz, hi timestamptz)
LANGUAGE sql
STABLE
AS $function$
  WITH paid AS (
    SELECT s.period_start, s.period_end
      FROM public.agent_commission_settlements s
     WHERE s.club_id = p_club_id AND s.user_id = p_user_id
     ORDER BY s.period_start
  ), edges AS (
    SELECT '-infinity'::timestamptz AS lo,
           COALESCE((SELECT min(period_start) FROM paid), 'infinity'::timestamptz) AS hi
    UNION ALL
    SELECT p.period_end AS lo,
           COALESCE((SELECT min(q.period_start) FROM paid q WHERE q.period_start >= p.period_end), 'infinity'::timestamptz) AS hi
      FROM paid p
  )
  SELECT e.lo, e.hi FROM edges e WHERE e.hi > e.lo ORDER BY e.lo;
$function$;
ALTER FUNCTION public.fn_agent_commission_open_intervals(uuid, uuid) RESET search_path;

CREATE OR REPLACE FUNCTION public.fn_agent_commission_owed_rows(p_club_id uuid, p_user_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS TABLE(id uuid, amount numeric, created_at timestamptz)
LANGUAGE sql
STABLE
AS $function$
  SELECT ac.id, ac.amount, ac.created_at
    FROM public.fn_agent_commission_open_intervals(p_club_id, p_user_id) i
    CROSS JOIN LATERAL (
      SELECT a.id, a.amount, a.created_at
        FROM public.agent_commissions a
       WHERE a.club_id = p_club_id AND a.user_id = p_user_id
         AND a.settled_at IS NULL
         AND a.created_at >= GREATEST(i.lo, COALESCE(p_from, '-infinity'::timestamptz))
         AND a.created_at <  LEAST(i.hi, COALESCE(p_to, 'infinity'::timestamptz))
       ORDER BY a.created_at
    ) ac
   ORDER BY ac.created_at;
$function$;
ALTER FUNCTION public.fn_agent_commission_owed_rows(uuid, uuid, timestamptz, timestamptz) RESET search_path;

/* 2. the whole-ledger readers spell the anti-join out */
CREATE OR REPLACE VIEW public.agent_commissions_unsettled WITH (security_invoker = true) AS
  SELECT ac.*
    FROM public.agent_commissions ac
   WHERE ac.settled_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                      WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                        AND ac.created_at >= s.period_start AND ac.created_at < s.period_end);

DO $readers$
DECLARE
  v_def text; v_new text;
  v_fn_ac constant text := 'NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)';
  v_ex_ac constant text := 'NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s2 WHERE s2.club_id = ac.club_id AND s2.user_id = ac.user_id AND ac.created_at >= s2.period_start AND ac.created_at < s2.period_end)';
  v_fn_a  constant text := 'NOT public.fn_agent_commission_paid_by_period(a.club_id, a.user_id, a.created_at)';
  v_ex_a  constant text := 'NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s2 WHERE s2.club_id = a.club_id AND s2.user_id = a.user_id AND a.created_at >= s2.period_start AND a.created_at < s2.period_end)';
BEGIN
  v_def := pg_get_functiondef('public.fn_club_unclaimable_commission(uuid)'::regprocedure);
  IF position(v_fn_ac IN v_def) = 0 THEN RAISE EXCEPTION 'unclaimable: predicate call not found'; END IF;
  EXECUTE replace(v_def, v_fn_ac, v_ex_ac);

  v_def := pg_get_functiondef('public.fn_ca_hierarchy_payables(uuid)'::regprocedure);
  IF position(v_fn_a IN v_def) = 0 THEN RAISE EXCEPTION 'hierarchy: predicate call not found'; END IF;
  EXECUTE replace(v_def, v_fn_a, v_ex_a);
END $readers$;

/* 3. PROVEN AGAINST PRODUCTION, ROLLED BACK. */
DO $proof$
DECLARE
  v_t0 timestamptz; v_ms_unclaim int; v_ms_hier int; v_ms_view int; v_ms_r2 int;
  v_x jsonb; v_rows int; v_view_amt numeric; v_r jsonb; v_old_amt numeric; v_old_pairs int;
  v_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_from  constant timestamptz := '2026-09-07 07:00:00+00';
  v_to    timestamptz := now() - interval '10 minutes';
BEGIN
  BEGIN
    /* these two are management-gated; the World Hub calls them with the
       service key. The claim is transaction-local and rolled back with the rest. */
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_t0 := clock_timestamp();
    v_x := public.fn_club_unclaimable_commission(NULL);
    v_ms_unclaim := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;
    IF v_ms_unclaim > 60000 THEN RAISE EXCEPTION 'PROBE_FAILED: unclaimable still takes % ms', v_ms_unclaim; END IF;

    v_t0 := clock_timestamp();
    SELECT count(*) INTO v_rows FROM public.fn_ca_hierarchy_payables(NULL);
    v_ms_hier := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;
    IF v_ms_hier > 60000 THEN RAISE EXCEPTION 'PROBE_FAILED: hierarchy still takes % ms', v_ms_hier; END IF;

    /* Both reads are bounded by v_to. The engine writes this table every
       second and each statement takes a fresh snapshot under READ COMMITTED,
       so an unbounded pair of sums disagrees by whatever arrived between them
       (measured: 1.83). A row written now carries created_at > v_to and is
       outside both. */
    v_t0 := clock_timestamp();
    SELECT round(COALESCE(sum(amount), 0), 2) INTO v_view_amt
      FROM public.agent_commissions_unsettled WHERE created_at < v_to;
    v_ms_view := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;

    -- with no settlement rows the view must still equal the old predicate exactly
    SELECT round(COALESCE(sum(amount), 0), 2) INTO v_old_amt
      FROM public.agent_commissions WHERE settled_at IS NULL AND created_at < v_to;
    IF v_view_amt <> v_old_amt THEN
      RAISE EXCEPTION 'PROBE_FAILED: view % <> settled_at IS NULL %', v_view_amt, v_old_amt;
    END IF;

    -- and round 2 still pays exactly what the old predicate selects
    SELECT count(DISTINCT (ac.club_id, ac.user_id)), round(sum(ac.amount), 2) INTO v_old_pairs, v_old_amt
      FROM public.agent_commissions ac
      JOIN public.union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = v_union
      JOIN public.agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status = 'active'
     WHERE ac.created_at >= v_from AND ac.created_at < v_to AND ac.settled_at IS NULL;
    v_t0 := clock_timestamp();
    v_r := public.fn_settle_round2_club_to_agents(v_union, v_from, v_to);
    v_ms_r2 := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;
    IF (v_r->>'payees')::int <> v_old_pairs OR round((v_r->>'amount')::numeric, 2) <> v_old_amt THEN
      RAISE EXCEPTION 'PROBE_FAILED: round 2 paid %/% against the old predicate %/%',
        v_r->>'payees', v_r->>'amount', v_old_pairs, v_old_amt;
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK unclaimable=% ms (pairs %, total %) hierarchy=% ms (% rows) view=% ms (%) r2=% ms (% payees, %)',
      v_ms_unclaim, v_x->>'pairs', v_x->>'total', v_ms_hier, v_rows, v_ms_view, v_view_amt, v_ms_r2, v_r->>'payees', v_r->>'amount';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'FIXTURE_ROLLBACK%' THEN RAISE; END IF;
    RAISE WARNING '%', SQLERRM;
  END;
END $proof$;

DO $assert$
DECLARE v_cfg text[]; v_src text;
BEGIN
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE proname = 'fn_agent_commission_paid_by_period' AND pronamespace = 'public'::regnamespace;
  IF v_cfg IS NOT NULL THEN RAISE EXCEPTION 'the predicate still carries a SET clause and cannot inline: %', v_cfg; END IF;
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE proname = 'fn_agent_commission_owed_rows' AND pronamespace = 'public'::regnamespace;
  IF v_cfg IS NOT NULL THEN RAISE EXCEPTION 'fn_agent_commission_owed_rows still carries a SET clause'; END IF;
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE proname = 'fn_agent_commission_open_intervals' AND pronamespace = 'public'::regnamespace;
  IF v_cfg IS NOT NULL THEN RAISE EXCEPTION 'fn_agent_commission_open_intervals still carries a SET clause'; END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_club_unclaimable_commission' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%fn_agent_commission_paid_by_period%' OR v_src NOT LIKE '%agent_commission_settlements%' THEN
    RAISE EXCEPTION 'fn_club_unclaimable_commission does not spell out its anti-join';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_ca_hierarchy_payables' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%fn_agent_commission_paid_by_period%' OR v_src NOT LIKE '%agent_commission_settlements%' THEN
    RAISE EXCEPTION 'fn_ca_hierarchy_payables does not spell out its anti-join';
  END IF;
  IF pg_get_viewdef('public.agent_commissions_unsettled'::regclass) LIKE '%fn_agent_commission_paid_by_period%' THEN
    RAISE EXCEPTION 'the view does not spell out its anti-join';
  END IF;
  IF has_table_privilege('anon', 'public.agent_commissions_unsettled', 'SELECT') THEN
    RAISE EXCEPTION 'anon reaches the unsettled view';
  END IF;
END $assert$;

COMMIT;