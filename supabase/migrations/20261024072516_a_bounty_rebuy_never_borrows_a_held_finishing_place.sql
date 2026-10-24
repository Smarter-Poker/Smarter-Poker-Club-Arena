-- 20261024072516_a_bounty_rebuy_never_borrows_a_held_finishing_place
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-24 07:25:16 UTC.
--
-- WHAT WAS WRONG
--
-- Dan, 2026-10-24, on "3K GTD Friday Fight Night PKO" (827a1b52): 276 entries
-- and 9 rebuys - "THIS LOOKS FAKE". Measured on production:
--
--   * 36 horse busts landed inside the rebuy window. The horse input device
--     (horseTournamentRebuyChoice, 45% at the time) chose YES on 16 of them,
--     but only 9 purchases committed.
--   * The other 7 were refused by the database on every attempt for the whole
--     30 second decision window, then eliminated. Postgres logged the reason:
--       "finishing place 241 in tournament 827a1b52 is already held by
--        1c7fc49a - refusing to stamp 294fd624 on it"
--     with context fn_claim_bounty_legacy_candidate_20260907 <-
--     fn_ca_settle_bounty_rebuy_generation_v1 <- process_tournament_rebuy.
--   * Platform-wide in the 24 hours to 07:30 UTC, process_tournament_rebuy was
--     refused 5,846 times by that one trigger - more than every other refusal
--     reason combined. Horse rebuy share on bounty/PKO/mystery events fell to
--     2-7% per three-hour bucket, against ~45% on non-bounty events.
--
-- THE LINE THAT PRODUCED IT
--
-- A bounty rebuy first settles the old head through the legacy claim, whose
-- outbox schema requires a field position, so fn_ca_settle_bounty_rebuy_
-- generation_v1 stamps a TEMPORARY position (prize 0; the money core clears it
-- again before commit). It chose that position as
--     GREATEST(2, count(*) of status='playing')
-- Places are handed out bottom-up from the same count, so that number is very
-- often the place the most recent real elimination already holds.
-- trg_tournament_place_collision then (correctly) refuses the duplicate and
-- the whole purchase rolls back. Nothing in the retry changes the count, so
-- the purchase fails identically until the decision deadline expires.
--
-- THE FIX
--
-- Start from the same field count, step down to the nearest place no other
-- entrant holds, and if every place from there to 2 is held, take the first
-- place above the highest held one. The value stays a plausible field
-- position, it can never collide, and nothing else in the step changes: the
-- obligation still records it, the prize stays 0, and the money core still
-- clears it. All of this runs under the tournament row lock and settlement
-- lane the caller already holds, so no concurrent elimination can take the
-- chosen place inside this transaction.
--
-- The live function is patched by exact anchor, not re-typed: the installed
-- body has drifted from its 20260911052648 source, so this refuses to run
-- unless the installed body is the measured md5 below (or already patched).
-- One transaction, one CREATE OR REPLACE (CLAUDE.md section 2 DDL policy);
-- no hot-table lock is taken, so it does not need the daily install window.
--
-- Pinned by tests/a-bounty-rebuy-never-borrows-a-held-finishing-place.law.test.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $a_bounty_rebuy_never_borrows_a_held_place$
DECLARE
  v_sig constant regprocedure :=
    'public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)'::regprocedure;
  v_marker constant text := 'A BOUNTY REBUY NEVER BORROWS A HELD FINISHING PLACE';
  v_src text;
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig;
  IF position(v_marker IN v_src) > 0 THEN
    RETURN; -- already installed
  END IF;
  IF md5(v_src) <> '9ff3e2ce1a8207df2830c1358da94c66' THEN
    RAISE EXCEPTION 'fn_ca_settle_bounty_rebuy_generation_v1 body changed (md5 %); refusing to patch a body this migration did not measure', md5(v_src);
  END IF;

  v_def := pg_get_functiondef(v_sig);

  v_old := $old$    SELECT GREATEST(2,count(*)::integer) INTO v_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.status='playing';
$old$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'temporary-position anchor is not present exactly once';
  END IF;

  v_new := $new$    SELECT GREATEST(2,count(*)::integer) INTO v_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.status='playing';
    -- A BOUNTY REBUY NEVER BORROWS A HELD FINISHING PLACE (2026-10-24).
    -- The field count is very often the place the latest real elimination
    -- already holds; trg_tournament_place_collision refuses that duplicate
    -- and the whole purchase rolls back on every retry. Step down to the
    -- nearest place nobody else holds; if 2..count are all held, take the
    -- first place above the highest held one.
    WHILE v_position>2 AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.position=v_position
         AND tp.user_id<>p_user_id) LOOP
      v_position:=v_position-1;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.position=v_position
         AND tp.user_id<>p_user_id) THEN
      SELECT GREATEST(2,COALESCE(max(tp.position),1)+1) INTO v_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.user_id<>p_user_id;
    END IF;
$new$;

  EXECUTE replace(v_def, v_old, v_new);

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig;
  IF position(v_marker IN v_src) = 0 THEN
    RAISE EXCEPTION 'patched body did not install';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_sig
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'patched function lost its security definer, settings or private grant';
  END IF;
END
$a_bounty_rebuy_never_borrows_a_held_place$;

COMMIT;
