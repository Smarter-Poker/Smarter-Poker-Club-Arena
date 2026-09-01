-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830040302; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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
       AND notified_at < now() - p_offer_ttl
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

REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM anon;
REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) TO service_role;

COMMENT ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) IS
  'Offers an open cash seat to the longest-waiting HUMAN on the table waitlist, in one transaction: reclaims lapsed offers (notifying whoever lost one), expires abandoned queue rows, retires rows for players already seated here, then claims the head under FOR UPDATE SKIP LOCKED and writes the seat-open notification. The notification is the only push writer. Replaces six round trips and a claim race in notifyWaitlistSeatOpen. Added 2026-08-30.';

DO $$
DECLARE v_probe jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_offer_open_seat'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: fn_offer_open_seat was not created';
  END IF;

  SELECT public.fn_offer_open_seat('00000000-0000-0000-0000-000000000000'::uuid) INTO v_probe;
  IF COALESCE(v_probe ->> 'reason', '') <> 'table_not_found' THEN
    RAISE EXCEPTION 'post-apply failed: unknown table probe answered %', v_probe;
  END IF;
END $$;
