-- 20260923204615_restore_blind_levels_the_clock_burned_with_a_live_lease_and_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  WHAT THIS CHANGES, AND WHY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This finishes the repair that 20260923165845 began.
--
-- That migration put twelve stalled tournaments back to the blind level in
-- force at their last dealt hand, beside the hard-coded fix in
-- server/src/tournament/TournamentManagerBase.ts that stops a level being
-- spent on a hand that was never dealt (#5140, merged 2026-09-23). It was
-- applied to production on 2026-09-23 at 20:40 UTC and did exactly what it
-- said: twelve events restored, no level raised, no money moved.
--
-- Its DERIVATION, however, asked a narrower question than the defect. Two
-- populations that carry the identical damage fell outside it, and because
-- both were excluded by a JOIN rather than by a test, neither was reported:
--
--   A. A MANAGER THAT IS STILL HEARTBEATING. The first derivation began
--      "no tournament manager has renewed its lease for an hour. That is the
--      population whose clock ran unattended." A lease heartbeat is not
--      evidence that the game was being PLAYED - it is evidence that a
--      manager process is alive, which is precisely the process that burns
--      the levels. 56 RUNNING events holding 539 seats have a lease renewed
--      inside the last hour, tables that have dealt nothing for up to 127
--      hours, and blinds standing above the level of their own last hand.
--      CLAUDE.md 10.9 says prefer the witness that was there. The witness is
--      the hand in hand_history, never the heartbeat, so this derivation
--      drops the lease condition entirely and asks only what the hands say.
--
--   B. AN EVENT THAT NEVER DEALT A HAND AT ALL. The first derivation reached
--      its ladder through an INNER JOIN on the last dealt hand, so an event
--      with no hand had no row to restore to and silently left the set. Two
--      such events had run their clock clean off the end of their own
--      published twelve-row ladder:
--
--        3 Chip Deep Stack Spin PLO4 e9c07fe8 - started 09-18 05:55, table
--          still "waiting", never dealt a card, level 1709 of 12, blinds
--          10,000,000/10,000,000 against three seats holding 1,000 each:
--          0.0001 big blinds apiece.
--        PLO4 Heads-Up 10 114c6069 - started 09-22 23:44, never dealt, level
--          354 of 12. Its level anchor was 2026-09-23 20:41 UTC - three
--          minutes before this was written - so this one was still burning
--          while the first repair was being applied.
--
--      For these the witness is not a hand but the absence of one: no hand
--      was dealt, therefore no level was ever legitimately spent, therefore
--      the level is the first row of the ladder and the anchor is the moment
--      the event was recorded as starting. Nothing here is extrapolated.
--
-- The 56 in A are restored the same way the twelve were: to the one row of
-- the tournament's own published ladder carrying exactly the small blind and
-- big blind that hand_history recorded for its last dealt hand, anchored to
-- that hand's instant. Matching BOTH blinds is what makes the row unique, and
-- an event matching more than one row aborts the whole migration rather than
-- being guessed at.
--
-- IT ONLY EVER MOVES A LEVEL DOWN. Raising one would take chips off a player
-- for our defect, which 10.9 forbids outright, so a row that would not move
-- down aborts.
--
-- IT IS IDEMPOTENT BY CONSTRUCTION. A restored event has level_started_at
-- equal to its last hand's instant, so "level_started_at > dealt_at" is false
-- for it on any later run. The twelve already restored are excluded by that
-- test and not by a hard-coded list; re-running this migration derives them
-- again only if the clock burns them again.
--
-- EVERY SEAT IN EVERY AFFECTED EVENT IS A HORSE. CLAUDE.md 10.5 is why that
-- changes nothing: a horse pays the same buy-in out of the same club wallet,
-- is owed the same game, and no is_horse filter appears below.
--
-- NO MONEY MOVES IN THIS MIGRATION, AND NONE IS OWED. Read on production
-- 2026-09-23: across the 399 stalled RUNNING events holding seats,
-- tournament_escrow carries gross_in 42,141.00, prize_out 0.00, fee_out 0.00,
-- refund_prize 0.00, prize_balance 75,701.35, and not one escrow is closed.
-- Nothing has been paid, so nobody has been short-paid; the entries are held,
-- not lost. fn_unaccounted_seat_exits() returns zero rows, so no stack left a
-- seat without a matching wallet credit. The damage was to the seated stacks
-- in big-blind terms, and this is what repairs it.
--
-- THIS IS NOT A REPAIR JOB (10.12). It is a one-time correction of rows a
-- defect wrote, applied beside the hard-coded fix that already stops the
-- defect occurring. That guard covers BOTH populations here: its witness
-- lastObservedHandCompletedAtMs is seeded to zero, so an event that has
-- never dealt holds its level for ever rather than spending it. It installs
-- no job, no cron, no sweep and no trigger.
--
-- DML only - no DDL, so no PostgREST schema-cache reload (production DDL
-- policy) and nothing for the break-window event triggers to refuse.
--
-- Because it creates no persistent object, nothing in a catalogue can say
-- whether production carries it, so it declares its own proof. The resolved
-- alert below is written by this migration and by nothing else.
-- @live-proof: EXISTS (SELECT 1 FROM public.financial_alerts WHERE source = $$tournament.blind_clock_burned_past_its_witness$$ AND resolved)

BEGIN;

DO $$
DECLARE
  v_a         integer;
  v_b         integer;
  v_total     integer;
  v_ambiguous integer;
  v_raised    integer;
  r           record;
BEGIN
  -- ── Population A: a witness hand exists, and the clock ran past it ───────
  -- Aliased lvl(lrow, ...), never r(row, ...): a PL/pgSQL "r record" in this
  -- same block shadows a SQL alias called r and the CREATE TEMP TABLE fails
  -- with "record r is not assigned yet". Inherited from 20260923165845, where
  -- a rolled-back probe found it.
  CREATE TEMP TABLE zz_blind_restore_2 ON COMMIT DROP AS
  WITH seated AS (
    SELECT DISTINCT t.id
    FROM public.tournaments t
    JOIN public.tables tb ON tb.tournament_id = t.id
    JOIN public.table_seats ts ON ts.table_id = tb.id AND ts.left_at IS NULL
    WHERE t.status ILIKE 'running'
  ), last_hand AS (
    SELECT DISTINCT ON (tb.tournament_id)
           tb.tournament_id, hh.created_at AS dealt_at,
           hh.small_blind, hh.big_blind
    FROM public.tables tb
    JOIN public.hand_history hh ON hh.table_id = tb.id
    WHERE tb.tournament_id IN (SELECT id FROM seated)
    ORDER BY tb.tournament_id, hh.created_at DESC
  )
  SELECT t.id,
         t.name,
         'witness'::text                                AS population,
         t.current_level                                AS level_before,
         t.blind_level_state                            AS state_before,
         t.level_started_at                             AS anchor_before,
         (lvl.ord - 1)::integer                         AS level_after,
         lh.dealt_at                                    AS anchor_after,
         jsonb_build_object(
           'index',       (lvl.ord - 1)::integer,
           'small_blind', (lvl.lrow ->> 'smallBlind')::numeric,
           'big_blind',   (lvl.lrow ->> 'bigBlind')::numeric,
           'ante',        COALESCE((lvl.lrow ->> 'ante')::numeric, 0)
         )                                              AS state_after,
         (count(*) OVER (PARTITION BY t.id))::integer   AS ladder_matches
  FROM seated s
  JOIN public.tournaments t ON t.id = s.id
  JOIN last_hand lh ON lh.tournament_id = s.id
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

  SELECT count(*) INTO v_a FROM zz_blind_restore_2;

  -- ── Population B: no hand was ever dealt, so no level was ever spent ─────
  INSERT INTO zz_blind_restore_2
  SELECT t.id,
         t.name,
         'never-dealt'::text,
         t.current_level,
         t.blind_level_state,
         t.level_started_at,
         0,
         t.started_at,
         jsonb_build_object(
           'index',       0,
           'small_blind', (t.blind_structure::jsonb -> 0 ->> 'smallBlind')::numeric,
           'big_blind',   (t.blind_structure::jsonb -> 0 ->> 'bigBlind')::numeric,
           'ante',        COALESCE((t.blind_structure::jsonb -> 0 ->> 'ante')::numeric, 0)
         ),
         1
  FROM public.tournaments t
  WHERE t.status ILIKE 'running'
    AND t.current_level > 0
    AND EXISTS (SELECT 1 FROM public.tables tb
                JOIN public.table_seats ts ON ts.table_id = tb.id AND ts.left_at IS NULL
                WHERE tb.tournament_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM public.hand_history hh
                    JOIN public.tables tb ON tb.id = hh.table_id
                    WHERE tb.tournament_id = t.id)
    AND jsonb_array_length(t.blind_structure::jsonb) > 0
    AND t.started_at IS NOT NULL;

  SELECT count(*) INTO v_total FROM zz_blind_restore_2;
  v_b := v_total - v_a;

  -- ── Assertions. Abort rather than guess if the board moved. ─────────────
  IF v_total = 0 THEN
    RAISE EXCEPTION
      'blind-level restore 2: nothing derived. The premise measured on 2026-09-23 (56 events with a live lease whose clock ran past their last dealt hand, and 2 that never dealt) no longer holds; re-measure before applying.';
  END IF;

  -- A platform-wide rewrite is never the right answer to this defect. 56 and
  -- 2 were measured; anything far above that means the derivation, not the
  -- board, has changed.
  IF v_a > 120 THEN
    RAISE EXCEPTION
      'blind-level restore 2: derived % witness rows, far above the 56 measured. Refusing to rewrite the board.', v_a;
  END IF;

  IF v_b > 20 THEN
    RAISE EXCEPTION
      'blind-level restore 2: derived % never-dealt rows, far above the 2 measured. Refusing to rewrite the board.', v_b;
  END IF;

  SELECT count(*) INTO v_ambiguous FROM zz_blind_restore_2 WHERE ladder_matches <> 1;
  IF v_ambiguous > 0 THEN
    RAISE EXCEPTION
      'blind-level restore 2: % event(s) matched more than one ladder row. An ambiguous level is not a level; refusing.', v_ambiguous;
  END IF;

  -- The restore may only ever move a level DOWN. Raising one would take chips
  -- off a player for our defect, which 10.9 forbids outright.
  SELECT count(*) INTO v_raised FROM zz_blind_restore_2 WHERE level_after >= level_before;
  IF v_raised > 0 THEN
    RAISE EXCEPTION
      'blind-level restore 2: % event(s) would not move down. Refusing to raise a blind level.', v_raised;
  END IF;

  -- A restore must never leave a level pointing outside its own ladder.
  IF EXISTS (
    SELECT 1 FROM zz_blind_restore_2 z
    JOIN public.tournaments t ON t.id = z.id
    WHERE z.level_after >= jsonb_array_length(t.blind_structure::jsonb)
  ) THEN
    RAISE EXCEPTION
      'blind-level restore 2: a derived level falls outside its own published ladder. Refusing.';
  END IF;

  -- ── The record is part of the fix. Name every event and both states. ────
  FOR r IN SELECT * FROM zz_blind_restore_2 ORDER BY population, name LOOP
    RAISE NOTICE 'blind-level restore 2 [%] % (%): level % -> %, blinds %/% -> %/%, anchor % -> %',
      r.population, r.name, left(r.id::text, 8), r.level_before, r.level_after,
      r.state_before ->> 'small_blind', r.state_before ->> 'big_blind',
      r.state_after  ->> 'small_blind', r.state_after  ->> 'big_blind',
      r.anchor_before, r.anchor_after;
  END LOOP;

  UPDATE public.tournaments t
     SET current_level     = z.level_after,
         blind_level_state = z.state_after,
         level_started_at  = z.anchor_after
    FROM zz_blind_restore_2 z
   WHERE t.id = z.id;

  RAISE NOTICE 'blind-level restore 2: % event(s) with a witness hand and % that never dealt, put back to the level play actually reached', v_a, v_b;

  -- ── The alert, filed and resolved in the same breath (10.9). ────────────
  INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
  SELECT
    -- financial_alerts_severity_check allows critical/warning/info only.
    'critical',
    'tournament.blind_clock_burned_past_its_witness',
    'Blind levels advanced on tournaments whose tables were dealing nothing, in two populations the first restore derivation excluded',
    jsonb_build_object(
      'measured_at', now(),
      'witness_population', v_a,
      'never_dealt_population', v_b,
      'human_seats', 0,
      'stalled_running_tournaments', 399,
      'escrow_gross_in', 42141.00,
      'escrow_prize_out', 0.00,
      'escrow_fee_out', 0.00,
      'escrow_refund_prize', 0.00,
      'escrow_prize_balance', 75701.35,
      'escrow_closed', 0,
      'unaccounted_seat_exits', 0,
      'predecessor_migration', '20260923165845_restore_blind_levels_burned_by_a_stalled_tournament_clock',
      'restored', (SELECT jsonb_agg(jsonb_build_object(
                     'tournament_id', z.id, 'name', z.name, 'population', z.population,
                     'level_before', z.level_before, 'level_after', z.level_after,
                     'bb_before', z.state_before ->> 'big_blind',
                     'bb_after',  z.state_after  ->> 'big_blind'
                   ) ORDER BY z.population, z.name) FROM zz_blind_restore_2 z)
    ),
    true,
    now(),
    'No money was owed and none moved. Every affected event is mid-flight with its prize pool intact and unpaid in tournament_escrow (gross_in 42,141.00 across the 399 stalled events, prize_out 0.00, refund_prize 0.00, nothing closed), and fn_unaccounted_seat_exits() returned zero rows, so no stack left a seat without a matching wallet credit. The damage was to the seated stacks in big-blind terms, caused by advanceBlindLevel spending levels against tables that dealt no hand. Migration 20260923165845 repaired twelve such events; its derivation excluded two further populations by a JOIN rather than by a test, so neither was reported: events whose tournament manager was still renewing its lease while its tables dealt nothing, and events that never dealt a hand at all and had run clean off the end of their own twelve-row ladder (3 Chip Deep Stack Spin PLO4 e9c07fe8 at level 1709 with 0.0001 big blinds a seat, and PLO4 Heads-Up 10 114c6069 at level 354, still burning three minutes before this was written). Each is now back to the level play actually reached: for the witness population, the one row of its own published ladder carrying exactly the blinds hand_history recorded for its last dealt hand, anchored to that hand; for the never-dealt population, the first row of its ladder anchored to its recorded start, because no hand was dealt and so no level was ever spent. No level was raised and no derived level falls outside its own ladder. The cause is fixed in server/src/tournament/TournamentManagerBase.ts, whose witness is seeded to zero and therefore holds the level on an event that has never dealt as well as one that has stopped, pinned by tests/a-blind-level-is-not-spent-on-a-hand-that-was-never-dealt.law.test.ts. No repair job, sweep or reconciler was created.'
  ;
END $$;

COMMIT;
