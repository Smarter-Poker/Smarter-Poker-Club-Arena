-- ─────────────────────────────────────────────────────────────────────────────
-- ONE SEAT OFFER, ONE TRANSACTION (Dan 2026-08-30)
--
-- `notifyWaitlistSeatOpen` grew to six round trips — read the table, expire
-- dead offers, expire abandoned rows, retire seated rows, page the queue
-- looking for a human, claim the head, insert the notification — and it runs
-- on EVERY cash-out at EVERY table (markSeatAsLeft, atomicCashout,
-- processLeavePending). That is the cost side, and at today's volume it is not
-- yet the problem.
--
-- THE CORRECTNESS SIDE IS. Between the read that picks the queue head and the
-- UPDATE that claims it, another engine (or another seat opening at the same
-- table a millisecond later) can pick the same row. The old code noticed and
-- coped — the claim is `.eq('status','waiting')` and a losing racer returns
-- when it updates nothing — but the cost of losing is that the SEAT GOES
-- UNOFFERED. Nobody is told, and the next offer only happens when another seat
-- turns over. Doing the whole thing under one lock removes the race rather than
-- surviving it: `FOR UPDATE ... SKIP LOCKED` hands a concurrent caller the NEXT
-- person in line instead of a collision.
--
-- TELLING SOMEBODY THEIR OFFER LAPSED. The offer TTL has always existed and has
-- always been silent: your place in line evaporates after three minutes and
-- nothing anywhere says so. The reclaim step now writes a notification to the
-- player whose offer it just expired. It is a BELL ITEM, not an interrupt --
-- `data->>'_push'` is set, which is the documented signal that makes
-- fn_mirror_notification_to_push_outbox skip the row, so this cannot itself
-- become the next round of unwanted pushes.
--
-- HORSES. The human-only filter is the ONE sanctioned use of `is_horse` here
-- (CLAUDE.md 10.5, "the horse's input device"): a horse has no phone, so
-- offering it the seat wastes the offer while real people wait behind it. It
-- denies a horse nothing — horses are seated by the fleet manager on the same
-- tables through the same RPCs.
--
-- Written as a plain SQL JOIN on purpose. The TypeScript version deliberately
-- avoided a PostgREST embed (`profiles!inner(is_horse)`) because
-- table_waitlist.user_id carries two foreign keys and an ambiguous embed
-- resolves at PostgREST's discretion — a 400 there would have stopped seat
-- offers entirely and silently. That hazard is a PostgREST one and does not
-- exist in SQL, where the join is explicit.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_offer_open_seat(uuid, interval, interval);
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_offer_open_seat(
  p_table_id  uuid,
  p_offer_ttl interval DEFAULT interval '3 minutes',
  p_entry_ttl interval DEFAULT interval '24 hours'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tbl      record;
  v_next     record;
  v_notif_id uuid;
  v_expired  int := 0;
BEGIN
  SELECT t.id, t.name, t.tournament_id, t.max_players, t.current_players
    INTO v_tbl
    FROM public.tables t
   WHERE t.id = p_table_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  -- Waitlists are cash-only. Tournament entrants are engine-seated and are
  -- never queued, so a row for one would be a bug upstream, not an offer.
  IF v_tbl.tournament_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_table');
  END IF;

  IF COALESCE(v_tbl.current_players, 0) >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  -- 1. RECLAIM DEAD OFFERS, AND SAY SO. Without the reclaim a single unclaimed
  --    offer jams the queue permanently. Without the notification the player
  --    simply stops existing in the line with no idea why.
  WITH dead AS (
    UPDATE public.table_waitlist
       SET status = 'expired'
     WHERE table_id = p_table_id
       AND status = 'notified'
       AND notified_at < now() - p_offer_ttl
    RETURNING user_id
  )
  INSERT INTO public.notifications (user_id, type, title, message, data)
  SELECT d.user_id,
         'waitlist_offer_expired',
         'Seat Offer Expired',
         'Your Seat At ' || COALESCE(v_tbl.name, 'The Table') ||
           ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
         -- '_push' is the gateway signal the mirror trigger checks first. This
         -- is a bell item; it must never buzz a phone.
         jsonb_build_object('table_id', p_table_id, '_push', 'skip')
    FROM dead d;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- 2. ABANDONED PLACES IN LINE. The 24h sweep in
  --    20260826151500_waitlist_queue_visibility_and_gc.sql ran ONCE, as a
  --    backlog cleanup, and no recurring job took it over — so a row you joined
  --    and walked away from has been immortal ever since. Offering a seat off
  --    one of those is indistinguishable, from the player's side, from a
  --    random push.
  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE table_id = p_table_id
     AND status = 'waiting'
     AND created_at < now() - p_entry_ttl;

  -- 3. ALREADY SITTING AT THIS TABLE. Nothing retired a queue row when the
  --    player took a seat by any route other than the offer itself, so buying
  --    in from the lobby left the row 'waiting' and the next seat to turn over
  --    pushed "tap to claim it" at somebody already in seat 4 — and burnt the
  --    offer doing it, because the head was marked notified and nobody moved.
  UPDATE public.table_waitlist w
     SET status = 'seated'
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = p_table_id
          AND s.left_at IS NULL
          AND s.user_id = w.user_id
     );

  -- 4. THE HEAD OF THE QUEUE, LOCKED. No arbitrary window: the old code read
  --    the ten oldest rows and gave up if all ten were horses, which on a
  --    deliberately horse-seeded queue is the expected shape rather than a
  --    freak one. ORDER BY + LIMIT 1 + SKIP LOCKED walks the whole queue and
  --    hands a concurrent caller the next person instead of a collision.
  SELECT w.id, w.user_id
    INTO v_next
    FROM public.table_waitlist w
    JOIN public.profiles p ON p.id = w.user_id
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND NOT COALESCE(p.is_horse, false)
   ORDER BY w.created_at
     FOR UPDATE OF w SKIP LOCKED
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'nobody_waiting', 'offers_expired', v_expired
    );
  END IF;

  UPDATE public.table_waitlist
     SET status = 'notified', notified_at = now()
   WHERE id = v_next.id;

  -- The ONLY push writer. fn_mirror_notification_to_push_outbox turns this row
  -- into exactly one push_outbox row, and push-dispatch runs gateDecision() on
  -- it, so consent is respected by construction. An explicit push_outbox insert
  -- beside this one is what produced the duplicate banner on 2026-08-29.
  INSERT INTO public.notifications (user_id, type, title, message, data)
  VALUES (
    v_next.user_id,
    'waitlist_seat_open',
    'Seat Open',
    'A Seat Just Opened At ' || COALESCE(v_tbl.name, 'Your Waitlisted Table') ||
      '. Sit Down Now To Claim It.',
    jsonb_build_object('table_id', p_table_id)
  )
  RETURNING id INTO v_notif_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_next.user_id,
    'table_name', v_tbl.name,
    'notification_id', v_notif_id,
    'offers_expired', v_expired
  );
