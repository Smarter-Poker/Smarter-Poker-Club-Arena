-- ═══════════════════════════════════════════════════════════════════════════
--  THE PLATFORM FREEZES. NOTHING MOVES FOR FIVE MINUTES.
--  Dan, 2026-09-01, binding
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim:
--
--   "THE ENTIRE PLATFORM NEEDS TO FREEZE FOR THE 5 MINUTES, NO BUY INS, NO
--   CHIP MOVEMENTS, NO BUY INS OR CASH OUTS... NOTHING HAPPENS FOR THE 5
--   MINUTES. HORSES SHOULD NOT STAND UP OR ROTATE, EVERYTHING JUST FREEZES,
--   THEN PICKS BACK UP EXACTLY AS IT WAS BEFORE THE FREEZE AND RESTART..."
--
-- ─── WHY THIS IS IN POSTGRES AND NOT IN THE ENGINE ─────────────────────────
--
-- Because THE ENGINE IS DEAD for about two of those five minutes. It is being
-- restarted; that is the entire point of the break. Any guard that lives in
-- engine memory is absent for exactly the window it is meant to cover.
--
-- And the platform does not stop when the engine does. Verified against
-- production on 2026-09-01, these pg_cron jobs run INSIDE Postgres every
-- single minute, engine or no engine:
--
--   sp_evict_sitting_out_cash_players   * * * * *   evicts seats, cashes stacks
--   credit-stalled-seat-first-stacks    * * * * *   writes chips onto seats
--   reconcile-tournament-denormals      * * * * *
--   sweep-seatless-late-registrants     * * * * *
--
-- plus `ca-payout-sweep-hourly` and `rake-repair-unbanked-hourly` at :52 and
-- `ca-burnin-gate-hourly` at :58, which bracket a :55 window, and
-- `reconcile-ledger-integrity-6h` at literally `55 */6`. The seat-eviction job
-- alone would fire FIVE TIMES inside every freeze, moving seats and chips
-- while every player watches a screen that says nothing is happening.
--
-- ─── WHY THE TABLES AND NOT THE FUNCTIONS ──────────────────────────────────
--
-- An audit counted 190 functions that write a money or seat table, across
-- 1310 migrations, many redefined a dozen times. Guarding each one is a list,
-- and a list can be wrong: miss one and chips move during a freeze, silently.
-- Worse, a list cannot cover the three paths that have no function to guard —
--
--   * TRIGGERS (fn_ca_autoledger, fn_club_members_ledger_writer, the sit-out
--     clock triggers) fire from inside other people's transactions;
--   * pg_cron, which calls SQL directly;
--   * the engine's own `.from(...).update()` writes, which are not RPCs at all;
--   * and roughly thirty legacy RPCs that still carry a default PUBLIC EXECUTE
--     grant and no caller anywhere in the client — `mass_fund_horses`,
--     `add_to_player_wallet`, `atomic_chip_transfer` and friends.
--
-- Those 190 functions write SEVEN tables. Guarding the tables is complete by
-- construction: every writer, known or forgotten, present or future, passes
-- through the same door. A future agent who adds a 191st money function gets
-- the freeze for free and cannot forget it.
--
-- ─── WHAT IS DELIBERATELY *NOT* FROZEN ─────────────────────────────────────
--
-- 1. The `last_hand` phase (:53 to :55). Hands are still finishing there, and
--    a finishing hand PAYS A POT. Freezing money at :53 would strand every
--    pot on the platform mid-settlement, which is the opposite of "nothing is
--    lost or corrupted". The freeze begins when the last hand has landed.
--
-- 2. Non-money columns. `club_members` carries presence and role alongside
--    `chip_balance`; refusing every write to it would break login during the
--    break. The trigger is told which columns are money and lets an UPDATE
--    through untouched when none of them changed. That also keeps this off
--    the hot path: the column comparison happens before the freeze lookup.
--
-- 3. Anything running under `app.freeze_bypass`. That is the thaw itself and
--    the engine's own state flush on SIGTERM - a table parked between hands
--    has already settled its pot, so what it writes on the way out is
--    bookkeeping, not movement. Nothing else may set it.

