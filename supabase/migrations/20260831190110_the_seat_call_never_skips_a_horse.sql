CREATE OR REPLACE FUNCTION public.fn_offer_open_seat(
  p_table_id uuid,
  p_offer_ttl interval DEFAULT '60 seconds'::interval,
  p_entry_ttl interval DEFAULT '24 hours'::interval
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tbl      record;
  v_next     record;
  v_notif_id uuid;
  v_expired  int := 0;
  v_holds    int := 0;
  v_cap      int := 1;
BEGIN
  SELECT COALESCE(max_concurrent_holds, 1) INTO v_cap FROM public.waitlist_policy WHERE id;
  IF v_cap IS NULL THEN v_cap := 1; END IF;

  SELECT t.id, t.name, t.tournament_id, t.max_players, t.current_players
    INTO v_tbl
    FROM public.tables t
   WHERE t.id = p_table_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF v_tbl.tournament_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_table');
  END IF;

  IF COALESCE(v_tbl.current_players, 0) >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  WITH dead AS (
    UPDATE public.table_waitlist
       SET status = 'expired'
     WHERE table_id = p_table_id
       AND status = 'notified'
       AND COALESCE(hold_expires_at, notified_at + p_offer_ttl) < now()
    RETURNING user_id
  )
  INSERT INTO public.notifications (user_id, type, title, message, data)
  SELECT d.user_id,
         'waitlist_offer_expired',
         'Seat Offer Expired',
         'Your Seat At ' || COALESCE(v_tbl.name, 'The Table') ||
           ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
         jsonb_build_object('table_id', p_table_id, '_push', 'skip')
    FROM dead d;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE table_id = p_table_id
     AND status = 'waiting'
     AND created_at < now() - p_entry_ttl;

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

  SELECT COUNT(*) INTO v_holds
    FROM public.table_waitlist
   WHERE table_id = p_table_id
     AND status = 'notified'
     AND COALESCE(hold_expires_at, notified_at + p_offer_ttl) > now();

  IF COALESCE(v_tbl.current_players, 0) + v_holds >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'open_seats_already_held', 'offers_expired', v_expired
    );
  END IF;

  -- THE HEAD OF THE QUEUE, LOCKED, AND NOT ALREADY HOLDING A SEAT ELSEWHERE.
  -- A hold is exclusive, so handing one player several at once takes seats
  -- away from everybody behind them. Skipping a capped player leaves their
  -- place in line untouched: they are passed over for THIS seat only.
  --
  -- 2026-08-31 (Dan, binding: horses are never skipped): the is_horse
  -- exclusion that used to sit in this predicate is GONE. Whoever is first in
  -- line is offered the seat. The JOIN to profiles stays: it is no longer read
  -- to exclude anyone, but dropping it would newly qualify waitlist rows whose
  -- user has no profile row at all.
  SELECT w.id, w.user_id, COALESCE(p.is_horse, false) AS is_horse
    INTO v_next
    FROM public.table_waitlist w
    JOIN public.profiles p ON p.id = w.user_id
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND (
       v_cap = 0
       OR (
         SELECT count(*) FROM public.table_waitlist h
          WHERE h.user_id = w.user_id
            AND h.status = 'notified'
            AND COALESCE(h.hold_expires_at, h.notified_at + p_offer_ttl) > now()
       ) < v_cap
     )
   ORDER BY w.created_at
     FOR UPDATE OF w SKIP LOCKED
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'nobody_waiting', 'offers_expired', v_expired
    );
  END IF;

  UPDATE public.table_waitlist
     SET status = 'notified',
         notified_at = now(),
         hold_expires_at = now() + p_offer_ttl
   WHERE id = v_next.id;

  -- The notification row is written for every player alike, so the queue's
  -- audit trail is identical. Only the PUSH flag differs: a horse has no
  -- device to push to, which is the sanctioned identification-for-display use,
  -- and it reuses the `_push:skip` marker the expiry notification above
  -- already uses. It decides how a message is delivered, never whether a seat
  -- is offered.
  INSERT INTO public.notifications (user_id, type, title, message, data)
  VALUES (
    v_next.user_id,
    'waitlist_seat_open',
    'Seat Open',
    'A Seat Just Opened At ' || COALESCE(v_tbl.name, 'Your Waitlisted Table') ||
      '. It Is Held For You For 60 Seconds. Sit Down Now To Claim It.',
    CASE WHEN v_next.is_horse
         THEN jsonb_build_object('table_id', p_table_id, '_push', 'skip')
         ELSE jsonb_build_object('table_id', p_table_id)
    END
  )
  RETURNING id INTO v_notif_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_next.user_id,
    'table_name', v_tbl.name,
    'notification_id', v_notif_id,
    'hold_expires_in_seconds', EXTRACT(epoch FROM p_offer_ttl)::int,
    'offers_expired', v_expired
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_offer_open_seat'
       AND p.prosrc ~* 'AND\s+NOT\s+COALESCE\(\s*p\.is_horse'
  ) THEN
    RAISE EXCEPTION 'fn_offer_open_seat still excludes horses from the queue';
  END IF;
END $$;
