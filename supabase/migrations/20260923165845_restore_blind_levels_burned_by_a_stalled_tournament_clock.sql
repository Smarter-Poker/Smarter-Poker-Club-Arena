-- 20260923165845_restore_blind_levels_burned_by_a_stalled_tournament_clock.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  WHAT THIS CHANGES, AND WHY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A tournament's blind level is a wall-clock deadline a PLAYER loses to.
-- CLAUDE.md section 13 invariant 4 says such a deadline is thawed, never
-- burned, and advanceBlindLevel already refuses to spend a level during a
-- break and during the maintenance freeze for exactly that reason.
--
-- It did not refuse to spend one while the tournament's own tables were
-- dealing nothing. The level clock is a local setTimeout chain and keeps its
-- own time perfectly well with every table under it dead, so on an engine
-- that had been unable to restart since 2026-09-18 the blinds climbed for
-- hours and, in two cases, days against stacks that could not act.
--
-- Measured on production 2026-09-23 (see docs/changelog/2026-09-23-a-blind-
-- level-is-not-spent-on-a-hand-that-was-never-dealt.md):
--
--   Evening Mystery Bounty (PLO5) 95a31bb1 - last hand 2026-09-22 13:28:45
--     at 2,000/4,000 with two players holding 30,000 each, 7.5 big blinds
--     apiece. The clock ran on unattended and left them at 500,000/1,000,000
--     with a 150,000 ante: 0.03 big blinds each, less than a quarter of one
--     ante. Resuming that is not the game they were playing.
--   $100 Freeroll 12:00 AM 37f7d04b - 111 hours of unattended levels, level 9
--     to level 141, 30 big blinds average down to 2.86.
--   $100 Freeroll 6:00 AM 6915596c - 12.83 big blinds down to 0.16.
--   Breakfast Turbo 019b6263 - 5.80 down to 0.15.
--
-- Every seat in every affected event is a horse. CLAUDE.md 10.5 is why that
-- changes nothing here: a horse pays the same buy-in out of the same club
-- wallet and is owed the same game, so the repair is not narrowed by it and
-- no `is_horse` filter appears below.
--
-- THE REPAIR. Each event's level is put back to the level IN FORCE AT ITS
-- LAST DEALT HAND, and its level anchor is put back to that hand's instant.
-- Nothing here is a number I chose: the small blind and big blind come out of
-- hand_history - the witness that was there (10.9) - and the level index is
-- the one row of that tournament's own published ladder carrying exactly that
-- pair. A reconstruction that disagreed with the witness would be the wrong
-- reconstruction, so this does not attempt one.
--
-- The level therefore resumes overdue by the whole stall, as it should: the
-- engine clamps an overdue level to 1s, the new guard in advanceBlindLevel
-- holds it until the tournament deals again, and the level that was in
-- progress when play stopped finishes when play restarts. "Picks back up
-- exactly as it was."
--
-- NO MONEY MOVES IN THIS MIGRATION. Nothing was owed: all 54 stalled events
-- are mid-flight with their prize money intact and unpaid in
-- tournament_escrow (gross_in 8,453.00, prize_out 0.00, prize_balance
-- 14,949.25, nothing closed), and fn_unaccounted_seat_exits() returns zero
-- rows, so no chips left a wallet and landed nowhere. The damage was to the
-- stacks, and this is what repairs the stacks.
--
-- THIS IS NOT A REPAIR JOB (10.12). It is a one-time correction of rows a
-- defect wrote, applied beside the hard-coded fix that stops the defect
-- occurring (server/src/tournament/TournamentManagerBase.ts, pinned by
-- tests/a-blind-level-is-not-spent-on-a-hand-that-was-never-dealt.law.test.ts).
-- It installs no job, no cron, no sweep and no trigger.
--
-- DML only - no DDL, so no PostgREST schema-cache reload (production DDL
-- policy) and nothing for the break-window event triggers to refuse.
--
-- Because it creates no persistent object, nothing in a catalogue can say
-- whether production carries it, so it declares its own proof. The resolved
-- alert below is written by this migration and by nothing else.
-- @live-proof: EXISTS (SELECT 1 FROM public.financial_alerts WHERE source = $$tournament.blind_clock_ran_while_stalled$$ AND resolved)