BEGIN;

-- ---------------------------------------------------------------------------
-- THE FREEZE ARMS ITSELF, AND ONLY THE RIGHT ENGINE CAN ARM IT.
--
-- `enforce_freeze` exists because of a deployment-ordering trap: the engine
-- build serving production when this migration is applied already declares
-- hourly breaks (PR #2527), but still carries the hand-for-hand bug that can
-- deal a hand INSIDE one. If the triggers honoured that engine's break row,
-- the first :55 after this migration would freeze the ledger underneath a pot
-- that is actively being paid - refused settlement writes on a live hand,
-- which is worse than anything the freeze prevents.
--
-- So the guard only engages when the row says enforce_freeze, and only the
-- engine build that contains the freeze-aware machinery writes that flag.
-- The moment that build deploys (through its own break, on the old rules),
-- the freeze arms itself. No human sequencing, no window where the wrong
-- engine can freeze the wrong things.
-- ---------------------------------------------------------------------------
ALTER TABLE public.engine_maintenance_break
  ADD COLUMN IF NOT EXISTS enforce_freeze BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- Is the platform frozen right now?
--
-- Self-expiring, like fn_maintenance_break_state: a row left behind by an
-- engine that died mid-break must not freeze the platform forever. If nothing
-- ever clears it, `break_ends_at > now()` stops being true on its own and the
-- platform thaws itself. A freeze that cannot end is worse than a restart
-- nobody announced.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
-- SECURITY INVOKER (the default), DELIBERATELY. The pre-push
-- definer-authorization guard refused the DEFINER version, and rightly: the
-- break row already carries a public SELECT policy, so INVOKER reads exactly
-- what any caller could read for themselves and lends nobody any rights.
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.engine_maintenance_break b
    WHERE b.phase = 'counting_down'
      AND b.enforce_freeze
      AND b.break_ends_at > NOW()
      -- Belt and braces against a clock skew or a bad write: the longest
      -- legitimate freeze is five minutes, so refuse to honour one that
      -- claims to run for more than fifteen.
      AND b.break_ends_at < NOW() + INTERVAL '15 minutes'
  );
$$;

COMMENT ON FUNCTION public.fn_platform_frozen() IS
  'True while the scheduled maintenance freeze is running (counting_down phase only - the last_hand phase still has pots to settle). Self-expiring: a stale row cannot freeze the platform permanently.';

GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The one sanctioned way past the freeze.
--
-- `SET LOCAL app.freeze_bypass = 'on'` inside a transaction. LOCAL matters:
-- it dies with the transaction, so a bypass cannot leak into the next
-- statement on a pooled connection.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.freeze_bypass', TRUE), '') = 'on';
$$;

COMMENT ON FUNCTION public.fn_freeze_bypass_active() IS
  'True inside a transaction that has done SET LOCAL app.freeze_bypass = on. Reserved for the thaw and the engine state flush; never set it to work around a refusal.';

