-- 20260922160729_an_unfinished_finish_is_alerted_per_tournament
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 16:07:29 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- fn_ca_tournament_finished_but_not_completed (cron 304,
-- ca-tournament-finished-not-completed-5m, every five minutes) is the only
-- thing on this database that can see a tournament whose final bust has
-- happened but which never reached COMPLETED: its winner is unpaid, and every
-- other payout check judges COMPLETED tournaments only. It decided whether to
-- say so like this (live body md5 6f153669e4b6b149bfccd36ad575bda8, byte for
-- byte the one 20260911062048 installed):
--
--     SELECT EXISTS (
--       SELECT 1 FROM public.financial_alerts fa
--        WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
--          AND COALESCE(fa.resolved, false) = false
--     ) INTO v_open;
--     IF NOT v_open THEN INSERT ...
--
-- ANY open alert from its own source silenced EVERY later finding, whatever
-- tournament it was about. Alert 8c6ce084 was raised 2026-09-08 17:15 for
-- cf7790b9 "NLH Heads-Up 100 Turbo". That tournament COMPLETED six minutes
-- later (17:21:24, one payout row, 190.00 against a 190.00 pool), nobody
-- closed the alert, and the detector has raised nothing since. It ran 4,138
-- times in those fourteen days and reported success every time.
--
-- MEASURED 2026-09-22, read-only. What it would have named had it spoken:
--   - today, at the 14:00 / 14:05 / 14:10 / 15:05 ticks: 17 / 23 / 1 / 4
--     tournaments RUNNING with one player left past the 15-minute threshold,
--     the longest 24.0 minutes. 44 non-satellite tournaments completed today
--     more than 15 minutes after their final recorded elimination (worst
--     28.5). All have since COMPLETED with their payout rows.
--   - since 8c6ce084 was raised: 16,311 of 67,269 tournaments that finished
--     by elimination completed more than 15 minutes after the final recorded
--     one, heaviest on 09-11, 09-12, 09-14, 09-16, 09-17 and 09-18, all in
--     Midway Union or Deep Stack Society.
--
-- It would not have paged anyone even then, which is written here so this
-- fix is not read as more than it is:
--   - 8c6ce084's message was byte-identical to the resolved 2026-09-07 alert,
--     so fn_ca_financial_alert_to_incident folded it into incident f38e91e4
--     as an echo, "folded without re-paging";
--   - the detector's context carries no amount, so its incident is filed at
--     0.00 and fn_ca_incident_notify withholds the push ("nothing is
--     unaccounted for"). Who is paged is an owner rule and is not changed here.
--
-- WHAT THIS CHANGES
--
-- 1. ONE OPEN ALERT PER STUCK TOURNAMENT. Each alert names its tournament
--    (context.tournament_id, and context.tournaments as before), and a
--    tournament is skipped only when an open alert from this source already
--    names IT. That question is one function the detector calls,
--    fn_ca_finished_not_completed_open_alert(uuid), so the verification below
--    asks the detector's own question rather than a copy of it. A stale or
--    unrelated open alert can no longer silence a new finding.
-- 2. A FINDING THAT IS NO LONGER TRUE CLOSES WHEN IT IS RE-MEASURED. Each run
--    closes an open alert from this source once every tournament it names is
--    COMPLETED, and writes each tournament's ended_at and payout rows into the
--    resolution. A named tournament that is CANCELLED, missing or still
--    RUNNING keeps its alert open for a person: nothing here can say that
--    winner was paid. No new job - it is the same five-minute run. 8c6ce084
--    closes on the first run, because cf7790b9 is COMPLETED.
-- 3. The message leads with the tournament id and keeps its first 200
--    characters otherwise fixed. fn_ca_financial_alert_to_incident keys an
--    incident on those 200 characters normalised, so one episode of stuck
--    tournaments is one incident, while no alert is ever byte-identical to
--    another tournament's and so none can be swallowed as an echo.
--
-- WHAT IT DOES NOT CHANGE: the 15-minute threshold, 'critical', the satellite
-- exclusion, how 'alive' and the last recorded elimination are measured, the
-- grants, the cron job. Over the 3,043 completions of the last 24 hours the
-- settle lag was p50 0.9s, p95 11.2 min, p99 18.1 min: the platform is
-- settling slowly today and 15 minutes still names only the tail (44), so the
-- threshold is not what was wrong. It settles nothing and moves no money.
--
-- VERIFIED IN THIS TRANSACTION, both directions, with no synthetic
-- tournament, no alert about a real tournament, and no game touched:
--   - a rolled-back savepoint opens an 'info' alert naming a tournament id
--     that is not a tournament. The old rule is shown to silence everything,
--     and the detector's question answers "raise" for a different tournament
--     (an unrelated open alert no longer silences) and "already open" for the
--     named one (no duplicate);
--   - then the detector runs for real, twice: every tournament it reports
--     stuck is named by exactly one open alert, the second run raises nothing
--     the first already raised, no tournament is named by two open alerts,
--     and no open alert is left naming only COMPLETED tournaments.
--
-- ROLLBACK: re-run the fn_ca_tournament_finished_but_not_completed statement
-- of 20260911062048_a_bust_is_ranked_by_when_it_happened.sql, then
--   DROP FUNCTION public.fn_ca_finished_not_completed_open_alert(uuid);
--
-- @live-proof: (SELECT position('fn_ca_finished_not_completed_open_alert(' in p.prosrc) > 0 AND position('v_open' in p.prosrc) = 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_ca_tournament_finished_but_not_completed(integer)'))
-- @live-proof: (SELECT to_regprocedure('public.fn_ca_finished_not_completed_open_alert(uuid)') IS NOT NULL AND NOT has_function_privilege('authenticated', 'public.fn_ca_finished_not_completed_open_alert(uuid)', 'EXECUTE'))
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The body this was written against, or this migration's own, and nothing
-- else: a detector that has moved on since refuses rather than being
-- overwritten blind.
DO $pre$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.fn_ca_tournament_finished_but_not_completed(integer)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'pre-check: fn_ca_tournament_finished_but_not_completed(integer) does not exist';
  END IF;
  IF md5(v_src) <> '6f153669e4b6b149bfccd36ad575bda8'
     AND position('fn_ca_finished_not_completed_open_alert(' IN v_src) = 0 THEN
    RAISE EXCEPTION 'pre-check: the live detector (md5 %) is neither the body this migration was written against nor its own', md5(v_src);
  END IF;
END $pre$;

-- THE DETECTOR'S QUESTION: which open alert from this source already names
-- this tournament? NULL means raise. Legacy alerts listed their tournaments
-- in context.tournaments exactly as the new ones do, so both are asked.
CREATE OR REPLACE FUNCTION public.fn_ca_finished_not_completed_open_alert(p_tournament_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT fa.id
    FROM public.financial_alerts fa
   WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
     AND NOT fa.resolved
     AND fa.context->'tournaments' @> jsonb_build_array(
           jsonb_build_object('tournament_id', p_tournament_id))
   ORDER BY fa.created_at, fa.id
   LIMIT 1
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_finished_not_completed_open_alert(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_finished_not_completed_open_alert(uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_finished_not_completed_open_alert(uuid) IS
  'The open fn_ca_tournament_finished_but_not_completed alert that already names this '
  'tournament, or NULL. The detector raises only on NULL, so one open alert exists per '
  'stuck tournament and an alert about another tournament silences nothing (20260922160729).';

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_finished_but_not_completed(p_minutes integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_count    int := 0;
  v_sample   jsonb := '[]'::jsonb;
  v_raised   int := 0;
  v_resolved int := 0;
  v_cutoff   interval := make_interval(mins => GREATEST(COALESCE(p_minutes, 15), 1));
BEGIN
  WITH stuck AS (
    SELECT t.id AS tournament_id,
           t.name,
           t.started_at,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id
               AND tp.status IN ('playing', 'active', 'registered')) AS alive,
           -- When the last bust was RECORDED. eliminated_at is the time of
           -- the bust (20260911062048), and a bust can be recorded long after
           -- it happened; the knockout door's own recording time is the
           -- resolved_at of the generation it consumed. Rows recorded without
           -- a generation still carry their recording time in eliminated_at.
           GREATEST(
             (SELECT max(tp.eliminated_at) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id AND tp.eliminated_at IS NOT NULL),
             (SELECT max(c.resolved_at) FROM public.tournament_knockout_candidates c
               WHERE c.tournament_id = t.id AND c.state = 'eliminated')) AS last_elimination,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS entrants
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
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
     AND last_elimination IS NOT NULL
     AND last_elimination < now() - v_cutoff;

  -- ONE OPEN ALERT PER STUCK TOURNAMENT (20260922160729). A tournament is
  -- skipped only when an open alert from this source already names IT. The
  -- rule this replaces skipped every tournament while ANY alert from this
  -- source was open, and one about a tournament that had completed six
  -- minutes after it was raised kept this detector silent for fourteen days.
  -- The first 200 characters of the message are fixed apart from the id:
  -- the incident bridge keys on them, so one episode is one incident.
  INSERT INTO public.financial_alerts (severity, source, message, context)
  SELECT 'critical',
         'fn_ca_tournament_finished_but_not_completed',
         format(
           'Tournament %s has one player or fewer left and has not completed, so its '
           || 'winner is unpaid. Every other payout check on this database judges '
           || 'COMPLETED tournaments only, so nothing else can see it. It is %s minute(s) '
           || 'since its last recorded elimination at %s; the threshold is %s minute(s), '
           || 'and healthy tournaments settle within 20s of it (p99 over 4,242 events).',
           s->>'tournament_id', s->>'stuck_for_minutes', s->>'last_elimination',
           GREATEST(COALESCE(p_minutes, 15), 1)),
         jsonb_build_object(
           'checked_at', now(),
           'threshold_minutes', GREATEST(COALESCE(p_minutes, 15), 1),
           'tournament_id', s->'tournament_id',
           'tournaments', jsonb_build_array(s),
           'cause', 'elimination sweep overruns on a saturated engine thread - '
                 || 'see docs/HANDOFF_CURRENT_STATE.md section 16 (P0/P1) and '
                 || 'docs/changelog/2026-09-07-the-collapse-was-not-the-reload-storm.md')
    FROM jsonb_array_elements(v_sample) s
   WHERE public.fn_ca_finished_not_completed_open_alert((s->>'tournament_id')::uuid) IS NULL;
  GET DIAGNOSTICS v_raised = ROW_COUNT;

  -- A FINDING THAT IS NO LONGER TRUE CLOSES WHEN IT IS RE-MEASURED
  -- (20260922160729). An open alert from this source is closed once every
  -- tournament it names is COMPLETED; from then on the payout checks that
  -- judge COMPLETED tournaments own it. A named tournament that is CANCELLED,
  -- missing or still RUNNING keeps the alert open for a person, because
  -- nothing here can say that winner was paid.
  WITH named AS (
    SELECT fa.id AS alert_id,
           e->>'tournament_id' AS named_id,
           t.status,
           t.ended_at,
           pay.payout_rows,
           pay.paid
      FROM public.financial_alerts fa
      CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(fa.context->'tournaments') = 'array'
                  THEN fa.context->'tournaments' ELSE '[]'::jsonb END) e
      LEFT JOIN public.tournaments t
        ON t.id = CASE
                    WHEN (e->>'tournament_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (e->>'tournament_id')::uuid
                  END
      LEFT JOIN LATERAL (
        SELECT count(*) AS payout_rows, COALESCE(sum(p.amount), 0) AS paid
          FROM public.tournament_payouts p
         WHERE p.tournament_id = t.id) pay ON true
     WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
       AND NOT fa.resolved
  ), closable AS (
    SELECT n.alert_id,
           string_agg(format('%s COMPLETED at %s with %s payout row(s) totalling %s',
                             n.named_id, n.ended_at, n.payout_rows, n.paid),
                      '; ' ORDER BY n.named_id) AS evidence
      FROM named n
     GROUP BY n.alert_id
    HAVING bool_and(COALESCE(n.status = 'COMPLETED', false))
  )
  UPDATE public.financial_alerts fa
     SET resolved    = true,
         resolved_at = now(),
         resolution  = format(
           'Re-measured by fn_ca_tournament_finished_but_not_completed at %s: every '
           || 'tournament this alert names has completed (%s), so the finding no longer '
           || 'holds. A COMPLETED tournament is judged from here by the payout checks '
           || 'that read COMPLETED events.',
           now(), c.evidence)
    FROM closable c
   WHERE fa.id = c.alert_id
     AND NOT fa.resolved;
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'checked_at', now(),
    'threshold_minutes', GREATEST(COALESCE(p_minutes, 15), 1),
    'stuck', v_count,
    'raised', v_raised,
    'resolved', v_resolved,
    'tournaments', v_sample
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer) IS
  'Tournaments still RUNNING with one player or fewer left, past the threshold. '
  'Every other payout check on this database judges COMPLETED tournaments only, '
  'so this class was invisible until 2026-09-07. One open alert per stuck tournament; '
  'an alert closes when every tournament it names has COMPLETED (20260922160729). '
  'Detector only - settles nothing.';

-- What the detector now is, read back from the catalogue, and who may run it.
DO $post$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.fn_ca_tournament_finished_but_not_completed(integer)');
  IF position('WHERE public.fn_ca_finished_not_completed_open_alert((s->>''tournament_id'')::uuid) IS NULL' IN v_src) = 0 THEN
    RAISE EXCEPTION 'post-check: the detector does not ask whether THIS tournament already has an open alert';
  END IF;
  IF position('v_open' IN v_src) > 0 THEN
    RAISE EXCEPTION 'post-check: the source-wide silence is still in the detector';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_finished_not_completed_open_alert(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_finished_not_completed_open_alert(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: a browser role can execute the detector or its question';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: service_role cannot execute the detector';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'ca-tournament-finished-not-completed-5m' AND active) THEN
    RAISE EXCEPTION 'post-check: the detector has no reader - cron job 304 is missing or inactive';
  END IF;
END $post$;

-- BOTH DIRECTIONS, in a savepoint that is always rolled back. The probe alert
-- is 'info', so fn_ca_financial_alert_to_incident files nothing for it, and it
-- names a tournament id that is not a tournament.
DO $verify$
DECLARE
  v_named     uuid := gen_random_uuid();
  v_unrelated uuid := gen_random_uuid();
  v_probe     uuid;
  v_ok        boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournaments WHERE id IN (v_named, v_unrelated)) THEN
    RAISE EXCEPTION 'verify: a random id is a real tournament; apply again';
  END IF;

  BEGIN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('info', 'fn_ca_tournament_finished_but_not_completed',
            'migration 20260922160729 verification probe, rolled back before commit',
            jsonb_build_object('tournament_id', v_named,
                               'tournaments', jsonb_build_array(
                                 jsonb_build_object('tournament_id', v_named))))
    RETURNING id INTO v_probe;

    -- The rule this replaces: with any alert from this source open, every
    -- finding was silenced. It is, so everything below is really tested.
    IF NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                    WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
                      AND COALESCE(fa.resolved, false) = false) THEN
      RAISE EXCEPTION 'verify: the probe alert is not open, so nothing below would be tested';
    END IF;

    -- A stuck tournament with an unrelated open alert still gets its own.
    IF public.fn_ca_finished_not_completed_open_alert(v_unrelated) IS NOT NULL THEN
      RAISE EXCEPTION 'verify: an open alert about another tournament still silences a new one';
    END IF;

    -- A tournament that already has an open alert is not alerted again.
    IF public.fn_ca_finished_not_completed_open_alert(v_named) IS DISTINCT FROM v_probe THEN
      RAISE EXCEPTION 'verify: a tournament whose alert is open would be alerted a second time';
    END IF;

    v_ok := true;
    RAISE EXCEPTION 'ca_verify_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'ca_verify_rollback' THEN
      RAISE;
    END IF;
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'verify: the both-direction check did not complete';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_alerts WHERE id = v_probe) THEN
    RAISE EXCEPTION 'verify: the probe alert survived its rollback';
  END IF;
END $verify$;

-- AND FOR REAL. This is the run the next cron tick would make: it closes what
-- no longer holds (8c6ce084 among them) and raises what does. Then again, as
-- the tick after would.
DO $live$
DECLARE
  r1  jsonb;
  r2  jsonb;
  v_n int;
BEGIN
  r1 := public.fn_ca_tournament_finished_but_not_completed(15);
  IF COALESCE(r1->>'ok', '') <> 'true' THEN
    RAISE EXCEPTION 'live: the detector did not answer ok: %', r1;
  END IF;

  -- Every tournament it reports stuck is named by exactly one open alert,
  -- whatever else was open when it ran.
  SELECT count(*) INTO v_n
    FROM jsonb_array_elements(r1->'tournaments') s
   WHERE (SELECT count(*) FROM public.financial_alerts fa
           WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
             AND NOT fa.resolved
             AND fa.context->'tournaments' @> jsonb_build_array(
                   jsonb_build_object('tournament_id', s->'tournament_id'))) <> 1;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'live: % stuck tournament(s) are not named by exactly one open alert: %', v_n, r1;
  END IF;

  -- The next run raises nothing the first already raised.
  r2 := public.fn_ca_tournament_finished_but_not_completed(15);
  IF COALESCE(r2->>'ok', '') <> 'true' THEN
    RAISE EXCEPTION 'live: the second run did not answer ok: %', r2;
  END IF;
  SELECT count(*) INTO v_n
    FROM jsonb_array_elements(r2->'tournaments') s
   WHERE NOT (r1->'tournaments' @> jsonb_build_array(
                jsonb_build_object('tournament_id', s->'tournament_id')));
  IF (r2->>'raised')::int > v_n THEN
    RAISE EXCEPTION 'live: the second run raised % alert(s) where only % tournament(s) were new: % / %',
      r2->>'raised', v_n, r1, r2;
  END IF;

  -- No tournament is named by two open alerts from this source.
  SELECT count(*) INTO v_n
    FROM (SELECT e->>'tournament_id'
            FROM public.financial_alerts fa
            CROSS JOIN LATERAL jsonb_array_elements(
                   CASE WHEN jsonb_typeof(fa.context->'tournaments') = 'array'
                        THEN fa.context->'tournaments' ELSE '[]'::jsonb END) e
           WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
             AND NOT fa.resolved
           GROUP BY 1
          HAVING count(*) > 1) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'live: % tournament(s) are named by more than one open alert', v_n;
  END IF;

  -- And a finding that no longer holds is not left open.
  SELECT count(*) INTO v_n
    FROM (SELECT fa.id
            FROM public.financial_alerts fa
            CROSS JOIN LATERAL jsonb_array_elements(
                   CASE WHEN jsonb_typeof(fa.context->'tournaments') = 'array'
                        THEN fa.context->'tournaments' ELSE '[]'::jsonb END) e
            LEFT JOIN public.tournaments t
              ON t.id = CASE
                          WHEN (e->>'tournament_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN (e->>'tournament_id')::uuid
                        END
           WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
             AND NOT fa.resolved
           GROUP BY fa.id
          HAVING bool_and(COALESCE(t.status = 'COMPLETED', false))) c;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'live: % open alert(s) still name only COMPLETED tournaments after a run', v_n;
  END IF;

  RAISE NOTICE 'detector live: stuck %, raised % then %, resolved % then %',
    r1->>'stuck', r1->>'raised', r2->>'raised', r1->>'resolved', r2->>'resolved';
END $live$;

COMMIT;
