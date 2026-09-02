-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: SEAT STUCK AWAY + STALE WAITLIST BADGES (2026-08-26)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- BUG 1: Player joins cash table → shows AWAY / "Seat Reserved, Never Dealt In"
-- Fix: BEFORE INSERT trigger forces is_sitting_out=false. atomic_table_buyin
-- uses DELETE+INSERT which bypassed the existing UPDATE trigger; any stale
-- is_sitting_out=true would cause restoreSitOutsFromSeats() to place the new
-- player into sit-out state before their first hand.
--
-- BUG 2: "You Are Waitlisted" lobby badge stays forever after being seated.
-- Fix: AFTER INSERT trigger on table_seats atomically cancels the user's active
-- waitlist entry for that table the moment they sit down. Also fixes
-- WaitlistService using 'cancelled' which is not in the DB constraint.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Bug 1 Fix: BEFORE INSERT trigger — force is_sitting_out=false ────────────
CREATE OR REPLACE FUNCTION public.fn_new_seat_clear_sitout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A brand-new seat occupant is NEVER sitting out. Enforce regardless of
  -- what the calling RPC wrote. This covers the INSERT path in
  -- atomic_table_buyin (DELETE+INSERT) which bypasses the UPDATE trigger
  -- trg_clear_sitout_on_turnover.
  NEW.is_sitting_out := false;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_new_seat_clear_sitout ON public.table_seats;

CREATE TRIGGER trg_new_seat_clear_sitout
  BEFORE INSERT ON public.table_seats
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_new_seat_clear_sitout();

-- Back-fill any existing stuck live rows (>10 min old, not in an active hand)
UPDATE public.table_seats
   SET is_sitting_out = false
 WHERE left_at IS NULL
   AND is_sitting_out = true
   AND joined_at < now() - interval '10 minutes';

-- ─── Bug 2 Fix: AFTER INSERT trigger — clear waitlist when player sits ─────────
CREATE OR REPLACE FUNCTION public.fn_seat_insert_cancel_waitlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When a player takes a seat, immediately mark their active waitlist entry
  -- for that table as 'seated' so the client's myWaitlists() query stops
  -- returning it and the lobby "You Are Waitlisted" badge clears.
  UPDATE public.table_waitlist
     SET status = 'seated'
   WHERE table_id = NEW.table_id
     AND user_id  = NEW.user_id
     AND status IN ('waiting', 'notified');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seat_insert_cancel_waitlist ON public.table_seats;

CREATE TRIGGER trg_seat_insert_cancel_waitlist
  AFTER INSERT ON public.table_seats
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_seat_insert_cancel_waitlist();

-- Back-fill stale waitlist rows for players who are already seated
UPDATE public.table_waitlist w
   SET status = 'seated'
  FROM public.table_seats s
 WHERE w.table_id = s.table_id
   AND w.user_id  = s.user_id
   AND s.left_at IS NULL
   AND w.status IN ('waiting', 'notified');

-- ─── Verification ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_new_seat_clear_sitout') THEN
    RAISE EXCEPTION 'trg_new_seat_clear_sitout missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_seat_insert_cancel_waitlist') THEN
    RAISE EXCEPTION 'trg_seat_insert_cancel_waitlist missing';
  END IF;
  RAISE NOTICE 'Migration 20260826100000 OK: both triggers present';
END;
$$;
