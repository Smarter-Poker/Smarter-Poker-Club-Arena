-- A PERIOD THAT KEEPS REFUSING STOPS HOLDING THE QUEUE
-- =============================================================================
-- PHASE 5 of 8, part 10 - a starvation bug in my own batch, found while
-- auditing what the bounded contract does to its callers.
--
-- fn_settle_club_rakeback_batch takes the OLDEST 40 pending periods each pass.
-- A deferred period is still `pending` - that is deliberate, it is money still
-- owed - so the same 40 are re-selected on every pass, for ever. If the oldest
-- 40 of a club are all permanently deferred, the batch does forty indexed
-- refusals, settles nothing, and the payable periods behind them are never
-- reached. The drain would report success and make no progress, indefinitely.
--
-- MEASURED on Midway, which is where this would bite: of the first 40 in queue
-- order, 24 are periods whose player has no membership at the earning club and
-- 16 are payable. So the head is not fully blocked today and the drain does
-- make progress - but 60% of every batch is spent on periods that cannot pay,
-- and it is one unlucky ordering away from zero. 792 of its 1,767 periods carry
-- that reason permanently.
--
-- THE FIX: order by how many times a period has already refused, then by age.
-- A period that has never been tried goes first; one that has refused ten times
-- sinks below one that has refused once. Nothing is skipped or given up on -
-- defer_count only decides ORDER - so a period that becomes payable (the club
-- is funded, the player joins the club) is picked up on the next pass it
-- reaches the head. It is self-balancing and needs no list of "permanent"
-- reasons, which would be a thing to maintain and get wrong.
--
-- The same ordering goes on the index, so the sort stays an index scan rather
-- than becoming a sort of every pending row.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS rakeback_periods_drain_order_idx
  ON public.rakeback_periods (club_id, defer_count, period_end, id)
  WHERE status = 'pending';

DO $migrate$
DECLARE v_def text; v_new text; v_a text; v_r text; v_n int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc
   WHERE proname='fn_settle_club_rakeback_batch' AND pronamespace='public'::regnamespace;

  v_a := E'     ORDER BY period_end, id\n'
      || E'     LIMIT p_max_periods';
  v_r := E'     -- Least-refused first. A deferred period stays pending because the\n'
      || E'     -- money is still owed, so ordering by age alone lets a permanently\n'
      || E'     -- refusing head of queue starve everything behind it.\n'
      || E'     ORDER BY defer_count, period_end, id\n'
      || E'     LIMIT p_max_periods';

  IF position(v_a in v_def) = 0 THEN
    RAISE EXCEPTION 'the period ordering is not where this migration expects it';
  END IF;
  v_new := replace(v_def, v_a, v_r);
  IF v_new = v_def THEN RAISE EXCEPTION 'the ordering change did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

DO $assert$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_settle_club_rakeback_batch' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%ORDER BY defer_count, period_end, id%' THEN
    RAISE EXCEPTION 'the batch still drains oldest-first and can starve on a refusing head';
  END IF;
  -- Nothing else may have been lost in the substitution.
  IF v_src NOT LIKE '%40P01%'
     OR v_src NOT LIKE '%cannot fund its smallest pending payout%'
     OR v_src NOT LIKE '%fn_is_platform_admin%'
     OR v_src NOT LIKE '%fn_rakeback_recompute_day%'
     OR v_src NOT LIKE '%lock_retries%' THEN
    RAISE EXCEPTION 'the substitution lost part of the batch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='rakeback_periods_drain_order_idx') THEN
    RAISE EXCEPTION 'the drain order has no index behind it';
  END IF;
END
$assert$;

-- Behaviour, rolled back: the batch must now reach payable periods that sit
-- behind refusing ones.
DO $fixture$
DECLARE
  v_msg text; v_club uuid; v_res jsonb; v_first_defer int; v_first_never int;
BEGIN
  BEGIN
    SELECT id INTO v_club FROM clubs WHERE name='Midway Union';

    -- Push every no-membership period to a high defer_count, as repeated real
    -- passes would, and confirm the never-tried ones then lead the queue.
    UPDATE rakeback_periods rp
       SET defer_count = 9
     WHERE rp.club_id = v_club AND rp.status='pending' AND rp.period_end < CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM club_members m
                        WHERE m.user_id=rp.user_id AND m.club_id=rp.club_id
                          AND m.status IN ('active','approved'));

    SELECT count(*) FILTER (WHERE defer_count >= 9), count(*) FILTER (WHERE defer_count = 0)
      INTO v_first_defer, v_first_never
      FROM (SELECT defer_count FROM rakeback_periods
             WHERE club_id=v_club AND status='pending' AND period_end < CURRENT_DATE
             ORDER BY defer_count, period_end, id LIMIT 40) q;

    IF v_first_defer > 0 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL a nine-times-refused period is still in the first 40 (% of them)', v_first_defer;
    END IF;
    IF v_first_never <> 40 THEN
      RAISE EXCEPTION 'FIXTURE_FAIL only % of the first 40 are untried', v_first_never;
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK head of queue is now 40 untried periods, 0 repeatedly-refused';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'FIXTURE_ROLLBACK%' THEN
      RAISE EXCEPTION 'drain-order fixture failed: %', v_msg;
    END IF;
  END;
END
$fixture$;

COMMIT;
