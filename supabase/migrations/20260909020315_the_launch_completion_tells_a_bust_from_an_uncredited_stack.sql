-- 20260909020315_the_launch_completion_tells_a_bust_from_an_uncredited_stack.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE SAME TRAP, ONE LEVEL DOWN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- #3912 fixed `proveTournamentLaunchSetup` in the engine: `chips > 0` on every
-- roster row cannot tell "the stacks were never credited" from "they were
-- credited and then played for", and it wedged Spins in REGISTERING for hours.
-- Conservation separates them, so that is what the engine now asserts.
--
-- **The fix did not land.** The wedged Spins simply moved to the next refusal:
-- `Tournament.launch_setup_unproven` became
-- `Tournament.launch_completion_unproven (launch_roster_unproven)`, 24 in six
-- minutes, because `fn_complete_tournament_launch_before_lease_generation`
-- carries the IDENTICAL rule in SQL - twice:
--
--     OR COALESCE(p.chips, 0) <= 0     -- the roster
--     OR COALESCE(s.stack, 0) <= 0     -- the felt
--
-- This is CLAUDE.md 10.86 rule 4 exactly: "a fix that leaves the same trap one
-- level up has not landed. When you fix something, ask what the next person
-- will reach for, and check that it works." I checked the engine and shipped.
-- The database was the next thing the code reached for.
--
-- THE RULE, matched to the engine so the two halves cannot disagree:
--
--   * a NEGATIVE or absent stack is still refused - that is impossible, not
--     busted;
--   * a ZERO stack is accepted, because a player who lost their chips at a
--     table that dealt before the launch was proven is busted, not uncredited;
--   * and the FIELD must still hold what it was bought for. An uncredited
--     field is short of `active_players x starting_chips`; a field that has
--     been played still adds up to it. Early-bird bonuses and rebuys only ever
--     add, so the expected total is a floor, not an equality. A field where
--     nothing was credited sums to zero and is refused by the new
--     `launch_stacks_uncredited` reason - which is the whole point of the
--     original check, kept.
--
-- Both the roster and the felt get the conservation test, because both carried
-- the per-row rule.
--
-- HOW THIS EDITS THE FUNCTION. The body is 7KB and owns the RUNNING status
-- transaction. Retyping it to change two predicates risks silently dropping one
-- of the other five proofs, so this reads the LIVE definition, does three
-- literal replaces, and refuses to proceed if any anchor is missing or if any
-- of the other refusal reasons goes missing from the result. Same pattern as
-- 20260828041248_the_union_law_check_follows_the_money.sql.
--
-- Anchor uniqueness was verified read-only against production before writing
-- this: each of the three appears exactly once.
--
-- ROLLBACK
--   Reverse the three replaces below; each quotes its before and after in full.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_old_roster  CONSTANT text := 'OR COALESCE(p.chips, 0) <= 0';
  v_new_roster  CONSTANT text := 'OR COALESCE(p.chips, 0) < 0';
  v_old_seat    CONSTANT text := 'OR COALESCE(s.stack, 0) <= 0';
  v_new_seat    CONSTANT text := 'OR COALESCE(s.stack, 0) < 0';
  v_old_if      CONSTANT text :=
    'IF v_active_count < v_required_field OR v_bad_roster_count <> 0 THEN';
  v_new_if      CONSTANT text :=
'IF (SELECT COALESCE(sum(p2.chips), 0)
         FROM public.tournament_players p2
        WHERE p2.tournament_id = p_tournament_id
          AND p2.status IN (''registered'', ''playing''))
      < v_active_count * COALESCE(
          (SELECT t2.starting_chips FROM public.tournaments t2
            WHERE t2.id = p_tournament_id), 0)
     OR (SELECT COALESCE(sum(s2.stack), 0)
           FROM public.table_seats s2
           JOIN public.tables t3 ON t3.id = s2.table_id
          WHERE t3.tournament_id = p_tournament_id
            AND s2.left_at IS NULL)
        < v_active_count * COALESCE(
            (SELECT t2.starting_chips FROM public.tournaments t2
              WHERE t2.id = p_tournament_id), 0) THEN
    RETURN jsonb_build_object(
      ''ok'', false,
      ''reason'', ''launch_stacks_uncredited'',
      ''active_players'', v_active_count
    );
  END IF;

  IF v_active_count < v_required_field OR v_bad_roster_count <> 0 THEN';
BEGIN
  v_src := pg_get_functiondef(
    'public.fn_complete_tournament_launch_before_lease_generation'::regproc);

  IF position(v_old_roster in v_src) = 0
     OR position(v_old_seat in v_src) = 0
     OR position(v_old_if in v_src) = 0 THEN
    RAISE EXCEPTION
      'the live definition is not the shape this migration expects; read it before re-running';
  END IF;

  v_new := replace(v_src, v_old_roster, v_new_roster);
  v_new := replace(v_new, v_old_seat, v_new_seat);
  v_new := replace(v_new, v_old_if, v_new_if);

  IF position('launch_stacks_uncredited' in v_new) = 0
     OR position(v_old_roster in v_new) <> 0
     OR position(v_old_seat in v_new) <> 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;

  -- Every other proof this function performs must survive the edit.
  IF position('launch_receipt_state_mismatch' in v_new) = 0
     OR position('launch_roster_unproven' in v_new) = 0
     OR position('launch_seats_unproven' in v_new) = 0
     OR position('launch_tables_unproven' in v_new) = 0
     OR position('launch_spin_settlement_unproven' in v_new) = 0
     OR position('tournament launch status changed inside its completion transaction' in v_new) = 0 THEN
    RAISE EXCEPTION 'a proof went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

-- Grants restated, unchanged and deliberately not widened: the live ACL is
-- `postgres` alone. This is the RUNNING status transaction, reached only from
-- inside the launch's own definer chain, and no browser role has ever been able
-- to call it. PUBLIC is named alongside the browser roles on purpose - revoking
-- a role while PUBLIC still holds the grant reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMIT;
