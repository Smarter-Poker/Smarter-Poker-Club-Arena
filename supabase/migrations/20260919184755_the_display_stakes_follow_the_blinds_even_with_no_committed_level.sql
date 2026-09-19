-- 20260919184755_the_display_stakes_follow_the_blinds_even_with_no_committed_level
--
-- Applied to production as version 20260919184206 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- READ WITH ITS PAIR: 20260919184835. This migration alone does NOT stop the
-- live drift, and the note at the end of this header says how that was found
-- out. Both are needed.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- public.tables.stakes is a display string that must agree with the same
-- row's small_blind and big_blind. It is maintained by a cron job,
-- reconcile-tournament-denormals, which runs EVERY MINUTE and whose second
-- branch is an UPDATE that rewrites stakes for tables whose tournament is
-- REGISTERING, ANNOUNCED or RUNNING.
--
-- MEASURED 2026-09-19 over all 272,707 rows of public.tables:
--
--   tournament tables                                     265,022
--   tournament tables whose stakes contradicts own blinds   40,998  (15.5%)
--   of those, inside the minutely job's status scope             0
--   of those, outside it                                    40,998
--
-- The job holds the invariant exactly where anyone would look for it and
-- nowhere else. Two distinct writer defects are visible in the stored values:
--
--   'undefined/undefined'   28,651 rows, 432 tournaments, Apr 13 to May 2
--   stale blind levels      12,347 rows, e.g. '10/20' on a table whose blinds
--                           have since advanced
--
-- The first is a JavaScript template literal reaching the database:
-- server/src/tournament/TournamentManagerBase.ts:6497 writes
-- `${firstLevel.smallBlind}/${firstLevel.bigBlind}`, which yields the literal
-- text 'undefined/undefined' when that level object is incomplete. No rows of
-- that shape have been produced since May 2026, so that path is already fixed;
-- the rows remain as history.
--
-- THE PART THAT IS STILL LIVE. 20260913200859 added the right authority: a
-- BEFORE trigger, fn_tournament_table_inherits_committed_blinds, which takes
-- the tournament's committed blind level and derives stakes from it. It is
-- correct for what it covers. It covers less than it looks:
--
--   IF v_state IS NULL THEN RETURN NEW; END IF;
--
-- When a tournament has no blind_level_state the trigger returns and leaves
-- whatever string the caller supplied. MEASURED: 167,997 tournaments have
-- blind_level_state IS NULL, 346 of them currently active. For all of those,
-- nothing in the schema constrains stakes at all and the minutely UPDATE is
-- the only thing keeping it true.
--
-- ===========================================================================
-- THE BAND-AID THAT WAS REFUSED
--
-- A generated column is the strongest form and was measured before being
-- rejected: public.tables is 222 MB over 272,707 rows with 20 indexes, and
-- adding a stored generated column rewrites the whole table under ACCESS
-- EXCLUSIVE while 194 tables are dealing. It also forbids every writer from
-- supplying stakes at all, which means changing five functions that currently
-- do. Correct, and not safe to do while the felt is live.
--
-- Widening the cron job is the thing the brief forbids by name.
--
-- The hole is in the authority that already exists, so the fix belongs there.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- One branch. When no blind level is committed, stakes is still derived from
-- the row's own blinds instead of being taken from the caller. Everything else
-- is byte-for-byte unchanged, and the current body is asserted before the
-- replacement so this refuses rather than clobbering a body that has moved.
--
-- Cash tables are untouched: the trigger's first statement returns when
-- tournament_id IS NULL, ahead of this branch. That matters, because cash
-- tables use a DIFFERENT format (fn_cash_stakes_label, via fn_cash_money_text)
-- and 1,090 of them carry a '$0.05/$0.10' form this expression would destroy.
--
-- ===========================================================================
-- WHAT THIS MIGRATION DID NOT DO, AND HOW THAT WAS FOUND
--
-- Every structural assertion below passed, and the live drift was untouched.
-- A BEHAVIOURAL probe run immediately after applying this wrote the value
-- 'PROBE/WRONG' to a real row from an ended tournament and read it back:
--
--   PROBE FAILED: trigger did not normalise; stakes is still PROBE/WRONG
--
-- fn_tournament_table_inherits_committed_blinds is registered BEFORE INSERT
-- ONLY. It has never run on an UPDATE, which is how stakes drifts. That is
-- fixed by its pair, 20260919184835. This file is still required: it closes
-- the INSERT path for the 167,997 tournaments with no committed level.
--
-- The lesson is the one the estate keeps relearning: a structural assertion
-- proves the text changed, not that the behaviour did.
--
-- @live-proof: (SELECT position('NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_tournament_table_inherits_committed_blinds')
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_tournament_table_inherits_committed_blinds';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'failed: fn_tournament_table_inherits_committed_blinds does not exist';
  END IF;

  -- Refuse rather than clobber a body that has moved since it was measured.
  IF position('IF v_state IS NULL THEN RETURN NEW; END IF;' in v_src) = 0
     AND position('NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the early return this migration rewrites is not present; the body has changed';
  END IF;
  IF position('Tournament table cannot inherit an unconfirmed blind level' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the unconfirmed-level refusal is missing; this is not the body that was read';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_tournament_table_inherits_committed_blinds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_level integer; v_state jsonb;
BEGIN
  IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;
  SELECT current_level,blind_level_state INTO v_level,v_state
    FROM public.tournaments WHERE id=NEW.tournament_id FOR SHARE;
  IF v_state IS NULL THEN
    -- No committed level to inherit. The display string is still a function of
    -- this row's own blinds, so derive it rather than trusting the caller:
    -- that is what let 'undefined/undefined' and stale levels be stored, and
    -- what left a minutely cron UPDATE as the only thing holding the invariant
    -- for the 167,997 tournaments with no blind_level_state.
    IF NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL THEN
      NEW.stakes := trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
    END IF;
    RETURN NEW;
  END IF;
  IF (v_state->>'index')::integer IS DISTINCT FROM v_level THEN
    RAISE EXCEPTION 'Tournament table cannot inherit an unconfirmed blind level';
  END IF;
  NEW.small_blind:=(v_state->>'small_blind')::numeric;
  NEW.big_blind:=(v_state->>'big_blind')::numeric;
  NEW.ante:=(v_state->>'ante')::numeric;
  NEW.stakes:=trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
  RETURN NEW;
END;
$function$;

DO $verify$
DECLARE
  v_src text;
  v_cash_pos int; v_null_branch_pos int;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_tournament_table_inherits_committed_blinds';

  -- The new branch is present.
  IF position('NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the no-committed-level branch did not take';
  END IF;

  -- THE OTHER DIRECTION (the 7.2 rule). Deriving stakes for everything would
  -- also satisfy the assertion above, and would rewrite 7,685 cash tables into
  -- a format their own label function does not produce. The cash early return
  -- must still come FIRST.
  v_cash_pos        := position('IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;' in v_src);
  v_null_branch_pos := position('NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL' in v_src);
  IF v_cash_pos = 0 THEN
    RAISE EXCEPTION 'failed: the cash early return is gone; cash stakes would be rewritten';
  END IF;
  IF v_cash_pos >= v_null_branch_pos THEN
    RAISE EXCEPTION 'failed: the cash early return no longer precedes the derivation';
  END IF;

  -- The committed path is still the authority it was.
  IF position('Tournament table cannot inherit an unconfirmed blind level' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the unconfirmed-level refusal was lost';
  END IF;

  RAISE NOTICE 'stakes now follows its own blinds on every tournament INSERT path; cash untouched';
END
$verify$;

COMMIT;
