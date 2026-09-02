-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831202412; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_tournament_chip_conservation_check(
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
      'Tournament chip conservation broken on %s of %s completed spin/sng game(s) '
      'in the last %sh: %s minted %s chips, %s destroyed %s chips. Worst single '
      'game off by %s. The prize does not depend on the chip count, but the '
      'WINNER does.',
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
    'detail',          'fixed-entry variants only; rebuy/add-on games are excluded, '
                       'not guessed at; no money was moved by this check');

  IF v_severity IS NOT NULL THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT v_severity, 'fn_tournament_chip_conservation_check', v_message, v_context
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_chip_conservation_check'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'verdict' = v_verdict);
    IF FOUND THEN v_alerts := 1; END IF;
  END IF;

  RETURN v_context || jsonb_build_object('ok', true, 'alerts_raised', v_alerts);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_chip_conservation_check(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_tournament_chip_conservation_check(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_tournament_chip_conservation_check(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_chip_conservation_check(integer) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_tournament_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the chip conservation check';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_tournament_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute the chip conservation check';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_tournament_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute the chip conservation check';
  END IF;
END $$;
