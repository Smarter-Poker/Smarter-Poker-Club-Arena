-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827002904; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DROP POLICY IF EXISTS waitlist_public_queue_read ON public.table_waitlist;
CREATE POLICY waitlist_public_queue_read
  ON public.table_waitlist
  FOR SELECT
  TO authenticated
  USING (status IN ('waiting', 'notified'));

UPDATE public.table_waitlist w
   SET status = 'cleared'
  FROM public.profiles p
 WHERE p.id = w.user_id
   AND COALESCE(p.is_horse, false)
   AND w.status IN ('waiting', 'notified')
   AND w.created_at < now() - interval '30 minutes';

UPDATE public.table_waitlist
   SET status = 'expired'
 WHERE status = 'waiting'
   AND created_at < now() - interval '24 hours';

UPDATE public.table_waitlist
   SET status = 'expired'
 WHERE status = 'notified'
   AND notified_at < now() - interval '1 hour';

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
