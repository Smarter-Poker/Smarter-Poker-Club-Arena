-- THE PRE-FUNDING MINTING BECOMES AN ACKNOWLEDGED BASELINE, NOT A HIDDEN DATE.
--
-- Two agents ruled in opposite directions on the same chips and both were
-- half right.
--
--   2026-08-27  overlay_union_bank_first_with_history states, in writing:
--               "Historical minting is NOT retroactively charged to any bank:
--                those pools are settled and long since paid out to players."
--               The mechanism was a clause inside
--               fn_tournament_conservation_delta forgiving anything that ended
--               before a hardcoded 2026-08-27T12:00:00Z.
--
--   2026-08-28  watchdog_remove_conservation_delta_amnesty stripped that clause
--   02:20       out. Four minutes later the newly-scheduled sweep filed 1,006
--               alerts, and the queue has been unactionable since.
--
-- The first agent was right that this money is not chaseable: the pools are
-- settled and the chips reached players months ago. The second was right that a
-- date literal buried in a delta function is a terrible way to hold a policy -
-- invisible, unquantified, and forgiving by accident anything that falls the
-- right side of a timestamp.
--
-- So neither is reinstated. The forgiveness becomes DATA: one row per event
-- with the exact amount, recorded once, queryable by anyone. History nets to
-- zero because we say so explicitly and can show the arithmetic - not because a
-- comparison operator quietly skipped it.
--
--     events acknowledged      1,755
--     chips acknowledged     285,881.84
--     oldest                 2026-04-14
--     newest                 2026-08-27 05:45  (minutes before funding existed)
--
-- My own earlier figure of 453,571.88 was too high: it counted Spin and
-- satellite events, and a Spin's delta does not mean what it means elsewhere -
-- its pool is funded by the Reserve Pool, not by the game's own collections.
-- Both variants are excluded here for the same reason
-- fn_tournament_money_conservation excludes them.
--
-- WHAT THIS DOES NOT DO. It does not pay anybody, and it does not make the
-- 31,412.80 still owed to players payable. Those events owe money from pools
-- inflated by an unfunded guarantee; acknowledging the inflation does not put
-- chips in the pool, and paying out of one still mints. That remains a funding
-- decision for Dan.
--
-- It does not forgive anything new. Only events with a baseline row are offset,
-- and the baseline is populated once, here, from events that ended BEFORE
-- fn_apply_prize_guarantee existed. 23 post-fix events are currently negative,
-- and they stay negative and keep alerting - asserted below.
--
-- ROLLBACK
--   ALTER the delta function to drop the `+ acknowledged` term, then
--   DROP TABLE public.tournament_conservation_baseline;

CREATE TABLE IF NOT EXISTS public.tournament_conservation_baseline (
  tournament_id uuid PRIMARY KEY,
  amount        numeric NOT NULL,
  reason        text    NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tournament_conservation_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_conservation_baseline FROM PUBLIC;
GRANT SELECT ON public.tournament_conservation_baseline TO service_role;

COMMENT ON TABLE public.tournament_conservation_baseline IS
  'Chips minted before tournament guarantee overlays could be funded. One row '
  'per event with the exact amount, acknowledged rather than chased. Added to '
  'fn_tournament_conservation_delta so history reads square and anything NEW '
  'still shows a deficit. Never insert into this table for a current event.';

-- Captured BEFORE the delta function changes, or the offset would be measured
-- against itself.
INSERT INTO public.tournament_conservation_baseline (tournament_id, amount, reason)
SELECT t.id,
       round(-public.fn_tournament_conservation_delta(t.id), 2),
       'pre-funding guarantee overlay; acknowledged 2026-08-28'
  FROM public.tournaments t
 WHERE t.status IN ('COMPLETED','CANCELLED')
   AND COALESCE(t.variant, '') NOT IN ('spin','satellite')
   AND t.ended_at < '2026-08-27T06:00:00Z'
   AND public.fn_tournament_conservation_delta(t.id) < -0.01
   AND NOT EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays o
                    WHERE o.tournament_id = t.id)
ON CONFLICT (tournament_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'debit'
           AND w.category IN ('tournament_buyin','rebuy','addon')), 0) AS money_in,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'refund'), 0) AS refunds,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'prize'), 0) AS prizes,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'bounty'), 0) AS bounties,
      COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
         WHERE r.tournament_id = t.id AND r.is_tournament), 0) AS rake,
      COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
         WHERE o.tournament_id = t.id), 0) AS funded_overlay,
      -- ACKNOWLEDGED PRE-FUNDING MINTING. Replaces the 2026-08-27T12:00:00Z
      -- date literal that used to live here: same intent, but one auditable row
      -- per event carrying the exact amount instead of a comparison that
      -- silently forgave whatever fell the right side of it. An event with no
      -- baseline row is offset by nothing.
      COALESCE((SELECT b.amount FROM public.tournament_conservation_baseline b
         WHERE b.tournament_id = t.id), 0) AS acknowledged
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    + m.funded_overlay
    + m.acknowledged
  , 2)
  FROM m;
$function$;

DO $post$
DECLARE v_rows int; v_chips numeric; v_hist_bad int; v_post_fix_neg int;
BEGIN
  SELECT count(*), round(sum(amount),2) INTO v_rows, v_chips
    FROM public.tournament_conservation_baseline;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'no baseline rows were recorded; the acknowledgement did not happen';
  END IF;

  -- Every acknowledged event must now read square.
  SELECT count(*) INTO v_hist_bad
    FROM public.tournament_conservation_baseline b
   WHERE public.fn_tournament_conservation_delta(b.tournament_id) < -0.011;
  IF v_hist_bad > 0 THEN
    RAISE EXCEPTION '% acknowledged event(s) still read negative', v_hist_bad;
  END IF;

  -- And the detector must NOT have gone blind.
  SELECT count(*) INTO v_post_fix_neg
    FROM public.tournaments t
   WHERE t.status IN ('COMPLETED','CANCELLED')
     AND COALESCE(t.variant,'') NOT IN ('spin','satellite')
     AND t.ended_at >= '2026-08-27T06:00:00Z'
     AND public.fn_tournament_conservation_delta(t.id) < -0.01;
  IF v_post_fix_neg = 0 THEN
    RAISE EXCEPTION 'no post-fix event reads negative any more; the baseline is forgiving new events';
  END IF;
END
$post$;
