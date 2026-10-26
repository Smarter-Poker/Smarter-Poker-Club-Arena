-- 20261026042452_a_cancelled_freeroll_s_last_knockout_candidate_is_closed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CANCELLED FREEROLL'S LAST KNOCKOUT CANDIDATE IS CLOSED (2026-10-26)
--
-- Exactly one row in public.tournament_knockout_candidates is still
-- `pending` from an event that no longer exists: 607ad6b3, created
-- 2026-09-18 22:09:40 UTC when RexSr's 133,875 stack went to 0 in hand
-- 12941429 of "$100 Freeroll - 12:00 PM" (5a387a75). Before the door
-- resolved it, the event was CANCELLED on 2026-09-27 14:32:32.230182 UTC by
-- atomic_cancel_tournament, which refunded the field and marked every
-- entrant `eliminated` at that instant - RexSr included (position 14,
-- eliminated_at 2026-09-27 14:32:32.230182). It closed every seat and table
-- but never touched the candidate, so the candidate has said `pending` for
-- 37 days about a player the event's own roster has eliminated.
--
-- Read from rows on 2026-10-26: it is the ONLY unresolved candidate of any
-- terminal event (521 other candidates of cancelled events are resolved), and
-- the only candidate older than one minute anywhere in the table.
--
-- WHY NOTHING ELSE CHANGES. The cause is closed already: both cancellation
-- authorities (atomic_cancel_tournament and fn_poker_diamond_tournament_cancel)
-- now refuse any event that has started or dealt a hand, and a knockout
-- candidate exists only for a dealt hand, so a cancellation can no longer
-- leave one behind. 20261015024956 stopped the stalled-door read counting it.
-- This settles the one row that predates both.
--
-- NO MONEY MOVES. The event was a freeroll, its escrow closed at exact zero
-- in the cancellation receipt, and this table carries no trigger. The row is
-- closed as `eliminated` at the cancellation instant, which is what the
-- event's own roster already records for this player.
--
-- The assertions refuse unless the board is exactly as read: one pending row,
-- its event CANCELLED, its entrant already eliminated at the cancellation
-- time. A re-run finds nothing pending and changes nothing.
--
-- @live-proof: (SELECT state = 'eliminated' AND resolved_at = '2026-09-27 14:32:32.230182+00'::timestamptz FROM public.tournament_knockout_candidates WHERE id = '607ad6b3-abfc-4454-a285-5ee3a63ff5d8')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $close$
DECLARE
  v_status text;
  v_player_status text;
  v_player_eliminated_at timestamptz;
  v_rows integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates
     WHERE id = '607ad6b3-abfc-4454-a285-5ee3a63ff5d8' AND state = 'pending') THEN
    RAISE NOTICE 'candidate 607ad6b3 is no longer pending; nothing to close';
    RETURN;
  END IF;

  SELECT upper(t.status::text) INTO v_status
    FROM public.tournaments t
   WHERE t.id = '5a387a75-754a-416e-8fee-b85b15fc2702';
  IF v_status IS DISTINCT FROM 'CANCELLED' THEN
    RAISE EXCEPTION 'tournament 5a387a75 is %, expected CANCELLED', v_status;
  END IF;

  SELECT tp.status::text, tp.eliminated_at
    INTO v_player_status, v_player_eliminated_at
    FROM public.tournament_players tp
   WHERE tp.tournament_id = '5a387a75-754a-416e-8fee-b85b15fc2702'
     AND tp.user_id = '6fa1c8e2-c2bb-4168-b121-6281a549b94f';
  IF v_player_status IS DISTINCT FROM 'eliminated'
     OR v_player_eliminated_at IS DISTINCT FROM '2026-09-27 14:32:32.230182+00'::timestamptz THEN
    RAISE EXCEPTION 'entrant is % at %, expected eliminated at the cancellation',
      v_player_status, v_player_eliminated_at;
  END IF;

  UPDATE public.tournament_knockout_candidates
     SET state = 'eliminated',
         resolved_at = '2026-09-27 14:32:32.230182+00'::timestamptz
   WHERE id = '607ad6b3-abfc-4454-a285-5ee3a63ff5d8'
     AND tournament_id = '5a387a75-754a-416e-8fee-b85b15fc2702'
     AND eliminated_user_id = '6fa1c8e2-c2bb-4168-b121-6281a549b94f'
     AND state = 'pending'
     AND resolved_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'closed % candidate rows, expected exactly 1', v_rows;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_knockout_candidates c
      JOIN public.tournaments t ON t.id = c.tournament_id
     WHERE c.state = 'pending'
       AND upper(t.status::text) IN ('CANCELLED', 'CANCELED', 'COMPLETED')) THEN
    RAISE EXCEPTION 'a terminal event still has a pending knockout candidate';
  END IF;
END
$close$;

COMMIT;
