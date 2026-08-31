-- ═══════════════════════════════════════════════════════════════════════════
-- 20260828_the_four_table_claim_is_atomic_and_counts_bookings.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- TIER:         2
-- AUTHOR:       Claude (Cowork), for Dan
-- AFFECTS:      one new STABLE function, one partial index on
--               tournament_players, a rewrite of fn_enforce_four_table_limit,
--               and one new BEFORE trigger on public.tournament_players.
--               No table data rewritten. No existing row re-validated.
-- IRREVERSIBLE: no (see ROLLBACK)
--
-- Extends 20260824_four_table_limit_is_a_hard_rule.sql, which is doing its job
-- perfectly and is not being weakened here. Dan's rule stands unchanged:
--   "NO PLAYER OR HORSE CAN EVER PLAY MORE THEN 4 TABLES AT ONCE."
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT WAS MEASURED, 2026-08-28, BEFORE ANY OF THIS WAS WRITTEN
-- ═══════════════════════════════════════════════════════════════════════════
-- 24 horses were over the four-game cap as the ENGINE defines a game
-- (horseLoadMap: one live seat, plus one registration for a tournament that
-- has not started). The distribution says exactly where the leak is:
--
--     seats  regs   horses
--       1      4      13
--       2      3       6
--       3      2       3
--       4      1       1
--     ------------------------
--     max live seats held by ANY account on the platform: 4
--     accounts over 4 live seats:                         0
--
-- Not one account breached the SEAT cap. The 2026-08-24 trigger has never let
-- a fifth seat through. Every one of the 24 breaches is on the REGISTRATION
-- side, which nothing enforces at all — the ceiling there lives in TypeScript,
-- in horseLoadMap/atCapacity, and is consulted by four callers that each read
-- the load, each pass, and then all book. The file says so itself:
--
--     "Shuffling the candidates does not make the claim atomic, but it turns
--      a near-certain collision into an unlikely one."
--
-- Unlikely is what 24 rows look like.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A BOOKING HAS TO COUNT
-- ═══════════════════════════════════════════════════════════════════════════
-- A registration is not a table being played, so it is fair to ask why it
-- counts at all. Because of what happens when it is honoured. A horse holding
-- 4 live seats and 1 pending registration — the bottom row above, live on
-- production while this was written — is an entrant that CANNOT BE SEATED: the
-- instant that tournament starts, its seat insert meets the 2026-08-24 trigger
-- and is refused with 23514. The field is then short a player who is on the
-- list, and the seat-first fill spends its pass re-offering a chair to someone
-- who can never take it. Over-booking does not create a fifth table; it
-- creates a phantom entrant and a stalled fill.
--
-- So the cap binds on the same number the engine already uses to decide, and
-- it binds at the moment of the claim rather than five minutes later.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THE DATABASE AND NOT THE FOUR CALL SITES
-- ═══════════════════════════════════════════════════════════════════════════
-- The same argument the 2026-08-24 migration made, and it has only got
-- stronger. The registration side has SIX entry points today —
-- atomic_tournament_register, fn_register_for_tournament,
-- fn_register_horse_for_tournament, fn_tournament_atomic_register,
-- fn_seat_horse_in_seat_first_game and the plain client INSERT — against four
-- application callers (the fleet seeder, the overlay guard, the seat-first
-- fill, and tournament registration). Fixing four call sites leaves six write
-- paths and the next one nobody has written yet. tournament_players is the
-- chokepoint on the booking side exactly as table_seats is on the seat side.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY IT IS NOW ACTUALLY ATOMIC
-- ═══════════════════════════════════════════════════════════════════════════
-- Both triggers take pg_advisory_xact_lock on 'table_cap:' || user_id before
-- counting. That is not a new convention: atomic_table_buyin has taken that
-- exact key since 2026-08-19. Taking the SAME key in the seat trigger, the
-- booking trigger and the buy-in RPC is what makes check-and-claim one
-- indivisible step across all of them — two concurrent callers for the same
-- account now queue instead of both reading 3 and both writing.
--
-- The lock is per-ACCOUNT, so it serialises nothing but that one account's
-- own claims; two different horses never wait on each other. It is taken AFTER
-- the cheap early-outs below, so a seat being vacated, a closed table or a
-- status change that is not a booking never touches it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- HORSES ARE PLAYERS (CLAUDE.md §10.5)
-- ═══════════════════════════════════════════════════════════════════════════
-- There is no is_horse anywhere in this file. The rule is identical for
-- everyone, which is the only form it is allowed to take. It was checked
-- against the live human population before being written rather than after:
-- of all accounts currently carrying any load at all, exactly one is human,
-- at load 1, and the maximum human load on the platform is 1. No human is
-- refused anything by this change today, and if one ever is, it is because
-- they are genuinely at four games — which is the rule.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The load, defined once, in the database.
-- ───────────────────────────────────────────────────────────────────────────
-- Byte-for-byte the definition horseLoadMap() uses in TypeScript. It was two
-- definitions in two languages that let them drift apart in the first place;
-- from here the engine's picker and the hard limit are reading the same rule,
-- and the engine's remains an optimisation (do not offer a horse that will be
-- refused) rather than the enforcement.
CREATE OR REPLACE FUNCTION public.fn_concurrent_game_load(
  p_user_id               uuid,
  p_exclude_seat_id       uuid DEFAULT NULL,
  p_exclude_table_id      uuid DEFAULT NULL,
  p_exclude_tournament_id uuid DEFAULT NULL
)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT (
    -- (1) A LIVE SEAT IS A GAME. Cash and tournament alike — the rule says
    -- tables. A seat at a closed table is history, not a game.
    (
      SELECT count(*)
        FROM public.table_seats ts
        JOIN public.tables t ON t.id = ts.table_id
       WHERE ts.user_id = p_user_id
         AND ts.left_at IS NULL
         AND t.status <> 'closed'
         -- The row being written never counts against itself. On INSERT it
         -- does not exist yet and this is a no-op; on UPDATE it stops a
         -- re-occupancy blocking itself.
         AND (p_exclude_seat_id IS NULL OR ts.id IS DISTINCT FROM p_exclude_seat_id)
         -- Re-seating at a table already occupied is not a new table.
         AND (p_exclude_table_id IS NULL OR ts.table_id IS DISTINCT FROM p_exclude_table_id)
    )
    +
    -- (2) A BOOKING IS A GAME ONLY UNTIL ITS TOURNAMENT STARTS. Once the
    -- tournament is RUNNING the entrant holds a seat at one of its tables and
    -- clause (1) has already counted it. RUNNING is absent from this list
    -- deliberately and must stay absent, or every tournament regular sits at
    -- an instant 2.
    (
      SELECT count(*)
        FROM public.tournament_players tp
        JOIN public.tournaments tr ON tr.id = tp.tournament_id
       WHERE tp.user_id = p_user_id
         AND tp.status IN ('registered', 'playing')
         AND tr.status IN ('ANNOUNCED', 'REGISTERING')
         AND (p_exclude_tournament_id IS NULL
              OR tp.tournament_id IS DISTINCT FROM p_exclude_tournament_id)
         -- NEVER BOTH. A seat-first game sells the chair before it starts, so
         -- for a few minutes a booking and a seat can describe the same game.
         -- Counting both is how a horse at two tables reads as four.
         AND NOT EXISTS (
           SELECT 1
             FROM public.table_seats ts2
             JOIN public.tables t2 ON t2.id = ts2.table_id
            WHERE ts2.user_id = p_user_id
              AND ts2.left_at IS NULL
              AND t2.status <> 'closed'
              AND t2.tournament_id = tp.tournament_id
         )
    )
  )::int;
