-- 20260924105049_a_player_is_not_eliminated_from_a_game_that_never_started
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-24 10:50:49 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THE GAME THAT PLAYED WITHOUT EVER STARTING
--
-- THE REPORT. Thirteen Spin tournaments have sat in REGISTERING since
-- 2026-09-08 holding player money, and public.fn_spin_expire_unfilled, the
-- function whose job is to refund a Spin nobody filled, has never freed one
-- of them. The obvious reading is that nothing calls it. That reading is
-- wrong twice over, and the real defect is upstream of it.
--
-- WHAT IS ACTUALLY TRUE, measured on production 2026-09-24 10:38 to 10:50 UTC:
--
--   (a) fn_spin_expire_unfilled IS called. server/src/GameServer.ts runs it
--       on the engine's own ten-minute timer, and the World Hub sweep calls
--       it too. No pg_cron job calls it, deliberately and by comment.
--
--   (b) It is REFUSING these thirteen, correctly. Each one has drawn: a
--       jackpot_draw row in spin_reserve_ledger and spin_multiplier = 2 on
--       the tournament row. A drawn Spin is never expired, because
--       cancelling it would unwind a committed reserve draw. The refusal is
--       the guard working, not the guard failing.
--
--   (c) They are not unfilled. Every one collected THREE buy-ins:
--       tournament_escrow.gross_in = 3 x buy_in on all thirteen, 669.00
--       collected in total, 446.00 still held as prize_balance and 53.52 as
--       fee_balance, nothing paid out and nothing refunded.
--
--   (d) They PLAYED. All thirty-nine registrations carry status 'eliminated'
--       or 'playing', with finishing positions 2 and 3 recorded and chip
--       stacks distributed. Eleven of the thirteen have two players
--       eliminated, which in a three-handed Spin means a winner was decided.
--       That winner's prize sits in escrow and was never paid.
--
-- So these games dealt, played, and in eleven cases finished, while
-- tournaments.started_at stayed NULL and tournaments.status stayed
-- REGISTERING. That single fact is the defect, and it is what puts the money
-- out of reach:
--
--   * the unfilled-Spin expiry refuses them, because they have drawn;
--   * the crash sweep and the finished-but-not-completed sweep cannot see
--     them, because both key on a tournament that started;
--   * the payout machinery cannot see them, for the same reason;
--   * and they can never launch again: fn_spin_draw_and_settle_atomic must
--     prove three paid entrants in status 'registered' or 'playing', and
--     eleven of these have exactly one left.
--
-- A state no writer can leave and no reader can reach is not a state a sweep
-- should be taught to mend. Owner policy v2.9 forbids the thirteenth repair
-- job, and one would not help here in any case: what to do with a decided
-- but unpaid Spin is a money decision, and money decisions are Dan's.
--
-- WHEN IT HAPPENED, AND ONLY THEN. Every violating row on the platform was
-- written inside one 61-minute window:
--
--   violating rows                                                    41
--   distinct tournaments                                              30
--   of those rows, Spin                                               24
--   first elimination                          2026-09-08 13:51:31.594+00
--   last elimination                           2026-09-08 14:52:52.136+00
--
-- Never before 13:51, never since 14:52, across every tournament the
-- platform has ever run. The launch path was cut over to the atomic lease
-- and receipt authority in the migration wave recorded at 2026-09-08 12:59
-- to 13:00 UTC (tournament_leases_have_fencing_generations,
-- tournament_launch_children_share_the_transition_lock,
-- seat_first_board_creation_is_one_transaction and
-- post_commit_obligations_are_atomic_and_resumable). The first stranded Spin
-- was created at 13:34:43 and drew at 13:46:11, inside the hour after it.
--
-- THIS IS NOT THE 17:17 EVENT. The retirement recorded at 20260924025037
-- notes that pending_fee_distributions kind='rake' has had no unresolved row
-- since 2026-09-08 17:30, and that the BBJ repair marker has none after
-- 17:17. Those two marks are the rake and BBJ writers being fixed at source,
-- two and a half hours after this window closed at 14:52. Same day,
-- different event.
--
-- THE FIX, AND WHY IT IS THIS SHAPE. A player may not be recorded out of a
-- game that never began. Elimination is the writer that proves a game is
-- being played, so elimination is where the contradiction first becomes
-- visible and where it is cheapest to refuse. Had this been armed on
-- 2026-09-08, the very first elimination at 13:51:31 would have aborted, the
-- engine would have reported it, and the Spin would have stayed a drawn but
-- undealt Spin with all three entrants still registered. That is exactly the
-- state fn_spin_draw_and_settle_atomic's legacy_projection branch is built
-- to adopt and relaunch. The refusal therefore does not merely detect the
-- defect; it preserves the only state from which the existing writer can
-- still finish the job. No new sweep, no new job, no new repair.
--
-- WHY IT IS DEFERRED. atomic_cancel_tournament marks every registration
-- 'eliminated' BEFORE it sets tournaments.status to 'CANCELLED'. An
-- immediate trigger would therefore refuse every cancellation on the
-- platform, including the refunds that are the reason to cancel at all. A
-- CONSTRAINT TRIGGER that is DEFERRABLE INITIALLY DEFERRED asks its question
-- at COMMIT, by which time the cancel has set its status and passes. It
-- judges the state a transaction leaves behind, never the order it took to
-- get there.
--
-- WHAT IT DOES NOT DO. It does not touch the thirteen. Those rows are
-- already written, and a constraint trigger fires only for rows a
-- transaction writes, so they are left exactly as measured for Dan to rule
-- on. When he does, atomic_cancel_tournament still works: it sets CANCELLED
-- in the same transaction, so the deferred check passes.
--
-- @live-proof: (SELECT count(*) FROM pg_trigger WHERE tgname = 'a_player_is_not_eliminated_from_a_game_that_never_started' AND NOT tgisinternal) = 1
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $arm$
DECLARE
  v_rows        bigint;
  v_tournaments bigint;
  v_spin        bigint;
  v_last        timestamptz;
  v_cancel      text;
