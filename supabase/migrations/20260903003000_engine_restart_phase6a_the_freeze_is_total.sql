-- ============================================================================
--  THE FREEZE IS TOTAL: NO NEW SEAT, NO REGISTRATION, NO LAUNCH - WHOEVER ASKS
--
--  Dan, 2026-09-01: "NO BUY INS, NO CHIP MOVEMENTS ... EVERYTHING JUST
--  FREEZES." Dan, 2026-09-03, on the measurement below: "THIS SOUNDS LIKE YOU
--  DIDN'T TRULY FREEZE ALL TRANSACTIONS FROM BEING ABLE TO HAPPEN, AND NEED TO
--  FIX THAT!"
--
--  WHAT HAPPENED. The 23:55 restart on 2026-09-02 was the first break that
--  parked every table (0 unparked, 0 hands started inside it). It still
--  recorded freeze_conserved = false, +1,282,347 chips onto the felt. All of
--  it was SEATING: 68 horses bought into 38 cash tables at 23:55:32-52, 48
--  late-registered into a running freeroll, eight Spins launched (three
--  completed) at 23:57-23:59, and a 00:00 MTT pre-seated its 34-horse field
--  at 23:59 for 1,020,000 chips. Every one of those writes came from the
--  engine, as service_role, which fn_refuse_while_frozen (20260902090000)
--  exempts on the stated premise that "the engine is already frozen by its
--  own machinery". It was not: its boot-time first passes and its in-flight
--  ramps do not consult the freeze flag (fixed in the same PR as this file),
--  and a premise that one forgotten call site can break is not a freeze.
--
--  THE RULE. Three writes are a buy-in or a launch BY DEFINITION and are never
--  part of settling a hand already in flight - which is the only legitimate
--  reason the engine writes money during a break:
--
--    1. INSERT INTO table_seats for a CASH table. A new cash seat is a buy-in.
--       (A new TOURNAMENT seat is either a table-balance move of chips
--       already in the event, which must never be refused mid-move, or a
--       seating that was paid for by a registration - and registrations are
--       refused at 2.)
--    2. INSERT INTO tournament_players. A registration is a buy-in.
--    3. UPDATE tournaments SET status = 'RUNNING'. A launch seats its field.
--
--  While fn_platform_frozen() is true these are refused for EVERY caller -
--  browser, pg_cron, and the engine - with the same 55006 the browser already
--  receives. The one exception is app.freeze_bypass, which only the thaw
--  sets. Nothing else the engine does during a break is touched: stack
--  UPDATEs (the last hand's settlement), sit-out clocks, presence, leases.
--
--  RESUMPTION. A refused registration RPC rolls back whole (debit included),
--  a refused launch is retried by the scheduler on its first pass after the
--  thaw, and a refused seat leaves the wallet exactly as it was. A human's
--  buy-in has behaved this way since 20260902090000; a horse's now does too.
--
--  COST. One indexed read of engine_maintenance_break per guarded write, and
--  for a cash-seat INSERT one primary-key read of tables - and only while a
--  break is running. Zero on the hot path outside the five minutes.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_refuse_new_entries_while_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_cash BOOLEAN;
BEGIN
  -- The thaw, and nothing else, may write through a freeze.
  IF public.fn_freeze_bypass_active() THEN
    RETURN NEW;
  END IF;

  -- Cheapest first: outside a break this is one indexed read and we are done.
  IF NOT public.fn_platform_frozen() THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'table_seats' THEN
    SELECT (t.tournament_id IS NULL) INTO v_is_cash
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    -- A tournament seat is a move or an already-paid seating: let it through.
    -- An unknown table is treated as cash: refusing is the safe error.
    IF NOT COALESCE(v_is_cash, TRUE) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'tournaments' THEN
    -- Only the transition INTO running is a launch. Every other status write
    -- (an event finishing, a cancellation, a late-reg close) is not.
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'RUNNING' THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55006',
          HINT = 'Scheduled maintenance breaks run from :55 to :00. No chips moved - retry after the break.';
END;
$$;

COMMENT ON FUNCTION public.fn_refuse_new_entries_while_frozen() IS
  'Refuses a new cash seat, a tournament registration, or a tournament launch while the platform is frozen - for EVERY role including service_role (the engine). Only app.freeze_bypass (the thaw) passes. These three writes are buy-ins or launches by definition and are never part of settling a hand in flight.';

-- zz_ prefix: fires last among BEFORE triggers (name order), so the existing
-- ledger / sit-out / four-table triggers see an ordinary write and this one
-- has the final say. Named distinctly from zz_freeze_guard because it is a
-- different rule with a different exemption list, and because a reviewer
-- must be able to see both on the table.
DROP TRIGGER IF EXISTS zz_freeze_entry_guard ON public.table_seats;
CREATE TRIGGER zz_freeze_entry_guard
  BEFORE INSERT ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();

DROP TRIGGER IF EXISTS zz_freeze_entry_guard ON public.tournament_players;
CREATE TRIGGER zz_freeze_entry_guard
  BEFORE INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();

DROP TRIGGER IF EXISTS zz_freeze_launch_guard ON public.tournaments;
CREATE TRIGGER zz_freeze_launch_guard
  BEFORE UPDATE OF status ON public.tournaments
  FOR EACH ROW
  WHEN (NEW.status = 'RUNNING' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();

-- Trigger functions take no arguments and are never called directly; still,
-- say so, the way every other guard here does.
REVOKE ALL ON FUNCTION public.fn_refuse_new_entries_while_frozen() FROM PUBLIC, anon, authenticated;

-- Assertions: all three doors are guarded, and the guard has no role exemption.
DO $$
DECLARE
  v_def TEXT := pg_get_functiondef('public.fn_refuse_new_entries_while_frozen()'::regprocedure);
BEGIN
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('zz_freeze_entry_guard', 'zz_freeze_launch_guard')
         AND NOT tgisinternal
         AND tgrelid IN ('public.table_seats'::regclass, 'public.tournament_players'::regclass, 'public.tournaments'::regclass)) <> 3 THEN
    RAISE EXCEPTION 'the freeze entry guard is not attached to all three tables';
  END IF;
  IF position('service_role' IN v_def) > 0 THEN
    RAISE EXCEPTION 'fn_refuse_new_entries_while_frozen must not exempt service_role - that exemption is the hole this migration closes';
  END IF;
  IF position('fn_freeze_bypass_active' IN v_def) = 0 OR position('fn_platform_frozen' IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_refuse_new_entries_while_frozen must consult the freeze and the thaw bypass';
  END IF;
END $$;

COMMIT;
