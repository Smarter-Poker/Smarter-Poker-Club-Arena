BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 7 OF 8 (UNION ACCOUNTING) - PERFORMANCE: THE ROUND-2 MODEL CHANGE.
   ---------------------------------------------------------------------------
   THE COST. Round 2 (fn_settle_round2_club_to_agents) paid each (club, agent)
   pair by summing the pair's agent_commissions rows in the period, then
   STAMPED every one of those rows with settled_at. Measured 2026-09-07
   (docs/changelog/2026-09-07-the-union-week-ends-at-midnight-pacific.md):
   2,124,321 rows to stamp for one week, a 2,035 MB table with eight indexes,
   settled_at inside a partial index predicate so no update is HOT, 3,180
   rows/s, 668 s projected for round 2 alone. The close job's ceiling was raised
   to 2,400 s to survive it, with the note: "the thing to change is the
   settled_at model ... deriving 'unsettled' from the last settled period end
   removes the write entirely. That is a design change." This is that change.

   WHY NOT A PLAIN WATERMARK. 1,118,785 rows carry a settled_at today and 83
   pairs have settled and unsettled rows interleaved in time (the agent claim,
   fn_agent_claim_commission, settles batches in no particular order), and
   239 pairs hold 1,008,358.25 of unsettled legacy rows older than any period
   round 2 will ever pay. A watermark "everything before T is settled" would
   silently mark that money paid. So:

   THE MODEL.
     - A commission row is SETTLED when EITHER its own settled_at is set (a
       claim, or history) OR it lies inside a period a settlement row says
       round 2 paid for its (club, agent). agent_commission_settlements holds
       one row per (club, agent, period): amount, rows, paid_at. Round 2
       writes ONE row per pair and touches no commission row.
     - Every reader asks the same question through one predicate,
       fn_agent_commission_paid_by_period(club, user, created_at), or reads
       the views agent_commissions_unsettled / v_agent_commissions.
     - Money paths (round 2, the claim, the rollup) read only the OPEN
       intervals between paid periods via fn_agent_commission_open_intervals
       and the partial index agent_commissions_open_idx
       (club_id, user_id, created_at) INCLUDE (amount, id) WHERE settled_at IS
       NULL (built CONCURRENTLY 2026-09-08 02:33 UTC, 235 MB), so their cost is
       the rows actually owed, never the rows already paid.
     - Round 2 refuses a period that ended less than five minutes ago: a
       commission row's created_at is its transaction's start, and the longest
       transaction that writes one is an eight-second engine call. Five
       minutes is the margin between "the period is closed" and "a row from a
       transaction that began inside it can still land".
     - Legacy stamps stay exactly as they are. The claim keeps stamping its
       batches (bounded to 5,000 rows, its own 8 s budget), and its batch now
       comes from the open intervals, so it can never re-pay a round-2 row.

   WHAT IS PROVEN BELOW, IN A ROLLED-BACK SUBTRANSACTION.
     1. With no settlement rows yet, the new predicate and the old
        settled_at IS NULL agree on every pair's owed figure and on the total.
     2. Round 2 for the week of 2026-08-31 pays the same pairs and amounts the
        old predicate would have selected, writes one settlement row per pair,
        updates no commission row, runs in seconds, and a second call pays
        nothing.
     3. A claim after that round 2 settles only rows outside the paid period.
   Then the whole rehearsal is rolled back: no money moves in this migration.

   READERS CHANGED HERE (every SQL function that read settled_at):
   fn_settle_round2_club_to_agents, fn_agent_claim_commission,
   fn_agent_unsettled_commission, fn_agent_commission_rollup_recompute,
   fn_rebuild_agent_commission_rollup, trg_agent_commission_rollup_insert,
   fn_union_settlement_preview, fn_get_agent_commission_summary,
   fn_agent_downline_commission, fn_club_unclaimable_commission,
   fn_ca_hierarchy_payables, fn_ca_rake_by_agent, fn_ca_gdpr_financial_precheck,
   fn_club_set_member_role. The two apps read the view v_agent_commissions
   (same columns, settled_at is the EFFECTIVE settlement time) - that change
   ships in the same pull request. */