-- ---------------------------------------------------------------------------
-- The guard itself.
--
-- Trigger arguments name the money columns for that table. On UPDATE, if none
-- of them actually changed, the write is not a chip movement and passes
-- straight through - which is both correct and what keeps this cheap on a hot
-- table. INSERT and DELETE of a row in these tables always count.
--
-- 55006 is object_not_in_prerequisite_state. PostgREST maps it to a clean
-- error the client can recognise rather than a 500.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  -- Cheapest checks first: this runs on every write to seven core tables.
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;  -- presence, role, a timestamp: not a chip movement
    END IF;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── THE ENGINE IS EXEMPT, DELIBERATELY ──────────────────────────────────
  --
  -- PostgREST requests made with the service key carry role=service_role in
  -- request.jwt.claims. Those are the ENGINE and trusted server routes, and
  -- they pass, for three reasons that hold together:
  --
  --   1. The engine cannot SET LOCAL a bypass GUC: it speaks PostgREST, and
  --      a per-request setting would need db-pre-request plumbing that does
  --      not exist here. Refusing its writes instead would break the two
  --      moments the freeze exists to protect - the state flush on SIGTERM
  --      and the boot bookkeeping at ~:58 (horse resets, seat restoration).
  --
  --   2. The engine is already frozen BY ITS OWN MACHINERY: every table is
  --      parked between hands, and every money-moving sweep (fee reconciler,
  --      rakeback settler, horse rotation, fleet seeding) checks the freeze
  --      before acting. What service_role writes during a freeze is recovery
  --      bookkeeping, not movement.
  --
  --   3. What this trigger must stop is everything that does NOT stop when
  --      the engine dies: browsers (role authenticated/anon - enforced),
  --      the ~30 legacy PUBLIC-EXECUTE RPCs (whatever role calls them -
  --      enforced), and pg_cron (no request.jwt.claims at all - enforced).
  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- unparseable claims are not an exemption
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.fn_refuse_while_frozen() IS
  'Refuses money and seat movement while the platform is frozen. Attached to the seven tables that receive every such write, because guarding 190 writer functions individually is a list that can be wrong and cannot cover triggers, pg_cron or direct engine writes.';

-- ---------------------------------------------------------------------------
-- The seven doors.
--
-- Trigger names are prefixed `zz_` so they fire LAST among BEFORE triggers on
-- these tables (Postgres fires BEFORE triggers in name order). The existing
-- ledger and sit-out triggers therefore see an unfrozen world and behave
-- normally; this one has the final say on whether the write happens at all.
-- ---------------------------------------------------------------------------

-- Seats: taking one, leaving one, or changing the stack on one.
DROP TRIGGER IF EXISTS zz_freeze_guard ON public.table_seats;
CREATE TRIGGER zz_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_while_frozen('stack', 'left_at', 'sit_out_at');

-- The live chip pool.
DROP TRIGGER IF EXISTS zz_freeze_guard ON public.club_members;
CREATE TRIGGER zz_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_while_frozen('chip_balance');

-- Frozen since 2026-08-21 and read by nothing, but it still holds
-- 732,591,994.33 chips. A path that writes it is already broken; during a
-- freeze it must not write at all.
-- Column names verified against the live schema before this was written. A
-- trigger argument naming a column that does not exist is the worst possible
-- outcome here: the comparison simply never matches, every UPDATE passes
-- through, and the guard reports itself as installed while guarding nothing.
-- `wallets` has `balance` and no `chip_balance`; `clubs` has `chip_pool` and
-- `total_rake` and no `rake_collected`.
DROP TRIGGER IF EXISTS zz_freeze_guard ON public.wallets;
CREATE TRIGGER zz_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_while_frozen('balance');

-- Club treasury and rake.
DROP TRIGGER IF EXISTS zz_freeze_guard ON public.clubs;
CREATE TRIGGER zz_freeze_guard
  BEFORE UPDATE ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_while_frozen('chip_pool', 'total_rake');

-- The ledgers. Nothing may be journalled during a freeze because nothing may
-- move during a freeze; a ledger row appearing with no movement behind it
-- would be a reconciliation failure by construction.
DROP TRIGGER IF EXISTS zz_freeze_guard ON public.chip_transactions;
CREATE TRIGGER zz_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.chip_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_while_frozen();

DROP TRIGGER IF EXISTS zz_freeze_guard ON public.wallet_transactions;
CREATE TRIGGER zz_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_while_frozen();

-- `chip_ledger` is the append-only journal the whole zero-drift programme is
-- built on, and it was missing from the first draft of this list. An entry
-- here without a movement behind it, or a movement without an entry, is
-- exactly the drift `reconcile_ledger_nightly` exists to catch.
DROP TRIGGER IF EXISTS zz_freeze_guard ON public.chip_ledger;
CREATE TRIGGER zz_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_while_frozen();

