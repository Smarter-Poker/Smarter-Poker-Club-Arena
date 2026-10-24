-- @live-proof: (SELECT position('LIGHTNING_CONVERSION_SEAT' IN pg_get_functiondef('public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure))>0 AND position('LIGHTNING_CONVERSION_SEAT' IN pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure))>0 AND position('LIGHTNING_CONVERSION_SEAT' IN pg_get_functiondef('public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)'::regprocedure))>0)
-- 20261024213844_lightning_conversion_seats_are_not_newcomers_and_a_newcomer_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261024195059 made Dan's rule hard ("NEW PLAYERS SHOULD ALWAYS BE BB
-- FIRST"): a newcomer - a pool slot that has never been the big blind - who
-- is not one of a pass's big blinds is held. Pool slots belong to a Cluster
-- epoch, so the moment a game converts to Lightning (or its epoch advances)
-- EVERY slot has last_bb_at NULL and every player at the tables counted as a
-- newcomer. Two consequences, both read off the live definitions:
--
--   1. For the first minutes after a conversion the hold bites on players who
--      were already seated: a pass of four regulars and three conversion
--      seats keeps two of the three back and deals a five-handed hand after
--      the three-second wait, or nothing, where it would have dealt six.
--   2. A player who BUYS IN shortly after the conversion is behind every
--      conversion seat that has not been the big blind yet: they all share
--      last_bb_at NULL and fn_lightning_blind_order breaks that tie by debt
--      age (the slot's opening), which is older for every conversion seat.
--      The real newcomer is held pass after pass until twenty-odd conversion
--      seats have each had their big blind - minutes, not a hand.
--
-- THE FIX, at the lines that decide it (CLAUDE.md 10.11/10.12):
--
--   - A CONVERSION SEAT is a pool slot whose pool session the conversion
--     itself entered: its cash session opened BEFORE the epoch began (the
--     player was at the tables already), and the session and the slot entered
--     with the conversion (within five seconds of the epoch's start - the
--     conversion transaction measured at 2 ms to 0.84 s on production; a
--     buy-in inside that window still has a cash session opened after the
--     epoch began, so it is not exempt). Read from production for the last
--     twenty days of conversions: every seat the conversion entered has its
--     cash session opened before the epoch; no later entry does.
--   - A NEWCOMER is now `last_bb_at IS NULL AND NOT <conversion seat>`, the
--     same expression, word for word, in the three readers:
--     fn_lightning_blind_order, fn_lightning_match_plan (the hold) and
--     fn_lightning_matcher_snapshot (the TypeScript port's input,
--     `newcomer`). A player who just bought in is still always the big blind
--     first; a player who was already seated is dealt in at once.
--   - fn_lightning_blind_order ranks a newcomer FIRST after an unresolved big
--     blind obligation, ahead of conversion seats that have not been the big
--     blind yet, so the held newcomer is the very next big blind instead of
--     waiting behind them. In a settled pool (every conversion seat has been
--     the big blind) the order is exactly the old one: a newcomer is then
--     precisely a NULL last_bb_at, which already ranked first.
--
-- The plan and the barrier both read the blind order from this one function,
-- so the plan's big blind is still the barrier's P2-first. The engine's
-- TypeScript port (server/src/lightning/LightningMatcherModel.ts:
-- isLightningNewcomer, compareBlindOrder) reads the same key from the
-- snapshot's `newcomer` and still requires lastBbAtMs === null, so the flag
-- can only exempt. Horses are players (CLAUDE.md 10.5): nothing here reads a
-- horse marker. No money, seat or ledger row is written; this is the plan.
--
-- Applied as md5-guarded text replacements of the live definitions (the house
-- pattern from 20261024195059), so a drifted source aborts instead of
-- overwriting someone else's change. No object is declared.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $source$
DECLARE
  r record; s text; n text;
  -- THE CONVERSION SEAT, once, for the three readers. `sl` is the pool slot.
  v_newcomer CONSTANT text := $expr$(sl.last_bb_at IS NULL AND NOT coalesce((
             -- LIGHTNING_CONVERSION_SEAT (20261024213844): the epoch's conversion
             -- entered this seat for a player already at the tables.
             SELECT cs_cps.opened_at < cs_ep.started_at
                    AND cs_ps.entered_at < cs_ep.started_at + interval '5 seconds'
                    AND sl.opened_at < cs_ep.started_at + interval '5 seconds'
               FROM public.lightning_pool_session cs_ps
               JOIN public.cash_player_session cs_cps ON cs_cps.id = cs_ps.cash_player_session_id
               JOIN public.cash_cluster_epoch cs_ep ON cs_ep.cluster_id = sl.cluster_id AND cs_ep.epoch = sl.cluster_epoch
              WHERE cs_ps.id = sl.pool_session_id), false))$expr$;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_lightning_blind_order(uuid,integer,uuid[])', 'ca3d5541df401156ea94be0c1277b74f'),
    ('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)', '94892943ee2a9cba3f495e507f2ff0d3'),
    ('public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)', 'ed556c33e570e8816e936cd026a6893f')
  ) x(sig, want) LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'Lightning source changed; requalify the conversion-seat newcomer before installation: %', r.sig;
    END IF;
  END LOOP;

  -- fn_lightning_blind_order: a newcomer leads, after an unresolved obligation.
  s := pg_get_functiondef('public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure);
  n := replace(s,
    E'           ORDER BY (coalesce(bl.missed_bb_debt, 0) > 0 OR coalesce(bl.bb_owed, 0) > 0) DESC,\n'
    || E'                    sl.last_bb_at ASC NULLS FIRST,\n',
    E'           ORDER BY (coalesce(bl.missed_bb_debt, 0) > 0 OR coalesce(bl.bb_owed, 0) > 0) DESC,\n'
    || E'                    -- A NEWCOMER NEXT (20261024213844): a player who has just bought in\n'
    || E'                    -- is the next big blind, ahead of the seats the epoch''s conversion\n'
    || E'                    -- made that have not been the big blind yet.\n'
    || E'                    ' || v_newcomer || E' DESC,\n'
    || E'                    sl.last_bb_at ASC NULLS FIRST,\n');
  IF n = s OR position('LIGHTNING_CONVERSION_SEAT' IN n) = 0 THEN
    RAISE EXCEPTION 'Lightning blind order anchor changed';
  END IF;
  EXECUTE n;

  -- fn_lightning_match_plan: the hold's key.
  s := pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure);
  n := replace(s, E'           (bo.last_bb_at IS NULL) AS newcomer,\n',
    E'           -- A NEWCOMER (20261024213844): never the big blind, and not a seat the\n'
    || E'           -- epoch''s conversion made for a player already at the tables.\n'
    || E'           ' || v_newcomer || E' AS newcomer,\n');
  IF n = s OR position('LIGHTNING_CONVERSION_SEAT' IN n) = 0 OR position('(bo.last_bb_at IS NULL) AS newcomer' IN n) > 0 THEN
    RAISE EXCEPTION 'Lightning plan newcomer anchor changed';
  END IF;
  EXECUTE n;

  -- fn_lightning_matcher_snapshot: the same key for the TypeScript port.
  s := pg_get_functiondef('public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)'::regprocedure);
  n := replace(s, '''newcomer'',sl.last_bb_at IS NULL,', '''newcomer'',' || v_newcomer || ',');
  IF n = s OR position('LIGHTNING_CONVERSION_SEAT' IN n) = 0 THEN
    RAISE EXCEPTION 'Lightning snapshot newcomer anchor changed';
  END IF;
  EXECUTE n;
END $source$;

COMMIT;
