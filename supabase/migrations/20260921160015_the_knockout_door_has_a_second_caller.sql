-- the_knockout_door_has_a_second_caller
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG
--
-- Seven knockout candidates have sat in state 'pending' since 2026-09-18/19 -
-- the only seven on a platform that has written 150,378 of them. Each one is a
-- real bust: stack_before > 0, stack_after = 0, a matching hand_atomic_commits
-- receipt, a matching hand_history row, no live seat, and a last seat holding
-- nothing. The evidence the engine demands was complete and valid the entire
-- time. Measured 2026-09-21: the five events holding them had not dealt a hand
-- in 57.5 to 82.5 hours, and each event's LAST hand is the exact hand that
-- created its stuck candidate.
--
-- An unranked player keeps an event from finishing, so 884.00 of prize escrow
-- could not be paid to anyone:
--
--   5a387a75  $100 Freeroll - 12:00 PM                 100.00   65.6h
--   615783bf  Afternoon Free Buy (NLH)                 289.00   65.6h
--   839f4ca3  Midnight Free Buy (NLH)                  312.00   57.5h
--   8ec7e81d  $100 Freeroll - 6:00 PM                  120.00   64.7h  (3 busts)
--   bfcfaf17  DSS Thursday $5.50 NLH Turbo - 9 PM CT    63.00   82.5h
--
-- WHY NOTHING RECOVERED THEM
--
-- fn_eliminate_tournament_player_atomic - the knockout door - accepts every
-- one of these claims. It was probed in a rolled-back transaction on
-- 2026-09-21 with SET CONSTRAINTS ALL IMMEDIATE and returned ok:true with the
-- correct finishing place for all five reachable busts. The door is not
-- refusing anything. NOTHING IS CALLING IT.
--
-- The door has exactly one caller, the live engine that owns the tournament.
-- The one other caller that ever existed, fn_ca_eliminate_absent_tournament_
-- players, was retired on 2026-09-10 (20260910073355): its cron row is
-- active=false, both its predicates refuse any candidate whose state is not
-- 'rebought', and the shape it wrote - status 'eliminated' with a NULL place -
-- is now refused outright in a live event by the constraint trigger
-- tournament_elimination_has_a_place (20260910072351). It cannot be revived and
-- must not be: that trigger is the law, and the door assigns the place.
--
-- So since 2026-09-10 a bust the engine fails to record has had NO recovery
-- path at all. That is the defect. It is fixed in the engine, in this same
-- pull request, by making a tournament manager reconcile its own pending
-- candidates through the door at adoption - the engine restarts every hour at
-- :55 by design, so a bust resolver that only lives in one process's memory is
-- guaranteed to strand work eventually. This migration settles the damage the
-- missing path already did; it creates no job, sweep, healer or backfill.
--
-- WHAT THIS MIGRATION DOES
--
-- Drives the five reachable busts through the platform's own idempotent door,
-- in the chronology the live engine recorded as it happened (candidate
-- created_at - the witness that was there, CLAUDE.md 10.9), each taking the
-- place its own field count gives it. No prize is due: every one of these is an
-- out-of-the-money mid-event bust, and the door returns 0.00 for each. NO MONEY
-- MOVES HERE. Escrow is asserted unchanged at 721.00 before and after. What
-- changes is that three events can finish and pay themselves by the normal
-- path, which they could not do while an unranked player remained.
--
-- THE TWO IT DOES NOT TOUCH
--
-- bfcfaf17/ed9ff9e2 and 5a387a75/6fa1c8e2 (163.00) sit on tables bound to an
-- F06 table-break operation still in state 'park_requested'. While a table is
-- bound, smarter_private.f06_source_guard raises F06_SOURCE_EXCLUDED on every
-- roster or seat write that is not part of the break's own dispatch - measured
-- here, the probe was refused. No amount of correctness at the knockout door
-- reaches them. They are left exactly as they are, deliberately and visibly,
-- because ending a half-completed table break is a different authority and
-- getting it wrong moves seated stacks. That is its own defect and a larger
-- one: 161 F06 operations platform-wide are stuck non-terminal (153
-- park_requested, 8 begun), all created 2026-09-18/19, across ~150 tables.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL
-- policy). This migration carries no DDL at all; it is one transaction because
-- a half-applied settlement is worse than none.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  r record;
  v_field integer;
  v_res jsonb;
  v_reachable integer;
  v_bound integer;
  v_done integer := 0;
  v_prize numeric := 0;
  v_escrow_before numeric;
  v_escrow_after numeric;
  v_left_unbound integer;
  v_left_bound integer;
  v_places text := '';
  c_events uuid[] := ARRAY[
    '615783bf-15e3-40b7-9368-75f21b6ac53b',
    '8ec7e81d-f681-4709-a1d8-8531ec9793e8',
    '839f4ca3-4826-4107-bcc3-465867928a8a']::uuid[];
