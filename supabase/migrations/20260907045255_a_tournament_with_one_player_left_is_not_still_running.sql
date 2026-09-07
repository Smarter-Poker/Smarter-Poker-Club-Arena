-- ═══════════════════════════════════════════════════════════════════════════
--  A TOURNAMENT WITH ONE PLAYER LEFT IS NOT STILL RUNNING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FOUND 2026-09-07 04:50, while measuring the engine-thread saturation that
-- took the fleet from 480 hands a minute to 6.
--
-- `3e346d72` "3 Chip Deep Stack Spin NLH", three entrants:
--
--     hawkk      eliminated 3rd   04:05:09
--     rookiee    eliminated 2nd   04:19:33
--     SlyViking  status 'playing', 3,774 chips, prize 0.00
--
-- One player left, thirty-one minutes after the final elimination, and the
-- tournament still `RUNNING`. **Its winner is unpaid and nothing on this
-- platform can see it.**
--
-- WHY NOTHING SEES IT. There are fourteen scheduled money checks on this
-- database and every one of them judges a COMPLETED tournament:
-- `ca-payout-sweep-hourly`, `ca-payout-guarantee-check-hourly`,
-- `tourney_money_conservation_hourly`, `ca-tournament-conservation-10m`, and
-- the rest. `fn_tournament_payout_reconcile` refuses anything else in its
-- third statement:
--
--     IF COALESCE(t.status, '') <> 'COMPLETED' THEN
--       RETURN ... 'skipped', 'not_completed'
--
-- That is correct - a reconciler must not settle a live event. But it means a
-- tournament that finishes DEALING and never transitions to COMPLETED falls
-- through every net at once. The winner waits for ever, and the only reason
-- this one was found is that somebody happened to be looking at the engine
-- tonight. CLAUDE.md 10.86 rule 3: a guard must have a reader, and this class
-- had no guard at all.
--
-- WHAT THIS IS, AND WHAT IT IS NOT. This is a DETECTOR, and 10.11 is explicit
-- that a detector is not a fix. The cause is the elimination sweep overrunning
-- on a saturated single JS thread - 780 stuck sweeps in fifteen minutes,
-- measured, recorded as P0/P1 in `docs/HANDOFF_CURRENT_STATE.md` section 16
-- and in `docs/changelog/2026-09-07-the-collapse-was-not-the-reload-storm.md`,
-- and it belongs to the engine-restart programme. This is the thing that makes
-- the consequence VISIBLE while that work happens, so no winner sits unpaid
-- and unnoticed again. It settles nothing and touches no money.
--
-- THE THRESHOLD, DERIVED (CLAUDE.md 10.84). Across **4,242 tournaments
-- completed in the last twelve hours**, the gap between the final elimination
-- and the first `tournament_payouts` row:
--
--     p50   6 seconds
--     p95  11 seconds
--     p99  20 seconds
--     max  83 minutes   <- one outlier, almost certainly this same defect
--
-- **15 minutes is 45x p99.** It cannot fire on a healthy tournament, and it
-- catches both tonight's case (31 minutes and counting) and that outlier.
--
-- ONE ALERT, NOT ONE PER TOURNAMENT. An unresolved alert from this source
-- suppresses the next insert; the message and context carry the current list.
-- An alarm that files a row every five minutes is an alarm somebody mutes.
--
-- GRANTS ARE WRITTEN DOWN, not left to the default. `CREATE FUNCTION` grants
-- EXECUTE to PUBLIC and `authenticated` inherits it - which is how
-- `fn_bbj_unclaimed_shares()` handed every unpaid jackpot share to any account
-- that could log in, earlier the same day (20260906153953). This one takes an
-- argument and returns a scalar jsonb, so it is not the shape rule 4 of
-- check-definer-authorization judges, but it reads every tournament on the
-- platform and it is closed to the browser regardless.
--
-- ROLLBACK:
--   select cron.unschedule('ca-tournament-finished-not-completed-5m');
--   drop function if exists public.fn_ca_tournament_finished_but_not_completed(integer);

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_finished_but_not_completed(
  p_minutes integer DEFAULT 15
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_count   int := 0;
  v_sample  jsonb := '[]'::jsonb;
  v_open    boolean;
  v_cutoff  interval := make_interval(mins => GREATEST(COALESCE(p_minutes, 15), 1));
BEGIN
  WITH stuck AS (
    SELECT t.id AS tournament_id,
           t.name,
           t.started_at,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id
               AND tp.status IN ('playing', 'active', 'registered')) AS alive,
           (SELECT max(tp.eliminated_at) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.eliminated_at IS NOT NULL) AS last_elimination,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS entrants
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       -- A satellite awards seats, not prizes, and finishes on its own terms.
       AND COALESCE(t.variant, '') <> 'satellite'
       AND upper(COALESCE(t.tournament_type, '')) <> 'SATELLITE'
  )
  SELECT count(*),
         COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', tournament_id,
           'name', left(COALESCE(name, ''), 60),
           'entrants', entrants,
           'alive', alive,
           'last_elimination', last_elimination,
           'stuck_for_minutes', round(extract(epoch FROM (now() - last_elimination)) / 60.0, 1))
           ORDER BY last_elimination), '[]'::jsonb)
    INTO v_count, v_sample
    FROM stuck
   WHERE alive <= 1
     -- At least one elimination must have happened: a tournament that has not
     -- started dealing has nobody waiting on a prize.
     AND last_elimination IS NOT NULL
     AND last_elimination < now() - v_cutoff;

  IF v_count > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.financial_alerts fa
       WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
         AND COALESCE(fa.resolved, false) = false
    ) INTO v_open;

    IF NOT v_open THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES (
        'critical',
        'fn_ca_tournament_finished_but_not_completed',
        format(
          '%s tournament(s) have one player or fewer left and have not completed '
          || 'for over %s minute(s). Their winners are unpaid, and every other payout '
          || 'check on this database only judges COMPLETED tournaments, so nothing '
          || 'else can see them. Healthy tournaments settle within 20s of the final '
          || 'elimination (p99 over 4,242 events).',
          v_count, GREATEST(COALESCE(p_minutes, 15), 1)),
        jsonb_build_object(
          'checked_at', now(),
          'threshold_minutes', GREATEST(COALESCE(p_minutes, 15), 1),
          'tournaments', v_sample,
          'cause', 'elimination sweep overruns on a saturated engine thread - '
                || 'see docs/HANDOFF_CURRENT_STATE.md section 16 (P0/P1) and '
                || 'docs/changelog/2026-09-07-the-collapse-was-not-the-reload-storm.md')
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'checked_at', now(),
    'threshold_minutes', GREATEST(COALESCE(p_minutes, 15), 1),
    'stuck', v_count,
    'tournaments', v_sample
  );
