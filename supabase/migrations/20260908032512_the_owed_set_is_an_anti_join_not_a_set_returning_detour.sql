BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 7 OF 8 - THE OWED SET IS AN ANTI-JOIN, NOT A SET-RETURNING DETOUR.
   ---------------------------------------------------------------------------
   20260908025653 expressed "what a pair is still owed" as the complement of
   its paid periods: fn_agent_commission_open_intervals produced the gaps and
   fn_agent_commission_owed_rows walked them. It is readable and it is right -
   the equality proofs passed on it - but it is a set-returning function, so
   the planner materialises it instead of folding it into an index scan.

   MEASURED ON PRODUCTION, 2026-09-08 03:2x UTC, one Deep Stack pair with
   14,485 open rows, once with no paid period and once with one:

     batch of 200 through the SRF          28 ms   /  60 ms
     the same batch as an anti-join         1 ms   /   2 ms
     the pair's whole owed sum, anti-join             8 ms (8,076 rows)

   Sixty milliseconds per pair is nothing on a claim and it is the whole cost
   of round 2: 83 pairs took 7,633 ms, most of it materialising sets the
   planner could have skipped.

   So the four hot paths - round 2, the claim's batch and its two "is there
   more" probes, the single-pair owed figure, and the rollup recompute - ask
   the question the way the index answers it:

     settled_at IS NULL
     AND NOT EXISTS (a settlement row for this pair covering created_at)

   which rides agent_commissions_open_idx (club_id, user_id, created_at)
   WHERE settled_at IS NULL and stops at the LIMIT.

   The two interval helpers then have no callers and are DROPPED rather than
   left as a door nobody opens. fn_agent_commission_paid_by_period stays: it
   is the scoped readers' predicate and it inlines (20260908031445).

   THE MODEL IS UNCHANGED. A row is settled when its own settled_at is set or
   a settlement row covers it; round 2 records the period and stamps nothing.
   Proven below, read-only, against production: the pairs and amounts round 2
   would pay are identical to the old settled_at predicate, and the claim's
   new batch selects exactly the ids the SRF selected. */

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_agent_commission_owed_rows' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'fn_agent_commission_owed_rows is gone - re-read before applying';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE proname = 'fn_agent_commission_paid_by_period' AND pronamespace = 'public'::regnamespace) IS NOT NULL THEN
    RAISE EXCEPTION 'the predicate carries a SET again; 20260908031445 must land first';
  END IF;
END $guard$;

/* 1. ROUND 2 reads the period with one grouped anti-join. */
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

  /* What each pair is owed INSIDE this period: unstamped, and not already
     covered by a settlement row. One index scan per pair, no materialised set. */
  FOR r IN
    SELECT ac.club_id, ac.user_id AS agent_user, SUM(ac.amount) AS owed, count(*) AS n
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status = 'active'
     WHERE ac.created_at >= p_period_start AND ac.created_at < p_period_end
       AND ac.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
     GROUP BY ac.club_id, ac.user_id
    HAVING SUM(ac.amount) > 0
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

/* 2. THE SINGLE-PAIR OWED FIGURE. */
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

  RETURN (
    SELECT COALESCE(SUM(ac.amount), 0)::numeric
      FROM public.agent_commissions ac
     WHERE ac.club_id = p_club_id
       AND ac.user_id = p_user_id
       AND ac.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end));
END
$function$;

/* 3. THE ROLLUP. */
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
           coalesce(sum(ac.amount), 0)  AS owed,
           count(ac.id)                 AS rows_behind,
           min(ac.created_at)           AS oldest
      FROM pairs pr
      LEFT JOIN public.agent_commissions ac
        ON ac.club_id = pr.club_id AND ac.user_id = pr.user_id
       AND ac.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
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