-- ---------------------------------------------------------------------------
-- THE MINUTE-BY-MINUTE CRON JOBS STOP THEMSELVES, QUIETLY.
--
-- The triggers above would refuse these anyway, but a refusal is an EXCEPTION:
-- `sp_evict_sitting_out_cash_players` runs every minute, so an unguarded
-- freeze would put five stack traces per hour into cron.job_run_details and
-- teach whoever reads it that failures there are normal. A job that knows
-- about the freeze returns 0 and says nothing.
--
-- Only the two that actually move seats or chips are wrapped. The reporting
-- and alarm jobs are welcome to keep running - they observe, they do not move.
-- ---------------------------------------------------------------------------
-- The body below is the LIVE definition, copied verbatim from
-- pg_get_functiondef, with exactly one addition: the freeze guard at the top.
-- Nothing else about it is changed - not the three loops, not the return type,
-- not the game_type filter, not the delegation to player_leave_table.
CREATE OR REPLACE FUNCTION public.fn_evict_sitting_out_cash_players()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  -- ── THE FREEZE (Dan 2026-09-01) ─────────────────────────────────────────
  -- Nothing moves during the break. This job runs EVERY MINUTE from pg_cron,
  -- so without this it would fire five times inside every freeze - and unlike
  -- everything in the engine, pg_cron does not stop when the engine is
  -- restarted, which is the whole reason the freeze is enforced down here.
  --
  -- Returning early rather than letting the table trigger refuse it: the
  -- trigger raises, and five stack traces an hour in cron.job_run_details
  -- teach whoever reads that table that failures there are normal.
  --
  -- The player loses nothing by being skipped. Their sit-out clock is shifted
  -- forward by the frozen duration on thaw, so the five minutes they spent
  -- frozen are not counted against them.
  IF public.fn_platform_frozen() THEN
    RETURN;
  END IF;

  -- A. Boot players sitting out for more than 5 minutes
  FOR r IN
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    WHERE t.game_type = 'cash'
      AND ts.left_at IS NULL
      AND ts.sit_out_at < (now() - interval '5 minutes')
  LOOP
    -- Safely removes them and refunds any remaining chips to wallet
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;

  -- B. Boot players with exactly 0 chips who are sitting out
  -- (If they are at 0 chips during a hand, is_sitting_out is false until the hand ends)
  FOR r IN
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    WHERE t.game_type = 'cash'
      AND ts.left_at IS NULL
      AND ts.stack = 0
      AND ts.is_sitting_out = true
  LOOP
    -- Safely removes them
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;

  -- C. Remove 0-chip players in Tournaments who are marked as eliminated
  -- This ensures they don't linger on the table as a zombie seat
  FOR r IN
    SELECT ts.table_id, ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    JOIN tournament_players tp ON tp.tournament_id = t.tournament_id AND tp.user_id = ts.user_id
    WHERE ts.left_at IS NULL
      AND tp.status = 'eliminated'
  LOOP
    -- Removing a tournament player using player_leave_table just soft-deletes the seat,
    -- it does NOT refund chips because they are in a tournament (v_tournament_id IS NOT NULL).
    PERFORM public.player_leave_table(r.table_id, r.user_id);
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.fn_evict_sitting_out_cash_players() IS
  'Evicts cash seats sat out beyond five minutes, zero-chip sit-outs, and eliminated tournament seats. Returns without acting while the platform is frozen: the sit-out clock is shifted forward on thaw so a maintenance break never counts against a player.';

-- ---------------------------------------------------------------------------
-- The other two per-minute movers. Live bodies verbatim (pg_get_functiondef,
-- 2026-09-01), one guard line each. Everything else untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_credit_stalled_seat_first_stacks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t record;
  v_fixed int := 0;
