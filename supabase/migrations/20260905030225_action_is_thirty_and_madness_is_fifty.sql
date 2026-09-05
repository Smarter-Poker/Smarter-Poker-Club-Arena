-- ACTION IS THIRTY AND MADNESS IS FIFTY (Dan, 2026-09-05)
--
-- Dan: "MAYBE WE CHANGE THE VPIP TO 30% FOR ACTION AND 50% FOR MADNESS."
--
-- WHY, measured. fn_cash_template_defaults set the floor per template AND per
-- family - action 30/40/35 and madness 60/70/65 for holdem/plo/other - and the
-- madness tier was set above anything a player of any kind reaches. The horse
-- fleet is the evidence, because it is nearly the whole player pool:
--
--   floor   hands   horse VPIP   margin      (ca_hand_facts, horses only, from
--      30   3,383        46.7     +16.7       2026-09-04 22:00 UTC - the hours
--      35     323        57.9     +22.9       after the VPIP floor layer
--      40   7,570        47.2      +7.2       deployed in #3034)
--      60   1,460        41.7     -18.3
--      65     312        51.0     -14.0
--      70   2,251        37.8     -32.2
--
-- Every floor at or below 40 is cleared with room. Every floor at or above 60
-- is missed, and missing it means the seat is stood up at hand eleven. That is
-- not a horse defect: HorseLogic.vpipFloorMul clamps its widening at
-- FLOOR_MUL = 0.35 of normal tightness, and a bar at a third of its height
-- still tops out near 50% VPIP. A 70% floor cannot be met by any strategy that
-- is still playing poker, so a Madness table was a room that emptied itself
-- every ten hands and reseeded - churn that reads to a watching player as a
-- game nobody stays in.
--
-- WHAT CHANGES. Two numbers, flat across families:
--
--   action  -> 30   (was 30 holdem / 40 plo / 35 other)
--   madness -> 50   (was 60 holdem / 70 plo / 65 other)
--
-- Flat is deliberate. The per-family spread made PLO the hardest floor to
-- clear when PLO is the loosest game there is - more players see more flops -
-- so it had the tiering backwards. 50 is just above the fleet's observed
-- ceiling at the old floors (51.0 at 65, 41.7 at 60) by a small enough margin
-- that
-- vpipFloorMul's closed loop reaches it: the prior multiplier at target 0.60
-- is 0.28/0.60 = 0.467, well clear of the 0.35 clamp, so the layer still has
-- room to widen rather than sitting pinned at its limit the way it does at 70.
--
-- Classic stays 0. The window stays ten hands.
--
-- The 163 live tables carrying the old numbers are migrated in the same
-- transaction, because a table created yesterday enforcing 70 is the same
-- broken room whatever the template function now says.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_cash_template_defaults(p_template text, p_variant text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t text := lower(coalesce(p_template, 'classic'));
  v_v text := lower(coalesce(p_variant, 'nlh'));
  v_family text;
  v_seats integer; v_seats_locked boolean; v_seat_choices integer[];
  v_vpip integer; v_vpip_window integer;
BEGIN
  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;

  v_family := CASE
    WHEN v_v IN ('plo4','plo5','plo6','plo8','flo8') THEN 'plo'
    WHEN v_v = 'short_deck' THEN 'shortdeck'
    WHEN v_v = 'pineapple' THEN 'pineapple'
    ELSE 'holdem' END;

  -- seats
  IF v_family = 'plo' THEN
    v_seats := 6; v_seats_locked := true; v_seat_choices := ARRAY[6];
  ELSIF v_family = 'holdem' THEN
    IF v_t = 'classic' THEN v_seats := 9; v_seat_choices := ARRAY[9, 6];
    ELSE v_seats := 6; v_seat_choices := ARRAY[2,3,4,5,6,7,8,9]; END IF;
    v_seats_locked := false;
  ELSE
    v_seats := 6; v_seats_locked := false; v_seat_choices := ARRAY[2,3,4,5,6,7,8];
  END IF;

  -- VPIP floor per template (percent), FLAT ACROSS FAMILIES (Dan 2026-09-05).
  -- The window is TEN hands for every template (Dan 2026-09-04: "AFTER 10
  -- HANDS, OR ANYTIME AFTER THE 10 HANDS, THEY GET BOOTED").
  v_vpip := CASE v_t
    WHEN 'classic' THEN 0
    WHEN 'action'  THEN 30
    ELSE                50 END;
  v_vpip_window := 10;

  RETURN jsonb_build_object(
    'template', v_t,
    'variant', v_v,
    'family', v_family,
    'seats', v_seats,
    'seats_locked', v_seats_locked,
    'seat_choices', to_jsonb(v_seat_choices),
    'min_buyin_bb', CASE v_t WHEN 'classic' THEN 40 WHEN 'action' THEN 50 ELSE 100 END,
    'max_buyin_bb', 200,
    'regular_ante', CASE v_t WHEN 'classic' THEN 'none' WHEN 'action' THEN 'sb' ELSE 'bb' END,
    'vpip_floor', v_vpip,
    'vpip_window', v_vpip_window,
    'bombs', jsonb_build_object(
      'enabled', v_t <> 'classic',
      'trigger', CASE v_t WHEN 'action' THEN 'timed_15m' WHEN 'madness' THEN 'every_orbit' ELSE NULL END,
      'ante_bb', CASE v_t WHEN 'action' THEN 2 WHEN 'madness' THEN 3 ELSE NULL END,
      'boards', CASE WHEN v_t = 'classic' THEN NULL ELSE 2 END),
    'straddle', false,
    'stay_clock_min', 10,
    'rejoin_window_min', 120,
    'run_it_n_times', 'opt_in',
    'rake', 'existing'
  );
END;
$function$;

-- Assert the new numbers before touching a single live table. If the function
-- above did not take, this aborts and nothing moves.
DO $assert$
BEGIN
  IF (public.fn_cash_template_defaults('action','nlh')->>'vpip_floor')::int <> 30
     OR (public.fn_cash_template_defaults('action','plo5')->>'vpip_floor')::int <> 30
     OR (public.fn_cash_template_defaults('madness','nlh')->>'vpip_floor')::int <> 50
     OR (public.fn_cash_template_defaults('madness','plo5')->>'vpip_floor')::int <> 50
     OR (public.fn_cash_template_defaults('madness','short_deck')->>'vpip_floor')::int <> 50
     OR (public.fn_cash_template_defaults('classic','nlh')->>'vpip_floor')::int <> 0
  THEN
    RAISE EXCEPTION 'template defaults did not take the new floors';
  END IF;
END
$assert$;

-- The live tables. Action family-spread (30/35/40) collapses to 30; Madness
-- (60/65/70) to 50. Anything already at 30 is left alone rather than rewritten,
-- so the row count below is the number actually changed.
DO $migrate$
DECLARE
  v_action integer;
  v_madness integer;
BEGIN
  UPDATE public.tables
     SET maintain_percent_min = 30
   WHERE coalesce(nit_game, false)
     AND maintain_percent_min IN (35, 40);
  GET DIAGNOSTICS v_action = ROW_COUNT;

  UPDATE public.tables
     SET maintain_percent_min = 50
   WHERE coalesce(nit_game, false)
     AND maintain_percent_min IN (60, 65, 70);
  GET DIAGNOSTICS v_madness = ROW_COUNT;

  RAISE NOTICE 'retiered % action tables to 30 and % madness tables to 50', v_action, v_madness;

  IF EXISTS (
    SELECT 1 FROM public.tables
     WHERE coalesce(nit_game, false)
       AND maintain_percent_min IS NOT NULL
       AND maintain_percent_min NOT IN (0, 30, 50)
  ) THEN
    RAISE EXCEPTION 'a nit table still carries a floor that is neither 30 nor 50';
  END IF;
END
$migrate$;

COMMIT;
