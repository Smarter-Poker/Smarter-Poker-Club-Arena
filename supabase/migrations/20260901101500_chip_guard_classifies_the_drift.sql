-- The chip guard learns to say WHICH kind of wrong.
--
-- fn_spin_chip_conservation_check told us a game's chips do not add up. It did
-- not say whether the engine also believed the wrong number, and that
-- distinction is the whole diagnosis:
--
--   LOST FINAL WRITE - the engine's own last hand ends on the right total, but
--   tournament_players holds a different one. The play was correct and the
--   record is wrong. Nothing ever repairs it: during a tournament the next
--   hand's settlement rewrites both copies, and a completed tournament has no
--   next hand. fn_reconcile_tournament_denormals does not touch chips at all -
--   it reconciles table_id, seat_number, stakes strings and current_players.
--
--   CHIPS MOVED IN PLAY - the engine's own last hand agrees with the wrong
--   total. The chips really were created or destroyed at the table and the
--   engine never knew. This is the serious one.
--
-- Measured on the 12 drifted games in the 5 hours after the creditSeatStacks
-- mint fix: 2 lost final writes, 10 chips-moved-in-play. All ten of the second
-- kind started between 00:31 and 00:41 on 2026-09-01, straddling a 39-second
-- board-wide dealing gap at 00:40:18 - an engine restart. Games in flight
-- across that restart came out wrong 15.8% of the time against 0.2% for
-- everything else. See issue #2406.
--
-- Whoever reads the alert should not have to rebuild that by hand, so the
-- check does it: for each of the (at most 20) sample games it compares the
-- stack sum recorded in the tournament's LAST hand_history row against both
-- the expected total and the stored total, and reports the counts.
--
-- Cost is bounded by the sample cap, not by how bad the hour was.
--
-- CLAUDE.md 10.5, horses are players: no is_horse filter, no p_include_horses.
--
-- The function reads and alerts. It moves no money and repairs nothing.

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
  v_lost_write integer := 0;
  v_in_play    integer := 0;
  v_unclear    integer := 0;
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

  -- Classify the sample against the engine's own last word on each game.
  IF array_length(v_ids, 1) > 0 THEN
    WITH s AS (
      SELECT t.id,
             (SELECT count(*) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id) * t.starting_chips AS expected,
             (SELECT COALESCE(sum(tp.chips), 0) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id) AS actual,
             (SELECT COALESCE(sum((p->>'stack')::numeric), 0)
                FROM public.hand_history h,
                     LATERAL jsonb_array_elements(h.players) p
               WHERE h.id = (SELECT h2.id FROM public.hand_history h2
                              WHERE h2.tournament_id = t.id
                              ORDER BY h2.hand_number DESC LIMIT 1)) AS last_hand
        FROM public.tournaments t
       WHERE t.id = ANY(v_ids)
    )
    SELECT count(*) FILTER (WHERE last_hand = expected AND last_hand <> actual),
           count(*) FILTER (WHERE last_hand = actual AND last_hand <> expected),
           count(*) FILTER (WHERE last_hand NOT IN (expected, actual))
      INTO v_lost_write, v_in_play, v_unclear
      FROM s;
  END IF;

  IF v_minted > 0 OR v_destroy > 0 THEN
    v_verdict  := CASE WHEN v_destroy > 0 THEN 'chips_destroyed' ELSE 'chips_minted' END;
    v_severity := 'critical';
    v_message  := format(
      'Chip conservation broken on %s of %s completed spin/sng game(s) in the '
      'last %sh: %s minted %s chips, %s destroyed %s chips. Worst single game '
      'off by %s. Of the %s sampled: %s lost the final write (the engine ended '
      'on the right total, the record did not), %s had chips move in play (the '
      'engine believed the wrong total too - the serious kind, see issue 2406), '
      '%s unclear. The prize does not depend on the chip count, but the WINNER '
      'does.',
      v_minted + v_destroy, v_checked, v_hours,
      v_minted, round(v_minted_c, 0), v_destroy, round(v_destroy_c, 0),
      round(v_worst, 0),
      COALESCE(array_length(v_ids, 1), 0), v_lost_write, v_in_play, v_unclear);
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
    'sample_size',     COALESCE(array_length(v_ids, 1), 0),
    'lost_final_write', v_lost_write,
    'chips_moved_in_play', v_in_play,
    'classification_unclear', v_unclear,
    'verdict',         v_verdict,
    'detail',          'completed fixed-entry games only; rebuy/add-on games are '
                       'excluded, not guessed at; the classification compares each '
                       'sampled game against the stack sum in its own last hand; '
                       'no money was moved by this check');

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

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_spin_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the spin chip conservation check';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_spin_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute the spin chip conservation check';
  END IF;
END $$;
