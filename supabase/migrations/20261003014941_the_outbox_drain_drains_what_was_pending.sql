-- ============================================================================
-- THE OUTBOX DRAIN DRAINS WHAT WAS PENDING
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-03 01:22-01:55 UTC.
-- Every number below was read from cron.job_run_details, pg_stat_statements,
-- pg_stat_slru, 0.1 s pg_stat_activity sampling, or a rolled-back probe.
-- Evidence: docs/changelog/2026-10-03-the-outbox-drain-drains-what-was-pending.md
--
-- THE DEFECT. sp_drain_daily_challenge_event_outbox runs on four shards every
-- minute with a 45-second budget. Its loop has exactly one early exit: the
-- shard picker finding nothing. Daily Missions events arrive continuously at
-- ~7/s (423 rows a minute, measured: the live outbox held 423 rows none older
-- than 60 s), so the picker almost always finds another row and the run keeps
-- going until its budget expires. Measured over three hours, 720 runs:
--
--   avg 17.13 s, 492 runs over 10 s, 121 over 30 s, 89 at the 45 s ceiling,
--   1.135 CORES of the primary held continuously (sum of run durations over
--   wall clock), 13.1 M shared_blks_read, 11,185 ms mean in
--   pg_stat_statements over 24,479 calls = 5.73% of all database time.
--
-- The work it is there to do is 2.9 s. A rolled-back probe replaying the exact
-- loop for shard 0 drained the shard dry (picker returned NULL) in 2,875 ms:
-- 155 iterations, 307 events, every one booked. The remaining ~14 s per run is
-- the loop chasing arrivals: a drain that never finishes draining.
--
-- The second cost is in the shape of that chase. Each iteration is one player
-- in one transaction - two set_config calls, pg_try_advisory_xact_lock,
-- fn_lock_daily_mission_user (advisory lock plus profiles FOR NO KEY UPDATE,
-- which takes a tuple lock and dirties a profiles heap page), the per-player
-- SELECT, then COMMIT AND CHAIN. Measured 1.98 events per iteration, so that
-- whole transaction is paid for about two events. Taking arrivals as they
-- dribble in is what makes the ratio that bad: a player whose second event
-- lands ten seconds after the first is drained twice, in two transactions,
-- instead of once. profiles carries the bill - 1,599 live rows, 994 dead
-- (38.33%), 2,134 pages, autovacuumed 3,887 times; the outbox itself is 323
-- live rows against 9,672 dead (96.77%) in 453 pages, autovacuumed 4,993 times.
--
-- THE CHANGE. A drain drains what was pending when it started. The picker gains
-- o.created_at <= $1, bound to the run's own entry instant, which is already
-- in scope with no new variable: v_deadline is set to clock_timestamp() +
-- c_budget in DECLARE, so v_deadline - c_budget IS that instant, exactly.
--
-- Rolled-back probe of the changed loop, same shard, same minute:
--
--                      iterations  events  booked  skipped  elapsed  events/iter
--   as it runs now            155     307     307        0   2,875 ms       1.98
--   with the watermark        198     577     577        0   6,443 ms       2.91
--
-- Both terminate on an exhausted picker. The watermark books 47% more events
-- per transaction, which is 47% fewer advisory locks, profiles tuple locks and
-- commits for the same events, and the run ENDS instead of running to budget.
--
-- Nothing is stranded. created_at is the row's own creation instant, so a row
-- deferred by this run's watermark is at or before every later run's
-- watermark, and the four jobs run every minute. A row backed off by the
-- contention handler keeps its original created_at and is picked up as soon as
-- next_attempt_at allows, exactly as before. Ordering, per-player
-- serialisation, the 35-day dead-letter branch, the backoff and the 5,000-row
-- p_limit are untouched.
--
-- The cost is latency: an event arriving mid-run now waits for the next
-- minute's run rather than joining the one already in flight. Bounded by the
-- one-minute schedule, on a missions progress bar.
--
-- NOT CHANGED, and deliberately: no timeout (the authenticator 5 min and
-- service_role 8 s settings of the PGRST002 policy stand), no lock_timeout, no
-- grant, no schedule, no index, nothing on the hand path, and
-- fn_ca_horse_claim_due's lock span.
--
-- NOT THE WHOLE P0. This run of the audit found the platform-wide cause
-- elsewhere and it is NOT a code defect: the two multixact SLRU caches are at
-- their compiled-in defaults (multixact_offset_buffers 16 blocks = 128 kB,
-- multixact_member_buffers 32 = 256 kB) while transaction_buffers and
-- subtransaction_buffers were both raised to 1024 (8 MB). Measured over 20 s,
-- multixact_member missed 18,646 of 81,662 lookups (22.8%, 931 reads/s) and
-- multixact_offset 11,793 of 81,064 (14.6%, 589 reads/s), while the two sized
-- caches missed nothing at all. SLRU buffer locks are global, which is why a
-- two-page config table read took 5,382 ms. Both GUCs are postmaster context;
-- that is a restart, not a migration, and it is reported rather than worked
-- around here. This migration does not pretend to fix it.
--
-- BOTH HASHES ARE PINNED, AND NEITHER NEEDED A DDL PROBE. CLAUDE.md section 2
-- rule 3 forbids running the replacement against production to see what it
-- produces, so the after-hash was derived instead: pg_get_functiondef rebuilds
-- the header from pg_proc and emits prosrc verbatim, and this substitution
-- changes only text inside the body, so md5(replace(live_def, old, new)) is the
-- hash the replaced function will report. Computed read-only on production:
-- 8d827eb13fb07f3d212ff3af839819f6. The transaction asserts the live text going
-- in, that the clause occurs exactly once, that hash coming out, and that
-- undoing the substitution reproduces the pinned text byte for byte - so the
-- committed body differs from the pinned one by this delta and nothing else.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.sp_drain_daily_challenge_event_outbox(integer,integer,integer)'::regprocedure)) = '61635cfbedf05addc77a53c781963b68')
-- @after-proof: (SELECT md5(pg_get_functiondef('public.sp_drain_daily_challenge_event_outbox(integer,integer,integer)'::regprocedure)) = '8d827eb13fb07f3d212ff3af839819f6')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  s record; v_def text; v_after text; v_n integer;
  v_acl text; v_owner text; v_secdef boolean;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('sp_drain_daily_challenge_event_outbox(integer,integer,integer)',
      '61635cfbedf05addc77a53c781963b68', '8d827eb13fb07f3d212ff3af839819f6',
      E'         AND (hashtext(o.user_id::text) & 2147483647) %% %s = %s\n'
      || E'       ORDER BY o.user_id, o.created_at, o.event_key\n'
      || E'       LIMIT 1\n'
      || E'      $q$,\n'
      || E'      p_shards,\n'
      || E'      p_shard\n'
      || E'    ) INTO v_user_id;\n',
      E'         AND (hashtext(o.user_id::text) & 2147483647) %% %s = %s\n'
      || E'         /* A DRAIN DRAINS WHAT WAS PENDING (2026-10-03). Events arrive at\n'
      || E'            ~7/s, so the only early exit - the picker finding nothing - was\n'
      || E'            unreachable and every shard ran its whole 45 s budget chasing\n'
      || E'            arrivals: 1.135 cores held for 2.9 s of work, 1.98 events per\n'
      || E'            per-player transaction. v_deadline - c_budget is this run''s own\n'
      || E'            entry instant, so the run finishes the backlog it found and the\n'
      || E'            next minute takes the next one. A deferred row is at or before\n'
      || E'            every later watermark, so nothing is stranded. */\n'
      || E'         AND o.created_at <= $1\n'
      || E'       ORDER BY o.user_id, o.created_at, o.event_key\n'
      || E'       LIMIT 1\n'
      || E'      $q$,\n'
      || E'      p_shards,\n'
      || E'      p_shard\n'
      || E'    ) INTO v_user_id USING (v_deadline - c_budget);\n')
  ) AS x(signature, before_md5, after_md5, old_text, new_text)
  LOOP
    v_def := pg_get_functiondef(('public.' || s.signature)::regprocedure);
    IF md5(v_def) <> s.before_md5 THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', s.signature, md5(v_def);
    END IF;
    v_n := (length(v_def) - length(replace(v_def, s.old_text, ''))) / length(s.old_text);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the clause to change occurs % times in %, expected exactly 1', v_n, s.signature;
    END IF;
    SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef
      INTO v_acl, v_owner, v_secdef
      FROM pg_proc p WHERE p.oid = ('public.' || s.signature)::regprocedure;

    EXECUTE replace(v_def, s.old_text, s.new_text);

    v_after := pg_get_functiondef(('public.' || s.signature)::regprocedure);
    IF md5(v_after) <> s.after_md5 THEN
      RAISE EXCEPTION '% is not the derived text (md5 %)', s.signature, md5(v_after);
    END IF;
    IF (length(v_after) - length(replace(v_after, s.new_text, ''))) / length(s.new_text) <> 1 THEN
      RAISE EXCEPTION '%: the new clause is not present exactly once', s.signature;
    END IF;
    IF md5(replace(v_after, s.new_text, s.old_text)) <> s.before_md5 THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', s.signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = ('public.' || s.signature)::regprocedure
         AND p.proacl::text IS NOT DISTINCT FROM v_acl
         AND pg_get_userbyid(p.proowner) = v_owner
         AND p.prosecdef = v_secdef
    ) THEN
      RAISE EXCEPTION '%: owner, security or grants moved', s.signature;
    END IF;
  END LOOP;

  -- The four per-minute shard jobs are the only caller and must still be the
  -- only caller, unchanged, owned by postgres and sending CALL at top level
  -- (COMMIT AND CHAIN needs that).
  IF (SELECT count(*) FROM cron.job
       WHERE command ~ '^CALL public[.]sp_drain_daily_challenge_event_outbox[(]5000, [0-3], 4[)];$'
         AND username = 'postgres' AND schedule = '* * * * *' AND active) <> 4 THEN
    RAISE EXCEPTION 'the four per-minute outbox shard jobs are not as pinned';
  END IF;
END $subs$;

COMMIT;
