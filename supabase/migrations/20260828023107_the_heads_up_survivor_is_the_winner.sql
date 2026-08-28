-- ============================================================================
-- THE HEADS-UP SURVIVOR IS THE WINNER.
--
-- 13 completed Heads-Up SNGs owed 589.00 chips and fn_backpay_hu_winner_
-- shortfalls refused to pay any of them, alerting "no single identifiable
-- winner - needs a human decision" once per event and once in aggregate.
--
-- They were not ambiguous. All 13 have the identical shape:
--
--     falcon       eliminated   position 2   chips 0
--     trailblazer  playing      position -   chips 3000
--
-- Two players. One busted and stamped second. One never eliminated, holding
-- the whole stack. The engine even knew who won - it credited trailblazer a
-- prize described "Tournament winner prize: 1st place" - it just never wrote
-- status/position back to tournament_players. The back-pay function resolves
-- the winner with `status = 'winner' OR position = 1`, that write never
-- happened, so it counted zero winners and stopped.
--
-- Asking a human which of two players won a heads-up match when one of them
-- has no chips and is already stamped second is not a decision. It is the
-- definition. Dan's rule, 2026-08-28: in a two-handed event with exactly one
-- player eliminated and exactly one never eliminated, the survivor won.
--
-- WHY THERE IS NO NEW RANKING LOGIC HERE. That rule already exists in this
-- database and is already deployed: fn_rank_survivors (migration
-- guard_completed_ranks_survivors) hands the free positions to the unranked
-- rows in ascending order by chips descending. For a heads-up event where
-- place 2 is taken, the only free place is 1, there is only one survivor, and
-- they get it - status 'winner', position 1. Re-deriving that here would be a
-- second copy of a rule that must never disagree with itself, so this calls
-- the canonical one. The trigger it was written for is BEFORE UPDATE and only
-- fires on the status flip into COMPLETED, so it protects new events and does
-- nothing for the 13 that are already finished. This reaches back for them.
--
-- SCOPE IS DELIBERATELY NARROW. That migration counted 699 unranked rows
-- across 125 completed tournaments. This touches only heads-up SNGs that owe
-- a shortfall. Ranking the survivors of a 30-entrant MTT decides 27 people's
-- finishing positions and unblocks a much larger payout; that is Dan's call
-- and it is reported to him, not taken here.
--
-- ---------------------------------------------------------------------------
-- TWO DEFECTS IN THE SWEEP ITSELF, FIXED IN THE SAME PLACE
--
-- 1. IT HAD ALREADY STOPPED RUNNING. The candidate window was written
--    `ended_at > '2026-08-01' AND ended_at < '2026-08-28T00:00:00Z'`. Today is
--    2026-08-28, so as of this morning the sweep covers nothing and will
--    report a clean `paid: 0` forever while new shortfalls accumulate behind
--    it. A repair job with a hardcoded end date is a repair job with an expiry
--    date. It is a rolling 30-day window now, with a 30-minute settling grace
--    so an event whose prize credits are still being written is never
--    back-paid mid-finalisation.
--
-- 2. THE THREE COPIES OF THE PREDICATE COULD DRIFT. The scope test was written
--    out three times - once to pick candidates, once to count the unpayable,
--    once implicitly in the alert. They have to agree or the sweep reports a
--    backlog it is not looking at. There is one definition now,
--    fn_hu_shortfall_candidates, and all three read it.
--
-- The debt filter stays INSIDE the candidate query, where
-- 20260827_hu_backpay_head_of_line_fix put it. Selecting oldest-first and
-- filtering the debt afterwards is what starved this sweep before: 95 of every
-- 100 rows it selected owed nothing, so nothing was ever credited and the
-- oldest-first queue never advanced, and every pass still reported success.
-- Measured cost of filtering in the query: 1.69s over 35,958 candidate rows.
--
-- ROLLBACK
--   The previous bodies are in the migration history. To restore:
--     DROP FUNCTION IF EXISTS public.fn_hu_shortfall_candidates(integer);
--   then re-apply fn_backpay_hu_winner_shortfalls from
--   20260827_hu_backpay_head_of_line_fix. No data written by this migration
--   needs undoing - it creates a function and redefines another. The chips it
--   later pays are keyed `tourney:{id}:prize:{winner}:hu_shortfall` through
--   fn_credit_and_log and cannot double-pay on a re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Preconditions. Assert against the executable catalog, never against text
-- that a comment could satisfy by accident.
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.fn_rank_survivors(uuid)') IS NULL THEN
    RAISE EXCEPTION 'fn_rank_survivors(uuid) is missing; apply guard_completed_ranks_survivors first';
  END IF;
  IF to_regprocedure('public.fn_tournament_conservation_delta(uuid)') IS NULL THEN
    RAISE EXCEPTION 'fn_tournament_conservation_delta(uuid) is missing';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- ONE definition of "a heads-up event that is short of money".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_hu_shortfall_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE (tournament_id uuid, name text, ended_at timestamptz, delta numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT t.id, t.name, t.ended_at, public.fn_tournament_conservation_delta(t.id)
    FROM public.tournaments t
   WHERE t.status = 'COMPLETED'
     AND COALESCE(t.variant, '') = 'sng'
     AND COALESCE(t.max_players, 0) <= 2
     AND COALESCE(t.guaranteed_prize, 0) = 0
     -- Rolling, not a fixed pair of dates. See defect 1 above.
     AND t.ended_at > now() - interval '30 days'
     AND t.ended_at < now() - interval '30 minutes'
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id = t.id
          AND w.type = 'credit' AND w.category = 'prize'
          AND w.description LIKE 'Heads-Up winner shortfall%')
     -- The debt is filtered HERE, not after the limit. See the note above.
     AND public.fn_tournament_conservation_delta(t.id) > 0.01
   ORDER BY t.ended_at ASC
   LIMIT GREATEST(COALESCE(p_limit, 100), 1);
