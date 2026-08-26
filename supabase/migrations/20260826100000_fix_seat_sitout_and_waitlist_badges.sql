-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: STALE WAITLIST BADGES + SEAT STUCK AWAY (2026-08-26)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- BUG 1 — Player joins cash table, shows AWAY / "Seat Reserved, You'll Be Dealt
-- In Next Hand" but is never dealt in.
--
-- Root cause: atomic_table_buyin uses DELETE+INSERT which bypasses the UPDATE
-- trigger. The INSERT does not include is_sitting_out so old stale live rows
-- stay broken. Also: restoreSitOutsFromSeats() picks up is_sitting_out=true
-- from a prior occupant and immediately places the brand-new player in sit-out.
--
-- BUG 2 — Lobby shows "You Are Waitlisted" badge permanently after seating.
--
-- Root cause: no code path ever writes table_waitlist.status='seated'/'cancelled'
-- when the player actually takes a seat. The client reads ACTIVE_STATES =
-- ['waiting','notified'] and the row stays there forever.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── FIX B: BEFORE INSERT trigger — force is_sitting_out=false for new seats ──
CREATE OR REPLACE FUNCTION public.fn_new_seat_clear_sitout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A brand-new seat occupant is NEVER sitting out. Override whatever the
  -- caller wrote (or forgot) so restoreSitOutsFromSeats() cannot place a
  -- new joiner into sitting-out state.
  NEW.is_sitting_out := false;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_new_seat_clear_sitout ON public.table_seats;

CREATE TRIGGER trg_new_seat_clear_sitout
  BEFORE INSERT ON public.table_seats
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_new_seat_clear_sitout();

-- ─── FIX C: back-fill stuck live rows older than 10 minutes ───────────────────
UPDATE public.table_seats
   SET is_sitting_out = false
 WHERE left_at IS NULL
   AND is_sitting_out = true
   AND joined_at < now() - interval '10 minutes';

-- ─── FIX D: AFTER INSERT trigger — cancel waitlist row when player sits ────────
CREATE OR REPLACE FUNCTION public.fn_seat_insert_cancel_waitlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Cancel any active waitlist entry for this user+table so the lobby badge clears.
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

-- ─── FIX E: back-fill stale waitlist rows for players already seated ──────────
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
    RAISE EXCEPTION 'trg_new_seat_clear_sitout trigger missing after apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_seat_insert_cancel_waitlist') THEN
    RAISE EXCEPTION 'trg_seat_insert_cancel_waitlist trigger missing after apply';
  END IF;
  RAISE NOTICE 'Migration 20260826100000 verified: both triggers exist';
END;
$$;