$function$;

COMMENT ON FUNCTION public.fn_concurrent_game_load(uuid, uuid, uuid, uuid) IS
  'Concurrent games for one account: live seats at open tables plus bookings '
  'for tournaments that have not started, never double-counting a seat-first '
  'chair. The single definition behind both four-table triggers and the '
  'engine''s horseLoadMap. Players and horses alike (CLAUDE.md 10.5).';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The index clause (2) needs.
-- ───────────────────────────────────────────────────────────────────────────
-- tournament_players is 160k rows and a horse carries a few hundred of them,
-- nearly all 'eliminated'. Only 586 rows platform-wide are open bookings, so
-- the partial index is tiny and keeps this off the hot path of every seat
-- INSERT. Built CONCURRENTLY out of band on 2026-08-28 so the table was never
-- locked; IF NOT EXISTS keeps this file idempotent for a fresh environment.
CREATE INDEX IF NOT EXISTS idx_tournament_players_user_open
  ON public.tournament_players (user_id)
  WHERE status IN ('registered', 'playing');

DO $$
BEGIN
  IF to_regclass('public.tournament_players') IS NULL THEN
    RAISE EXCEPTION 'tournament_players missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public'
                    AND indexname = 'idx_tournament_players_user_open') THEN
    RAISE EXCEPTION
      'idx_tournament_players_user_open missing - every seat INSERT would scan a 160k-row table';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public'
                    AND indexname = 'idx_table_seats_user_live') THEN
    RAISE EXCEPTION
      'idx_table_seats_user_live missing - clause (1) would seq-scan a hot table';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The seat side: same rule, now atomic, now counting bookings too.
