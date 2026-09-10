-- the_busts_the_door_can_now_accept_are_recorded
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- a_place_is_not_a_bounty corrected the knockout door at 14:58 and it began
-- accepting busts it had refused for days: 62 stranded busts across ten events
-- fell to 27. The 27 left are the ones whose hand cannot name an exact pot
-- claimant, and for those the ENGINE never calls the door at all - it loads
-- bounty evidence first and returns before asking. That is fixed too
-- (fix/the-engine-asks-the-door), but engine code only goes live at a :55
-- cutover, and these players have been unranked for up to 44 hours while their
-- events hold prize escrow that has nothing to do with bounties.
--
-- The door is already correct. This calls it, once, for the busts it can now
-- accept - through the platform's own idempotent money path, never around it
-- (CLAUDE.md 10.9 rule 2). It manufactures nothing: every candidate it passes
-- was written by the live engine at the moment of the bust, and the door
-- re-proves the atomic receipt, the settlement idempotency key, the history
-- roster and the seat generation before it accepts anything. A candidate that
-- cannot pass those is left exactly where it is.
--
-- THE PLACE, derived the way the engine derives it rather than invented:
-- TournamentManagerEliminations sorts busts by hand_number ASCENDING
-- (compareBusted -> bustRank) and walks nextPosition DOWNWARD from
-- GREATEST(unplaced, playing, count+1). So the EARLIEST bust takes the worst
-- remaining place and the latest takes the best, which is what actually
-- happened at the table. Taken places are skipped, and nothing is ever
-- assigned below 2.
--
-- THE PRIZE IS ZERO, and that is not a shortcut. The elimination RPC records a
-- PROVISIONAL place and moves no place money: "Tournament completion normalizes
-- the final standings and pays the immutable place-plus-Bubble plan in one
-- all-or-none database transaction." Every one of the 65 obligations already
-- settled in 9320fe50 carries prize 0.00 for the same reason. Passing anything
-- else here would be this migration pricing a payout, which is the terminal
-- batch's job.
--
-- Bounded, and it proves its own outcome: only events fn_ca_absent_tournament_players
-- is reporting right now, only `pending` candidates, at most 200 doors opened,
-- and afterwards NO event it touched may hold a duplicate finishing place or a
-- placeless eliminated row. If either check fails the whole transaction is
-- discarded and nothing was recorded.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_t record;
  v_c record;
  v_res jsonb;
  v_place integer;
  v_next integer;
  v_playing integer;
  v_unplaced integer;
  v_pending integer;
  v_recorded integer := 0;
  v_refused integer := 0;
  v_blocked integer := 0;
  v_bad integer;
  v_touched uuid[] := ARRAY[]::uuid[];
BEGIN
  -- the corrected door must be live, or this just repeats the old refusals
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname = 'fn_claim_bounty_legacy_candidate_20260907'
       AND position('A PLACE IS NOT A BOUNTY' IN pg_get_functiondef(p.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'the knockout door has not been corrected; nothing here would be accepted';
  END IF;

  FOR v_t IN
    SELECT DISTINCT a.tournament_id AS tid
      FROM public.fn_ca_absent_tournament_players() a
      JOIN public.tournaments t ON t.id = a.tournament_id
     WHERE t.status = 'RUNNING'
     ORDER BY 1
  LOOP
    SELECT count(*) INTO v_playing
      FROM public.tournament_players p
     WHERE p.tournament_id = v_t.tid AND p.status = 'playing';
    SELECT count(*) INTO v_unplaced
      FROM public.tournament_players p
     WHERE p.tournament_id = v_t.tid AND p.position IS NULL;
    SELECT count(*) INTO v_pending
      FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id = v_t.tid AND c.state = 'pending';
    CONTINUE WHEN v_pending = 0;

    v_next := GREATEST(v_unplaced, v_playing, v_pending + 1);
    v_touched := v_touched || v_t.tid;

    FOR v_c IN
      SELECT c.* FROM public.tournament_knockout_candidates c
       WHERE c.tournament_id = v_t.tid AND c.state = 'pending'
       ORDER BY c.hand_number, c.id
    LOOP
      EXIT WHEN v_recorded + v_refused + v_blocked >= 200;

      -- the highest free place at or below the walk position, never below 2
      SELECT max(g) INTO v_place
        FROM generate_series(2, GREATEST(v_next, 2)) g
       WHERE NOT EXISTS (
         SELECT 1 FROM public.tournament_players p
          WHERE p.tournament_id = v_t.tid AND p.position = g);
      IF v_place IS NULL THEN
        v_refused := v_refused + 1;
        CONTINUE;
      END IF;

      v_res := public.fn_claim_tournament_bounty_elimination(
        v_t.tid, v_c.eliminated_user_id, v_place, 0,
        v_c.table_id, v_c.hand_id, v_c.hand_number, v_c.seat_joined_at,
        NULL, NULL, 0, false);

      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_recorded := v_recorded + 1;
        IF COALESCE(v_res->>'bounty_blocked', '') <> '' THEN
          v_blocked := v_blocked + 1;
        END IF;
        v_next := v_place - 1;
      ELSE
        -- the door re-proves every piece of evidence; one it will not accept
        -- stays exactly where it is rather than being forced
        v_refused := v_refused + 1;
      END IF;
    END LOOP;
  END LOOP;

  IF v_recorded = 0 THEN
    RAISE EXCEPTION 'the door accepted none of the stranded busts; nothing to record and this migration should not have been written';
  END IF;

  -- NOTHING may have been given a place somebody else already holds
  SELECT count(*) INTO v_bad FROM (
    SELECT p.tournament_id, p.position
      FROM public.tournament_players p
     WHERE p.tournament_id = ANY (v_touched) AND p.position IS NOT NULL
     GROUP BY p.tournament_id, p.position HAVING count(*) > 1) d;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% duplicate finishing place(s) were created; discarding every elimination in this transaction', v_bad;
  END IF;

  -- and nothing may have been eliminated without one
  SELECT count(*) INTO v_bad
    FROM public.tournament_players p
   WHERE p.tournament_id = ANY (v_touched)
     AND p.status = 'eliminated' AND p.position IS NULL;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% eliminated row(s) have no finishing place; discarding every elimination in this transaction', v_bad;
  END IF;

  RAISE NOTICE 'recorded % bust(s) across % event(s); % had an unattributable head; % left for the door to judge another time',
    v_recorded, coalesce(array_length(v_touched, 1), 0), v_blocked, v_refused;
END
$body$;

COMMIT;
