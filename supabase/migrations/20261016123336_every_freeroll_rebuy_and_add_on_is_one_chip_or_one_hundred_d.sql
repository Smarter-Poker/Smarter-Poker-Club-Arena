-- 20261016123336_every_freeroll_rebuy_and_add_on_is_one_chip_or_one_hundred_d.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-16, verbatim: "ALL REBUY ADD ON'S FOR MIDWAY UNION ARE 1 CHIP
-- REBUY ADD ON NOT 2, DIAMOND REBUYS ARE 100 DIAMONDS (ONE DOLLAR)".
--
-- 1. fn_freerolls_are_free_buy (the BEFORE INSERT/UPDATE trigger every
--    0-buy-in MTT passes through) used to leave a `free_buy` event's own price
--    alone, which is how the 8 PM Prime Time Free Buy charged 2 chips. It now
--    prices EVERY freeroll by the club's asset, with no exception: 1 chip in a
--    chip club, 100 Diamonds in a Diamond club. The rule lives in the one
--    trigger every freeroll row is written through, so no creator can set a
--    different price.
-- 2. fn_poker_diamond_create_tournament_core (the Diamond Arena's creation
--    door) required and wrote 1 Diamond for a freeroll rebuy and add-on. It
--    now requires and writes 100. The replacement is exact: the live
--    definition must match md5 2adb63251df0fc580803e30c07130935 and every
--    replaced token must appear the stated number of times, or this aborts.
-- 3. ca_diamond_economics records the new answer for freeroll_rebuy_cost and
--    freeroll_addon_cost (the door reads the newest row), superseding the
--    2026-10-06 one-Diamond answer.
-- 4. Every freeroll nobody has entered yet is repriced to the rule, through
--    the trigger itself. An event with a registered entrant keeps the
--    contract it was entered under (fn_guard_managed_game_lifecycle); at
--    writing that is 48 already-published events, the last starting
--    2026-10-19 06:00 Chicago, and every event published after this runs at
--    the new price.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_freerolls_are_free_buy()'::regprocedure)) <> 'b4cd5955cb813a63b6364b9b9f1de844' AND public.fn_ca_diamond_economic_text('freeroll_rebuy_cost') = 'one_hundred_diamonds_to_the_prize_pool' AND public.fn_ca_diamond_economic_text('freeroll_addon_cost') = 'one_hundred_diamonds_to_the_prize_pool' AND position('v_rebuy_cost := 100; v_addon_cost := 100;' in pg_get_functiondef('public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure)) > 0)

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. The trigger: one price per asset, no exceptions.
CREATE OR REPLACE FUNCTION public.fn_freerolls_are_free_buy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed jsonb := '{}'::jsonb;
  v_stack   integer;
  v_op      text;
  v_price   numeric;
