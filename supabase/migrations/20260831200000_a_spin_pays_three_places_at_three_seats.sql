-- ═══════════════════════════════════════════════════════════════════════════
-- A SPIN PAYS THREE PLACES AT THREE SEATS, AND THE RPC REFUSED EXACTLY THAT
-- ═══════════════════════════════════════════════════════════════════════════
-- Closes the divergence recorded, deliberately and in writing, by
-- `20260831180000_a_tournament_guard_binds_every_writer_not_just_the_rpc`:
--
--   "The RPC keeps its stricter rule for now because relaxing it would change
--    what an owner may author by hand, which is a product decision rather than
--    a correctness one. It is written up for Dan."
--
-- It is decided. The table-level guard already enforces the real law with `>`;
-- this brings `fn_create_tournament` onto the same operator so the platform
-- has ONE rule about paid places instead of two that disagree.
--
-- ── WHAT THE OPERATOR WAS REFUSING ────────────────────────────────────────
--
--   IF jsonb_array_length(v_payouts) >= v_max_players THEN
--     RETURN ... 'more_paid_places_than_players';
--
-- The error names "more paid places THAN players". `>=` does not test that.
-- It tests "as many paid places as players", which is a different and much
-- stricter claim, and it refuses this platform's own shipped product: a Spin
-- & Go is three seats paying three places. 21 live `tournaments` rows carry
-- the 80 / 12 / 8 ladder at `max_players = 3` right now, completed and paid,
-- so the structure the RPC calls impossible is one the engine settles daily.
--
-- Those 21 rows exist because `TournamentRecurringService` writes the row
-- DIRECTLY and never met this guard. The direct-insert spawner was never
-- affected by the bug and is not affected by this fix.
--
-- ── WHAT THE OFF-BY-ONE COST THE PATHS THAT DID GO THROUGH THE RPC ────────
--
-- Both RPC-fed paths were bent around the check rather than the check being
-- questioned, and both are corrected in the same commit as this migration:
--
--   src/lib/tournamentFieldRules.ts   `capPaidPlaces` trimmed every ladder to
--     `fieldCapFor(fieldCap) - 1` places. The `- 1` existed for no reason but
--     this operator. Fed the Spin ladder at a 3-seat field it dropped third
--     place and renormalised the remainder, so 80 / 12 / 8 was silently sold
--     to the operator, and written, as 86.96 / 13.04.
--
--   src/lib/tournamentFromTableConfig.ts  wrote winner-take-all for every Spin
--     under the comment "a spin is winner-take-all by definition". Three of
--     the seven tiers pay three places; the definition was the workaround.
--
-- ── WHY `>` IS THE WHOLE OF THE LAW ───────────────────────────────────────
--
-- Paying every seat is unusual, not impossible - a Spin does it by design, and
-- a heads-up game paying both seats is a rake-free structure an owner is
-- allowed to author. Paying a place nobody can reach is genuinely impossible,
-- and `>` still catches it: the two-seat schedule row carrying a five-place
-- preset that the guard migration was written for is refused by both layers.
--
-- ── HOW THIS IS APPLIED, AND WHY NOT BY RE-EMITTING THE BODY ──────────────
--
-- Same technique as `20260831_tournament_fee_is_keyed_on_seats_not_on_the_word
-- _sng`, for the same reasons and one more.
--
-- The function is ~300 lines and most of them are a money path, so re-typing
-- it to change one character invites a transcription error review would not
-- catch. Worse, the LIVE body and every migration file that defines it have
-- already diverged - diffed 2026-08-31, live vs the newest repo copy
-- (`20260823103000_union_tournament_creation_parity`), three substantive
-- differences:
--
--   * the fee CASE is seat-keyed live (`maxPlayers BETWEEN 1 AND 2`), and
--     label-keyed in the file (`round(v_total * 0.1)`) - the file predates
--     `20260831_tournament_fee_is_keyed_on_seats_not_on_the_word_sng`;
--   * the file's union lookup carries a `WHEN c.is_union THEN c.id` branch
--     that is NOT in the live function;
--   * the file writes `lateRegistrationLevels` into `late_reg_mins`; live
--     writes `lateRegistrationMinutes`.
--
-- So a CREATE OR REPLACE typed from any migration file would have quietly
-- reverted at least one shipped fix. This reads the LIVE definition,
-- substitutes one operator, and EXECUTEs the result - which is a genuine
-- CREATE OR REPLACE, emitted by Postgres itself, so the parameter list and its
-- defaults are reproduced exactly and 42P13 is not reachable.
--
-- It REFUSES to proceed unless it finds the target line exactly once, and
-- asserts afterwards that the new form is in place and the old one is gone.
--
-- ROLLBACK:
--   Re-run this migration with v_old and v_new swapped and the two assertions
--   inverted. It is a symmetric one-substring rewrite with the same guards in
--   both directions. Note that rolling back re-breaks 3-seat Spin creation
--   through the RPC.

DO $mig$
DECLARE
  v_src text;
  v_old text := 'IF jsonb_array_length(v_payouts) >= v_max_players THEN';
  v_new text := 'IF jsonb_array_length(v_payouts) > v_max_players THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_create_tournament'
     AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_config jsonb';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_create_tournament(uuid, jsonb) not found - nothing to rewrite';
  END IF;

  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION
      'fn_create_tournament no longer contains the paid-places guard exactly once; it has changed since this migration was written. Re-read the live body before rewriting.';
  END IF;

  EXECUTE replace(v_src, v_old, v_new);
END
$mig$;

-- ── POST-APPLY ASSERTIONS ─────────────────────────────────────────────────
DO $verify$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_create_tournament'
     AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_config jsonb';

  IF v_src NOT LIKE '%jsonb_array_length(v_payouts) > v_max_players%' THEN
    RAISE EXCEPTION 'the corrected paid-places guard is not present after the rewrite';
  END IF;

  IF v_src LIKE '%jsonb_array_length(v_payouts) >= v_max_players%' THEN
    RAISE EXCEPTION 'the >= form of the paid-places guard survived the rewrite';
  END IF;

  -- The error string must survive: TournamentService maps it to the message
  -- the operator reads, and ScheduledTournamentService reports under it.
  IF v_src NOT LIKE '%more_paid_places_than_players%' THEN
    RAISE EXCEPTION 'the more_paid_places_than_players error code was lost';
  END IF;

  -- The RPC must now agree with the table-level guard rather than out-rank it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'tournaments_creation_guard'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'tournaments_creation_guard is missing - the two layers can no longer be checked against each other';
  END IF;
END
$verify$;
