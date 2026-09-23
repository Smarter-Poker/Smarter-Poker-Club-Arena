-- 20260923205828_the_morning_free_buy_stranded_hand_is_voided_not_settled.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE MORNING FREE BUY'S STRANDED HAND IS VOIDED, AND ITS 283.80 IS NOT PAID
-- (2026-09-23).
--
-- Morning Free Buy (NLH) 7c6277e7 started 2026-09-19 13:00, dealt 283 hands
-- across three tables, and stopped dead at 14:29:08 on 2026-09-19 when the
-- engine generation driving it, 29afae24, died. It has been RUNNING ever since
-- with 18 registrations seated on 338,000 chips and 283.80 of prize money held
-- in escrow. It holds no engine_tournament_leases row.
--
-- It is also what has been holding every engine release on the platform shut.
-- auto-deploy-hetzner run 35897820986 refused its restart certificate with
-- f06_custody_not_drained on table 9e432569, reporting permitPhase=attempted -
-- "a hand that may have started". /health reports exactly one table holding the
-- certificate: unparkedReasons {f06_preparation_unresolved: 1}.
--
-- NO HAND WAS EVER DEALT UNDER THAT PERMIT, AND THIS IS READ FROM ROWS.
--   - Table 9e432569 holds 121 f06_hand_permits in state 'accepted' and exactly
--     121 hand_history rows; 26c00afc holds 88 and 88; 244a2997 holds 74 and 74.
--     Accepted permits equal dealt hands on every table, with no remainder.
--   - Two permits remain 'reserved', both of generation 29afae24: hand 13180949
--     on 9e432569 and hand 13180944 on 26c00afc. Both hand numbers are HIGHER
--     than the last hand each table actually dealt (13180877 and 13180796).
--   - For both: zero hand_history rows at or above that hand number, zero
--     hand_atomic_commits, zero hand_private_state, zero f06_hand_dispatch rows,
--     zero hand_submissions, and zero table_hole_cards. No cards were dealt.
--   - Each has one hand_state_snapshots row, written at 14:29:12.951 and
--     14:29:07.147, stage 'preflop', is_complete false - a hand staged with
--     blinds and antes posted into the snapshot and abandoned before the deal.
--   - The snapshots reconcile to the felt exactly. On 9e432569 the snapshot pot
--     is 3,450 and the players' totalInvested sums to 3,450; on 26c00afc both
--     are 3,050. Every one of the ten chairs named in those snapshots satisfies
--     table_seats.stack = snapshot stack + totalInvested, so the staged blinds
--     never left a chair. Voiding these two hands returns nothing because
--     nothing was ever taken.
--
-- WHY NO MONEY IS PAID HERE, HAVING LOOKED HARD AT PAYING IT. The obvious
-- reading of a four-day-old RUNNING event is 10.9's "a tournament that cannot
-- end itself", settled by ruling on chip standard the way the 6:00 AM freeroll
-- was on 2026-09-09. That reading is wrong here, on three counts.
--
--   1. THERE IS NO RESULT TO SETTLE. The event is not undecidable; it is
--      un-driven. Its 18 registrations were never eliminated and hold live
--      equity in a pool that pays only three places. Ruling the places from
--      chips now would hand 142.64, 81.93 and 59.23 to the top three stacks and
--      extinguish the other fifteen players' claim on the same pool - taking
--      something real from them to tidy up a release. A 12,451-chip stack with
--      eight big blinds is not a finished fifteenth place.
--   2. THE PLATFORM ALREADY HAS A REMEDY, AND IT NAMES THIS EVENT.
--      fn_f06_abort_abandoned_generation was rewritten on 2026-09-22
--      (20260922132318) specifically for "24 frozen multi-table events (1,606
--      playing registrations - Prime Time, Midday and Morning Free Buy, Lunch
--      Rush, the $100 Freerolls, Friday Rebuy Rush, Omaha Thursday)". Its
--      purpose is to void the hand a dead generation left reserved so that an
--      adopting successor can take custody and the event can carry on, and its
--      header states that the void "still credits nothing and debits nothing".
--      Measured on this database: 452 events took that door on 2026-09-22
--      between 12:40 and 13:23 UTC; 412 have since COMPLETED and 40 are
--      RUNNING with live leases, and 447 of the 452 dealt hands after their
--      abort. Morning Free Buy was named in the cohort and missed by the sweep:
--      smarter_private.f06_generation_aborts holds no row for generation
--      29afae24.
--   3. A RULING IS NOT REACHABLE THROUGH ANY PLATFORM PATH TODAY, AND THE ONLY
--      WAYS TO REACH ONE ARE FORBIDDEN. Table 244a2997 carries an open
--      f06_operations row in state 'begun' (break dce8ddb0, manifest written,
--      8 members, 8 attempts, origin and custody generation 29afae24) - a table
--      break that was one move into eight when the engine died. MiaPoker
--      3b7caeb9 completed hers at 14:29:14 and sits on 26c00afc seat 3 with her
--      13,510 intact; the other seven attempts are still 'active' and those
--      players never moved. While that operation is open,
--      smarter_private.f06_source_guard refuses every UPDATE OF status on
--      tournament_players and every UPDATE OF left_at on table_seats for that
--      table with F06_SOURCE_EXCLUDED, which blocks both the roster stamp and
--      the seat release the finish trigger performs. No function on this tip
--      takes a 'begun' operation with active attempts to a terminal state:
--      fn_f06_close_break needs every attempt to be a winner, and every
--      withdrawn_before_manifest door is keyed to a park that never got a
--      manifest. Reaching a ruling would mean hand-editing f06_operations or
--      fabricating an engine lease to impersonate a generation. Neither is
--      allowed, and neither is necessary.
--
-- So the money stays where it is. tournament_escrow still holds prize_balance
-- 283.80 and fee_balance 1.20, enforced, exactly as it has since 2026-09-19,
-- and it is paid when the event finishes, to whoever finishes in the places.
-- Nothing is owed today and nothing is written to a wallet.
--
-- WHAT THIS MIGRATION DOES. One call to the platform's own door, voiding the
-- two staged hands of the dead generation. It sets those two permits to
-- 'aborted_unsettled' with this receipt as evidence, marks their two snapshots
-- complete, and writes its receipts. It moves no chips, changes no roster row,
-- releases no seat, and pays nobody. p_release_current_lease is false because
-- there is no lease to release.
--
-- The 'begun' break on 244a2997 is deliberately LEFT ALONE. It is not this
-- migration's to close: an adopting successor takes custody of it through
-- fn_f06_claim_custody, which is how 58 acknowledged operations have already
-- completed. The teardown defect that strands it - TournamentManagerBase
-- throwing "retained an unresolved seat-move UUID" before its unregister loop,
-- which is what leaves engines stopped-but-registered and produces the
-- metaSeatedWithoutBank=6 census on this very table - is the root cause, and it
-- is owned by the agent working F06 recovery. This migration does not duplicate
-- that work and does not paper over it.
--
-- EVERY ONE OF THESE 24 REGISTRATIONS IS A HORSE, AND NOTHING HERE TREATS THEM
-- DIFFERENTLY FOR IT (CLAUDE.md 10.5). They keep their seats, their chips and
-- their claim on the pool exactly as a human field would.
--
-- This migration carries no DDL, so it fires no schema-cache reload - which is
-- also why it declares its own proof: it creates no object for
-- scripts/ci/check-migrations-are-live.mjs to look up, so it says instead what
-- a reader would run to see that production carries it. The three together are
-- the whole of what this migration did: the receipt exists, no permit is left
-- reserved, and the finding is recorded and resolved.
--
-- @live-proof: (SELECT count(*) FROM smarter_private.f06_generation_aborts WHERE tournament_id = '7c6277e7-921d-4651-91bc-15071a3884be' AND generation = '29afae24-5415-458f-acca-778b4f14444f') = 1
-- @live-proof: (SELECT count(*) FROM smarter_private.f06_hand_permits WHERE tournament_id = '7c6277e7-921d-4651-91bc-15071a3884be' AND state = 'reserved') = 0
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE source = 'tournament.stranded_event' AND context->>'tournament_id' = '7c6277e7-921d-4651-91bc-15071a3884be' AND resolved) = 1

