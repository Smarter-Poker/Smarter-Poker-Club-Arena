-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831084428; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE SWEEP MUST ADVANCE THE QUEUE, NOT JUST CLOSE THE ROW (2026-08-31)
--
-- Follow-up to 20260831010000_sixty_second_exclusive_seat_hold.sql, which cut
-- the seat offer from three minutes to sixty seconds. That migration left
-- fn_sweep_stale_waitlists behind, and the gap it opened is real:
--
--   1. WRONG TTL. The sweep still defaulted to '00:03:00' and read
--      notified_at directly, so it did not know hold_expires_at exists. A
--      sixty-second hold was not swept until three minutes had passed - and a
--      row whose hold was set explicitly was judged by the wrong clock.
--
--   2. IT NEVER RE-OFFERED THE SEAT. The sweep expired the lapsed row and told
--      the player their offer went "To The Next Player In Line" - and then no
--      next player was ever offered anything. Only fn_offer_open_seat makes an
--      offer, and that runs solely when a seat opens AT THAT TABLE. So the
--      seat sat open, the queue sat still, and the notification the sweep had
--      just sent was false.
--
-- Both are fixed here, in the sweep rather than in a second rule: the sweep
-- expires by hold_expires_at with a sixty-second default, then CALLS
-- fn_offer_open_seat for every table it touched. One definition of an offer,
-- one definition of an expiry.
--
-- It also re-offers on tables that have a waiting queue and NO live hold. That
-- is the state a stalled queue actually rests in - a seat opened, the offer
-- lapsed a while ago, and nobody has left since - and without it the stall
-- only clears when somebody happens to cash out. fn_offer_open_seat re-checks
-- capacity itself and answers table_full harmlessly, so a table with no room
-- costs one cheap call and changes nothing.
--
-- The scan is bounded (200 tables) so a pathological backlog cannot turn one
-- cron tick into an unbounded loop.
--
-- ROLLBACK: re-apply the previous definition, which is quoted in full in the
-- 2026-08-31 changelog entry (docs/changelog/2026-08-31-*.md).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_sweep_stale_waitlists(
  p_offer_ttl interval DEFAULT interval '60 seconds',
  p_entry_ttl interval DEFAULT interval '24 hours'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_offers_expired  int := 0;
  v_entries_expired int := 0;
  v_seated_retired  int := 0;
  v_reoffered       int := 0;
  v_tables          uuid[] := '{}';
  v_tid             uuid;
  v_res             jsonb;
BEGIN
  -- 1. LAPSED OFFERS. Judged by the row's own hold_expires_at, falling back to
  --    notified_at + TTL for rows written before the hold column existed.
  WITH dead AS (
    UPDATE public.table_waitlist w
       SET status = 'expired'
     WHERE w.status = 'notified'
       AND COALESCE(w.hold_expires_at, w.notified_at + p_offer_ttl) < now()
    RETURNING w.user_id, w.table_id
  ), ins AS (
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
  SELECT (SELECT count(*) FROM ins),
         COALESCE((SELECT array_agg(DISTINCT d.table_id) FROM dead d), '{}')
    INTO v_offers_expired, v_tables;

  -- 2. ABANDONED PLACES IN LINE.
  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE status = 'waiting'
     AND created_at < now() - p_entry_ttl;
  GET DIAGNOSTICS v_entries_expired = ROW_COUNT;

  -- 3. ALREADY SITTING.
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

  -- 4. STALLED QUEUES. Any table with people waiting and no live hold is a
  --    queue that is not moving. Include the tables we just expired an offer
  --    on, so the "went to the next player" notification is true.
  SELECT COALESCE(array_agg(DISTINCT tid), '{}')
    INTO v_tables
    FROM (
      SELECT unnest(v_tables) AS tid
      UNION
      SELECT w.table_id
        FROM public.table_waitlist w
       WHERE w.status = 'waiting'
         AND NOT EXISTS (
           SELECT 1 FROM public.table_waitlist h
            WHERE h.table_id = w.table_id
              AND h.status = 'notified'
              AND COALESCE(h.hold_expires_at, h.notified_at + p_offer_ttl) > now()
         )
       LIMIT 200
    ) s;

  -- 5. ADVANCE THE QUEUE through the ONE function that makes an offer.
  FOREACH v_tid IN ARRAY v_tables LOOP
    v_res := public.fn_offer_open_seat(v_tid, p_offer_ttl, p_entry_ttl);
    IF COALESCE((v_res ->> 'ok')::boolean, false) THEN
      v_reoffered := v_reoffered + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'offers_expired', v_offers_expired,
    'entries_expired', v_entries_expired,
    'seated_retired', v_seated_retired,
    'seats_reoffered', v_reoffered,
    'tables_scanned', COALESCE(array_length(v_tables, 1), 0)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) FROM anon;
REVOKE ALL ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) TO service_role;

COMMENT ON FUNCTION public.fn_sweep_stale_waitlists(interval, interval) IS
  'Recurring half of the waitlist TTLs. Since 2026-08-31 it expires offers by hold_expires_at (60s default, matching fn_offer_open_seat) and then CALLS fn_offer_open_seat for every table it touched plus every table with a waiting queue and no live hold - so a lapsed offer actually moves to the next player instead of stalling the queue until someone cashes out.';

-- Post-apply assertions.
DO $$
DECLARE v jsonb; v_args text;
BEGIN
  SELECT pg_get_function_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_sweep_stale_waitlists' LIMIT 1;
  IF v_args NOT LIKE '%00:01:00%' THEN
    RAISE EXCEPTION 'post-apply failed: sweep TTL default is not 60 seconds (got %)', v_args;
  END IF;

  -- Real run. The waitlist is empty or near-empty in normal operation, so this
  -- is a genuine exercise of every branch rather than a probe against a fake id.
  SELECT public.fn_sweep_stale_waitlists() INTO v;
  IF COALESCE(v ->> 'ok', '') <> 'true' THEN
    RAISE EXCEPTION 'post-apply failed: sweep did not return ok (got %)', v;
  END IF;
  IF NOT (v ? 'seats_reoffered') THEN
    RAISE EXCEPTION 'post-apply failed: sweep does not report seats_reoffered';
  END IF;
END $$;
