-- ═══════════════════════════════════════════════════════════════════════════
-- A TOURNAMENT GUARD BINDS EVERY WRITER, NOT JUST THE RPC (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
-- FOUR PATHS CREATE A TOURNAMENT. ONE OF THEM HAS THE GUARDS.
--
--   fn_create_tournament                     the owner-facing modal. Guarded.
--   TournamentRecurringService               writes rows directly.
--   ScheduledTournamentService               writes rows directly.
--   HorseOrchestrator                        writes rows directly.
--
-- Every defect this audit found in that area is a symptom of that one fact:
-- heads-up games charged 10% instead of 5% because the fee rule lived in the
-- RPC (18 rows, 2026-08-27); 39,046 rows carry a table_size nobody wrote; a
-- schedule row with two seats and a five-place payout preset would create a
-- two-handed game paying five, because only the RPC checks.
--
-- The database already knows how to fix this. `tournaments` carries thirteen
-- triggers — guarantee affordability, the multi-day refusal, union ownership,
-- whole-dollar buy-ins — and every one of them binds all four writers because
-- it lives on the TABLE rather than in one caller. `tables` got the same
-- treatment on 2026-08-31 when its creation guard became a trigger. This does
-- it for the two tournament rules that can be enforced with no live casualty.
--
-- ── WHAT IS ENFORCED, AND WHY ONLY THESE TWO ───────────────────────────────
--
-- Measured against all 52,407 live tournament rows before writing a line:
--
--   max_players <= 0                     0 rows.  ENFORCED.
--   paid places  >  max_players          0 rows.  ENFORCED.
--   paid places  >= max_players         21 rows.  NOT ENFORCED - see below.
--   table_size beyond the deck        5,000 rows.  NOT ENFORCED - see below.
--   buy_in_fee off the seats rule     9,357 rows.  NOT ENFORCED - see below.
--
-- A guard that refuses rows a live writer creates every hour is not a guard,
-- it is an outage. So the two with zero casualties become law today and the
-- other three are recorded here with their numbers.
--
-- ── WHY `>=` IS NOT THE RULE, THOUGH THE RPC USES IT ───────────────────────
--
-- fn_create_tournament refuses `jsonb_array_length(payouts) >= max_players`.
-- That is stricter than reality and it refuses this platform's own live
-- product: every Spin & Go is three seats paying three places, 80/12/8, and
-- 21 of them are sitting in the table right now, completed and paid. Paying
-- every seat is unusual, not impossible.
--
-- What is genuinely impossible is paying MORE places than can finish, so that
-- is the law here: `>` , not `>=`. It still catches the case this was written
-- for - a two-seat schedule row carrying a five-place preset - while leaving
-- the Spin structure alone.
--
-- The RPC keeps its stricter rule for now because relaxing it would change
-- what an owner may author by hand, which is a product decision rather than a
-- correctness one. It is written up for Dan. The divergence is deliberate and
-- documented rather than accidental.
--
-- ── THE THREE NOT ENFORCED ─────────────────────────────────────────────────
--
-- table_size beyond the deck: 5,000 rows, all of them PLO6 at 9 seats against
-- a deck ceiling of 7. Not a refusal case - the fix belongs in the writers,
-- which never wrote the column at all and let it default to 9, and it lands
-- in the same commit as this migration. Blocking here would refuse the
-- creation instead of correcting the number.
--
-- buy_in_fee off the seats rule: 9,357 rows. This is money and it is history;
-- a blocking trigger would refuse creations tomorrow over a rule that was not
-- applied yesterday. Recorded for Dan with the count.
--
-- ── SAFETY ─────────────────────────────────────────────────────────────────
--
-- BEFORE INSERT only. It never fires on UPDATE, so no lifecycle transition,
-- payout write or status change can be refused by it - a guard that can
-- refuse an update is a guard that can strand a running tournament.
--
-- APPLIED TO PRODUCTION 2026-08-31 via Supabase MCP apply_migration, in TWO
-- parts (migration names: fn_tournaments_creation_guard_function_only, then
-- attach_tournaments_creation_guard), then probed in a transaction that was
-- ROLLED BACK (CLAUDE.md 11.5). All four probes behaved:
--   zero seats                      REFUSED
--   five paid places on two seats   REFUSED
--   a 100-seat MTT paying three     ACCEPTED
--   a 3-seat Spin paying 80/12/8    ACCEPTED
-- Zero probe rows reached the table.
--
-- ── ATTACHING A TRIGGER TO `tournaments` DEADLOCKS AGAINST REALTIME ────────
--
-- Worth writing down, because it cost six attempts and the next person will
-- hit it too. CREATE TRIGGER needs AccessExclusiveLock on `tournaments`.
-- Supabase Realtime is subscribed to that table and cycles constantly: it
-- holds `realtime.subscription` and then wants AccessShareLock on
-- `tournaments`, so the two requests form a cycle and Postgres kills one:
--
--   deadlock detected
--   Process A waits for AccessExclusiveLock on realtime.subscription;
--     blocked by process B.
--   Process B waits for AccessShareLock on tournaments; blocked by process A.
--
-- The blocker is NOT a stuck transaction - pg_stat_activity showed it idle,
-- having just committed. It is ordinary high-frequency traffic and the
-- windows between are small but real.
--
-- What worked: split the DDL so the FUNCTION is created in its own migration
-- (it needs no lock on the table at all), then attach the trigger in a second
-- migration that is nothing but DROP TRIGGER + CREATE TRIGGER, with a SHORT
-- `SET lock_timeout` so each attempt fails fast and cleanly instead of
-- sitting in the lock queue long enough to deadlock. 1500ms caught the window
-- on the first try after 4s and 8s had both deadlocked. Do not raise the
-- timeout to "try harder" - a longer wait makes a deadlock MORE likely, not
-- less, because it widens the overlap.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS tournaments_creation_guard ON public.tournaments;
--   DROP FUNCTION IF EXISTS public.fn_tournaments_creation_guard();

CREATE OR REPLACE FUNCTION public.fn_tournaments_creation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_paid int;
BEGIN
  -- 1. A field of nobody. fn_create_tournament calls this
  --    'max_players_must_be_positive'; the modal used to send 0 for eight of
  --    its ten formats meaning "unlimited", and every one of those failed
  --    before a row was written.
  IF COALESCE(NEW.max_players, 0) <= 0 THEN
    RAISE EXCEPTION
      'tournament guard: max_players must be positive (got %) - a tournament with no seats can never start',
      NEW.max_players
      USING ERRCODE = '23514';
  END IF;

  -- 2. More paid places than players who can enter. Paying EVERY seat is
  --    legal (a Spin pays 3 of 3); paying more than exist is not.
  IF NEW.payout_structure IS NOT NULL
     AND jsonb_typeof(NEW.payout_structure::jsonb) = 'array' THEN
    v_paid := jsonb_array_length(NEW.payout_structure::jsonb);
    IF v_paid > NEW.max_players THEN
      RAISE EXCEPTION
        'tournament guard: % paid places for % seats - more places than players who can enter',
        v_paid, NEW.max_players
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournaments_creation_guard ON public.tournaments;
CREATE TRIGGER tournaments_creation_guard
  BEFORE INSERT ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournaments_creation_guard();

-- Post-apply assertion: no existing row would have been refused.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tournaments
   WHERE COALESCE(max_players, 0) <= 0
      OR (payout_structure IS NOT NULL
          AND jsonb_typeof(payout_structure::jsonb) = 'array'
          AND jsonb_array_length(payout_structure::jsonb) > max_players);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'the new guard would have refused % existing row(s)', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'tournaments_creation_guard'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'tournaments_creation_guard is not attached';
  END IF;
END $$;
