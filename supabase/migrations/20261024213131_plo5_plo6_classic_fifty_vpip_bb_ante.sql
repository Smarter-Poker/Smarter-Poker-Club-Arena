-- 20261024213131_plo5_plo6_classic_fifty_vpip_bb_ante.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: (public.fn_cash_template_defaults('classic','plo5')->>'vpip_floor')='50' AND (public.fn_cash_template_defaults('classic','plo6')->>'regular_ante')='bb' AND (public.fn_cash_template_defaults('classic','plo4')->>'vpip_floor')='0' AND NOT EXISTS (SELECT 1 FROM public.cash_games g JOIN public.tables t ON t.cluster_id=g.id AND t.lifecycle<>'closed' WHERE g.template_name='classic' AND g.variant IN ('plo5','plo6') AND g.closed_at IS NULL AND (t.maintain_percent_min IS DISTINCT FROM 50 OR NOT t.nit_game OR NOT t.big_blind_ante_enabled))
--
-- OWNER (Dan, 2026-10-24): "MAKE ALL PLO5 1/2 GAMES THAT ARE 'CLASSIC' 50% VPIP
-- WITH BB ANTE. THOSE AREN'T LIGHTNING GAMES, THEY ARE FEEDER GAMES. MAKE THIS
-- ADJUSTMENT NOW TO ALL PLO5 AND PLO6 CLASSIC GAMES. 50% VPIP AND BB ANTE FOR
-- ALL STAKES."
--
-- WHAT THIS DOES:
--   1. The Classic template's promise for PLO5 and PLO6 becomes a big blind
--      ante and a 50% VPIP floor (10-hand window), every stake, every club.
--      No bomb pots: the owner named the ante and the floor only. Every other
--      variant's Classic promise (no ante, no floor) is unchanged, and
--      Lightning Games are untouched. fn_cash_template_defaults is the one
--      source the creator, the ensure path and the floor trigger all read, so
--      new games and every later write agree.
--   2. Every open PLO5/PLO6 Classic game's snapshot is rewritten through the
--      floor trigger and projected to its tables by fn_cash_apply_ruleset.
--   3. A FLOOR TURNED ON MID-SITTING JUDGES ONLY WHAT FOLLOWS IT. fn_nit_check
--      judges the cumulative VPIP of a sitting since the roster join. A player
--      seated under a 0% floor has a sitting VPIP near 28%, so turning the
--      floor on would stand up and two-hour-bar every seat at the next check,
--      humans and horses alike, for hands played under the old rule. The game
--      snapshot now carries vpip_floor_since, and the maintain window starts
--      at the later of the roster join and that instant: everyone gets the
--      same fresh ten hands under the new rule. Same rule for every player.
--
-- No wallet, seat, hand or payout writes. Row-level writes only.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $defaults$
DECLARE s text; n text;
BEGIN
  s := pg_get_functiondef('public.fn_cash_template_defaults(text,text)'::regprocedure);
  IF md5(s) <> 'dff0793b509ab2a0ad3ce7214b4e8fef' THEN
    RAISE EXCEPTION 'fn_cash_template_defaults changed since this migration was written; requalify';
  END IF;
  n := replace(s,
    $a$'regular_ante',CASE WHEN t='classic' THEN 'none' ELSE 'bb' END,$a$,
    $b$'regular_ante',CASE WHEN t='classic' AND v NOT IN ('plo5','plo6') THEN 'none' ELSE 'bb' END,$b$);
  n := replace(n,
    $a$'vpip_floor',CASE WHEN t='classic' THEN 0 ELSE 40 END,$a$,
    $b$'vpip_floor',CASE WHEN t='classic' AND v IN ('plo5','plo6') THEN 50 WHEN t='classic' THEN 0 ELSE 40 END,$b$);
  IF n = s OR n NOT LIKE $p$%v NOT IN ('plo5','plo6') THEN 'none'%$p$
     OR n NOT LIKE $p$%v IN ('plo5','plo6') THEN 50%$p$ THEN
    RAISE EXCEPTION 'fn_cash_template_defaults anchors changed';
  END IF;
  EXECUTE n;
END $defaults$;

DO $nit$
DECLARE s text; n text;
BEGIN
  s := pg_get_functiondef('public.fn_nit_check(uuid,uuid,timestamptz)'::regprocedure);
  IF md5(s) <> '7254da1baec76082f8de928199f58c48' THEN
    RAISE EXCEPTION 'fn_nit_check changed since this migration was written; requalify';
  END IF;
  n := replace(s,
    $a$      IF NOT FOUND THEN v_since := p_since; END IF;$a$,
    $b$      IF NOT FOUND THEN v_since := p_since; END IF;
      -- A FLOOR TURNED ON MID-SITTING JUDGES ONLY WHAT FOLLOWS IT (2026-10-24).
      v_since := GREATEST(v_since, (SELECT (g.ruleset_snapshot->>'vpip_floor_since')::timestamptz
                                      FROM public.cash_games g WHERE g.id = v_game));$b$);
  IF n = s OR n NOT LIKE '%vpip_floor_since%' THEN
    RAISE EXCEPTION 'fn_nit_check anchor changed';
  END IF;
  EXECUTE n;
END $nit$;

DO $apply$
DECLARE r record; v_n integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.cash_games
     WHERE template_name = 'classic' AND variant IN ('plo5', 'plo6') AND closed_at IS NULL
     ORDER BY id
  LOOP
    -- The floor trigger rewrites the four promised fields from the template.
    UPDATE public.cash_games
       SET ruleset_snapshot = ruleset_snapshot
             || jsonb_build_object('vpip_floor_since', to_jsonb(clock_timestamp())),
           updated_at = now()
     WHERE id = r.id;
    PERFORM public.fn_cash_apply_ruleset(r.id);
    v_n := v_n + 1;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.cash_games g
     WHERE g.template_name = 'classic' AND g.variant IN ('plo5', 'plo6') AND g.closed_at IS NULL
       AND ((g.ruleset_snapshot->>'vpip_floor') IS DISTINCT FROM '50'
         OR (g.ruleset_snapshot->>'regular_ante') IS DISTINCT FROM 'bb')) THEN
    RAISE EXCEPTION 'a PLO5/PLO6 Classic snapshot did not take 50%% and the BB ante';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cash_games g JOIN public.tables t ON t.cluster_id = g.id
     WHERE g.template_name = 'classic' AND g.variant IN ('plo5', 'plo6') AND g.closed_at IS NULL
       AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false
       AND (t.maintain_percent_min IS DISTINCT FROM 50 OR NOT t.nit_game
         OR NOT t.big_blind_ante_enabled OR t.ante IS DISTINCT FROM g.bb)) THEN
    RAISE EXCEPTION 'a PLO5/PLO6 Classic table did not project 50%% and the BB ante';
  END IF;
  -- Nothing else moved: PLO4 Classic and Lightning keep their promise.
  IF (public.fn_cash_template_defaults('classic', 'plo4')->>'vpip_floor') <> '0'
     OR (public.fn_cash_template_defaults('classic', 'nlh')->>'regular_ante') <> 'none'
     OR (public.fn_cash_template_defaults('madness', 'plo5')->>'vpip_floor') <> '40' THEN
    RAISE EXCEPTION 'the template change reached a game it was not meant for';
  END IF;
  RAISE NOTICE 'PLO5/PLO6 Classic games updated: %', v_n;
END $apply$;

COMMIT;