BEGIN
  -- (a) The violation set this was measured against. If it has grown, the
  --     defect is live again and this reasoning is stale: refuse, re-measure,
  --     do not guess.
  SELECT count(*), count(DISTINCT p.tournament_id),
         count(*) FILTER (WHERE t.variant = 'spin'), max(p.eliminated_at)
    INTO v_rows, v_tournaments, v_spin, v_last
    FROM public.tournament_players p
    JOIN public.tournaments t ON t.id = p.tournament_id
   WHERE p.status IN ('eliminated', 'winner')
     AND t.started_at IS NULL
     AND upper(COALESCE(t.status, '')) NOT IN ('CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETING');

  IF v_rows IS DISTINCT FROM 41 OR v_tournaments IS DISTINCT FROM 30
     OR v_spin IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'refused: % row(s) across % tournament(s), % of them Spin, break this invariant; this expected 41 / 30 / 24, the state measured 2026-09-24. Re-measure, do not guess.',
      v_rows, v_tournaments, v_spin;
  END IF;
  IF v_last IS DISTINCT FROM timestamptz '2026-09-08 14:52:52.136+00' THEN
    RAISE EXCEPTION 'refused: the last violating elimination is %, not 2026-09-08 14:52:52.136+00; something has written this state since it was measured',
      v_last;
  END IF;

  -- (b) The deferred design depends on cancellation setting its status in the
  --     same transaction as it records everyone out. If that stops being
  --     true, an immediate reading of this invariant would break refunds.
  SELECT pg_get_functiondef(p.oid) INTO v_cancel
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_cancel_tournament';
  IF v_cancel IS NULL THEN
    RAISE EXCEPTION 'refused: public.atomic_cancel_tournament is not defined; the cancellation path this invariant must not break is gone';
  END IF;
  IF v_cancel !~ 'SET\s+status\s*=\s*''CANCELLED''' THEN
    RAISE EXCEPTION 'refused: atomic_cancel_tournament no longer sets status CANCELLED; the deferred reading of this invariant is no longer safe';
  END IF;

  -- (c) Nothing has armed this already.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'a_player_is_not_eliminated_from_a_game_that_never_started'
                AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'refused: the trigger already exists';
  END IF;

  RAISE NOTICE 'arming: 41 known violations from 2026-09-08 left untouched';
END;
$arm$;

CREATE OR REPLACE FUNCTION public.fn_player_needs_a_started_game()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz;
  v_status  text;
  v_found   boolean := false;