BEGIN;

DO $$
DECLARE
  v_rows      integer;
  v_ambiguous integer;
  v_raised    integer;
  r           record;
BEGIN
  -- ── The derivation, read once into a temporary table (pg_temp only) ──────
  CREATE TEMP TABLE zz_blind_restore ON COMMIT DROP AS
  WITH stalled AS (
    -- RUNNING, still holding seats, and no tournament manager has renewed its
    -- lease for an hour. That is the population whose clock ran unattended.
    SELECT DISTINCT t.id
    FROM public.tournaments t
    JOIN public.tables tb ON tb.tournament_id = t.id
    JOIN public.table_seats ts ON ts.table_id = tb.id AND ts.left_at IS NULL
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = t.id
    WHERE t.status ILIKE 'running'
      AND (l.tournament_id IS NULL OR l.heartbeat_at <= now() - interval '1 hour')
  ), last_hand AS (
    SELECT DISTINCT ON (tb.tournament_id)
           tb.tournament_id, hh.created_at AS dealt_at,
           hh.small_blind, hh.big_blind
    FROM public.tables tb
    JOIN public.hand_history hh ON hh.table_id = tb.id
    WHERE tb.tournament_id IN (SELECT id FROM stalled)
    ORDER BY tb.tournament_id, hh.created_at DESC
  )
  SELECT t.id,
         t.name,
         t.current_level                                AS level_before,
         t.blind_level_state                            AS state_before,
         t.level_started_at                             AS anchor_before,
         (r.ord - 1)::integer                           AS level_after,
         lh.dealt_at                                    AS anchor_after,
         jsonb_build_object(
           'index',       (lvl.ord - 1)::integer,
           'small_blind', (lvl.lrow ->> 'smallBlind')::numeric,
           'big_blind',   (lvl.lrow ->> 'bigBlind')::numeric,
           'ante',        (lvl.lrow ->> 'ante')::numeric
         )                                              AS state_after,
         count(*) OVER (PARTITION BY t.id)              AS ladder_matches
  FROM stalled s
  JOIN public.tournaments t ON t.id = s.id
  JOIN last_hand lh ON lh.tournament_id = s.id
  -- Aliased lvl(lrow, ...), not r(row, ...): a PL/pgSQL `r record` in this
  -- same block shadows a SQL alias called `r` and the CREATE TEMP TABLE fails
  -- with "record r is not assigned yet". Found by the rolled-back probe.
  JOIN LATERAL jsonb_array_elements(t.blind_structure::jsonb)
         WITH ORDINALITY AS lvl(lrow, ord) ON TRUE
  WHERE
    -- the clock ran ON after the last hand this event dealt ...
    t.level_started_at > lh.dealt_at
    -- ... and it left the blinds above where play actually stopped ...
    AND (t.blind_level_state ->> 'big_blind')::numeric > lh.big_blind
    -- ... and this ladder row is the one carrying exactly the blinds the
    -- witness recorded. Matching BOTH blinds is what makes it unique.
    AND (lvl.lrow ->> 'smallBlind')::numeric = lh.small_blind
    AND (lvl.lrow ->> 'bigBlind')::numeric   = lh.big_blind;

  SELECT count(*) INTO v_rows FROM zz_blind_restore;

  -- ── Assertions. Abort rather than guess if the board moved. ─────────────
  IF v_rows = 0 THEN
    RAISE EXCEPTION
      'blind-level restore: nothing derived. The premise measured on 2026-09-23 (12 stalled events whose clock ran past their last dealt hand) no longer holds; re-measure before applying.';
  END IF;

  -- A platform-wide rewrite is never the right answer to this defect. 54
  -- events were stalled when this was measured; anything near that ceiling
  -- means the derivation, not the board, has changed.
  IF v_rows > 54 THEN
    RAISE EXCEPTION
      'blind-level restore: derived % rows, more than the 54 stalled events measured. Refusing to rewrite the board.', v_rows;
  END IF;

  SELECT count(*) INTO v_ambiguous FROM zz_blind_restore WHERE ladder_matches <> 1;
  IF v_ambiguous > 0 THEN
    RAISE EXCEPTION
      'blind-level restore: % event(s) matched more than one ladder row. An ambiguous level is not a level; refusing.', v_ambiguous;
  END IF;

  -- The restore may only ever move a level DOWN. Raising one would take chips
  -- off a player for our defect, which 10.9 forbids outright.
  SELECT count(*) INTO v_raised FROM zz_blind_restore WHERE level_after >= level_before;
  IF v_raised > 0 THEN
    RAISE EXCEPTION
      'blind-level restore: % event(s) would not move down. Refusing to raise a blind level.', v_raised;
  END IF;

  -- ── The record is part of the fix. Name every event and both states. ────
  FOR r IN SELECT * FROM zz_blind_restore ORDER BY name LOOP
    RAISE NOTICE 'blind-level restore % (%): level % -> %, blinds %/% -> %/%, anchor % -> %',
      r.name, left(r.id::text, 8), r.level_before, r.level_after,
      r.state_before ->> 'small_blind', r.state_before ->> 'big_blind',
      r.state_after  ->> 'small_blind', r.state_after  ->> 'big_blind',
      r.anchor_before, r.anchor_after;
  END LOOP;

  UPDATE public.tournaments t
     SET current_level     = z.level_after,
         blind_level_state = z.state_after,
         level_started_at  = z.anchor_after
    FROM zz_blind_restore z
   WHERE t.id = z.id;

  RAISE NOTICE 'blind-level restore: % tournament(s) put back to the level in force at their last dealt hand', v_rows;

  -- ── The alert, filed and resolved in the same breath (10.9). ────────────
  INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
  SELECT
    -- financial_alerts_severity_check allows critical/warning/info only. The
    -- rolled-back probe rejected 'high'; 11.5 is why that cost nothing.
    'critical',
    'tournament.blind_clock_ran_while_stalled',
    'Blind levels advanced on tournaments whose tables were dealing nothing, destroying seated stacks in big-blind terms',
    jsonb_build_object(
      'measured_at', now(),
      'stalled_running_tournaments', 54,
      'open_seats', 807,
      'human_seats', 0,
      'horse_seats', 807,
      'escrow_prize_balance', 14949.25,
      'escrow_prize_out', 0.00,
      'unaccounted_seat_exits', 0,
      'restored', (SELECT jsonb_agg(jsonb_build_object(
                     'tournament_id', z.id, 'name', z.name,
                     'level_before', z.level_before, 'level_after', z.level_after,
                     'bb_before', z.state_before ->> 'big_blind',
                     'bb_after',  z.state_after  ->> 'big_blind'
                   ) ORDER BY z.name) FROM zz_blind_restore z)
    ),
    true,
    now(),
    'No money was owed and none moved: every affected event is mid-flight with its prize pool intact and unpaid in tournament_escrow, and fn_unaccounted_seat_exits() returned zero rows, so no chips left a wallet and landed nowhere. The damage was to the seated stacks, caused by advanceBlindLevel spending levels against tables that dealt no hand. Each event has been put back to the level in force at its last dealt hand, read from hand_history and matched to the one row of its own published ladder carrying those blinds; no level was raised. The cause is fixed in server/src/tournament/TournamentManagerBase.ts, which now refuses to spend a level on a hand that was never dealt, in the same shape as the break and maintenance-freeze guards beside it, and is pinned by tests/a-blind-level-is-not-spent-on-a-hand-that-was-never-dealt.law.test.ts. No repair job, sweep or reconciler was created.'
  ;
END $$;

COMMIT;
