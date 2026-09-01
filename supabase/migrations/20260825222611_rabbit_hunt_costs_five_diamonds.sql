-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825222611; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  RABBIT HUNT COSTS WHAT DAN SAID IT COSTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan 2026-08-25: "vip members get 100 rabbit hunts a month for free, and they
-- COST 5 DIAMONDS EACH after that."
--
-- The live `feature_pricing` row said 1. It was seeded on 2026-01-24 and has
-- disagreed with the client ever since: src/services/VIPService.ts has always
-- declared `rabbit_hunt: { cost: 5 }`, and tests/unit/VIPService.test.ts
-- asserts 5.
--
-- Nobody noticed because nothing read the row. The client rendered its own
-- constant on the button, and the charge path (fn_purchase_feature via
-- VIPService) relied on a cost that defaults to 0, so rabbit hunts were comped
-- outright — a wrong number in a column nothing consulted.
--
-- fn_consume_rabbit_hunt now reads this row for the charge, and the engine
-- sends it to the client so the button quotes the live price. That turned a
-- dormant disagreement into a live one: every rabbit hunt would have been
-- advertised and billed at 1 diamond, a fifth of the stated price.
--
-- The migration that introduced fn_consume_rabbit_hunt inserted the row with
-- ON CONFLICT DO NOTHING, correctly refusing to stamp over live pricing. This
-- is the deliberate correction it declined to make on its own.
--
-- ROLLBACK
--   UPDATE public.feature_pricing SET diamond_cost = 1 WHERE feature = 'rabbit_hunt';

UPDATE public.feature_pricing
   SET diamond_cost = 5,
       description  = 'See the cards that would have come'
 WHERE feature = 'rabbit_hunt';

DO $$
DECLARE
  v_cost int;
BEGIN
  SELECT diamond_cost INTO v_cost FROM public.feature_pricing WHERE feature = 'rabbit_hunt';
  IF v_cost IS NULL THEN
    RAISE EXCEPTION 'rabbit_hunt has no pricing row; fn_consume_rabbit_hunt would fall back to its default';
  END IF;
  IF v_cost <> 5 THEN
    RAISE EXCEPTION 'rabbit_hunt priced at % diamonds, expected 5', v_cost;
  END IF;
END $$;
