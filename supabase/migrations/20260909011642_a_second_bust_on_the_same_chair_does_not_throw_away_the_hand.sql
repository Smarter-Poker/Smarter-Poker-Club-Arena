-- 20260909011642_a_second_bust_on_the_same_chair_does_not_throw_away_the_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  AN UNHANDLED CONFLICT TARGET WAS DISCARDING DEALT HANDS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tournament_knockout_candidates` carries TWO unique constraints:
--
--   tournament_knockout_candidate_tournament_id_hand_number_eli_key
--     UNIQUE (tournament_id, hand_number, eliminated_user_id)
--   tournament_knockout_candidate_tournament_id_eliminated_user_key
--     UNIQUE (tournament_id, eliminated_user_id, seat_joined_at)
--
-- The knockout insert inside `fn_ca_commit_hand_settlement_before_lease_generation`
-- named only the first one:
--
--     ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING
--
-- An `ON CONFLICT` with an explicit target does not absorb a violation of any
-- OTHER constraint. So when the same player busts a SECOND time from the SAME
-- chair - which is the ordinary rebuy shape, because a rebuy credits chips
-- without a new seat row and `seat_joined_at` therefore does not move - the
-- second constraint raised, and the raise took the WHOLE atomic hand commit
-- with it.
--
-- The hand was dealt, played and settled, and then thrown away. The engine
-- reported it as `authoritative_hand_semantic_refusal`, filed a critical
-- `financial_alerts` row, and self-terminated the table engine for a restart.
-- Measured on production 2026-09-09: 19 in twenty minutes, part of 312
-- criticals in three hours, and 37 table-engine kills in the same window.
--
-- THE FIX IS TWO HALVES, AND BOTH ARE NEEDED.
--
--   1. Absorb every unique violation, not one of them: bare `ON CONFLICT DO
--      NOTHING`. A knockout candidate is a record that a player busted; a
--      second one for the same chair is not new information and must never
--      cost a table its hand.
--
--   2. Teach the identity re-check what it is now allowed to see. It verified
--      that the conflicting row was an exact replay of THIS hand, and a second
--      bust on the same chair is a different hand number, so leaving it alone
--      would swap a constraint violation for a hand-killing RAISE. It now also
--      accepts an existing candidate for this tournament, player and seat
--      generation - the case the second constraint exists to describe. Anything
--      else still raises, so a genuine identity conflict is as loud as it was.
--
-- The first bust stays the operative one and is deliberately NOT overwritten:
-- it is the witness that was there (CLAUDE.md 10.9), and
-- `fn_eliminate_tournament_player_atomic` resolves generations from it.
--
-- HOW THIS EDITS THE FUNCTION. The body is 13KB and carries the whole hand
-- settlement. Retyping it to change one statement risks silently dropping
-- another, so this reads the LIVE definition, does a literal replace of the two
-- blocks, and refuses to proceed if either is not found or if the result does
-- not contain both replacements. That is the pattern
-- 20260828041248_the_union_law_check_follows_the_money.sql established for
-- exactly this situation.
--
-- ROLLBACK
--   Re-apply the previous definition from
--   supabase/migrations/*_an_accepted_hand_is_one_commit_*.sql, or reverse the
--   two literal replaces below.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_old_conflict CONSTANT text :=
    'ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING';
  v_new_conflict CONSTANT text :=
    'ON CONFLICT DO NOTHING';
  v_old_check CONSTANT text :=
             'AND c.stack_before=v_before
             AND c.stack_after=0) THEN';
  v_new_check CONSTANT text :=
             'AND c.stack_before=v_before
             AND c.stack_after=0)
           AND NOT EXISTS (
          SELECT 1 FROM public.tournament_knockout_candidates c2
           WHERE c2.tournament_id=v_tournament_id
             AND c2.eliminated_user_id=v_uid
             AND c2.seat_joined_at=v_seat.joined_at) THEN';
BEGIN
  v_src := pg_get_functiondef(
    'public.fn_ca_commit_hand_settlement_before_lease_generation'::regproc);

  IF position(v_old_conflict in v_src) = 0 THEN
    RAISE EXCEPTION
      'the targeted ON CONFLICT clause is not in the live definition - it has already been changed; read it before re-running this migration';
  END IF;
  IF position(v_old_check in v_src) = 0 THEN
    RAISE EXCEPTION
      'the knockout identity re-check is not in the live definition in the shape this migration expects; read it before re-running';
  END IF;

  v_new := replace(v_src, v_old_conflict, v_new_conflict);
  v_new := replace(v_new, v_old_check, v_new_check);

  -- Prove the edit landed, and that nothing else moved: the body must still
  -- carry the settlement's own landmarks.
  IF position(v_new_conflict in v_new) = 0
     OR position('AND c2.seat_joined_at=v_seat.joined_at' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  IF position('INSERT INTO public.tournament_knockout_candidates' in v_new) = 0
     OR position('rebuy_prompt_until' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the hand settlement went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

-- Grants restated, unchanged, and deliberately NOT widened. The live ACL on
-- this function is `postgres` alone: it is not called over PostgREST at all,
-- only from inside the settlement's own definer chain, so it needs no
-- service_role grant and must not be given one. PUBLIC is named alongside the
-- browser roles on purpose - revoking a role while PUBLIC still holds the grant
-- reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMIT;
