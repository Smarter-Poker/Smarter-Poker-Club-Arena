-- A player gets paid their place once.
--
-- WHAT HAPPENED. Between 2026-08-31 13:37:36 and 13:45:12 -- seven and a half
-- minutes -- 24 tournaments finished and 30 of their finishers received TWO
-- 'structure' rows in tournament_payouts instead of one, 688.30 beyond the
-- ladder. In "Union PKO Afternoon (PLO4)" every place from 3rd to 9th collected
-- its own prize plus the prize of the place above it, so a 600.00 pool paid out
-- 1,005.00 -- a 67% overpay on one event.
--
-- HOW IT SURFACED, and why that is the real complaint. Nothing raised an alarm.
-- fn_tournament_payout_reconcile saw it perfectly well and filed it as
-- 'overpaid' with the note "reported only; automatic clawback is deliberately
-- not done" -- correct policy, silent outcome. The finding then sat inside the
-- return value of a sweep that is read by nobody, in a list it shared with
-- one-cent rounding artifacts. A 405.00 double-pay and a 0.01 rounding tail
-- were the same shape of nothing.
--
-- WHAT IT WAS NOT. The obvious suspect is an engine restart re-running the
-- completion path, which would tie this to #2406. It is not that: hand_history
-- shows no dealing gap anywhere near it -- every minute from 13:33 to 13:50
-- deals between 35 and 233 hands, unbroken. Whatever ran twice, the engine
-- never stopped. Recorded so the next person does not spend the afternoon I
-- nearly did.
--
-- STATUS. Confined to those seven minutes. The table holds no other duplicate
-- pair, before or since, and the 2,780 'structure' rows written after
-- 2026-09-01 are all singletons. It stopped on its own, which means nobody
-- knows what stopped it, which is the reason to watch rather than close the
-- book.
--
-- WHY A GUARD AND NOT A CONSTRAINT. A partial UNIQUE index on
-- (tournament_id, user_id) WHERE source = 'structure' would make this
-- impossible rather than merely visible, and that is the stronger fix. It also
-- refuses writes at the moment a tournament is paying out, and a legitimate
-- second structure payment -- a final-table deal restated, a re-pay after a
-- correction -- would fail closed onto a player mid-payout. That trade belongs
-- to whoever owns the writer, after auditing every source value. This makes it
-- loud today without risking that.
--
-- The money already paid is NOT touched. Clawing back from players is a policy
-- decision and a money movement, and neither is a guard's to make.

CREATE OR REPLACE FUNCTION public.fn_ca_duplicate_structure_payout_check(
  p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_players int := 0;
  v_events  int := 0;
  v_excess  numeric := 0;
  v_sample  jsonb;
  v_since   timestamptz := now() - make_interval(hours => GREATEST(p_hours, 1));
BEGIN
  WITH dup AS (
    SELECT tpo.tournament_id,
           tpo.user_id,
           count(*)            AS rows_,
           sum(tpo.amount)     AS paid,
           max(tpo.amount)     AS largest,
           max(tpo.created_at) AS last_at
      FROM public.tournament_payouts tpo
     WHERE tpo.source = 'structure'
       AND tpo.amount > 0
       AND tpo.created_at > v_since
     GROUP BY 1, 2
    HAVING count(*) > 1
  )
  SELECT count(*),
         count(DISTINCT tournament_id),
         COALESCE(sum(paid - largest), 0),
         COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', tournament_id, 'user_id', user_id,
           'rows', rows_, 'paid', round(paid, 2),
           'excess', round(paid - largest, 2), 'last_at', last_at)
           ORDER BY paid - largest DESC), '[]'::jsonb)
    INTO v_players, v_events, v_excess, v_sample
    FROM dup;

  IF v_players > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical',
           'fn_ca_duplicate_structure_payout_check',
           format('%s finisher(s) across %s tournament(s) hold more than one '
                  'structure payout row for the same place; %s paid beyond the '
                  'ladder in the last %s hour(s). A place pays once.',
                  v_players, v_events, round(v_excess, 2), GREATEST(p_hours, 1)),
           jsonb_build_object('players', v_players, 'tournaments', v_events,
                              'excess', round(v_excess, 2),
                              'hours', GREATEST(p_hours, 1),
                              'sample', v_sample)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_ca_duplicate_structure_payout_check'
          AND fa.resolved IS NOT TRUE);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'hours', GREATEST(p_hours, 1),
    'players_double_paid', v_players,
    'tournaments', v_events,
    'excess', round(v_excess, 2),
    'sample', v_sample);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_duplicate_structure_payout_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_duplicate_structure_payout_check(integer)
  TO service_role;

SELECT cron.schedule(
  'ca-duplicate-structure-payout-hourly',
  '37 * * * *',
  $cron$select public.fn_ca_duplicate_structure_payout_check(24);$cron$
);

-- Prove it both ways: silent on the clean present, loud on the known incident.
-- The clean-now probe uses SIX hours on purpose. A 24h window still contains
-- 2026-08-31 13:37 as this is applied, and a guard that "passes" only because
-- the window happens to miss the incident proves nothing. Six hours is strictly
-- after it and strictly inside the period the writer has been well behaved.
DO $$
DECLARE
  v_now  jsonb;
  v_then jsonb;
  v_hours int;
BEGIN
  v_now := public.fn_ca_duplicate_structure_payout_check(6);
  IF (v_now->>'players_double_paid')::int <> 0 THEN
    RAISE EXCEPTION 'expected the last 6h to be clean, got %', v_now;
  END IF;

  v_hours := CEIL(EXTRACT(epoch FROM (now() - timestamptz '2026-08-31 13:00:00+00')) / 3600)::int;
  v_then := public.fn_ca_duplicate_structure_payout_check(v_hours);
  IF (v_then->>'players_double_paid')::int < 30 THEN
    RAISE EXCEPTION
      'the guard cannot see the 2026-08-31 incident it was written for: %', v_then;
  END IF;

  RAISE NOTICE 'duplicate-structure guard: clean over 6h, and finds % players across % tournaments in the 08-31 window',
    v_then->>'players_double_paid', v_then->>'tournaments';
END $$;

-- The wide probe files the alert it is designed to file. Resolve it: it
-- describes a closed incident, and an unresolved row would make the hourly
-- guard's dedupe suppress the next REAL one. The incident ages out of the
-- 24h window on its own within the hour.
UPDATE public.financial_alerts
   SET resolved = true
 WHERE source = 'fn_ca_duplicate_structure_payout_check'
   AND resolved IS NOT TRUE;;
