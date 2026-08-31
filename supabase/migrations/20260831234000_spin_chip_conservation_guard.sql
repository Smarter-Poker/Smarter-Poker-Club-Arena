-- Nobody counts the chips on the felt.
--
-- The estate already checks that the PRIZE is conserved: fn_tourney_money_conservation
-- proves collected = rake + payouts, and the rake law proves the 8% is exactly 8%.
-- Every one of those guards watches the money. None of them watches the chips.
--
-- That gap is why a chip mint in creditSeatStacks ran unseen for its entire
-- lifetime. Topping a losing seat back up to the starting stack does not move a
-- cent -- the prize pool is fixed at buy-in time -- so every money guard stayed
-- green while the felt carried up to 2x the chips it should have. The prize does
-- not depend on the chip count, but the WINNER does: a busted player handed a
-- fresh stack can go on to take the money from the player who actually beat them.
--
-- SCOPE: 'spin' and 'sng' only, and that is a deliberate limit, not an oversight.
-- For those two variants expected chips = seats x starting_chips is EXACT: over
-- the 3,307 such games completed in the 24h before this migration, zero had late
-- registration, zero allowed re-entry or add-ons, and zero carried early-bird
-- chips. Multi-table variants (freezeout, satellite, bounty) are excluded because
-- for them that identity is simply not true -- late registration alone (9 levels
-- on a live freezeout sampled here) means seats and stacks arrive after the clock
-- starts. Pointed at all variants this check flags 281 of 1,341 games, which is
-- not a guard, it is a way to teach people to close the alert unread.
--
-- The wallet-transaction exclusion below is belt-and-braces: today no spin or sng
-- has ever had a rebuy/add-on transaction, but if one ever does, this check skips
-- that game rather than guessing at what the extra chips were worth.
--
-- CLAUDE.md 10.5, horses are players: there is no is_horse filter here and no
-- p_include_horses parameter. A horse's chips are chips.
--
-- The function reads and raises an alert. It moves no money and repairs nothing.

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
       -- A rebuy or add-on adds chips this function cannot price. Skip, never guess.
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

  -- v_ids is ordered by abs(delta) DESC, so the worst offender is the first one.
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

-- Prove the grants, in the migration, rather than trusting that they took.
DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_spin_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the chip conservation check';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_spin_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute the chip conservation check';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_spin_chip_conservation_check(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute the chip conservation check';
  END IF;
END $$;
