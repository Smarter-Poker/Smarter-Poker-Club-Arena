-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830042553; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_sweep_stale_waitlists(
  p_offer_ttl interval DEFAULT interval '3 minutes',
  p_entry_ttl interval DEFAULT interval '24 hours'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_offers_expired  int := 0;
  v_entries_expired int := 0;
  v_seated_retired  int := 0;
BEGIN
  WITH dead AS (
    UPDATE public.table_waitlist w
       SET status = 'expired'
     WHERE w.status = 'notified'
       AND w.notified_at < now() - p_offer_ttl
    RETURNING w.user_id, w.table_id
  )
  INSERT INTO public.notifications (user_id, type, title, message, data)
  SELECT d.user_id,
         'waitlist_offer_expired',
         'Seat Offer Expired',
         'Your Seat At ' || COALESCE(t.name, 'The Table') ||
           ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
         jsonb_build_object('table_id', d.table_id, '_push', 'skip')
    FROM dead d
    LEFT JOIN public.tables t ON t.id = d.table_id;
  GET DIAGNOSTICS v_offers_expired = ROW_COUNT;

  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE status = 'waiting'
     AND created_at < now() - p_entry_ttl;
  GET DIAGNOSTICS v_entries_expired = ROW_COUNT;

  UPDATE public.table_waitlist w
     SET status = 'seated'
   WHERE w.status = 'waiting'
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = w.table_id
          AND s.left_at IS NULL
          AND s.user_id = w.user_id
     );
  GET DIAGNOSTICS v_seated_retired = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'offers_expired', v_offers_expired,
    'entries_expired', v_entries_expired,
    'seated_retired', v_seated_retired
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) FROM anon;
REVOKE ALL ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) TO service_role;

COMMENT ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) IS
  'The recurring half of the waitlist TTLs. fn_offer_open_seat applies the same two rules but only when a seat opens at that table, so a quiet table keeps stale rows: the lobby overstates its queue and a lapsed offer is never announced. Called by pages/api/cron/waitlist-sweep.js on Open Claw. Added 2026-08-30.';

DO $$
DECLARE v_res jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_sweep_stale_waitlists'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: fn_sweep_stale_waitlists was not created';
  END IF;

  SELECT public.fn_sweep_stale_waitlists() INTO v_res;
  IF COALESCE(v_res ->> 'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION 'post-apply failed: first sweep answered %', v_res;
  END IF;
  RAISE NOTICE 'first waitlist sweep: %', v_res;
END $$;