BEGIN
  IF NOT public.fn_is_free_buy_event(
       NEW.buy_in_amount, NEW.buy_in_fee, NEW.tournament_type, NEW.variant
     ) THEN
    RETURN NEW;
  END IF;

  -- A live or finished event keeps the contract its players entered under.
  -- Inserts are always pre-start.
  IF TG_OP = 'UPDATE'
     AND upper(COALESCE(NEW.status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN NEW;
  END IF;

  v_stack := COALESCE(NULLIF(NEW.starting_chips, 0), 10000);

  /* EVERY FREEROLL REBUY AND ADD-ON HAS ONE PRICE (Dan 2026-10-16): "ALL REBUY
     ADD ON'S FOR MIDWAY UNION ARE 1 CHIP REBUY ADD ON NOT 2, DIAMOND REBUYS
     ARE 100 DIAMONDS (ONE DOLLAR)". 1 in a chip club, 100 in a Diamond club.
     The 2026-09-04 exception that let a scheduled Free Buy charge 2 is gone. */
  v_price := CASE
    WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = NEW.club_id AND c.asset = 'diamonds')
      THEN 100.00
    ELSE 1.00
  END;

  IF NEW.buy_in_fee IS DISTINCT FROM 0 THEN
    v_changed := v_changed || jsonb_build_object('buy_in_fee',
      jsonb_build_object('from', NEW.buy_in_fee, 'to', 0));
    NEW.buy_in_fee := 0;
  END IF;

  IF NOT COALESCE(NEW.is_rebuy, false) THEN
    v_changed := v_changed || jsonb_build_object('is_rebuy',
      jsonb_build_object('from', NEW.is_rebuy, 'to', true));
    NEW.is_rebuy := true;
  END IF;

  IF NOT COALESCE(NEW.add_on_available, false) THEN
    v_changed := v_changed || jsonb_build_object('add_on_available',
      jsonb_build_object('from', NEW.add_on_available, 'to', true));
    NEW.add_on_available := true;
  END IF;

  IF NEW.rebuy_cost IS DISTINCT FROM v_price THEN
    v_changed := v_changed || jsonb_build_object('rebuy_cost',
      jsonb_build_object('from', NEW.rebuy_cost, 'to', v_price));
    NEW.rebuy_cost := v_price;
  END IF;

  IF NEW.addon_cost IS DISTINCT FROM v_price THEN
    v_changed := v_changed || jsonb_build_object('addon_cost',
      jsonb_build_object('from', NEW.addon_cost, 'to', v_price));
    NEW.addon_cost := v_price;
  END IF;

  IF COALESCE(NEW.rebuy_chips, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_chips',
      jsonb_build_object('from', NEW.rebuy_chips, 'to', v_stack));
    NEW.rebuy_chips := v_stack;
  END IF;

  IF COALESCE(NEW.addon_chips, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_chips',
      jsonb_build_object('from', NEW.addon_chips, 'to', v_stack));
    NEW.addon_chips := v_stack;
  END IF;

  IF COALESCE(NEW.rebuy_levels, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_levels',
      jsonb_build_object('from', NEW.rebuy_levels, 'to', 4));
    NEW.rebuy_levels := 4;
  END IF;

  IF COALESCE(NEW.addon_levels, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_levels',
      jsonb_build_object('from', NEW.addon_levels, 'to', 1));
    NEW.addon_levels := 1;
  END IF;

  IF NEW.max_rebuys IS NOT NULL AND NEW.max_rebuys <= 0 THEN
    v_changed := v_changed || jsonb_build_object('max_rebuys',
      jsonb_build_object('from', NEW.max_rebuys, 'to', NULL));
    NEW.max_rebuys := NULL;
  END IF;

  IF v_changed <> '{}'::jsonb THEN
    v_op := CASE
      WHEN COALESCE(current_setting('app.freeroll_free_buy_backfill', true), '') = 'on'
        THEN 'BACKFILL'
      ELSE TG_OP
    END;
    BEGIN
      INSERT INTO public.ca_freeroll_free_buy_log
        (tournament_id, tournament_name, op, status, changed)
      VALUES
        (NEW.id, NEW.name, v_op, NEW.status, v_changed);
    EXCEPTION WHEN OTHERS THEN
      -- The log is evidence, not a gate. Never let it block the row.
      RAISE WARNING 'fn_freerolls_are_free_buy: could not log % for %: %',
        v_op, NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;

-- 2. The Diamond creation door: a freeroll rebuy and add-on are 100 Diamonds.
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure);
  v_new text;
  FUNCTION_MD5 constant text := '2adb63251df0fc580803e30c07130935';
BEGIN
  IF md5(v_def) <> FUNCTION_MD5 THEN
    RAISE EXCEPTION 'fn_poker_diamond_create_tournament_core changed since this migration was written (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, 'v_rebuy_num <> 1)', ''))) / length('v_rebuy_num <> 1)') <> 1
     OR (length(v_def) - length(replace(v_def, 'v_addon_num <> 1)', ''))) / length('v_addon_num <> 1)') <> 1
     OR (length(v_def) - length(replace(v_def, 'v_rebuy_cost := 1; v_addon_cost := 1;', ''))) / length('v_rebuy_cost := 1; v_addon_cost := 1;') <> 1
     OR (length(v_def) - length(replace(v_def, '''one_diamond_to_the_prize_pool''', ''))) / length('''one_diamond_to_the_prize_pool''') <> 2
     OR (length(v_def) - length(replace(v_def, 'diamond_freeroll_rebuy_and_addon_cost_one_diamond', ''))) / length('diamond_freeroll_rebuy_and_addon_cost_one_diamond') <> 1 THEN
    RAISE EXCEPTION 'fn_poker_diamond_create_tournament_core: a freeroll price token is not where this migration expects it';
  END IF;
  v_new := v_def;
  v_new := replace(v_new, 'v_rebuy_num <> 1)', 'v_rebuy_num <> 100)');
  v_new := replace(v_new, 'v_addon_num <> 1)', 'v_addon_num <> 100)');
  v_new := replace(v_new, 'v_rebuy_cost := 1; v_addon_cost := 1;', 'v_rebuy_cost := 100; v_addon_cost := 100;');
  v_new := replace(v_new, '''one_diamond_to_the_prize_pool''', '''one_hundred_diamonds_to_the_prize_pool''');
  v_new := replace(v_new, 'diamond_freeroll_rebuy_and_addon_cost_one_diamond', 'diamond_freeroll_rebuy_and_addon_cost_one_hundred_diamonds');
  EXECUTE v_new;
END $do$;

-- 3. The recorded answer the door reads (newest row wins). The choice list
--    learns the new option first; every other option is unchanged.
ALTER TABLE public.ca_diamond_economics
  DROP CONSTRAINT ca_diamond_economics_choice_is_an_option;
