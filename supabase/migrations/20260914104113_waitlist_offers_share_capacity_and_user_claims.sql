-- Serialize exclusive offers against actual table capacity and each player's allowance.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $preflight$
DECLARE v_hash text;
BEGIN
 SELECT md5(pg_get_functiondef('public.fn_offer_open_seat(uuid,interval,interval)'::regprocedure)) INTO v_hash;
 IF v_hash NOT IN ('3dbcee6f093d9c36d7f0ee1e940d5a2b','153c27efa0ce07bf7208b9561c281796') THEN
  RAISE EXCEPTION 'Waitlist offer definition drift: %',v_hash;
 END IF;
 IF md5(pg_get_functiondef('public.fn_cash_game_open_seats(uuid)'::regprocedure))
      IS DISTINCT FROM 'badc9c72a4cd29aeff5591d988953743'
    OR md5(pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure))
      IS DISTINCT FROM '1b9173dde43a3e6d4e887843deeaa9e7' THEN
  RAISE EXCEPTION 'Waitlist offer admission dependency drift; requalify callers';
 END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION public.fn_offer_open_seat(p_table_id uuid, p_offer_ttl interval DEFAULT '00:01:00'::interval, p_entry_ttl interval DEFAULT '24:00:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tbl      record;
  v_next     record;
  v_notif_id uuid;
  v_expired  int := 0;
  v_cap      int := 1;
  v_selected boolean := false;
  v_legacy_holds integer := 0;
BEGIN
  -- Share the actual seat admission key with cash-game joins and buy-ins.
  -- A busy table is left untouched; a caller may already hold sweep rows,
  -- so waiting for another claimant here can invert that caller's locks.
  IF p_table_id IS NOT NULL AND NOT pg_try_advisory_xact_lock(
       hashtextextended('table_seat:' || p_table_id::text, 0)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_claim_busy');
  END IF;

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

  -- The cached lobby count cannot authorize an exclusive chair offer.
  v_tbl.current_players := (SELECT count(*) FROM public.table_seats s
                            WHERE s.table_id=p_table_id AND s.left_at IS NULL);
  IF v_tbl.current_players >= COALESCE(v_tbl.max_players, 9) THEN
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

  -- This same reader also reserves pending non-swap seat moves. Re-read it
  -- after expiry and under the common table key, just like the join door.
  -- Pre-column offers retain their original notified_at + TTL reservation.
  -- The shared reader counts explicit hold_expires_at values only.
  SELECT count(*) INTO v_legacy_holds FROM public.table_waitlist h
   WHERE h.table_id=p_table_id AND h.status='notified'
     AND h.hold_expires_at IS NULL AND h.notified_at+p_offer_ttl>now();
  IF COALESCE(public.fn_cash_game_open_seats(p_table_id),0) <= v_legacy_holds THEN
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
  FOR v_next IN
  SELECT w.id, w.user_id, COALESCE(p.is_horse, false) AS is_horse
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
   ORDER BY w.created_at, w.id
     FOR UPDATE OF w SKIP LOCKED
  LOOP
    -- Queue-row locks on different tables do not serialize this player's
    -- offer allowance. A nonblocking claim preserves other queue members'
    -- progress without waiting while this transaction owns a table key.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(
      hashtextextended('waitlist_offer_user:' || v_next.user_id::text, 0));
    CONTINUE WHEN v_cap > 0 AND (
      SELECT count(*) FROM public.table_waitlist h
       WHERE h.user_id=v_next.user_id AND h.status='notified'
         AND COALESCE(h.hold_expires_at,h.notified_at+p_offer_ttl)>now()
    ) >= v_cap;
    v_selected := true;
    EXIT;
  END LOOP;

  IF NOT v_selected THEN
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
$function$
;

REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid,interval,interval) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_offer_open_seat(uuid,interval,interval) TO service_role;
COMMIT;