BEGIN;

DO $mig$
DECLARE
  v_t       uuid := '7c6277e7-921d-4651-91bc-15071a3884be';
  v_gen     uuid := '29afae24-5415-458f-acca-778b4f14444f';
  v_receipt uuid := md5('f06:abandoned:7c6277e7:29afae24:void-20260923')::uuid;
  r         jsonb;
BEGIN
  ------------------------------------------------------------------ preconditions
  IF (SELECT status FROM public.tournaments WHERE id = v_t) <> 'RUNNING' THEN
    RAISE NOTICE 'the Morning Free Buy is no longer RUNNING; nothing to void';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_generation_aborts
              WHERE tournament_id = v_t AND generation = v_gen) THEN
    RAISE NOTICE 'generation 29afae24 has already been aborted; nothing to do';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM smarter_private.f06_hand_permits
       WHERE tournament_id = v_t AND state = 'reserved' AND generation = v_gen) <> 2 THEN
    RAISE EXCEPTION 'the abandoned generation no longer holds exactly two reserved permits';
  END IF;
  -- Accepted permits still equal dealt hands on every table, with no remainder.
  IF EXISTS (
    SELECT 1 FROM public.tables tb
     WHERE tb.tournament_id = v_t
       AND (SELECT count(*) FROM smarter_private.f06_hand_permits p
             WHERE p.table_id = tb.id AND p.state = 'accepted')
           <> (SELECT count(*) FROM public.hand_history h WHERE h.table_id = tb.id)) THEN
    RAISE EXCEPTION 'accepted permits no longer equal dealt hands on every table';
  END IF;
  -- Nothing was ever dealt at or above either reserved hand number.
  IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
              WHERE p.tournament_id = v_t AND p.state = 'reserved'
                AND (EXISTS (SELECT 1 FROM public.hand_history h
                              WHERE h.table_id = p.table_id AND h.hand_number >= p.hand_number)
                  OR EXISTS (SELECT 1 FROM public.table_hole_cards c
                              WHERE c.table_id = p.table_id AND c.hand_number = p.hand_number)
                  OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                              WHERE a.table_id = p.table_id AND a.hand_number >= p.hand_number)
                  OR EXISTS (SELECT 1 FROM public.hand_private_state hp
                              WHERE hp.table_id = p.table_id AND hp.hand_number >= p.hand_number)
                  OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d
                              WHERE d.permit_id = p.permit_id))) THEN
    RAISE EXCEPTION 'a reserved permit now has a dealt hand behind it; do not void it';
  END IF;
  IF (SELECT count(*) FROM public.tournament_players
       WHERE tournament_id = v_t AND status = 'playing') <> 18
     OR (SELECT sum(chips) FROM public.tournament_players
          WHERE tournament_id = v_t AND status = 'playing') <> 338000 THEN
    RAISE EXCEPTION 'the seated field is no longer 18 registrations holding 338,000 chips';
  END IF;
  IF (SELECT round(prize_balance, 2) FROM public.tournament_escrow
       WHERE tournament_id = v_t) <> 283.80 THEN
    RAISE EXCEPTION 'the prize balance is no longer 283.80';
  END IF;
  IF EXISTS (SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id = v_t) THEN
    RAISE EXCEPTION 'an engine now holds a lease on this event; let it drive';
  END IF;

  ------------------------------------------------------------- void the dead hands
  -- Service authority for the F06 door, transaction-local. The door refuses any
  -- caller that is not the platform service; this migration IS the platform
  -- acting on its own event, and the grant is dropped again immediately below.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('app.smarter_data_actor', 'service', true);

  r := public.fn_f06_abort_abandoned_generation(v_t, v_gen, v_receipt,
    'Morning Free Buy (NLH) generation 29afae24 died at 2026-09-19 14:29 leaving two '
    || 'preflop hands staged and never dealt: no cards, no commits, no dispatch, and '
    || 'every chair still holding snapshot stack plus totalInvested. Missed by the '
    || '2026-09-22 cohort sweep. Voided so an adopting successor can take custody and '
    || 'the event can carry on, and so the restart certificate can close.', false);

  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('app.smarter_data_actor', '', true);

  IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the abandoned-generation abort was refused: %', r;
  END IF;
  IF COALESCE((r->>'credit')::numeric, -1) <> 0 THEN
    RAISE EXCEPTION 'the abort moved chips, which it must never do: %', r;
  END IF;
  RAISE NOTICE 'f06 abort -> %', r;

  ------------------------------------------------------------------- the assertions
  IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits
              WHERE tournament_id = v_t AND state = 'reserved') THEN
    RAISE EXCEPTION 'a reserved permit survived the void';
  END IF;
  -- Nothing moved: the felt, the roster and the escrow are exactly as they were.
  IF (SELECT count(*) FROM public.tournament_players
       WHERE tournament_id = v_t AND status = 'playing') <> 18
     OR (SELECT sum(chips) FROM public.tournament_players
          WHERE tournament_id = v_t AND status = 'playing') <> 338000 THEN
    RAISE EXCEPTION 'the void changed the roster, which it must never do';
  END IF;
  IF (SELECT count(*) FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.tournament_id = v_t AND ts.left_at IS NULL) <> 18
     OR (SELECT sum(ts.stack) FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
          WHERE tb.tournament_id = v_t AND ts.left_at IS NULL) <> 338000 THEN
    RAISE EXCEPTION 'the void changed the felt, which it must never do';
  END IF;
  IF (SELECT round(prize_balance, 2) FROM public.tournament_escrow
       WHERE tournament_id = v_t) <> 283.80
     OR (SELECT round(fee_balance, 2) FROM public.tournament_escrow
          WHERE tournament_id = v_t) <> 1.20 THEN
    RAISE EXCEPTION 'the void touched the escrow, which it must never do';
  END IF;
  IF (SELECT status FROM public.tournaments WHERE id = v_t) <> 'RUNNING' THEN
    RAISE EXCEPTION 'the void changed the event status, which it must never do';
  END IF;

  RAISE NOTICE 'Morning Free Buy: two staged hands voided, 18 seats and 338,000 chips untouched, 283.80 still in escrow';
