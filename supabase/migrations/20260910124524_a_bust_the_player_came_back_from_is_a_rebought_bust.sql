-- a_bust_the_player_came_back_from_is_a_rebought_bust
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A one-time correction, and the evidence for it.
--
-- fn_eliminate_tournament_player_atomic refuses a bust with
-- `unresolved_knockout_generation_chain` when the player has an OLDER knockout
-- candidate whose state is not `rebought`: an earlier bust that was never
-- accounted for makes the later one unsafe to record, which is the right rule.
-- The engine's assignment pass aborts on the first refusal, so ONE such row
-- freezes an entire event - $100 Freeroll 12:00 PM (7aa16fa7, 55 busted
-- players, 216.00 in escrow) and Early Bird Freeroll (a5aa6984, 12 busted,
-- 102.00) have been refusing the same player every fifteen seconds since
-- 2026-09-08.
--
-- WHAT THE ROWS SAY. Seventeen candidates platform-wide are `pending` while a
-- STRICTLY NEWER candidate exists for the same player in the same event, and
-- for all seventeen that newer candidate has `stack_before > 0`. A player
-- cannot lose chips they never had: holding chips after the earlier bust is
-- proof they came back from it. 5e94c522 in 7aa16fa7 is the worked example -
-- busted at hand 8259513 (5,000 -> 0) at 18:03:43, `rebuys = 2` with two
-- `rebuy` legs at 18:03:50 and 18:30:36, a new seat at 18:04:11, and a second
-- bust at hand 8270532 holding 2,179. The rebuy happened; the candidate was
-- never marked.
--
-- So the correction writes what the rebuy would have written: state `rebought`,
-- resolved now. It touches ONLY rows that carry that proof, and it is not a
-- repair job - it runs once, it is not scheduled, and nothing about it is
-- allowed to guess: a candidate whose successor shows no chips is left alone
-- and would abort this migration.
--
-- Every one of the seventeen was created on 2026-09-08 or 2026-09-09; none
-- today. The engine-side hardening that stops one blocked player freezing an
-- event ships with it in the same branch (a bust pass that has already refused
-- the same player three times records the rest of the field and says so).
--
-- No money moves here. These players' entitlements are computed by the knockout
-- door when it records their finish, which is what this unblocks.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_total integer;
  v_unproven integer;
  v_rows integer;
BEGIN
  WITH chain AS (
    SELECT c.id,
           (SELECT c2.stack_before
              FROM public.tournament_knockout_candidates c2
             WHERE c2.tournament_id = c.tournament_id
               AND c2.eliminated_user_id = c.eliminated_user_id
               AND c2.hand_number > c.hand_number
             ORDER BY c2.hand_number
             LIMIT 1) AS next_stack_before
      FROM public.tournament_knockout_candidates c
     WHERE c.state = 'pending'
       AND EXISTS (SELECT 1 FROM public.tournament_knockout_candidates c2
                    WHERE c2.tournament_id = c.tournament_id
                      AND c2.eliminated_user_id = c.eliminated_user_id
                      AND c2.hand_number > c.hand_number)
  )
  SELECT count(*), count(*) FILTER (WHERE COALESCE(next_stack_before, 0) <= 0)
    INTO v_total, v_unproven
    FROM chain;

  IF v_total = 0 THEN
    RAISE EXCEPTION 'no unresolved knockout chain remains; this migration is being applied against a board it does not describe';
  END IF;
  IF v_unproven <> 0 THEN
    RAISE EXCEPTION '% of % chained candidates have a successor that held no chips - that is not proof of a comeback and this correction refuses to guess', v_unproven, v_total;
  END IF;

  UPDATE public.tournament_knockout_candidates c
     SET state = 'rebought', resolved_at = COALESCE(c.resolved_at, clock_timestamp())
   WHERE c.state = 'pending'
     AND EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c2
        WHERE c2.tournament_id = c.tournament_id
          AND c2.eliminated_user_id = c.eliminated_user_id
          AND c2.hand_number > c.hand_number
          AND c2.stack_before > 0);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_total THEN
    RAISE EXCEPTION 'resolved % chained candidate(s), expected %', v_rows, v_total;
  END IF;

  -- post-condition: no player anywhere still holds an unresolved earlier bust
  SELECT count(*) INTO v_total
    FROM public.tournament_knockout_candidates c
   WHERE c.state = 'pending'
     AND EXISTS (SELECT 1 FROM public.tournament_knockout_candidates c2
                  WHERE c2.tournament_id = c.tournament_id
                    AND c2.eliminated_user_id = c.eliminated_user_id
                    AND c2.hand_number > c.hand_number);
  IF v_total <> 0 THEN
    RAISE EXCEPTION '% unresolved knockout chain(s) remain after the correction', v_total;
  END IF;
END
$body$;

COMMIT;
