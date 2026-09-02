-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831201808; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  THE CHIPS THAT FINISH A GAME ARE THE CHIPS THAT STARTED IT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nothing in the estate measured this. The tournament sentinel checks payout
-- conservation (prize_pool against what was paid) and stranded players; the
-- rake law checks fees. NOBODY counted the chips on the felt, so two opposite
-- failures ran unseen for their entire lifetime:
--
--   MINTED     creditSeatStacks raised any seat below the starting stack back
--              up to it with no check that a hand had been dealt, so a losing
--              player was rescued on every engine restart. 502 spins in 24h,
--              worst +1,603, and not one over twice the starting stack -
--              exactly the ceiling of topping up the two players who can be
--              behind. Fixed 2026-08-31 (a credit may fund an empty seat, not
--              rescue a losing one).
--   DESTROYED  81 spins the other way, worst -1,000 (one whole stack), all of
--              them between 08:00 and 15:00 on 2026-08-31 and none since. Both
--              losers in the worst case had played real poker for minutes, so
--              this was not an unfunded seat: the chips existed and left.
--
-- A Spin's prize is buy_in x multiplier, so neither creates money directly.
-- What they change is WHO WINS - the engine decides on chips - and on an MTT,
-- where finishing position is the payout, that is money.
--
-- THE POPULATION IS EXACT ON PURPOSE. A rebuy or an add-on legitimately puts
-- new chips on the table, and the chip amount is not derivable from the wallet
-- row, so any tournament with a real rebuy/addon transaction is EXCLUDED
-- rather than guessed at. `rebuy_levels` cannot be used for this: it is set
-- above zero on 2,473 of 2,510 spins, which have no rebuys at all - it is
-- tournament-block junk written onto rows that are not MTTs. Measured on the
-- actual transactions, spins and SNGs have ZERO, so the exact invariant still
-- covers 3,285 of 3,298 completed games.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5): no is_horse filter, and none may be
-- added. A horse's stack is chips on the felt like anyone else's.

CREATE OR REPLACE FUNCTION public.fn_tournament_chip_conservation_check(
  p_since_hours integer DEFAULT 6
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_hours    integer := GREATEST(COALESCE(p_since_hours, 6), 1);
  v_since    timestamptz := now() - make_interval(hours => v_hours);
  v_checked  integer := 0;
  v_minted   integer := 0;
  v_destroy  integer := 0;
  v_minted_c numeric := 0;
  v_destroy_c numeric := 0;
  v_worst    numeric := 0;
  v_worst_id uuid;
  v_ids      uuid[];
  v_verdict  text := 'pass';
  v_severity text;
  v_message  text;
  v_context  jsonb;
  v_alerts   integer := 0;
BEGIN
  WITH g AS (
    SELECT t.id,
           t.variant,
           (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) * t.starting_chips AS expected,
           (SELECT COALESCE(sum(tp.chips), 0) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS actual
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND COALESCE(t.starting_chips, 0) > 0
       AND t.ended_at >= v_since
       -- A rebuy or add-on adds chips this function cannot price. Skip, never guess.
       AND NOT EXISTS (
         SELECT 1 FROM public.wallet_transactions w
          WHERE w.related_entity_id = t.id
            AND w.category IN ('rebuy', 'addon', 'addon_refund'))
  ), d AS (
    SELECT id, variant, expected, actual, actual - expected AS delta FROM g
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

  SELECT id INTO v_worst_id
    FROM (
      SELECT t.id,
             abs((SELECT COALESCE(sum(tp.chips),0) FROM public.tournament_players tp
                   WHERE tp.tournament_id = t.id)
                 - (SELECT count(*) FROM public.tournament_players tp
                     WHERE tp.tournament_id = t.id) * t.starting_chips) AS ad
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND COALESCE(t.starting_chips, 0) > 0
         AND t.ended_at >= v_since
         AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w
                          WHERE w.related_entity_id = t.id
                            AND w.category IN ('rebuy','addon','addon_refund'))
       ORDER BY ad DESC NULLS LAST
       LIMIT 1) x
   WHERE x.ad > 0;

  IF v_minted > 0 OR v_destroy > 0 THEN
    v_verdict  := CASE WHEN v_destroy > 0 THEN 'chips_destroyed' ELSE 'chips_minted' END;
    v_severity := 'critical';
    v_message  := format(
      'Tournament chip conservation broken on %s of %s completed game(s) in the '
      'last %sh: %s minted %s chips, %s destroyed %s chips. Worst single game '
      'off by %s. The prize does not depend on the chip count, but the WINNER '
      'does.',
      v_minted + v_destroy, v_checked, v_hours,
      v_minted, round(v_minted_c, 0), v_destroy, round(v_destroy_c, 0), round(v_worst, 0));
  END IF;

  v_context := jsonb_build_object(
    'window_hours',    v_hours,
    'games_checked',   v_checked,
    'minted_games',    v_minted,
    'minted_chips',    round(v_minted_c, 2),
    'destroyed_games', v_destroy,
    'destroyed_chips', round(v_destroy_c, 2),
    'worst_abs_delta', round(v_worst, 2),
    'worst_game',      v_worst_id,
    'sample_games',    to_jsonb(v_ids),
    'verdict',         v_verdict,
    'detail',          'rebuy/add-on games are excluded, not guessed at; no money '
                       'was moved by this check');

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

COMMENT ON FUNCTION public.fn_tournament_chip_conservation_check(integer) IS
  'Asserts that the chips finishing a tournament are the chips that started it. '
  'Excludes games with a real rebuy/add-on transaction. Raises into '
  'financial_alerts, moves no money. Counts horses (CLAUDE.md 10.5).';

REVOKE ALL ON FUNCTION public.fn_tournament_chip_conservation_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_chip_conservation_check(integer) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('authenticated',
       'public.fn_tournament_chip_conservation_check(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_tournament_chip_conservation_check(integer)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'fn_tournament_chip_conservation_check grants did not take';
  END IF;
END $$;
