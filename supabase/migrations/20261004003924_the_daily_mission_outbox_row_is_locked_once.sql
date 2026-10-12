-- ============================================================================
-- THE DAILY MISSION OUTBOX ROW IS LOCKED ONCE
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-03 21:00 to
-- 2026-10-04 00:21 UTC, read-only: cron.job_run_details, progress receipts
-- per run window, pg_stat_get_activity sampling, pg_stat_get_slru deltas,
-- mxid_age deltas, and per-call index counters of the shard picker run in a
-- separate session. Evidence:
-- docs/changelog/2026-10-04-the-daily-mission-outbox-row-is-locked-once.md
--
-- THE DEFECT. enqueue_daily_challenge_event (the six-argument overload that
-- fn_drain_daily_challenge_event_outbox_user calls for every event) reads the
-- outbox row with SELECT ... FOR UPDATE. That runs inside the drain's
-- per-player exception block (subtransaction A). It then deletes the same row
-- inside its own exception block (subtransaction B). A tuple locked by one
-- subtransaction and deleted by another gets a new MultiXact as its xmax
-- (compute_new_xmax_infomask: the locker is our own transaction but not the
-- same subtransaction, so PostgreSQL creates a multixact to keep the lock if
-- B aborts). Every drained outbox row therefore dies with a MultiXact xmax,
-- and two things follow:
--
--   1. HeapTupleIsSurelyDead returns false for a MultiXact xmax, so index
--      scans never mark these entries dead, and MVCC checks cannot set a hint
--      bit on them. Until autovacuum removes them, the shard picker re-reads
--      every row drained since the last vacuum on every call, and each read
--      is a MultiXact member lookup in the 128 kB / 256 kB SLRU caches.
--   2. The drain creates one MultiXact per booked event on top of the ones
--      foreign-key locks already create.
--
-- MEASURED (after the 00:09:55 UTC compute resize, shared_buffers 16 GB):
--   picker, 480 calls: avg 600 index entries read per call during a run and
--     965 after it, about 26 live; 2.0 to 2.3 ms per call, max 11.8 ms.
--   drain window (3.7 s a minute) vs the rest of the minute:
--     MultiXact member lookups 141,000/s vs 7,700/s;
--     MultiXacts created       2,464/s  vs 119/s;
--     that window is 71% of all member lookups and 74% of all MultiXacts
--     created on the database; 2.25 MultiXacts per booked event.
--   runs: 3.05 s average over 44 runs, 2.64 ms per event + 4.0 ms per
--     player transaction (picker included).
-- BEFORE the resize (21:00 to 23:50 UTC, 652 runs): 15.4 s per run, about
--   9 ms per event + 20 to 25 ms per player transaction.
--
-- THE CHANGE. The outbox SELECT loses FOR UPDATE. Nothing else changes. The
-- delete then stamps a plain xid, so the dead row gets a hint bit and its
-- index entries can be killed, and no MultiXact is created for it.
--
-- WHY CREDITS CANNOT CHANGE. The function's first statement is
-- fn_lock_daily_mission_user (player advisory lock + profiles FOR NO KEY
-- UPDATE), so the row lock is redundant for every writer of a player's
-- outbox rows:
--   fn_drain_daily_challenge_event_outbox_user  holds the player lock;
--   enqueue_daily_challenge_event (both)        holds the player lock;
--   fn_enqueue_hand_daily_missions              INSERT ... ON CONFLICT DO
--                                               NOTHING, never changes a row;
--   fn_prune_daily_mission_operations           deletes rows dead-lettered
--                                               over 180 days ago only;
--   cleanup_reserved_certification_account      test-account teardown, takes
--                                               auth.users FOR UPDATE first,
--                                               which already conflicts with
--                                               the receipt insert's FK lock.
-- The drain's skip path updates attempts/last_error/next_attempt_at only,
-- never the payload columns this read compares. The row read feeds only the
-- payload check and the record_daily_challenge_event call; receipts, period
-- assignment, progress and completion are untouched.
-- scripts/ci/test-the-daily-mission-outbox-row-is-locked-once.py drives the
-- same hand stream through both versions and compares every receipt and
-- every user_daily_challenges row.
--
-- NOT CHANGED: the receipt-table FOR UPDATE, the five-argument overload
-- (the drain does not call it), the player lock, the drain procedure, the
-- schedule, grants.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)'::regprocedure)) = 'fb7a950cdbbc657b2b6a4b52b65443bf')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  c_sig constant text := 'public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)';
  c_before constant text := '1131a47e5e916b94ab0383ee570d4a60';
  c_after constant text := 'fb7a950cdbbc657b2b6a4b52b65443bf';
  c_old constant text :=
       E'  FROM public.daily_challenge_event_outbox\n'
    || E'  WHERE user_id = p_user_id\n'
    || E'    AND event_key = p_event_key\n'
    || E'  FOR UPDATE;\n';
  c_new constant text :=
       E'  FROM public.daily_challenge_event_outbox\n'
    || E'  WHERE user_id = p_user_id\n'
    || E'    AND event_key = p_event_key;\n';
  v_def text; v_after text; v_acl text; v_owner text; v_secdef boolean;
BEGIN
  v_def := pg_get_functiondef(c_sig::regprocedure);
  IF md5(v_def) <> c_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', c_sig, md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'the outbox row read does not occur exactly once in %', c_sig;
  END IF;
  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef
    INTO v_acl, v_owner, v_secdef
    FROM pg_proc p WHERE p.oid = c_sig::regprocedure;

  EXECUTE replace(v_def, c_old, c_new);

  v_after := pg_get_functiondef(c_sig::regprocedure);
  IF md5(v_after) <> c_after THEN
    RAISE EXCEPTION '% is not the derived text (md5 %)', c_sig, md5(v_after);
  END IF;
  IF md5(replace(v_after, c_new, c_old)) <> c_before THEN
    RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', c_sig;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = c_sig::regprocedure
       AND p.proacl::text IS NOT DISTINCT FROM v_acl
       AND pg_get_userbyid(p.proowner) = v_owner
       AND p.prosecdef = v_secdef
  ) THEN
    RAISE EXCEPTION '%: owner, security or grants moved', c_sig;
  END IF;
  IF has_function_privilege('anon', c_sig::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', c_sig::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '%: anon or authenticated can execute it', c_sig;
  END IF;
END $subs$;

COMMIT;