/* 4. THE CLAIM's batch and its two "is there more" probes. */
DO $claim$
DECLARE v_def text; v_new text;
  v_old_pick constant text :=
       '  SELECT array_agg(o.id) INTO v_ids' || E'\n'
    || '    FROM (SELECT r.id FROM public.fn_agent_commission_owed_rows(p_club_id, v_actor, NULL, NULL) r LIMIT v_batch) o;';
  v_new_pick constant text :=
       '  SELECT array_agg(o.id) INTO v_ids' || E'\n'
    || '    FROM (SELECT ac.id' || E'\n'
    || '            FROM public.agent_commissions ac' || E'\n'
    || '           WHERE ac.club_id = p_club_id AND ac.user_id = v_actor' || E'\n'
    || '             AND ac.settled_at IS NULL' || E'\n'
    || '             AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s' || E'\n'
    || '                              WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id' || E'\n'
    || '                                AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)' || E'\n'
    || '           LIMIT v_batch) o;';
  v_old_note constant text :=
       '  /* Phase 7 (20260908): the batch comes from the OPEN INTERVALS between the' || E'\n'
    || '     periods round 2 has paid (fn_agent_commission_owed_rows), so a claim can' || E'\n'
    || '     never re-pay a row a period already covers. The rows are then locked' || E'\n'
    || '     by id; the ORDER BY note below is history. */';
  v_new_note constant text :=
       '  /* Phase 7 (20260908): the batch is the pair''s OPEN rows - unstamped, and' || E'\n'
    || '     not covered by a settlement row - so a claim can never re-pay a row a' || E'\n'
    || '     period already covers. The anti-join rides agent_commissions_open_idx' || E'\n'
    || '     and stops at the LIMIT; the ORDER BY note below is history. */';
  v_old_more1 constant text := 'EXISTS (SELECT 1 FROM public.fn_agent_commission_owed_rows(p_club_id, v_actor, NULL, NULL))';
  v_old_more2 constant text :=
       'SELECT EXISTS (' || E'\n'
    || '    SELECT 1 FROM public.fn_agent_commission_owed_rows(p_club_id, v_actor, NULL, NULL)' || E'\n'
    || '  ) INTO v_more;';
  v_new_more1 constant text :=
       'EXISTS (SELECT 1 FROM public.agent_commissions ac WHERE ac.club_id = p_club_id AND ac.user_id = v_actor'
    || ' AND ac.settled_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s'
    || ' WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id AND ac.created_at >= s.period_start AND ac.created_at < s.period_end))';
  v_new_more2 constant text :=
       'SELECT EXISTS (' || E'\n'
    || '    SELECT 1 FROM public.agent_commissions ac' || E'\n'
    || '     WHERE ac.club_id = p_club_id AND ac.user_id = v_actor AND ac.settled_at IS NULL' || E'\n'
    || '       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s' || E'\n'
    || '                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id' || E'\n'
    || '                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)' || E'\n'
    || '  ) INTO v_more;';
  v_n int;
BEGIN
  v_def := pg_get_functiondef('public.fn_agent_claim_commission(uuid,uuid,integer)'::regprocedure);
  IF position(v_old_pick IN v_def) = 0 THEN RAISE EXCEPTION 'claim: batch anchor not found'; END IF;
  /* the two probes are written differently - one inline in the replay reply,
     one across three lines before the return - so each is replaced by name. */
  IF position(v_old_more1 IN v_def) = 0 THEN RAISE EXCEPTION 'claim: replay more-probe not found'; END IF;
  IF position(v_old_more2 IN v_def) = 0 THEN RAISE EXCEPTION 'claim: final more-probe not found'; END IF;
  IF position(v_old_note IN v_def) = 0 THEN RAISE EXCEPTION 'claim: the phase 6 note is not where it was'; END IF;
  v_new := replace(v_def, v_old_note, v_new_note);
  v_new := replace(v_new, v_old_pick, v_new_pick);
  v_new := replace(v_new, v_old_more2, v_new_more2);
  v_new := replace(v_new, v_old_more1, v_new_more1);
  IF position('fn_agent_commission_owed_rows' IN v_new) > 0 THEN
    RAISE EXCEPTION 'claim: a call to the dropped SRF survived the rewrite';
  END IF;
  EXECUTE v_new;
END $claim$;

