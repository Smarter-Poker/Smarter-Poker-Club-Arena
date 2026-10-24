-- 20261024212524_plo5_classic_plays_at_a_fifty_percent_vpip_floor.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE g.template_name='classic' AND g.variant='plo5' AND g.closed_at IS NULL AND coalesce(g.ruleset_snapshot->>'vpip_floor','')<>'50') AND NOT EXISTS (SELECT 1 FROM public.cash_games g JOIN public.tables t ON t.cluster_id=g.id AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false) WHERE g.template_name='classic' AND g.variant='plo5' AND g.enabled AND g.closed_at IS NULL AND NOT (t.nit_game AND t.maintain_percent_min=50 AND t.maintain_hands=10)) AND (public.fn_cash_template_defaults('classic','plo5')->>'vpip_floor')='50' AND (public.fn_cash_template_defaults('classic','plo')->>'vpip_floor')='0'
--
-- OWNER (Dan, 2026-10-24): "just make the plo5 classic to 50% vpip and stop.
-- thats it. then relaunch the game." Asked which games: "Every PLO5 Classic
-- game".
--
-- WHY A MIGRATION: the VPIP floor is the template's promise, not a per-game
-- setting. fn_cash_template_defaults decides it, fn_cash_game_create refuses
-- any override that differs from it (OVERRIDE_LOCKED), and the
-- zz_cash_game_floor_from_template trigger rewrites every snapshot from it on
-- every write. Changing one game's snapshot by hand would be undone by the
-- next write, so the template itself is what changes.
--
-- WHAT THIS DOES:
--   1. fn_cash_template_defaults: Classic PLO5 now returns vpip_floor 50 (the
--      window stays 10 hands). Every other template and variant returns
--      exactly what it did before - Classic NLH, PLO, PLO6, PLO8, Short Deck,
--      Pineapple stay at 0, Madness stays at 40. The body is otherwise
--      byte-identical to the live definition (md5 guarded below).
--   2. Re-stamps every non-closed Classic PLO5 game (18 today: 7 enabled,
--      11 dormant) by touching ruleset_snapshot, so the floor trigger writes
--      the new template floor into each snapshot. The one game on the
--      'madness_without_lightning' profile (050f0735) already plays at 50 and
--      is unchanged by the trigger.
--   3. Relaunch: fn_cash_apply_ruleset projects each ENABLED game's snapshot
--      onto its open tables (nit_game, maintain_percent_min=50,
--      maintain_hands=10). The engine re-reads these between hands, so the
--      floor applies from the next hand and nobody is unseated. New tables
--      opened by the cluster read the snapshot, so they open at 50 too.
--      Dormant games are not projected: they get the floor when re-enabled.
--   4. Asserts all of the above and aborts if any of it did not hold.
--
-- Horses are held to the floor exactly like everyone else (CLAUDE.md 10.5);
-- a 50% floor is reachable by HorseLogic
-- (tests/a-vpip-floor-must-be-reachable.law.test.ts).
--
-- No wallet, seat, hand or payout writes. Row updates only on cash_games and
-- tables; no relation-level locks beyond ROW EXCLUSIVE.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cash_template_defaults(text,text)'::regprocedure))
     <> 'dff0793b509ab2a0ad3ce7214b4e8fef' THEN
    RAISE EXCEPTION 'fn_cash_template_defaults changed since this migration was written; requalify';
  END IF;
  IF md5(pg_get_functiondef('public.fn_cash_game_floor_from_template()'::regprocedure))
     <> '3e958bf044bb7caeabc40e4ef82873b4' THEN
    RAISE EXCEPTION 'fn_cash_game_floor_from_template changed since this migration was written; requalify';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_cash_template_defaults(p_template text, p_variant text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t text:=lower(coalesce(p_template,'classic')); v text:=lower(coalesce(p_variant,'nlh')); family text; seats int;
BEGIN
 IF t IN ('action','madness','lightning') THEN t:='madness'; END IF;
 IF t NOT IN ('classic','madness') THEN RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %',p_template; END IF;
 IF t='madness' AND v IN ('pineapple','pineapple_holdem') THEN
  RAISE EXCEPTION 'LIGHTNING_VARIANT_NOT_SUPPORTED: Pineapple Uses Classic Games';
 END IF;
 family:=CASE WHEN v IN ('plo4','plo5','plo6','plo8','flo8') THEN 'plo' WHEN v='short_deck' THEN 'shortdeck' WHEN v='pineapple' THEN 'pineapple' ELSE 'holdem' END;
 seats:=CASE WHEN t='classic' AND family='holdem' THEN 9 ELSE 6 END;
 RETURN jsonb_build_object('template',t,'variant',v,'family',family,'seats',seats,
  'seats_locked',t='madness' OR family='plo',
  'seat_choices',CASE WHEN t='madness' OR family='plo' THEN '[6]'::jsonb WHEN family='holdem' THEN '[9,6]'::jsonb ELSE '[2,3,4,5,6,7,8]'::jsonb END,
  'min_buyin_bb',CASE WHEN t='classic' THEN 40 ELSE 100 END,'max_buyin_bb',200,
  'regular_ante',CASE WHEN t='classic' THEN 'none' ELSE 'bb' END,
  'vpip_floor',CASE WHEN t='classic' AND v='plo5' THEN 50 WHEN t='classic' THEN 0 ELSE 40 END,'vpip_window',10,
  'bombs',jsonb_build_object('enabled',t<>'classic','trigger',CASE WHEN t='classic' THEN NULL ELSE 'timed_10m' END,'ante_bb',CASE WHEN t='classic' THEN NULL ELSE 3 END,'boards',CASE WHEN t='classic' THEN NULL ELSE 2 END),
  'straddle',false,'stay_clock_min',10,'rejoin_window_min',120,'run_it_n_times','opt_in','rake','existing');
END $function$;

DO $relaunch$
DECLARE
  v_stamped integer;
  v_game record;
  v_projected integer := 0;
  v_bad integer;
BEGIN
  -- Every other template keeps its floor.
  IF (public.fn_cash_template_defaults('classic','plo5')->>'vpip_floor') <> '50'
     OR (public.fn_cash_template_defaults('classic','plo5')->>'vpip_window') <> '10'
     OR (public.fn_cash_template_defaults('classic','plo')->>'vpip_floor') <> '0'
     OR (public.fn_cash_template_defaults('classic','plo6')->>'vpip_floor') <> '0'
     OR (public.fn_cash_template_defaults('classic','nlh')->>'vpip_floor') <> '0'
     OR (public.fn_cash_template_defaults('madness','plo5')->>'vpip_floor') <> '40' THEN
    RAISE EXCEPTION 'template floors are not what this migration promises';
  END IF;

  -- Re-stamp: the floor trigger writes the template floor into each snapshot.
  UPDATE public.cash_games g
     SET ruleset_snapshot = g.ruleset_snapshot
   WHERE g.template_name = 'classic'
     AND g.variant = 'plo5'
     AND g.closed_at IS NULL
     AND g.ruleset_snapshot IS NOT NULL;
  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  IF v_stamped < 1 THEN
    RAISE EXCEPTION 'no Classic PLO5 game was re-stamped';
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.cash_games g
   WHERE g.template_name = 'classic' AND g.variant = 'plo5' AND g.closed_at IS NULL
     AND coalesce(g.ruleset_snapshot->>'vpip_floor', '') <> '50';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% Classic PLO5 game(s) still have a floor other than 50', v_bad;
  END IF;

  -- Relaunch the live games: project the new floor onto their open tables.
  FOR v_game IN
    SELECT g.id FROM public.cash_games g
     WHERE g.template_name = 'classic' AND g.variant = 'plo5'
       AND g.enabled AND g.closed_at IS NULL
     ORDER BY g.id
  LOOP
    v_projected := v_projected + coalesce(public.fn_cash_apply_ruleset(v_game.id), 0);
  END LOOP;

  SELECT count(*) INTO v_bad
    FROM public.cash_games g
    JOIN public.tables t ON t.cluster_id = g.id
                        AND t.lifecycle <> 'closed'
                        AND NOT coalesce(t.is_deleted, false)
   WHERE g.template_name = 'classic' AND g.variant = 'plo5'
     AND g.enabled AND g.closed_at IS NULL
     AND NOT (t.nit_game AND t.maintain_percent_min = 50 AND t.maintain_hands = 10);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% live Classic PLO5 table(s) did not take the 50%% floor', v_bad;
  END IF;

  RAISE NOTICE 'Classic PLO5 at 50%% VPIP: % game(s) re-stamped, % table(s) relaunched', v_stamped, v_projected;
END $relaunch$;

COMMIT;
