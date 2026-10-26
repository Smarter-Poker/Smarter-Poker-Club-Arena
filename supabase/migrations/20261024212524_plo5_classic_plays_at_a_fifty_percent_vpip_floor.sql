-- SUPERSEDED BY 20261024213131
-- Never installed. 20261024213131 (applied as 20261024213348) made the same PLO5
-- Classic floor change and PLO6 with it, against the same pre-image; that
-- pre-image is gone, and on a rebuild in version order this file would change
-- the body 213131's guard and anchors read. It must never run.
-- 20261024212524_plo5_classic_plays_at_a_fifty_percent_vpip_floor.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: (public.fn_cash_template_defaults('classic','plo5')->>'vpip_floor')='50' AND NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE g.template_name='classic' AND g.variant='plo5' AND g.closed_at IS NULL AND coalesce(g.ruleset_snapshot->>'vpip_floor','')<>'50') AND NOT EXISTS (SELECT 1 FROM public.cash_games g JOIN public.tables t ON t.cluster_id=g.id AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false) WHERE g.template_name='classic' AND g.variant='plo5' AND g.enabled AND g.closed_at IS NULL AND NOT (t.nit_game AND t.maintain_percent_min=50 AND t.maintain_hands=10))
--
-- OWNER (Dan, 2026-10-24): "just make the plo5 classic to 50% vpip and stop.
-- thats it. then relaunch the game." Scope: every PLO5 Classic game.
--
-- SUPERSEDED BEFORE IT WAS INSTALLED, SO IT ONLY VERIFIES.
--
-- This file first merged (#7938) carrying its own change to
-- fn_cash_template_defaults. Before it could be installed, a later owner
-- instruction ("MAKE THIS ADJUSTMENT NOW TO ALL PLO5 AND PLO6 CLASSIC GAMES.
-- 50% VPIP AND BB ANTE FOR ALL STAKES.") was installed as
-- 20261024213131_plo5_plo6_classic_fifty_vpip_bb_ante.sql (#7942). That
-- migration already sets the Classic PLO5 floor to 50, re-stamps every PLO5
-- Classic game and projects the floor onto the live tables, and it also adds
-- the BB ante. The original body of this file would have replaced the
-- template with one that has no ante for PLO5 Classic, undoing the later
-- instruction, so it is gone. Its md5 guard would have refused it anyway.
--
-- What remains is the owner's request stated as a proof: every PLO5 Classic
-- game plays at a 50% floor over 10 hands, and every open table of an enabled
-- one enforces it. It reads, writes nothing, and aborts if the proof fails.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $verify$
DECLARE
  v_bad integer;
BEGIN
  IF (public.fn_cash_template_defaults('classic','plo5')->>'vpip_floor') <> '50'
     OR (public.fn_cash_template_defaults('classic','plo5')->>'vpip_window') <> '10' THEN
    RAISE EXCEPTION 'the Classic PLO5 template does not promise a 50%% floor over 10 hands';
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.cash_games g
   WHERE g.template_name = 'classic' AND g.variant = 'plo5' AND g.closed_at IS NULL
     AND coalesce(g.ruleset_snapshot->>'vpip_floor', '') <> '50';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% Classic PLO5 game(s) have a floor other than 50', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.cash_games g
    JOIN public.tables t ON t.cluster_id = g.id
                        AND t.lifecycle <> 'closed'
                        AND NOT coalesce(t.is_deleted, false)
   WHERE g.template_name = 'classic' AND g.variant = 'plo5'
     AND g.enabled AND g.closed_at IS NULL
     AND NOT (t.nit_game AND t.maintain_percent_min = 50 AND t.maintain_hands = 10);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% live Classic PLO5 table(s) do not enforce the 50%% floor', v_bad;
  END IF;
END $verify$;

COMMIT;