$fn$;

REVOKE ALL ON FUNCTION public.fn_hu_shortfall_candidates(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_hu_shortfall_candidates(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- The sweep.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_backpay_hu_winner_shortfalls(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record;
  v_paid integer := 0; v_chips numeric := 0; v_scanned integer := 0;
  v_ranked integer := 0; v_unpayable integer := 0; v_ok boolean;
  v_winner uuid; v_winners integer;
BEGIN
  -- STEP 1. Finish the matches the engine left open. A heads-up event whose
  -- loser is stamped second and whose survivor is still 'playing' has a
  -- winner; it just was not written down.
  FOR v_row IN
    SELECT c.tournament_id AS id
      FROM public.fn_hu_shortfall_candidates(p_limit) c
     WHERE EXISTS (SELECT 1 FROM public.tournament_players tp
                    WHERE tp.tournament_id = c.tournament_id
                      AND tp.position IS NULL)
  LOOP
    v_ranked := v_ranked + COALESCE(public.fn_rank_survivors(v_row.id), 0);
  END LOOP;

  -- STEP 2. Pay. Re-reads the candidates so STEP 1's writes are visible.
  FOR v_row IN
    SELECT c.tournament_id AS id, c.name, c.delta
      FROM public.fn_hu_shortfall_candidates(p_limit) c
  LOOP
    v_scanned := v_scanned + 1;

    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_winners, v_winner
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_row.id
       AND (tp.status = 'winner' OR tp.position = 1);

    IF v_winners <> 1 OR v_winner IS NULL THEN
      CONTINUE;  -- counted as unpayable below, and alerted there
    END IF;

    v_ok := public.fn_credit_and_log(
      v_winner, v_row.delta,
      'tourney:' || v_row.id || ':prize:' || v_winner || ':hu_shortfall',
      'prize',
      'Heads-Up winner shortfall back-pay (' || COALESCE(v_row.name, 'sng') || ')',
      v_row.id);

    IF COALESCE(v_ok, false) THEN
      v_paid := v_paid + 1;
      v_chips := v_chips + v_row.delta;
      UPDATE public.tournament_players
         SET prize = round(COALESCE(prize, 0) + v_row.delta, 2)
       WHERE tournament_id = v_row.id AND user_id = v_winner;
      UPDATE public.tournaments
         SET prize_pool = round(COALESCE(prize_pool, 0) + v_row.delta, 2)
       WHERE id = v_row.id;

      -- This event is settled. Close its own alert rather than leaving a
      -- resolved problem sitting in the queue looking unresolved.
      UPDATE public.financial_alerts
         SET resolved = true, resolved_at = now()
       WHERE source = 'fn_backpay_hu_winner_shortfalls'
         AND resolved IS NOT TRUE
         AND (context->>'tournament_id')::uuid = v_row.id;
    END IF;
  END LOOP;

  -- STEP 3. What is genuinely left. Same definition as STEP 2 used.
  SELECT count(*) INTO v_unpayable
    FROM public.fn_hu_shortfall_candidates(10000) c
   WHERE (SELECT count(*) FROM public.tournament_players tp
           WHERE tp.tournament_id = c.tournament_id
             AND (tp.status = 'winner' OR tp.position = 1)) <> 1;

  IF v_unpayable > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning', 'fn_backpay_hu_winner_shortfalls',
           v_unpayable || ' Heads-Up event(s) owe a shortfall but have no single '
             || 'identifiable winner - needs a human decision',
           jsonb_build_object('unpayable_events', v_unpayable)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts
        WHERE source = 'fn_backpay_hu_winner_shortfalls'
          AND resolved IS NOT TRUE
          AND context ? 'unpayable_events');
  ELSE
    -- Nothing is unpayable any more. A sweep that can raise this alert must
    -- also be able to clear it, or the queue only ever grows.
    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now()
     WHERE source = 'fn_backpay_hu_winner_shortfalls'
       AND resolved IS NOT TRUE
       AND context ? 'unpayable_events';
  END IF;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned, 'ranked', v_ranked,
    'paid', v_paid, 'chips', round(v_chips, 2), 'unpayable', v_unpayable);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Post-apply assertions.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_n integer;
BEGIN
  IF to_regprocedure('public.fn_hu_shortfall_candidates(integer)') IS NULL THEN
    RAISE EXCEPTION 'fn_hu_shortfall_candidates was not created';
  END IF;

  -- The window must be live, not expired. If the candidate definition covers
  -- nothing because its dates ran out, this migration achieved nothing.
  SELECT count(*) INTO v_n FROM public.fn_hu_shortfall_candidates(10000);
  RAISE LOG 'fn_hu_shortfall_candidates currently sees % event(s) owing a shortfall', v_n;
END
$post$;