BEGIN
  -- The WHEN clause already asks this; asked again so the refusal survives a
  -- trigger that is ever re-armed without one.
  IF NEW.status IS NULL OR NEW.status NOT IN ('eliminated', 'winner') THEN
    RETURN NULL;
  END IF;

  SELECT t.started_at, upper(COALESCE(t.status, '')), true
    INTO v_started, v_status, v_found
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;

  -- A parent removed later in the same transaction owes nothing.
  IF NOT COALESCE(v_found, false) THEN
    RETURN NULL;
  END IF;

  -- A terminal tournament records everyone out on purpose: cancellation
  -- refunds through exactly this write, and completion settles through it.
  IF v_status IN ('CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETING') THEN
    RETURN NULL;
  END IF;

  IF v_started IS NULL THEN
    RAISE EXCEPTION
      'tournament % never started: registration % cannot be recorded as %',
      NEW.tournament_id, NEW.id, NEW.status
      USING ERRCODE = 'P0404',
            HINT = 'A game that has not started cannot put a player out. Finish the launch, or cancel the tournament, before recording a result.';
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_player_needs_a_started_game() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_player_needs_a_started_game() IS
  'Refuses to record a player out of a tournament that never started and is not terminal. Deferred to COMMIT so atomic_cancel_tournament, which eliminates before it cancels, still refunds.';

CREATE CONSTRAINT TRIGGER a_player_is_not_eliminated_from_a_game_that_never_started
  AFTER INSERT OR UPDATE ON public.tournament_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status IN ('eliminated', 'winner'))
  EXECUTE FUNCTION public.fn_player_needs_a_started_game();

-- A new trigger on a money table declares itself in the migration that creates
-- it. A declaration in a later migration is a promise, and the register is
-- already long enough in promises.
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('tournament_players',
        'a_player_is_not_eliminated_from_a_game_that_never_started',
        'Reviewed 2026-09-24. Deferred constraint trigger, AFTER INSERT OR UPDATE, fired only WHEN NEW.status IS eliminated or winner. It reads public.tournaments and refuses only when that parent never started and is not terminal. It moves no money, writes no row and returns NULL on every accepted path, so it can add nothing to a balance and remove nothing from one. DEFERRABLE INITIALLY DEFERRED is load-bearing: atomic_cancel_tournament records every registration eliminated BEFORE it sets the tournament CANCELLED, so an immediate reading of this invariant would refuse every cancellation refund on the platform.');

DO $verify$
DECLARE
  t             pg_trigger%ROWTYPE;
  v_rows        bigint;
  v_tournaments bigint;
BEGIN
  SELECT * INTO t FROM pg_trigger
   WHERE tgname = 'a_player_is_not_eliminated_from_a_game_that_never_started'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'failed: the trigger is not installed';
  END IF;
  IF t.tgrelid <> 'public.tournament_players'::regclass THEN
    RAISE EXCEPTION 'failed: the trigger is on %, not tournament_players', t.tgrelid::regclass;
  END IF;
  IF t.tgconstraint = 0 THEN
    RAISE EXCEPTION 'failed: it is not a constraint trigger, so it cannot be deferred';
  END IF;
  IF NOT t.tgdeferrable OR NOT t.tginitdeferred THEN
    RAISE EXCEPTION 'failed: it is not DEFERRABLE INITIALLY DEFERRED; it would refuse every cancellation';
  END IF;
  IF t.tgqual IS NULL THEN
    RAISE EXCEPTION 'failed: it has no WHEN clause, so it would read the parent on every row write';
  END IF;
  IF t.tgfoid <> 'public.fn_player_needs_a_started_game()'::regprocedure THEN
    RAISE EXCEPTION 'failed: it does not call fn_player_needs_a_started_game';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ca_declared_money_triggers
                  WHERE table_name = 'tournament_players'
                    AND trigger_name = 'a_player_is_not_eliminated_from_a_game_that_never_started') THEN
    RAISE EXCEPTION 'failed: the trigger is not declared in the money-trigger register';
  END IF;

  -- This migration is a guard, not a repair: the known violations are exactly
  -- as they were, because nothing here writes a row.
  SELECT count(*), count(DISTINCT p.tournament_id) INTO v_rows, v_tournaments
    FROM public.tournament_players p
    JOIN public.tournaments t2 ON t2.id = p.tournament_id
   WHERE p.status IN ('eliminated', 'winner')
     AND t2.started_at IS NULL
     AND upper(COALESCE(t2.status, '')) NOT IN ('CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETING');
  IF v_rows IS DISTINCT FROM 41 OR v_tournaments IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'failed: the known violation set is now % row(s) over % tournament(s); this migration must change no data',
      v_rows, v_tournaments;
  END IF;

  RAISE NOTICE 'PASS: deferred refusal armed on tournament_players; 41 known violations over 30 tournaments untouched';
END;
$verify$;

COMMIT;