BEGIN
  -- THE FREEZE (Dan 2026-09-01). This writes chips onto seats and runs every
  -- minute from pg_cron - which does not stop when the engine restarts. A
  -- tournament stalled at zero chips has already waited a minute; it can wait
  -- out the break and is credited on the first tick after the thaw.
  IF public.fn_platform_frozen() THEN
    RETURN 0;
  END IF;

  FOR v_t IN
    SELECT t.id, t.starting_chips
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND COALESCE(t.starting_chips, 0) > 0
       AND t.started_at IS NOT NULL
       AND t.started_at < now() - interval '60 seconds'
       -- Never touch a game that has actually played.
       AND NOT EXISTS (
         SELECT 1 FROM public.tables tb
          JOIN public.hand_history hh ON hh.table_id = tb.id
          WHERE tb.tournament_id = t.id
       )
       -- At least one live seat ...
       AND EXISTS (
         SELECT 1 FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id AND s.left_at IS NULL
       )
       -- ... and every one of them is still a zero-chip reservation.
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id AND s.left_at IS NULL
            AND COALESCE(s.stack, 0) > 0
       )
     FOR UPDATE OF t SKIP LOCKED
  LOOP
    UPDATE public.table_seats s
       SET stack = v_t.starting_chips
      FROM public.tables tb
     WHERE tb.id = s.table_id
       AND tb.tournament_id = v_t.id
       AND s.left_at IS NULL
       AND COALESCE(s.stack, 0) < v_t.starting_chips;

    UPDATE public.tournament_players tp
       SET chips = v_t.starting_chips
     WHERE tp.tournament_id = v_t.id
       AND tp.status IN ('playing', 'registered')
       AND COALESCE(tp.chips, 0) < v_t.starting_chips;

    v_fixed := v_fixed + 1;
    RAISE WARNING 'credited stalled seat-first tournament % to % chips', v_t.id, v_t.starting_chips;
  END LOOP;

  RETURN v_fixed;
END;
$function$;

-- The two cron movers were BROWSER-CALLABLE before this file touched them:
-- SECURITY DEFINER with no explicit grant defaults to PUBLIC EXECUTE, so any
-- anon visitor could fire a platform-wide seat-eviction sweep on demand. A
-- pre-existing hole; redeclaring them here made it ours to close. pg_cron
-- runs them as postgres, which no grant can refuse, so the jobs continue.
REVOKE ALL ON FUNCTION public.fn_evict_sitting_out_cash_players() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_evict_sitting_out_cash_players() TO service_role;
REVOKE ALL ON FUNCTION public.fn_credit_stalled_seat_first_stacks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_stalled_seat_first_stacks() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_sweep_seatless_late_registrants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_row    record;
  v_res    jsonb;
  v_seated int := 0;
  v_failed int := 0;
BEGIN
  -- THE FREEZE (Dan 2026-09-01). Seating a registrant is a seat INSERT and a
  -- chip stack; both are frozen. The registrant stays registered and is
  -- seated on the first sweep after the thaw - the same minute play resumes.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('seated', 0, 'still_waiting', 0, 'frozen', true);
  END IF;

  FOR v_row IN
    SELECT tp.tournament_id, tp.user_id
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
     WHERE t.status = 'RUNNING'
       AND tp.status = 'registered'
       AND tp.table_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats s
           JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = tp.tournament_id
            AND s.user_id = tp.user_id
            AND s.left_at IS NULL
       )
     ORDER BY tp.registered_at ASC NULLS LAST
     LIMIT 200
  LOOP
    BEGIN
      v_res := public.fn_seat_late_registrant(v_row.tournament_id, v_row.user_id);
      IF COALESCE((v_res ->> 'ok')::boolean, false) THEN
        v_seated := v_seated + 1;
      ELSE
        v_failed := v_failed + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('seated', v_seated, 'still_waiting', v_failed);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_sweep_seatless_late_registrants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_seatless_late_registrants() TO service_role;

COMMIT;