END
$fn$;

-- A mutating SECURITY DEFINER function is never callable by a browser. Only the
-- engine's service role runs this. Same posture as
-- 20260819_revoke_anon_exec_mutating_definer_fns.sql in World Hub.
REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM anon;
REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) TO service_role;

COMMENT ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) IS
  'Offers an open cash seat to the longest-waiting HUMAN on the table waitlist, in one transaction: reclaims lapsed offers (notifying whoever lost one), expires abandoned queue rows, retires rows for players already seated here, then claims the head under FOR UPDATE SKIP LOCKED and writes the seat-open notification. The notification is the only push writer. Replaces six round trips and a claim race in notifyWaitlistSeatOpen. Added 2026-08-30.';

-- Post-apply assertions.
DO $$
DECLARE v_probe jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_offer_open_seat'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: fn_offer_open_seat was not created';
  END IF;

  -- Probe with a table id that cannot exist. This exercises parse, plan and the
  -- first branch without touching a single real row — the pattern from
  -- CLAUDE.md 11.5, where what you want from a probe is the answer, not the
  -- side effects.
  SELECT public.fn_offer_open_seat('00000000-0000-0000-0000-000000000000'::uuid) INTO v_probe;
  IF COALESCE(v_probe ->> 'reason', '') <> 'table_not_found' THEN
    RAISE EXCEPTION 'post-apply failed: unknown table probe answered %', v_probe;
  END IF;
END $$;
