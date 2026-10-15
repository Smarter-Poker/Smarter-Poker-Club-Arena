-- 20261015044258_a_seat_offer_that_lapses_is_never_a_notification.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-14, with a screenshot of his notification inbox: "SEAT OFFER
-- EXPIRED SHOULD NEVER BE SENT AS A PUSH NOTIFICATION LIKE THIS."
--
-- The two functions that lapse a waitlist hold each wrote a notifications row
-- of type 'waitlist_offer_expired' ("Seat Offer Expired ... Went To The Next
-- Player In Line"). The device push was already skipped (data._push='skip'),
-- but the row itself landed in the Signal Inbox, which is what Dan was shown.
-- A lapsed one-minute hold is a table event, not news: the waitlist on the
-- table already says the player is no longer holding the seat.
--
-- Root fix: the two creator lines are removed.
--   - fn_offer_open_seat: the lapsed holds are still expired in the same
--     statement; the count it reports ('offers_expired') is now taken from the
--     lapsed rows themselves instead of from the notifications it wrote.
--   - fn_sweep_stale_waitlists: same, `count(*) FROM dead` instead of
--     `FROM ins`.
-- Both are rewritten from their exact production bodies (md5 guarded below),
-- with only those lines changed, so nothing else about the queue moves.
-- The rows already written are removed so the inboxes stop showing them.
-- @live-proof: position('waitlist_offer_expired' in pg_get_functiondef('public.fn_offer_open_seat(uuid,interval,interval)'::regprocedure)) = 0 AND position('waitlist_offer_expired' in pg_get_functiondef('public.fn_sweep_stale_waitlists(interval,interval)'::regprocedure)) = 0

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $rewrite$
DECLARE
  d text;
  old_frag text;
  new_frag text;
BEGIN
  IF md5(pg_get_functiondef('public.fn_offer_open_seat(uuid,interval,interval)'::regprocedure))
       IS DISTINCT FROM '601a55f77865b62e16605af65af48841' THEN
    RAISE EXCEPTION 'fn_offer_open_seat changed since this migration was written';
  END IF;
  IF md5(pg_get_functiondef('public.fn_sweep_stale_waitlists(interval,interval)'::regprocedure))
       IS DISTINCT FROM 'bd0c970c80227578c40edfbe28e33064' THEN
    RAISE EXCEPTION 'fn_sweep_stale_waitlists changed since this migration was written';
  END IF;

  -- fn_offer_open_seat
  d := pg_get_functiondef('public.fn_offer_open_seat(uuid,interval,interval)'::regprocedure);
  old_frag := $f$  INSERT INTO public.notifications (user_id, type, title, message, data)
  SELECT d.user_id,
         'waitlist_offer_expired',
         'Seat Offer Expired',
         'Your Seat At ' || COALESCE(v_tbl.name, 'The Table') ||
           ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
         jsonb_build_object('table_id', p_table_id, '_push', 'skip')
    FROM dead d;
  GET DIAGNOSTICS v_expired = ROW_COUNT;$f$;
  new_frag := $f$  -- A lapsed hold is not a notification (Dan 2026-10-14).
  SELECT count(*) INTO v_expired FROM dead;$f$;
  IF strpos(d, old_frag) = 0 THEN RAISE EXCEPTION 'fn_offer_open_seat fragment not found'; END IF;
  EXECUTE replace(d, old_frag, new_frag);

  -- fn_sweep_stale_waitlists
  d := pg_get_functiondef('public.fn_sweep_stale_waitlists(interval,interval)'::regprocedure);
  old_frag := $f$  ), ins AS (
    INSERT INTO public.notifications (user_id, type, title, message, data)
    SELECT d.user_id,
           'waitlist_offer_expired',
           'Seat Offer Expired',
           'Your Seat At ' || COALESCE(t.name, 'The Table') ||
             ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
           jsonb_build_object('table_id', d.table_id, '_push', 'skip')
      FROM dead d
      LEFT JOIN public.tables t ON t.id = d.table_id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins),$f$;
  new_frag := $f$  )
  -- A lapsed hold is not a notification (Dan 2026-10-14).
  SELECT (SELECT count(*) FROM dead),$f$;
  IF strpos(d, old_frag) = 0 THEN RAISE EXCEPTION 'fn_sweep_stale_waitlists fragment not found'; END IF;
  EXECUTE replace(d, old_frag, new_frag);

  -- Neither body may still write the notice.
  IF pg_get_functiondef('public.fn_offer_open_seat(uuid,interval,interval)'::regprocedure) ILIKE '%waitlist_offer_expired%'
     OR pg_get_functiondef('public.fn_sweep_stale_waitlists(interval,interval)'::regprocedure) ILIKE '%waitlist_offer_expired%' THEN
    RAISE EXCEPTION 'a lapsed-hold notification writer survived';
  END IF;
END
$rewrite$;

DELETE FROM public.notifications WHERE type = 'waitlist_offer_expired';

COMMIT;
