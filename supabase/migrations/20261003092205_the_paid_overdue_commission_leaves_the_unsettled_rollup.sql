-- 20261003092205_the_paid_overdue_commission_leaves_the_unsettled_rollup.sql
--
-- THE PAID OVERDUE COMMISSION LEAVES THE UNSETTLED ROLLUP (step 2 of 2 of
-- operation c419b506-79a3-465a-99ba-adca6e0e5c2e)
--
-- 20261003092151 paid every recorded agent commission row created before
-- 2026-09-28 07:00Z and settled them by period: one agent_commission_settlements
-- row per (club, agent, week), ref owner_legacy_commission:c419b506-..., each
-- carrying the exact amount and row count it covered. The derived read model
-- agent_commission_unsettled_rollup still counts those rows until it is told.
--
-- A full recompute (fn_agent_commission_rollup_recompute) re-reads every row of
-- the pair, ~7.5M in all, and would hold the rollup rows - and with them every
-- commission insert of these clubs, i.e. every hand commit - for minutes. So
-- the rollup is brought down by exactly what was settled, the way its insert
-- trigger brings it up: owed - amount, rows_behind - rows, and the oldest
-- unsettled row re-read from the open week by index (no row before
-- 2026-09-28 07:00Z is unsettled any more; 20261003092151 asserted that the
-- payment covered every one it found).
--
-- Locks: the per-club commission keys first, in club order, exactly as
-- trg_agent_commission_rollup_insert takes them (20261001), so no live writer
-- is half-way through a pair; then the rollup rows. Held for one UPDATE.
-- Moves no chips. Runs once: a replay finds this migration in the history and
-- refuses (a second decrement would understate what is owed).
--
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.agent_commission_unsettled_rollup r WHERE r.oldest_unsettled < timestamptz '2026-09-28 07:00:00+00'))

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $op$
DECLARE
  c_ref CONSTANT text := 'owner_legacy_commission:c419b506-79a3-465a-99ba-adca6e0e5c2e';
  c_cut CONSTANT timestamptz := '2026-09-28 07:00:00+00';
  v_club uuid; v_n int; v_before numeric; v_after numeric; v_paid numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261003092205') THEN
    RAISE EXCEPTION 'rollup: 20261003092205 already applied; a second decrement would understate what is owed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements WHERE settlement_ref = c_ref) THEN
    RAISE EXCEPTION 'rollup: operation c419b506 has not paid (apply 20261003092151 first)';
  END IF;

  CREATE TEMP TABLE _oc_done ON COMMIT DROP AS
    SELECT club_id, user_id, sum(amount) AS amount, sum(rows_count)::bigint AS n
      FROM public.agent_commission_settlements WHERE settlement_ref = c_ref GROUP BY 1, 2;
  SELECT sum(amount) INTO v_paid FROM _oc_done;
  IF v_paid <> 1162765.28 THEN
    RAISE EXCEPTION 'rollup: the settled amount is %, not the paid 1,162,765.28', v_paid;
  END IF;

  -- The live writers' order: one commission key per club, in club order.
  FOR v_club IN SELECT DISTINCT club_id FROM _oc_done ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:' || v_club::text, 0));
  END LOOP;
  PERFORM 1 FROM public.agent_commission_unsettled_rollup r JOIN _oc_done d USING (club_id, user_id)
    ORDER BY r.club_id, r.user_id FOR UPDATE OF r;

  SELECT sum(r.owed) INTO v_before FROM public.agent_commission_unsettled_rollup r JOIN _oc_done d USING (club_id, user_id);
  IF EXISTS (SELECT 1 FROM public.agent_commission_unsettled_rollup r JOIN _oc_done d USING (club_id, user_id)
              WHERE r.owed < d.amount OR r.rows_behind < d.n)
     OR (SELECT count(*) FROM public.agent_commission_unsettled_rollup r JOIN _oc_done d USING (club_id, user_id))
        <> (SELECT count(*) FROM _oc_done) THEN
    RAISE EXCEPTION 'rollup: a pair holds less than was settled; refusing to drive it negative';
  END IF;

  UPDATE public.agent_commission_unsettled_rollup r
     SET owed = r.owed - d.amount,
         rows_behind = r.rows_behind - d.n,
         oldest_unsettled = (SELECT ac.created_at FROM public.agent_commissions ac
                              WHERE ac.club_id = r.club_id AND ac.user_id = r.user_id
                                AND ac.settled_at IS NULL AND ac.created_at >= c_cut
                                AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at)
                              ORDER BY ac.created_at LIMIT 1),
         updated_at = now()
    FROM _oc_done d
   WHERE r.club_id = d.club_id AND r.user_id = d.user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  SELECT sum(r.owed) INTO v_after FROM public.agent_commission_unsettled_rollup r JOIN _oc_done d USING (club_id, user_id);
  IF v_n <> (SELECT count(*) FROM _oc_done) OR v_before - v_after <> v_paid
     OR EXISTS (SELECT 1 FROM public.agent_commission_unsettled_rollup r JOIN _oc_done d USING (club_id, user_id)
                 WHERE r.owed < 0 OR r.rows_behind < 0 OR (r.rows_behind = 0) <> (r.oldest_unsettled IS NULL)
                    OR r.oldest_unsettled < c_cut) THEN
    RAISE EXCEPTION 'rollup: the decrement did not land whole (pairs %, before %, after %)', v_n, v_before, v_after;
  END IF;
  RAISE NOTICE 'rollup: % pairs brought down by %; owed % -> %', v_n, v_paid, v_before, v_after;
END
$op$;

COMMIT;