BEGIN
  -- The board must be exactly where it was measured, or this aborts.
  SELECT count(*) FILTER (WHERE NOT bound), count(*) FILTER (WHERE bound)
    INTO v_reachable, v_bound
    FROM (
      SELECT EXISTS (SELECT 1 FROM smarter_private.f06_operations o
                      WHERE o.source_table_id = c.table_id
                        AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')) AS bound
        FROM public.tournament_knockout_candidates c
        JOIN public.tournaments t ON t.id = c.tournament_id
        JOIN public.tournament_players p
          ON p.tournament_id = c.tournament_id AND p.user_id = c.eliminated_user_id
       WHERE c.state = 'pending'
         AND t.status = 'RUNNING'
         AND p.status IN ('playing','registered')) q;

  IF v_reachable <> 5 OR v_bound <> 2 THEN
    RAISE EXCEPTION
      'the board moved: expected 5 reachable and 2 F06-bound pending busts, found % and %',
      v_reachable, v_bound;
  END IF;

  SELECT coalesce(sum(prize_balance),0) INTO v_escrow_before
    FROM public.tournament_escrow WHERE tournament_id = ANY(c_events);
  IF v_escrow_before <> 721.00 THEN
    RAISE EXCEPTION 'expected 721.00 of prize escrow across the three reachable events, found %',
      v_escrow_before;
  END IF;

  FOR r IN
    SELECT c.tournament_id, c.eliminated_user_id, t.name, c.created_at
      FROM public.tournament_knockout_candidates c
      JOIN public.tournaments t ON t.id = c.tournament_id
      JOIN public.tournament_players p
        ON p.tournament_id = c.tournament_id AND p.user_id = c.eliminated_user_id
     WHERE c.state = 'pending'
       AND t.status = 'RUNNING'
       AND p.status IN ('playing','registered')
       AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_operations o
                        WHERE o.source_table_id = c.table_id
                          AND o.state NOT IN ('acknowledged','withdrawn_before_manifest'))
     -- bust chronology as the engine recorded it, not as a clock reconstructs it
     ORDER BY c.tournament_id, c.created_at, c.id
  LOOP
    SELECT count(*) INTO v_field FROM public.tournament_players
     WHERE tournament_id = r.tournament_id AND status IN ('playing','registered');

    v_res := public.fn_eliminate_tournament_player_atomic(
               r.tournament_id, r.eliminated_user_id, v_field, 0, 0);

    IF coalesce((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'the knockout door refused % in %: %',
        r.eliminated_user_id, r.name, v_res::text;
    END IF;

    v_done  := v_done + 1;
    v_prize := v_prize + coalesce((v_res->>'prize')::numeric, 0);
    v_places := v_places || E'\n  ' || r.name || ' / ' || left(r.eliminated_user_id::text,8)
                || ' busted ' || to_char(r.created_at,'YYYY-MM-DD HH24:MI:SS')
                || ' -> place ' || (v_res->>'position');
  END LOOP;

  IF v_done <> 5 THEN
    RAISE EXCEPTION 'expected to record 5 busts through the door, recorded %', v_done;
  END IF;

  -- Every one of these is out of the money. A non-zero total here means the
  -- board moved underneath this migration and a place now carries a prize.
  IF v_prize <> 0 THEN
    RAISE EXCEPTION 'the door paid % against these places; expected 0.00 - refusing to commit',
      v_prize;
  END IF;

  SELECT count(*) FILTER (WHERE NOT bound), count(*) FILTER (WHERE bound)
    INTO v_left_unbound, v_left_bound
    FROM (
      SELECT EXISTS (SELECT 1 FROM smarter_private.f06_operations o
                      WHERE o.source_table_id = c.table_id
                        AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')) AS bound
        FROM public.tournament_knockout_candidates c
        JOIN public.tournaments t ON t.id = c.tournament_id
       WHERE c.state = 'pending' AND t.status = 'RUNNING') q;

  IF v_left_unbound <> 0 THEN
    RAISE EXCEPTION '% reachable pending bust(s) remain; refusing to leave the set half settled',
      v_left_unbound;
  END IF;
  IF v_left_bound <> 2 THEN
    RAISE EXCEPTION 'expected the 2 F06-bound busts to be untouched, found %', v_left_bound;
  END IF;

  SELECT coalesce(sum(prize_balance),0) INTO v_escrow_after
    FROM public.tournament_escrow WHERE tournament_id = ANY(c_events);
  IF v_escrow_after <> v_escrow_before THEN
    RAISE EXCEPTION 'escrow moved from % to %; this settlement must move no money',
      v_escrow_before, v_escrow_after;
  END IF;

  INSERT INTO public.financial_alerts
    (severity, source, message, context, resolved, resolved_at, resolved_by, resolution)
  VALUES (
    'warning',
    'the_knockout_door_has_a_second_caller',
    'Five busts proven by an accepted hand had sat unrecorded for 57-82 hours because the knockout door has only one caller and the engine never called it. Recorded through the door at their own places; no money moved.',
    jsonb_build_object(
      'recorded', v_done,
      'places', v_places,
      'prize_paid', v_prize,
      'escrow_before', v_escrow_before,
      'escrow_after', v_escrow_after,
      'still_blocked_by_f06', v_left_bound,
      'f06_blocked_escrow', 163.00,
      'events', c_events, 'migration', '20260921160015'),
    true, now(), NULL,
    'The five reachable busts were recorded through fn_eliminate_tournament_player_atomic, the platform''s own idempotent door, each taking the place its field count gave it in the bust chronology the live engine recorded. Every one is an out-of-the-money mid-event bust, so the door paid 0.00 and prize escrow is unchanged at 721.00: this settles a ranking, not a payment, and the three events can now finish and pay themselves by the normal path. Two further busts (bfcfaf17/ed9ff9e2 and 5a387a75/6fa1c8e2, holding 163.00) sit on tables bound to an F06 table-break stuck in park_requested, where f06_source_guard refuses every write; they are deliberately left untouched and reported, because ending a half-completed table break is a different authority. The cause - a knockout door with exactly one caller, the retired sweep being unrevivable since tournament_elimination_has_a_place forbids its write shape - is fixed in the engine in the same pull request.');

  RAISE NOTICE 'recorded % bust(s) through the knockout door, 0.00 paid, escrow unchanged at %:%',
    v_done, v_escrow_after, v_places;
END
$body$;

COMMIT;