ALTER TABLE public.ca_diamond_economics
  ADD CONSTRAINT ca_diamond_economics_choice_is_an_option CHECK (((units <> 'choice'::text) OR
CASE name
    WHEN 'guarantee_covers'::text THEN (value_text = ANY (ARRAY['prize_pool_only'::text, 'prize_pool_and_bounties'::text]))
    WHEN 'guarantee_funding_moment'::text THEN (value_text = ANY (ARRAY['set_aside_at_creation'::text, 'checked_at_creation_paid_at_close'::text]))
    WHEN 'freeroll_rebuy_cost'::text THEN (value_text = ANY (ARRAY['none_offered'::text, 'one_diamond_to_the_prize_pool'::text, 'one_hundred_diamonds_to_the_prize_pool'::text]))
    WHEN 'freeroll_addon_cost'::text THEN (value_text = ANY (ARRAY['none_offered'::text, 'one_diamond_to_the_prize_pool'::text, 'one_hundred_diamonds_to_the_prize_pool'::text]))
    WHEN 'promo_entry_refund_destination'::text THEN (value_text = ANY (ARRAY['funding_account'::text, 'unused_promotional_entry'::text, 'player_wallet'::text]))
    WHEN 'horse_entry_funding'::text THEN (value_text = ANY (ARRAY['own_balance'::text, 'funding_account'::text]))
    WHEN 'cash_rake_rounding'::text THEN (value_text = ANY (ARRAY['down'::text, 'nearest'::text, 'up'::text]))
    ELSE false
END));

-- 3b. The recorded answer itself.
INSERT INTO public.ca_diamond_economics
  (name, scope, units, value, value_text, approved_on, recorded_by, approved_quote, basis)
VALUES
  ('freeroll_rebuy_cost', 'all', 'choice', NULL, 'one_hundred_diamonds_to_the_prize_pool', '2026-10-16',
   'claude-code:the-board-is-a-fixed-schedule',
   'ALL REBUY ADD ON''S FOR MIDWAY UNION ARE 1 CHIP REBUY ADD ON NOT 2, DIAMOND REBUYS ARE 100 DIAMONDS (ONE DOLLAR)',
   'Dan 2026-10-16. A Diamond freeroll rebuy is 100 Diamonds (one dollar), wholly to the prize pool. Supersedes the 2026-10-06 answer one_diamond_to_the_prize_pool.'),
  ('freeroll_addon_cost', 'all', 'choice', NULL, 'one_hundred_diamonds_to_the_prize_pool', '2026-10-16',
   'claude-code:the-board-is-a-fixed-schedule',
   'ALL REBUY ADD ON''S FOR MIDWAY UNION ARE 1 CHIP REBUY ADD ON NOT 2, DIAMOND REBUYS ARE 100 DIAMONDS (ONE DOLLAR)',
   'Dan 2026-10-16. A Diamond freeroll add-on is 100 Diamonds (one dollar), wholly to the prize pool. Supersedes the 2026-10-06 answer one_diamond_to_the_prize_pool.');

-- 4. Every freeroll nobody has entered yet takes the rule, through the trigger.
--    An event with a registered entrant keeps the contract it was entered
--    under: fn_guard_managed_game_lifecycle refuses any change to its rebuy or
--    add-on price, by design, and this migration does not go around it.
UPDATE public.tournaments t
   SET rebuy_cost = t.rebuy_cost
 WHERE upper(COALESCE(t.status, '')) IN ('ANNOUNCED', 'REGISTERING')
   AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id)
   AND public.fn_is_free_buy_event(t.buy_in_amount, t.buy_in_fee, t.tournament_type, t.variant)
   AND (t.rebuy_cost IS DISTINCT FROM (CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = t.club_id AND c.asset = 'diamonds') THEN 100.00 ELSE 1.00 END)
     OR t.addon_cost IS DISTINCT FROM (CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = t.club_id AND c.asset = 'diamonds') THEN 100.00 ELSE 1.00 END));

DO $do$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM public.tournaments t
   WHERE upper(COALESCE(t.status, '')) IN ('ANNOUNCED', 'REGISTERING')
     AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id)
     AND public.fn_is_free_buy_event(t.buy_in_amount, t.buy_in_fee, t.tournament_type, t.variant)
     AND (t.rebuy_cost IS DISTINCT FROM (CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = t.club_id AND c.asset = 'diamonds') THEN 100.00 ELSE 1.00 END)
       OR t.addon_cost IS DISTINCT FROM (CASE WHEN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = t.club_id AND c.asset = 'diamonds') THEN 100.00 ELSE 1.00 END));
  IF n <> 0 THEN
    RAISE EXCEPTION 'freeroll prices: % pre-start freeroll(s) still off the rule', n;
  END IF;
END $do$;

COMMIT;