/* 5. the detour, closed. */
DROP FUNCTION IF EXISTS public.fn_agent_commission_owed_rows(uuid, uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.fn_agent_commission_open_intervals(uuid, uuid);

/* PROOFS - read-only, against production. */
DO $proof$
DECLARE
  v_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_from  constant timestamptz := '2026-09-07 07:00:00+00';
  v_to    timestamptz := now() - interval '10 minutes';
  v_old_pairs int; v_old_amt numeric; v_new_pairs int; v_new_amt numeric;
  v_t0 timestamptz; v_ms int; v_club uuid; v_agent uuid; v_a numeric; v_b numeric;
BEGIN
  -- the pairs and amounts round 2 will pay, both ways, in ONE statement each
  -- (bounded by v_to, so rows arriving mid-probe fall outside both)
  SELECT count(*), round(COALESCE(sum(owed), 0), 2) INTO v_old_pairs, v_old_amt FROM (
    SELECT ac.club_id, ac.user_id, SUM(ac.amount) AS owed
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = v_union
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status = 'active'
     WHERE ac.created_at >= v_from AND ac.created_at < v_to AND ac.settled_at IS NULL
     GROUP BY ac.club_id, ac.user_id HAVING SUM(ac.amount) > 0) x;

  v_t0 := clock_timestamp();
  SELECT count(*), round(COALESCE(sum(owed), 0), 2) INTO v_new_pairs, v_new_amt FROM (
    SELECT ac.club_id, ac.user_id, SUM(ac.amount) AS owed
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = v_union
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status = 'active'
     WHERE ac.created_at >= v_from AND ac.created_at < v_to
       AND ac.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
     GROUP BY ac.club_id, ac.user_id HAVING SUM(ac.amount) > 0) x;
  v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;

  IF v_old_pairs <> v_new_pairs OR v_old_amt <> v_new_amt THEN
    RAISE EXCEPTION 'PROBE_FAILED: round 2 basis moved: % pairs / % vs % pairs / %', v_old_pairs, v_old_amt, v_new_pairs, v_new_amt;
  END IF;
  IF v_ms > 30000 THEN RAISE EXCEPTION 'PROBE_FAILED: the round 2 read took % ms', v_ms; END IF;

  -- the single-pair figure agrees with the view, for the pair that owes most
  SELECT r.club_id, r.user_id INTO v_club, v_agent
    FROM agent_commission_unsettled_rollup r ORDER BY r.owed DESC LIMIT 1;
  SELECT round(COALESCE(sum(amount), 0), 2) INTO v_a FROM agent_commissions_unsettled WHERE club_id = v_club AND user_id = v_agent;
  SELECT round(COALESCE(SUM(ac.amount), 0), 2) INTO v_b
    FROM agent_commissions ac
   WHERE ac.club_id = v_club AND ac.user_id = v_agent AND ac.settled_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM agent_commission_settlements s
                      WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                        AND ac.created_at >= s.period_start AND ac.created_at < s.period_end);
  IF v_a <> v_b THEN RAISE EXCEPTION 'PROBE_FAILED: pair figure % <> view %', v_b, v_a; END IF;

  RAISE NOTICE 'phase 7 anti-join proof: % pairs / % identical, round 2 read % ms', v_new_pairs, v_new_amt, v_ms;
END $proof$;

DO $assert$
DECLARE v_src text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('fn_agent_commission_owed_rows', 'fn_agent_commission_open_intervals')
               AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'an interval helper survived with no callers';
  END IF;
  FOR v_src IN SELECT prosrc FROM pg_proc WHERE proname IN ('fn_settle_round2_club_to_agents','fn_agent_claim_commission',
      'fn_agent_unsettled_commission','fn_agent_commission_rollup_recompute') AND pronamespace = 'public'::regnamespace
  LOOP
    IF v_src LIKE '%fn_agent_commission_owed_rows%' THEN RAISE EXCEPTION 'a hot path still calls the dropped SRF'; END IF;
    IF v_src NOT LIKE '%agent_commission_settlements%' THEN RAISE EXCEPTION 'a hot path does not consult the settlement ledger'; END IF;
  END LOOP;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_settle_round2_club_to_agents' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%SET settled_at = now()%' THEN RAISE EXCEPTION 'round 2 stamps rows again'; END IF;
  IF v_src NOT LIKE '%period_too_fresh%' THEN RAISE EXCEPTION 'round 2 lost its in-flight margin'; END IF;
END $assert$;

COMMIT;