END;
$function$;

-- Silence is not "closed". See the header.
REVOKE ALL ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer) IS
  'Tournaments still RUNNING with one player or fewer left, past the threshold. '
  'Every other payout check on this database judges COMPLETED tournaments only, '
  'so this class was invisible until 2026-09-07. Detector only - settles nothing.';

COMMIT;

-- ── THE READER ─────────────────────────────────────────────────────────────
-- Its own statement: cron.schedule is not DDL and fires no schema reload, and
-- keeping it out of the transaction above means a re-run cannot fail on the
-- job already existing.
--
-- Every five minutes, in the same idiom as the fourteen money checks already
-- here (ca-tournament-conservation-10m, ca-payout-sweep-hourly, ...). Five
-- minutes against a fifteen-minute threshold means a stuck winner is named
-- within twenty minutes at the worst.
SELECT cron.unschedule('ca-tournament-finished-not-completed-5m')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-tournament-finished-not-completed-5m');

SELECT cron.schedule(
  'ca-tournament-finished-not-completed-5m',
  '*/5 * * * *',
  $cron$select public.fn_ca_tournament_finished_but_not_completed(15);$cron$
);

-- ── POST-CHECKS ────────────────────────────────────────────────────────────
DO $$
DECLARE v_res jsonb;
BEGIN
  IF to_regprocedure('public.fn_ca_tournament_finished_but_not_completed(integer)') IS NULL THEN
    RAISE EXCEPTION 'post-check: the function does not exist';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: a browser role can execute the detector';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: service_role cannot execute the detector';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'ca-tournament-finished-not-completed-5m' AND active) THEN
    RAISE EXCEPTION 'post-check: the detector has no reader - the cron job is missing or inactive';
  END IF;

  -- And it must actually answer. A detector nobody has watched run is a
  -- detector nobody knows works.
  SELECT public.fn_ca_tournament_finished_but_not_completed(15) INTO v_res;
  IF COALESCE(v_res->>'ok', '') <> 'true' THEN
    RAISE EXCEPTION 'post-check: the detector did not return ok: %', v_res;
  END IF;
  RAISE NOTICE 'detector live; current stuck count = %', v_res->>'stuck';
END $$;