-- ───────────────────────────────────────────────────────────────────────────
-- Unchanged from 2026-08-24: scoped to INSERT and UPDATE OF left_at so it
-- never sees the ~34,700 stack UPDATEs per autovacuum window, and a row being
-- vacated is always allowed.
CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_live       int;
  v_is_closed  boolean;
  v_tournament uuid;
BEGIN
  -- Only a row that OCCUPIES a seat can breach the limit. A row being vacated
  -- reduces the count and is always allowed.
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed'), t.tournament_id
    INTO v_is_closed, v_tournament
    FROM public.tables t
   WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
    RETURN NEW;
  END IF;

  -- ATOMIC (2026-08-28). Everything above is a cheap early-out that cannot
  -- breach anything, so the lock is taken here and not at the top. Same key
  -- atomic_table_buyin has used since 2026-08-19, which is the point: the
  -- buy-in RPC, this trigger and the booking trigger below now serialise
  -- against each other for one account, so check-and-claim is indivisible
  -- across all three. Transaction-scoped — released on COMMIT or ROLLBACK,
  -- never held by a crashed caller.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  -- This seat's own tournament is excluded: the entrant is not competing with
  -- their own booking for a chair, they are converting it into one. Without
  -- this, every tournament that seats its field before flipping to RUNNING
  -- would refuse its own fourth entrant.
  v_live := public.fn_concurrent_game_load(NEW.user_id, NEW.id, NEW.table_id, v_tournament);

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before joining another. '
                   'A game is a live seat or a booking for a tournament that has not started. '
                   'This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_four_table_limit ON public.table_seats;

