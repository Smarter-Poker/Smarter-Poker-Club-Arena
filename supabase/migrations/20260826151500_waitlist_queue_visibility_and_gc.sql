-- ─────────────────────────────────────────────────────────────────────────────
-- WAITLIST: make the queue visible, and clean out the garbage (Dan 2026-08-26)
--
-- 1. VISIBILITY. The only SELECT policies on table_waitlist were "own rows"
--    and "club admins". A regular player therefore saw a waiting list of at
--    most themselves — the lobby panel's queue and its "Waiting N" count only
--    worked for admins, which is why the feature looked dead ("waiting list
--    is broke and has zero functionality"). A table's ACTIVE queue is public
--    information in every poker room: names on the list, in order. Historic
--    rows (left/seated/cleared/expired) stay private.
--
-- 2. GC. The horse fleet seeded "atmosphere" queue rows behind hot tables and
--    nothing ever removed them, so queues inflated without bound ("54
--    waiting" beside an open seat map). The engine now prunes continuously
--    (HorseFleetManager.pruneHorseWaitlist); this clears the backlog it
--    inherited. Horse rows active > 30 minutes are dead by definition — a
--    horse never claims a seat offer. Human 'waiting' rows older than 24h are
--    equally dead (their table has turned over many times); 'notified' rows
--    older than 1h are unclaimed offers.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS waitlist_public_queue_read ON public.table_waitlist;
CREATE POLICY waitlist_public_queue_read
  ON public.table_waitlist
  FOR SELECT
  TO authenticated
  USING (status IN ('waiting', 'notified'));

-- Backlog GC: horse atmosphere rows.
UPDATE public.table_waitlist w
   SET status = 'cleared'
  FROM public.profiles p
 WHERE p.id = w.user_id
   AND COALESCE(p.is_horse, false)
   AND w.status IN ('waiting', 'notified')
   AND w.created_at < now() - interval '30 minutes';

-- Backlog GC: abandoned human rows.
UPDATE public.table_waitlist
   SET status = 'expired'
 WHERE status = 'waiting'
   AND created_at < now() - interval '24 hours';

UPDATE public.table_waitlist
   SET status = 'expired'
 WHERE status = 'notified'
   AND notified_at < now() - interval '1 hour';

-- Post-apply assertion: the public read policy exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.table_waitlist'::regclass
       AND polname = 'waitlist_public_queue_read'
  ) THEN
    RAISE EXCEPTION 'waitlist_public_queue_read policy missing — migration did not take';
  END IF;
END $$;

-- ROLLBACK: DROP POLICY waitlist_public_queue_read ON public.table_waitlist;
-- The GC updates are one-way by design (the rows were garbage); statuses used
-- ('cleared'/'expired') are within the existing CHECK constraint.