END
$mig$;

-- The finding, recorded and resolved in the same transaction that answers it
-- (CLAUDE.md 10.9: the record is part of the fix). It is resolved as a void, not
-- as a payment, and the note says so plainly.
INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
SELECT 'critical',
       'tournament.stranded_event',
       'Morning Free Buy (NLH) 7c6277e7 has been RUNNING with 18 seated registrations, 338,000 '
       || 'chips and 283.80 of prize money held since its engine generation died on 2026-09-19, '
       || 'and its stranded hand permit was holding every engine release on the platform shut',
       jsonb_build_object(
         'tournament_id', '7c6277e7-921d-4651-91bc-15071a3884be',
         'tables', jsonb_build_array('9e432569-5ebc-467a-9972-e450dfc0b296',
                                     '26c00afc-b4a1-460c-ac0e-7894bb4c7efb',
                                     '244a2997-d7c8-4afc-a179-dac438c7f30a'),
         'dead_generation', '29afae24-5415-458f-acca-778b4f14444f',
         'last_hand_at', '2026-09-19T14:29:08.504+00:00',
         'hands_dealt', 283,
         'seated_registrations', 18,
         'chips_on_felt', 338000,
         'prize_pool', 283.80,
         'open_break', 'dce8ddb0-ac3a-469b-aadf-bcd1a3dac0c5'),
       true,
       now(),
       'Resolved by voiding the dead generation''s two staged hands in migration 20260923205828, '
       || 'through public.fn_f06_abort_abandoned_generation. NO MONEY WAS PAID AND NONE IS OWED '
       || 'YET: the event has no result. Its 18 registrations were never eliminated and hold live '
       || 'equity in a pool that pays three places, so 283.80 and 1.20 remain in tournament_escrow '
       || 'for the event to finish and pay properly. No hand was ever in the air - accepted F06 '
       || 'permits equalled dealt hands on all three tables (121/121, 88/88, 74/74), and the two '
       || 'permits still reserved carried zero hand_history rows, zero hole cards, zero atomic '
       || 'commits and zero dispatches, with each staged snapshot reconciling to the felt at '
       || 'stack + totalInvested, so the void moved no chips. No chips are stranded or destroyed: '
       || '24 entries at 3,000 plus 12 rebuys at 3,000 plus 23 add-ons at 10,000 is 338,000, '
       || 'exactly the total on the felt. All 24 registrations are horses and none was treated '
       || 'differently for it (CLAUDE.md 10.5). REMAINING: table 244a2997 still carries an open '
       || 'f06_operations row in state ''begun'' (break dce8ddb0, 7 of 8 seat moves unresolved), '
       || 'which no door on this tip can take terminal and which is what leaves the tournament '
       || 'manager stopped-but-registered. That root cause is owned by the F06 recovery work and '
       || 'is not duplicated here.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.financial_alerts
   WHERE source = 'tournament.stranded_event'
     AND context->>'tournament_id' = '7c6277e7-921d-4651-91bc-15071a3884be');

COMMIT;
