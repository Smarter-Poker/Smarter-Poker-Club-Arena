-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831232524; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Two functions were sharing one name.
--
-- fn_tournament_chip_conservation_check(numeric) already existed: it measures
-- LIVE tournaments against issued chips with a per-player tolerance, and
-- RakebackSettlerService calls it every cycle. The check added earlier today
-- measures COMPLETED spin and sng games for exact conservation and returns
-- jsonb. Same name, different signature, different job.
--
-- Nothing broke, because the existing caller passes p_tolerance_per_player by
-- NAME and PostgREST resolves on argument names. But an unqualified call with
-- a bare number would bind to the integer overload, and a reader has no way to
-- tell which function a name refers to. So the newer one takes the name that
-- describes what it actually does.

CREATE OR REPLACE FUNCTION public.fn_spin_chip_conservation_check(
  p_since_hours integer DEFAULT 6
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_hours     integer := GREATEST(COALESCE(p_since_hours, 6), 1);
  v_since     timestamptz := now() - make_interval(hours => v_hours);
  v_checked   integer := 0;
  v_minted    integer := 0;
  v_destroy   integer := 0;
  v_minted_c  numeric := 0;
  v_destroy_c numeric := 0;
  v_worst     numeric := 0;
  v_worst_id  uuid;
  v_ids       uuid[];
  v_verdict   text := 'pass';
  v_severity  text;
  v_message   text;
  v_context   jsonb;
  v_alerts    integer := 0;
BEGIN
  WITH g AS (
    SELECT t.id,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) * t.starting_chips AS expected,
           (SELECT COALESCE(sum(tp.chips), 0) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS actual
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND t.variant IN ('spin', 'sng')
       AND COALESCE(t.starting_chips, 0) > 0
       AND t.ended_at >= v_since
       AND NOT EXISTS (
         SELECT 1 FROM public.wallet_transactions w
          WHERE w.related_entity_id = t.id
            AND w.category IN ('rebuy', 'addon', 'addon_refund'))
  ), d AS (
    SELECT id, actual - expected AS delta FROM g
  )
  SELECT count(*),
         count(*) FILTER (WHERE delta > 0),
         count(*) FILTER (WHERE delta < 0),
         COALESCE(sum(delta) FILTER (WHERE delta > 0), 0),
         COALESCE(sum(-delta) FILTER (WHERE delta < 0), 0),
         COALESCE(max(abs(delta)), 0),
         COALESCE((array_agg(id ORDER BY abs(delta) DESC) FILTER (WHERE delta <> 0))[1:20],
                  ARRAY[]::uuid[])
    INTO v_checked, v_minted, v_destroy, v_minted_c, v_destroy_c, v_worst, v_ids
    FROM d;

  v_worst_id := v_ids[1];

  IF v_minted > 0 OR v_destroy > 0 THEN
    v_verdict  := CASE WHEN v_destroy > 0 THEN 'chips_destroyed' ELSE 'chips_minted' END;
    v_severity := 'critical';
    v_message  := format(
      'Chip conservation broken on %s of %s completed spin/sng game(s) in the '
      'last %sh: %s minted %s chips, %s destroyed %s chips. Worst single game '
      'off by %s. The prize does not depend on the chip count, but the WINNER '
      'does.',
      v_minted + v_destroy, v_checked, v_hours,
      v_minted, round(v_minted_c, 0), v_destroy, round(v_destroy_c, 0),
      round(v_worst, 0));
  END IF;

  v_context := jsonb_build_object(
    'window_hours',    v_hours,
    'variants',        jsonb_build_array('spin', 'sng'),
    'games_checked',   v_checked,
    'minted_games',    v_minted,
    'minted_chips',    round(v_minted_c, 2),
    'destroyed_games', v_destroy,
    'destroyed_chips', round(v_destroy_c, 2),
    'worst_abs_delta', round(v_worst, 2),
    'worst_game',      v_worst_id,
    'sample_games',    to_jsonb(v_ids),
    'verdict',         v_verdict,
    'detail',          'completed fixed-entry games only; rebuy/add-on games are '
                       'excluded, not guessed at; no money was moved by this check');

  IF v_severity IS NOT NULL THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT v_severity, 'fn_spin_chip_conservation_check', v_message, v_context
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_spin_chip_conservation_check'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'verdict' = v_verdict);
    IF FOUND THEN v_alerts := 1; END IF;
  END IF;

  RETURN v_context || jsonb_build_object('ok', true, 'alerts_raised', v_alerts);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_chip_conservation_check(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_spin_chip_conservation_check(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_spin_chip_conservation_check(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_chip_conservation_check(integer) TO service_role;

-- The overload goes. The (numeric) function that owned this name keeps it.
DROP FUNCTION IF EXISTS public.fn_tournament_chip_conservation_check(integer);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname = 'fn_tournament_chip_conservation_check'
                AND pg_get_function_identity_arguments(p.oid) = 'integer') THEN
    RAISE EXCEPTION 'the integer overload survived the rename';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public'
                    AND p.proname = 'fn_tournament_chip_conservation_check') THEN
    RAISE EXCEPTION 'the pre-existing tournament chip check was dropped -- it must survive';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_spin_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the spin chip conservation check';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_spin_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute the spin chip conservation check';
  END IF;
END $$;

-- Repoint the cron job at the renamed function, and prove it took.
DO $$
BEGIN
  PERFORM cron.unschedule('tournament_chip_conservation_hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job
                   WHERE jobname = 'tournament_chip_conservation_hourly');

  PERFORM cron.schedule(
    'spin_chip_conservation_hourly',
    '49 * * * *',
    $job$
    SELECT CASE
             WHEN pg_try_advisory_lock(hashtext('spin_chip_conservation'))
               THEN (SELECT public.fn_spin_chip_conservation_check(6)::text)
             ELSE 'skipped: previous run still holding the lock'
           END;
    $job$);
END $$;

DO $$
DECLARE v_sched text; v_active boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tournament_chip_conservation_hourly') THEN
    RAISE EXCEPTION 'the old chip conservation job is still scheduled';
  END IF;
  SELECT schedule, active INTO v_sched, v_active
    FROM cron.job WHERE jobname = 'spin_chip_conservation_hourly';
  IF v_sched IS NULL THEN
    RAISE EXCEPTION 'spin_chip_conservation_hourly was not scheduled';
  END IF;
  IF v_sched <> '49 * * * *' THEN
    RAISE EXCEPTION 'spin_chip_conservation_hourly is on % not 49 * * * *', v_sched;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'spin_chip_conservation_hourly is scheduled but inactive';
  END IF;
END $$;