CREATE TRIGGER trg_enforce_four_table_limit
BEFORE INSERT OR UPDATE OF left_at ON public.table_seats
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_four_table_limit();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The booking side: the half that had no enforcement at all.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_enforce_booking_game_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_load    int;
  v_tstatus text;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only an OPEN booking is a claim on a chair. Busting out, winning, or being
  -- unregistered all reduce the count and are always allowed.
  IF NEW.status IS NULL OR NEW.status NOT IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  -- An UPDATE that leaves an already-open booking open is not a new claim —
  -- registered -> playing at late registration must never be refused, or a
  -- paid entrant is stranded off the felt by a rule about entering.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  SELECT tr.status INTO v_tstatus
    FROM public.tournaments tr
   WHERE tr.id = NEW.tournament_id;

  -- Once a tournament is under way its entrants are counted by their SEATS,
  -- and the seat trigger owns the rule. Late registration into a RUNNING event
  -- is therefore not gated here — it is gated where it becomes real, at the
  -- seat. An unreadable tournament row is not a licence to book: treat it as
  -- open and check, rather than waving it through.
  IF v_tstatus IS NOT NULL AND v_tstatus NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  -- Exclude this tournament so a re-registration after an unregister, and any
  -- retry of a committed-but-timed-out booking, is priced as itself and not as
  -- an additional game.
  v_load := public.fn_concurrent_game_load(NEW.user_id, NULL, NULL, NEW.tournament_id);

  IF v_load >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not enter another',
      NEW.user_id, v_load
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before entering another. '
                   'A game is a live seat or a booking for a tournament that has not started. '
                   'This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_booking_game_cap ON public.tournament_players;

-- UPDATE OF status, not UPDATE: chip syncs write tournament_players.chips for
-- every live entrant every five seconds and must never pay for this check.
CREATE TRIGGER trg_enforce_booking_game_cap
BEFORE INSERT OR UPDATE OF status ON public.tournament_players
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_booking_game_cap();

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Post-apply assertions.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_found int;
BEGIN
  SELECT count(*) INTO v_found
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relname = 'table_seats'
     AND tg.tgname = 'trg_enforce_four_table_limit'
     AND NOT tg.tgisinternal;
  IF v_found <> 1 THEN
    RAISE EXCEPTION 'seat trigger was not created';
  END IF;

  SELECT count(*) INTO v_found
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relname = 'tournament_players'
     AND tg.tgname = 'trg_enforce_booking_game_cap'
     AND NOT tg.tgisinternal;
  IF v_found <> 1 THEN
    RAISE EXCEPTION 'booking trigger was not created';
  END IF;

  -- Both triggers must take the per-account lock, or "atomic" is a comment.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_enforce_four_table_limit', 'fn_enforce_booking_game_cap')
         AND p.prosrc LIKE '%pg_advisory_xact_lock%') <> 2 THEN
    RAISE EXCEPTION 'a four-table trigger is counting without holding the per-account lock';
  END IF;

  -- Nobody's existing rows are re-validated by this migration, but the load
  -- function must agree with the seat trigger it now backs.
  IF (SELECT count(*)
        FROM (SELECT ts.user_id
                FROM public.table_seats ts
                JOIN public.tables t ON t.id = ts.table_id
               WHERE ts.left_at IS NULL AND t.status <> 'closed'
               GROUP BY 1 HAVING count(*) > 4) q) <> 0 THEN
    RAISE EXCEPTION 'an account already holds more than four live seats - fix the data before tightening the rule';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- EXISTING OVER-BOOKINGS ARE DELIBERATELY LEFT ALONE
-- ═══════════════════════════════════════════════════════════════════════════
-- The 24 rows measured above are not touched. Unregistering someone is a money
-- decision (refund or not, and on whose authority) and inventing one is exactly
-- the mistake CLAUDE.md 10.5 was written about. They drain on their own as
-- their tournaments start and finish; the seat trigger holds the hard line
-- meanwhile, and no NEW over-booking can be created from here.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_enforce_booking_game_cap ON public.tournament_players;
--   DROP FUNCTION IF EXISTS public.fn_enforce_booking_game_cap();
--   -- restore the seat trigger's 2026-08-24 body (seats only, no lock):
--   -- re-run 20260824_four_table_limit_is_a_hard_rule.sql, which is idempotent.
--   DROP FUNCTION IF EXISTS public.fn_concurrent_game_load(uuid, uuid, uuid, uuid);
--   DROP INDEX IF EXISTS public.idx_tournament_players_user_open;
-- Rolling back returns booking enforcement to the application's advisory
-- ceiling, which is four callers that each check and then all book.
-- ═══════════════════════════════════════════════════════════════════════════