DO $guard$
DECLARE bad text := '';
BEGIN
  IF md5(pg_get_functiondef('public.fn_agent_downline_commission(uuid)'::regprocedure)) <> 'd04009ba43ff25079ebc7cf9c3e59cd4' THEN bad := bad || ' fn_agent_downline_commission'; END IF;
  IF md5(pg_get_functiondef('public.fn_ca_gdpr_financial_precheck(uuid)'::regprocedure)) <> '596b78770ac295fd6c8d92328ce2e93c' THEN bad := bad || ' fn_ca_gdpr_financial_precheck'; END IF;
  IF md5(pg_get_functiondef('public.fn_ca_hierarchy_payables(uuid)'::regprocedure)) <> '0a238b345f84be3bfc0dde8e5bc1b20a' THEN bad := bad || ' fn_ca_hierarchy_payables'; END IF;
  IF md5(pg_get_functiondef('public.fn_club_unclaimable_commission(uuid)'::regprocedure)) <> 'bd7721b83d20a2e34ed9253c5f2335c9' THEN bad := bad || ' fn_club_unclaimable_commission'; END IF;
  IF md5(pg_get_functiondef('public.fn_get_agent_commission_summary(uuid,uuid)'::regprocedure)) <> 'ff57d5ab6f07b0e692dee637758f3bb6' THEN bad := bad || ' fn_get_agent_commission_summary'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_settlement_preview(uuid,timestamptz,timestamptz)'::regprocedure)) <> 'ef4fd4be1a80b8cc6fd4ff8eebfebce6' THEN bad := bad || ' fn_union_settlement_preview'; END IF;
  IF md5(pg_get_functiondef('public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure)) <> 'd2edcca17b56804cdec09ae10ff9cfe4' THEN bad := bad || ' fn_ca_rake_by_agent'; END IF;
  IF md5(pg_get_functiondef('public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)'::regprocedure)) <> '67636eb782a97d462cc2360b30cbf159' THEN bad := bad || ' fn_club_set_member_role'; END IF;
  IF md5(pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure)) <> '69f77a27a2637da5f36dc4ecd2f72e4a' THEN bad := bad || ' trg_agent_commission_rollup_insert'; END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'changed since the 2026-09-08 02:40 UTC audit; re-read before applying:%', bad; END IF;
END $guard$;

/* 1. THE SETTLEMENT LEDGER: one row per (club, agent, period) round 2 paid. */
CREATE TABLE IF NOT EXISTS public.agent_commission_settlements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id        uuid        NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL,
  union_id       uuid,
  period_start   timestamptz NOT NULL,
  period_end     timestamptz NOT NULL,
  amount         numeric     NOT NULL CHECK (amount >= 0 AND amount = round(amount, 2)),
  rows_count     integer     NOT NULL DEFAULT 0,
  paid_at        timestamptz NOT NULL DEFAULT now(),
  settlement_ref text,
  CHECK (period_end > period_start),
  UNIQUE (club_id, user_id, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS agent_commission_settlements_pair_idx
  ON public.agent_commission_settlements (club_id, user_id, period_start, period_end);
COMMENT ON TABLE public.agent_commission_settlements IS
  'Phase 7 (20260908): the periods round 2 has paid per (club, agent). A commission row created inside one of these periods is settled without carrying a settled_at of its own. Read through fn_agent_commission_paid_by_period; never through a row scan.';

ALTER TABLE public.agent_commission_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_commission_settlements FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.agent_commission_settlements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_commission_settlements TO service_role;
DROP POLICY IF EXISTS acs_service_only ON public.agent_commission_settlements;
CREATE POLICY acs_service_only ON public.agent_commission_settlements FOR ALL TO service_role
  USING ((SELECT auth.role()) = 'service_role');
DROP POLICY IF EXISTS acs_agent_reads_own ON public.agent_commission_settlements;
CREATE POLICY acs_agent_reads_own ON public.agent_commission_settlements FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS acs_union_overseer_read ON public.agent_commission_settlements;
CREATE POLICY acs_union_overseer_read ON public.agent_commission_settlements FOR SELECT TO authenticated
  USING ((SELECT public.fn_is_any_union_overseer((SELECT auth.uid()))) AND public.fn_union_oversees_club(club_id, (SELECT auth.uid())));

/* the index, on the record. It was built CONCURRENTLY beforehand:
     CREATE INDEX CONCURRENTLY agent_commissions_open_idx
       ON public.agent_commissions (club_id, user_id, created_at) INCLUDE (amount, id) WHERE settled_at IS NULL;
   Not re-declared here even with IF NOT EXISTS: that form takes a ShareLock on
   the table before it looks for the name, and on this table (a constant
   stream of engine inserts) that is a lock timeout every time. Asserted. */
DO $idx$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'agent_commissions_open_idx' AND i.indisvalid) THEN
    RAISE EXCEPTION 'agent_commissions_open_idx is missing or invalid - build it CONCURRENTLY first';
  END IF;
END $idx$;

/* 2. THE ONE PREDICATE. */
CREATE OR REPLACE FUNCTION public.fn_agent_commission_paid_by_period(p_club_id uuid, p_user_id uuid, p_created_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                  WHERE s.club_id = p_club_id AND s.user_id = p_user_id
                    AND p_created_at >= s.period_start AND p_created_at < s.period_end);
$function$;

/* 3. THE OPEN INTERVALS of a pair: the complement of its paid periods. */
CREATE OR REPLACE FUNCTION public.fn_agent_commission_open_intervals(p_club_id uuid, p_user_id uuid)
RETURNS TABLE(lo timestamptz, hi timestamptz)
LANGUAGE sql
STABLE
SET search_path TO 'public'
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

/* 4. THE ROWS A PAIR IS OWED, read only from its open intervals. */
CREATE OR REPLACE FUNCTION public.fn_agent_commission_owed_rows(p_club_id uuid, p_user_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS TABLE(id uuid, amount numeric, created_at timestamptz)
LANGUAGE sql
STABLE
SET search_path TO 'public'
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

REVOKE ALL ON FUNCTION public.fn_agent_commission_paid_by_period(uuid, uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_agent_commission_open_intervals(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_agent_commission_owed_rows(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_commission_paid_by_period(uuid, uuid, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_commission_open_intervals(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_commission_owed_rows(uuid, uuid, timestamptz, timestamptz) TO authenticated, service_role;

/* 5. THE VIEWS the apps read. security_invoker: the base tables' row security applies. */
CREATE OR REPLACE VIEW public.agent_commissions_unsettled WITH (security_invoker = true) AS
  SELECT ac.*
    FROM public.agent_commissions ac
   WHERE ac.settled_at IS NULL
     AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at);

CREATE OR REPLACE VIEW public.v_agent_commissions WITH (security_invoker = true) AS
  SELECT ac.id, ac.club_id, ac.user_id, ac.amount, ac.commission_rate, ac.source_type, ac.source_id,
         ac.notes, ac.created_at,
         COALESCE(ac.settled_at, s.paid_at) AS settled_at,
         CASE WHEN ac.settled_at IS NOT NULL THEN 'claim'
              WHEN s.id IS NOT NULL THEN 'round2'
              ELSE NULL END AS settled_via,
         s.id AS settlement_id
    FROM public.agent_commissions ac
    LEFT JOIN LATERAL (
      SELECT x.id, x.paid_at FROM public.agent_commission_settlements x
       WHERE x.club_id = ac.club_id AND x.user_id = ac.user_id
         AND ac.created_at >= x.period_start AND ac.created_at < x.period_end
       LIMIT 1) s ON TRUE;

REVOKE ALL ON public.agent_commissions_unsettled FROM PUBLIC, anon;
REVOKE ALL ON public.v_agent_commissions FROM PUBLIC, anon;
GRANT SELECT ON public.agent_commissions_unsettled TO authenticated, service_role;
GRANT SELECT ON public.v_agent_commissions TO authenticated, service_role;

/* 6. ROUND 2 - pays a pair from its open intervals inside the period, records
   the period, and never touches a commission row. */
CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_club_bal numeric; v_paid numeric := 0;
  v_payees int := 0; v_short int := 0; v_detail jsonb := '[]'::jsonb;
  v_debit jsonb; v_agent_bal numeric; v_pairs jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id, auth.uid())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;
  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents', 'success', false, 'error', 'bad_params',
                              'payees', 0, 'amount', 0, 'shortfalls', 0, 'detail', '[]'::jsonb);
  END IF;
  /* A row's created_at is its transaction's start. The longest transaction that
     writes agent_commissions is an eight-second engine call; five minutes after
     the period closes, nothing that began inside it is still in flight. Before
     that, a period recorded as paid could swallow a row that landed late. */
  IF p_period_end > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents', 'success', false, 'retryable', true,
                              'error', 'period_too_fresh', 'period_end', p_period_end,
                              'payees', 0, 'amount', 0, 'shortfalls', 0, 'detail', '[]'::jsonb);
  END IF;

  FOR r IN
    SELECT uc.club_id, a.user_id AS agent_user, SUM(o.amount) AS owed, count(*) AS n
      FROM union_clubs uc
      JOIN agents a ON a.club_id = uc.club_id AND a.status = 'active'
      CROSS JOIN LATERAL public.fn_agent_commission_owed_rows(uc.club_id, a.user_id, p_period_start, p_period_end) o
     WHERE uc.union_id = p_union_id
     GROUP BY uc.club_id, a.user_id
    HAVING SUM(o.amount) > 0
     ORDER BY 1, 2
  LOOP
    -- Same pot Round 1 credits (clubs.chip_treasury), not club_wallets.
    SELECT COALESCE(chip_treasury, 0) INTO v_club_bal FROM clubs WHERE id = r.club_id FOR UPDATE;

    IF COALESCE(v_club_bal, 0) < r.owed THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'club_treasury', COALESCE(v_club_bal, 0), 'skipped', true);
      CONTINUE;
    END IF;

    v_debit := public.fn_debit_treasury(
      r.club_id, r.owed,
      'Round 2: club -> agent commission',
      jsonb_build_object('union_id', p_union_id, 'agent_user_id', r.agent_user,
                         'period_start', p_period_start, 'period_end', p_period_end));
    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'error', v_debit, 'skipped', true);
      CONTINUE;
    END IF;

    PERFORM public.fn_ensure_club_wallet(r.agent_user, r.club_id);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id
     RETURNING chip_balance INTO v_agent_bal;

    /* THE RECORD, instead of two million stamps: one row says this pair's
       rows inside this period are paid. A second call finds no open rows
       inside the period and pays nothing. */
    INSERT INTO public.agent_commission_settlements
      (club_id, user_id, union_id, period_start, period_end, amount, rows_count, paid_at, settlement_ref)
    VALUES (r.club_id, r.agent_user, p_union_id, p_period_start, p_period_end, round(r.owed, 2), r.n, now(),
            'round2:' || p_union_id::text || ':' || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD'))
    ON CONFLICT (club_id, user_id, period_start, period_end) DO NOTHING;

    -- Both sides of the entry: club-side debit above, agent credit here.
    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES
      (r.agent_user, 'PLAYER', 'credit', r.owed, 'commission',
       'Round 2: club -> agent commission [club wallet]', v_agent_bal);

    v_pairs := v_pairs || jsonb_build_object('club_id', r.club_id, 'user_id', r.agent_user);
    v_paid := v_paid + r.owed;
    v_payees := v_payees + 1;
  END LOOP;

  IF v_pairs <> '[]'::jsonb THEN
    PERFORM public.fn_agent_commission_rollup_recompute(v_pairs);
  END IF;

  RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents',
    'payees', v_payees, 'amount', round(v_paid, 2), 'shortfalls', v_short, 'detail', v_detail);
END
$function$;

/* 7. THE ROLLUP reads the same intervals. */
CREATE OR REPLACE FUNCTION public.fn_agent_commission_rollup_recompute(p_pairs jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  WITH pairs AS (
    SELECT DISTINCT (p->>'club_id')::uuid AS club_id, (p->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(p_pairs) p
     WHERE p->>'club_id' IS NOT NULL AND p->>'user_id' IS NOT NULL
  ),
  fresh AS (
    SELECT pr.club_id, pr.user_id,
           coalesce(sum(o.amount), 0)  AS owed,
           count(o.id)                 AS rows_behind,
           min(o.created_at)           AS oldest
      FROM pairs pr
      LEFT JOIN LATERAL public.fn_agent_commission_owed_rows(pr.club_id, pr.user_id, NULL, NULL) o ON TRUE
     GROUP BY pr.club_id, pr.user_id
  )
  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT f.club_id, f.user_id, f.owed, f.rows_behind, f.oldest, now() FROM fresh f
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed = EXCLUDED.owed,
         rows_behind = EXCLUDED.rows_behind,
         oldest_unsettled = EXCLUDED.oldest_unsettled,
         updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_rebuild_agent_commission_rollup()
RETURNS TABLE(pairs bigint, owed numeric, rows_behind bigint)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (session_user IN ('postgres', 'supabase_admin')
          OR coalesce(auth.role(), '') = 'service_role'
          OR coalesce(fn_is_platform_admin(), false)) THEN
    RAISE EXCEPTION 'rebuild is an operator action' USING ERRCODE = '42501';
  END IF;

  -- Nothing may write the ledger between the count and the commit.
  LOCK TABLE public.agent_commissions IN SHARE ROW EXCLUSIVE MODE;

  DELETE FROM public.agent_commission_unsettled_rollup WHERE true;
  INSERT INTO public.agent_commission_unsettled_rollup
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT ac.club_id, ac.user_id, sum(ac.amount), count(*), min(ac.created_at), now()
    FROM public.agent_commissions_unsettled ac
   WHERE ac.club_id IS NOT NULL AND ac.user_id IS NOT NULL
   GROUP BY ac.club_id, ac.user_id;

  RETURN QUERY
  SELECT count(*)::bigint, coalesce(sum(r.owed), 0), coalesce(sum(r.rows_behind), 0)::bigint
    FROM public.agent_commission_unsettled_rollup r;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_agent_unsettled_commission(p_club_id uuid, p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'fn_agent_unsettled_commission needs a club and a user'
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.fn_agent_may_read_commission(p_club_id, p_user_id) THEN
    -- Not a zero. A zero is indistinguishable from "owes nothing", and this
    -- caller is not entitled to know which of the two it is.
    RAISE EXCEPTION 'not authorized to read that member''s commission'
      USING ERRCODE = '42501';
  END IF;

  RETURN (SELECT COALESCE(SUM(o.amount), 0)::numeric
            FROM public.fn_agent_commission_owed_rows(p_club_id, p_user_id, NULL, NULL) o);
END
$function$;

/* 8. THE CLAIM takes its batch from the open intervals. */
DO $claim$
DECLARE v_def text; v_new text;
  v_old_batch constant text :=
       '  SELECT array_agg(id), COALESCE(SUM(amount), 0), COUNT(*)' || E'\n'
    || '    INTO v_ids, v_amount, v_rows' || E'\n'
    || '    FROM (' || E'\n'
    || '      SELECT id, amount' || E'\n'
    || '        FROM agent_commissions' || E'\n'
    || '       WHERE club_id = p_club_id' || E'\n'
    || '         AND user_id = v_actor' || E'\n'
    || '         AND settled_at IS NULL';
  v_new_batch constant text :=
       '  /* Phase 7 (20260908): the batch comes from the OPEN INTERVALS between the' || E'\n'
    || '     periods round 2 has paid (fn_agent_commission_owed_rows), so a claim can' || E'\n'
    || '     never re-pay a row a period already covers. The rows are then locked' || E'\n'
    || '     by id; the ORDER BY note below is history. */' || E'\n'
    || '  SELECT array_agg(o.id) INTO v_ids' || E'\n'
    || '    FROM (SELECT r.id FROM public.fn_agent_commission_owed_rows(p_club_id, v_actor, NULL, NULL) r LIMIT v_batch) o;' || E'\n'
    || '  SELECT array_agg(id), COALESCE(SUM(amount), 0), COUNT(*)' || E'\n'
    || '    INTO v_ids, v_amount, v_rows' || E'\n'
    || '    FROM (' || E'\n'
    || '      SELECT id, amount' || E'\n'
    || '        FROM agent_commissions' || E'\n'
    || '       WHERE id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))' || E'\n'
    || '         AND settled_at IS NULL';
  v_old_more1 constant text :=
       '      ''more'', EXISTS (SELECT 1 FROM agent_commissions' || E'\n'
    || '                        WHERE club_id = p_club_id AND user_id = v_actor' || E'\n'
    || '                          AND settled_at IS NULL),';
  v_new_more1 constant text :=
       '      ''more'', EXISTS (SELECT 1 FROM public.fn_agent_commission_owed_rows(p_club_id, v_actor, NULL, NULL)),';
  v_old_more2 constant text :=
       '  SELECT EXISTS (' || E'\n'
    || '    SELECT 1 FROM agent_commissions' || E'\n'
    || '     WHERE club_id = p_club_id AND user_id = v_actor AND settled_at IS NULL' || E'\n'
    || '  ) INTO v_more;';
  v_new_more2 constant text :=
       '  SELECT EXISTS (' || E'\n'
    || '    SELECT 1 FROM public.fn_agent_commission_owed_rows(p_club_id, v_actor, NULL, NULL)' || E'\n'
    || '  ) INTO v_more;';
BEGIN
  v_def := pg_get_functiondef('public.fn_agent_claim_commission(uuid,uuid,integer)'::regprocedure);
  IF position(v_old_batch IN v_def) = 0 THEN RAISE EXCEPTION 'claim: batch anchor not found'; END IF;
  IF position(v_old_more1 IN v_def) = 0 THEN RAISE EXCEPTION 'claim: replay-more anchor not found'; END IF;
  IF position(v_old_more2 IN v_def) = 0 THEN RAISE EXCEPTION 'claim: more anchor not found'; END IF;
  v_new := replace(replace(replace(v_def, v_old_batch, v_new_batch), v_old_more1, v_new_more1), v_old_more2, v_new_more2);
  IF v_new = v_def THEN RAISE EXCEPTION 'claim: nothing changed'; END IF;
  EXECUTE v_new;
END $claim$;

/* 9. EVERY OTHER READER: the same predicate, by text substitution. */
DO $readers$
DECLARE
  v_def text; v_new text; f text; v_n int;
  v_old constant text := 'ac.settled_at IS NULL';
  v_rep constant text := 'ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)';
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.fn_agent_downline_commission(uuid)',
    'public.fn_ca_gdpr_financial_precheck(uuid)',
    'public.fn_club_unclaimable_commission(uuid)',
    'public.fn_union_settlement_preview(uuid,timestamptz,timestamptz)',
    'public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)']
  LOOP
    v_def := pg_get_functiondef(f::regprocedure);
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n = 0 THEN RAISE EXCEPTION '%: predicate not found', f; END IF;
    v_new := replace(v_def, v_old, v_rep);
    EXECUTE v_new;
  END LOOP;

  -- fn_ca_hierarchy_payables aliases the table as a
  v_def := pg_get_functiondef('public.fn_ca_hierarchy_payables(uuid)'::regprocedure);
  IF position('     WHERE a.settled_at IS NULL' IN v_def) = 0 THEN RAISE EXCEPTION 'hierarchy: predicate not found'; END IF;
  EXECUTE replace(v_def, '     WHERE a.settled_at IS NULL',
                  '     WHERE a.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(a.club_id, a.user_id, a.created_at)');

  -- fn_get_agent_commission_summary: pending through the predicate, last_payout from either door
  v_def := pg_get_functiondef('public.fn_get_agent_commission_summary(uuid,uuid)'::regprocedure);
  IF position('''pending_payout'', COALESCE(SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL), 0),' IN v_def) = 0
     OR position('''last_payout'',    MAX(ac.settled_at))' IN v_def) = 0 THEN
    RAISE EXCEPTION 'summary: anchors not found';
  END IF;
  v_new := replace(v_def, '''pending_payout'', COALESCE(SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL), 0),',
                   '''pending_payout'', COALESCE(SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)), 0),');
  v_new := replace(v_new, '''last_payout'',    MAX(ac.settled_at))',
                   '''last_payout'',    GREATEST(MAX(ac.settled_at), (SELECT MAX(s.paid_at) FROM public.agent_commission_settlements s WHERE s.user_id = v_uid AND (p_club_id IS NULL OR s.club_id = p_club_id))))');
  EXECUTE v_new;

  -- fn_ca_rake_by_agent: outstanding and settled through the predicate
  v_def := pg_get_functiondef('public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text)'::regprocedure);
  IF position('SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL)     AS outstanding,' IN v_def) = 0
     OR position('SUM(ac.amount) FILTER (WHERE ac.settled_at IS NOT NULL) AS settled' IN v_def) = 0 THEN
    RAISE EXCEPTION 'rake_by_agent: anchors not found';
  END IF;
  v_new := replace(v_def, 'SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL)     AS outstanding,',
                   'SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)) AS outstanding,');
  v_new := replace(v_new, 'SUM(ac.amount) FILTER (WHERE ac.settled_at IS NOT NULL) AS settled',
                   'SUM(ac.amount) FILTER (WHERE ac.settled_at IS NOT NULL OR public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)) AS settled');
  EXECUTE v_new;

  -- the insert trigger counts a new row as owed only when no paid period covers it
  v_def := pg_get_functiondef('public.trg_agent_commission_rollup_insert()'::regprocedure);
  IF position('   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION 'rollup insert trigger: anchor not found';
  END IF;
  EXECUTE replace(v_def, '   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL',
                  '   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL' || E'\n'
                  || '     AND NOT public.fn_agent_commission_paid_by_period(n.club_id, n.user_id, n.created_at)');
END $readers$;

/* THE PROOFS - one subtransaction, rolled back by the sentinel. */
DO $proof$
DECLARE
  v_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_from  constant timestamptz := '2026-08-31 07:00:00+00';
  v_to    constant timestamptz := '2026-09-07 07:00:00+00';
  v_old_total numeric; v_new_total numeric; v_pairs_diff int; v_old_pairs int; v_new_pairs int;
  v_expect_payees int; v_expect_amt numeric; v_r jsonb; v_r2 jsonb; v_t0 timestamptz; v_ms int;
  v_stamped_before bigint; v_stamped_after bigint; v_settle_rows int; v_claim jsonb; v_agent uuid; v_club uuid;
  v_ids uuid[]; v_bad int; v_owed_before numeric; v_owed_after numeric;
BEGIN
  BEGIN
    -- 1. with no settlement rows, old and new predicates agree per pair and in total
    SELECT round(sum(amount), 2), count(DISTINCT (club_id, user_id)) INTO v_old_total, v_old_pairs
      FROM agent_commissions WHERE settled_at IS NULL;
    SELECT round(sum(amount), 2), count(DISTINCT (club_id, user_id)) INTO v_new_total, v_new_pairs
      FROM agent_commissions_unsettled;
    IF v_old_total <> v_new_total OR v_old_pairs <> v_new_pairs THEN
      RAISE EXCEPTION 'PROBE_FAILED: predicates disagree before any settlement: % / % vs % / %', v_old_total, v_old_pairs, v_new_total, v_new_pairs;
    END IF;
    SELECT count(*) INTO v_pairs_diff FROM (
      SELECT r.club_id, r.user_id, r.owed AS rollup_owed,
             (SELECT COALESCE(sum(o.amount), 0) FROM fn_agent_commission_owed_rows(r.club_id, r.user_id, NULL, NULL) o) AS via_intervals
        FROM agent_commission_unsettled_rollup r) x
     WHERE round(x.rollup_owed, 2) <> round(x.via_intervals, 2);
    IF v_pairs_diff <> 0 THEN
      RAISE EXCEPTION 'PROBE_FAILED: % rollup pairs disagree with the interval read', v_pairs_diff;
    END IF;

    -- 2. round 2 for the 08-31 week: what the old predicate would have paid
    SELECT count(*), round(COALESCE(sum(owed), 0), 2) INTO v_expect_payees, v_expect_amt FROM (
      SELECT ac.club_id, ac.user_id, SUM(ac.amount) AS owed
        FROM agent_commissions ac
        JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = v_union
        JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status = 'active'
       WHERE ac.created_at >= v_from AND ac.created_at < v_to AND ac.settled_at IS NULL
       GROUP BY ac.club_id, ac.user_id HAVING SUM(ac.amount) > 0) x;
    SELECT count(*) INTO v_stamped_before FROM agent_commissions WHERE settled_at IS NOT NULL;

    v_t0 := clock_timestamp();
    v_r := public.fn_settle_round2_club_to_agents(v_union, v_from, v_to);
    v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;

    IF (v_r->>'payees')::int + (v_r->>'shortfalls')::int <> v_expect_payees THEN
      RAISE EXCEPTION 'PROBE_FAILED: round 2 saw % pairs (paid % + short %), the old predicate saw %', (v_r->>'payees')::int + (v_r->>'shortfalls')::int, v_r->>'payees', v_r->>'shortfalls', v_expect_payees;
    END IF;
    SELECT count(*) INTO v_stamped_after FROM agent_commissions WHERE settled_at IS NOT NULL;
    IF v_stamped_after <> v_stamped_before THEN
      RAISE EXCEPTION 'PROBE_FAILED: round 2 stamped % rows', v_stamped_after - v_stamped_before;
    END IF;
    SELECT count(*) INTO v_settle_rows FROM agent_commission_settlements WHERE period_start = v_from AND period_end = v_to;
    IF v_settle_rows <> (v_r->>'payees')::int THEN
      RAISE EXCEPTION 'PROBE_FAILED: % settlement rows for % payees', v_settle_rows, v_r->>'payees';
    END IF;
    -- the paid figure equals the sum of the settlement rows
    IF (SELECT round(COALESCE(sum(amount), 0), 2) FROM agent_commission_settlements WHERE period_start = v_from AND period_end = v_to)
       <> round((v_r->>'amount')::numeric, 2) THEN
      RAISE EXCEPTION 'PROBE_FAILED: settlement rows do not sum to the amount paid';
    END IF;

    -- a second call pays nothing
    v_r2 := public.fn_settle_round2_club_to_agents(v_union, v_from, v_to);
    IF (v_r2->>'payees')::int <> 0 OR (v_r2->>'amount')::numeric <> 0 THEN
      RAISE EXCEPTION 'PROBE_FAILED: a second round 2 paid again: %', v_r2;
    END IF;

    -- 3. a claim after round 2 settles only rows outside the paid period
    SELECT s.club_id, s.user_id INTO v_club, v_agent
      FROM agent_commission_settlements s
      JOIN clubs c ON c.id = s.club_id AND COALESCE(c.chip_treasury, 0) > 5000
      JOIN club_members cm ON cm.club_id = s.club_id AND cm.user_id = s.user_id AND COALESCE(cm.status, 'active') IN ('active', 'approved')
     WHERE s.period_start = v_from
       AND EXISTS (SELECT 1 FROM agent_commissions a WHERE a.club_id = s.club_id AND a.user_id = s.user_id AND a.settled_at IS NULL
                     AND (a.created_at < v_from OR a.created_at >= v_to))
     ORDER BY s.amount DESC LIMIT 1;
    IF v_agent IS NOT NULL THEN
      SELECT round(sum(amount), 2) INTO v_owed_before FROM agent_commissions_unsettled WHERE club_id = v_club AND user_id = v_agent;
      PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
      v_claim := public.fn_agent_claim_commission(v_club, gen_random_uuid(), 50);
      PERFORM set_config('request.jwt.claims', '', true);
      IF COALESCE((v_claim->>'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PROBE_FAILED: claim refused: %', v_claim;
      END IF;
      SELECT count(*) INTO v_bad FROM agent_commissions a
       WHERE a.club_id = v_club AND a.user_id = v_agent AND a.settled_at = now()
         AND a.created_at >= v_from AND a.created_at < v_to;
      IF v_bad <> 0 THEN
        RAISE EXCEPTION 'PROBE_FAILED: the claim re-paid % rows round 2 had covered', v_bad;
      END IF;
      SELECT round(sum(amount), 2) INTO v_owed_after FROM agent_commissions_unsettled WHERE club_id = v_club AND user_id = v_agent;
      IF round(v_owed_before - COALESCE(v_owed_after, 0), 2) <> round((v_claim->>'amount')::numeric, 2) THEN
        RAISE EXCEPTION 'PROBE_FAILED: owed moved by % but the claim paid %', v_owed_before - COALESCE(v_owed_after, 0), v_claim->>'amount';
      END IF;
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK round2 % ms: payees % amount % short % (old predicate: % pairs / %); stamped %->%; claim %',
      v_ms, v_r->>'payees', v_r->>'amount', v_r->>'shortfalls', v_expect_payees, v_expect_amt, v_stamped_before, v_stamped_after, COALESCE(left(v_claim::text, 120), 'skipped');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'FIXTURE_ROLLBACK%' THEN RAISE; END IF;
    RAISE NOTICE '%', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM agent_commission_settlements) THEN
    RAISE EXCEPTION 'the rehearsal committed settlement rows';
  END IF;
END $proof$;

DO $assert$
DECLARE
  v_src text; i int;
  /* each reader, and the door it must now read through */
  doors text[][] := ARRAY[
    ['fn_settle_round2_club_to_agents',      'fn_agent_commission_owed_rows'],
    ['fn_agent_claim_commission',            'fn_agent_commission_owed_rows'],
    ['fn_agent_unsettled_commission',        'fn_agent_commission_owed_rows'],
    ['fn_agent_commission_rollup_recompute', 'fn_agent_commission_owed_rows'],
    ['fn_rebuild_agent_commission_rollup',   'agent_commissions_unsettled'],
    ['trg_agent_commission_rollup_insert',   'fn_agent_commission_paid_by_period'],
    ['fn_union_settlement_preview',          'fn_agent_commission_paid_by_period'],
    ['fn_get_agent_commission_summary',      'fn_agent_commission_paid_by_period'],
    ['fn_agent_downline_commission',         'fn_agent_commission_paid_by_period'],
    ['fn_club_unclaimable_commission',       'fn_agent_commission_paid_by_period'],
    ['fn_ca_hierarchy_payables',             'fn_agent_commission_paid_by_period'],
    ['fn_ca_rake_by_agent',                  'fn_agent_commission_paid_by_period'],
    ['fn_ca_gdpr_financial_precheck',        'fn_agent_commission_paid_by_period'],
    ['fn_club_set_member_role',              'fn_agent_commission_paid_by_period']];
BEGIN
  FOR i IN 1 .. array_length(doors, 1) LOOP
    SELECT prosrc INTO v_src FROM pg_proc
     WHERE proname = doors[i][1] AND pronamespace = 'public'::regnamespace;
    IF v_src IS NULL THEN RAISE EXCEPTION '% is gone', doors[i][1]; END IF;
    IF v_src NOT LIKE '%' || doors[i][2] || '%' THEN
      RAISE EXCEPTION '% does not read through %; it still asks settled_at on its own', doors[i][1], doors[i][2];
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_settle_round2_club_to_agents' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%SET settled_at = now()%' THEN RAISE EXCEPTION 'round 2 still stamps rows'; END IF;
  IF v_src NOT LIKE '%agent_commission_settlements%' THEN RAISE EXCEPTION 'round 2 does not record the period it paid'; END IF;
  IF v_src NOT LIKE '%period_too_fresh%' THEN RAISE EXCEPTION 'round 2 has no in-flight margin'; END IF;

  IF has_table_privilege('anon', 'public.agent_commission_settlements', 'SELECT')
     OR has_table_privilege('anon', 'public.v_agent_commissions', 'SELECT')
     OR has_table_privilege('anon', 'public.agent_commissions_unsettled', 'SELECT') THEN
    RAISE EXCEPTION 'anon reaches the settlement ledger';
  END IF;
END $assert$;

COMMIT;