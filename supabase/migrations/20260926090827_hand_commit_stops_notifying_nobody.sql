-- 20260926090827_hand_commit_stops_notifying_nobody
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 09:08:27 UTC.
--
-- WHAT WAS WRONG
--
-- Every committed hand inserts one row into public.hand_projection_outbox, and
-- the AFTER INSERT trigger z9_notify_hand_projection_outbox (20260910052523)
-- calls pg_notify('hand_projection_outbox', ...). A transaction that has queued
-- a notification takes Postgres's single cluster-wide notification lock
-- (AccessExclusiveLock on "object 0 of class 1262 of database 0") in
-- PreCommit_Notify and holds it until its commit has finished, which includes
-- the WAL flush. So every hand commit on the platform commits one at a time,
-- and group commit is switched off for exactly the path that matters most.
--
-- 20260910052523 said "with no LISTENer connected the notification is dropped
-- at commit for free". That is not how Postgres works: the lock is taken
-- whether or not anyone listens, and PostgREST's own `LISTEN "pgrst"` session
-- is a registered listener, so the entry is also written to the queue.
--
-- NOBODY CONSUMES IT. The only intended reader is the engine's dedicated
-- LISTEN session (server/src/services/supabase/handOutboxListener.ts), which
-- only opens when ENGINE_PG_LISTEN_URL is set on the engine host. It is not
-- set and never has been: at 09:0x UTC on 2026-09-26 the engine's /metrics
-- read poker_hand_outbox_listener_enabled 0, _connects_total 0,
-- poker_hand_projection_wakes_total{source="listen"} 0, and pg_stat_activity
-- showed exactly one LISTEN in the whole database (PostgREST, channel pgrst).
-- The worker was carried entirely by its 5 s poll (poll 67, startup 1) and the
-- in-process commit wake. The payload is documented as "never consumed".
--
-- WHAT IT COST (log_lock_waits, deadlock_timeout 1 s, so only waits > 1 s are
-- logged): 04:00-09:00 UTC 2026-09-26, 2,754 PostgREST COMMITs waited more
-- than a second for this lock, p95 up to 5.2 s and max 5.6 s per 5-minute
-- bucket, every one of them "COMMIT waiting" from PostgREST 14.5. The buckets
-- are the brownouts: 06:40 (218), 07:25 (386), 07:45 (720), 08:05 (206),
-- 08:40 (191). The trigger for each spike was an IO stall - the 07:11:32 and
-- 07:16:24 checkpoints report sync=26.5 s and 20.5 s (longest file 3.0 s) -
-- and this lock is what turned a stalled flush into a queue of every hand
-- commit in the fleet, each one holding a PostgREST pool connection that the
-- lease heartbeat also needs. 07:10-07:13 is when the 338 managers lost proof.
--
-- WHAT THIS CHANGES
--
-- Detaches the trigger. The function stays (its md5 is pinned by
-- 20260918092329 and scripts/ci/probes/f06-shared-hand-lane) but nothing calls
-- it. The hand projection worker loses nothing: it is woken in-process when
-- the engine commits a hand (handHistory.ts), by its 5 s poll, and by the
-- startup/resync wake; it always re-reads the outbox ordered by hand_number,
-- so the order the database enforces is unchanged. The engine needs no
-- release for this: its LISTEN session, if ever enabled, simply receives
-- nothing and the poll carries the worker, as it does today.
--
-- SAFETY
--   * One transaction, SET LOCAL lock_timeout: DROP TRIGGER needs
--     AccessExclusiveLock on a table every hand writes. If it cannot get it in
--     3 s the whole file aborts and changes nothing; apply it once more after
--     :03, never in a loop (CLAUDE.md section 2 rules 2 and 8).
--   * Refuses if any session's current or last statement is a LISTEN on this
--     channel, so a consumer that appears after this was measured is not cut
--     off silently.
--   * Refuses if the trigger exists with any definition other than the one
--     measured; no-op if it is already gone.
--
-- ROLLBACK
--   CREATE TRIGGER z9_notify_hand_projection_outbox AFTER INSERT ON
--   public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION
--   trg_notify_hand_projection_outbox();

-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'public.hand_projection_outbox'::regclass AND NOT t.tgisinternal AND p.prosrc ~* 'pg_notify'))

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $guard$
DECLARE
  v_def text;
  v_listeners integer;
BEGIN
  SELECT count(*) INTO v_listeners
    FROM pg_stat_activity
   WHERE pid <> pg_backend_pid()
     AND query ~* '^\s*LISTEN\s+"?hand_projection_outbox"?';
  IF v_listeners > 0 THEN
    RAISE EXCEPTION 'HAND_OUTBOX_NOTIFY_HAS_A_LISTENER: % session(s) LISTEN on hand_projection_outbox; re-measure before detaching', v_listeners;
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.hand_projection_outbox'::regclass
     AND t.tgname = 'z9_notify_hand_projection_outbox'
     AND NOT t.tgisinternal;

  IF v_def IS NOT NULL AND v_def IS DISTINCT FROM
     'CREATE TRIGGER z9_notify_hand_projection_outbox AFTER INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION trg_notify_hand_projection_outbox()' THEN
    RAISE EXCEPTION 'HAND_OUTBOX_NOTIFY_PREIMAGE_CHANGED: %', v_def;
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS z9_notify_hand_projection_outbox ON public.hand_projection_outbox;

DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.hand_projection_outbox'::regclass
       AND NOT t.tgisinternal
       AND p.prosrc ~* 'pg_notify|\mNOTIFY\M'
  ) THEN
    RAISE EXCEPTION 'HAND_OUTBOX_STILL_NOTIFIES';
  END IF;
END
$post$;

COMMIT;
