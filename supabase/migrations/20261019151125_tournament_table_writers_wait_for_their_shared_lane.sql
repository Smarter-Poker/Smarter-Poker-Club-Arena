-- 20261019151125_tournament_table_writers_wait_for_their_shared_lane.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- TOURNAMENT TABLE WRITERS WAIT FOR THEIR SHARED LANE (2026-10-19, launch-day
-- phase 2B). Full account:
-- docs/changelog/2026-10-19-tournament-table-writers-wait-for-their-shared-lane.md.
--
-- THE DEFECT, MEASURED. In the 24 hours to 2026-10-19 15:00 UTC Postgres
-- logged about 17,900 F06_RETRY_CANONICAL_LANE refusals (SQLSTATE 55P03),
-- 1,741 of them in the 14:00 hour alone. 99.9% are raised by the two F06 hand
-- guards - smarter_private.f06_cancelled_preparation_writer_guard (1,878 since
-- 11:00) and smarter_private.f06_aborted_hand_guard (1,709) - inside exactly
-- four engine RPCs: fn_ca_process_hand_post_commit_obligations (1,236),
-- insert_hole_cards (1,061), save_hand_state_snapshot (817) and
-- fn_project_hand_side_effects (475). The engine gives a hole-card save three
-- attempts; when all three are refused it sends hole_cards_unavailable and
-- the hand plays on without the durable cards a reconnecting player reads.
--
-- THE CAUSE. Both guards prove the write is inside the tournament lane by
-- TRYING G shared and T(id) shared (pg_try_advisory_xact_lock_shared) and
-- raising on the first refusal. A shared try is refused whenever T(id) is
-- held exclusively OR an exclusive request for it is queued (Postgres queues
-- new shared requests behind a waiting exclusive one). Every tournament-wide
-- authority holds T(id) exclusive: a self-aborting production sample of
-- pg_locks at 15:03 UTC (12,422 reads over 30 s) found some running
-- tournament's T(id) held exclusively in 22% of reads - by
-- fn_complete_tournament_terminal, fn_move_tournament_player,
-- fn_register_horse_for_tournament..., fn_seat_horse_in_seat_first_game,
-- fn_eliminate_tournament_player_atomic, fn_f06_begin_break,
-- fn_f06_discover_breaks and fn_publish_tournament_blind_level - and an
-- exclusive request queued in 5%. In those windows every table of that
-- tournament had its hole cards, snapshot and post-commit work refused at
-- once, which is why the refusals grow with the number of tables. The other
-- per-table F06 calls (fn_f06_allocate_hand_number, fn_f06_begin_hand,
-- fn_f06_finish_hand, fn_ca_commit_hand_submission) already WAIT for the
-- same shared lane (20261003230910 and fn_ca_share_settlement_lane_for_table);
-- the same sample shows them queued, never refused.
--
-- THE FIX. smarter_private.f06_wait_table_lane(table) takes G shared and
-- T(id) shared, WAITING (bounded at 4 s by its own lock_timeout; on expiry
-- it raises the same F06_RETRY_CANONICAL_LANE / 55P03 the guard raises, so
-- the engine's existing classification and retries are unchanged). Each of
-- the four RPCs calls it as its FIRST lock, before any row or advisory lock,
-- after only lock-free reads that resolve its table. When the guard then
-- tries the same two locks inside the write, this transaction already holds
-- them and the try returns at once.
--
-- WHAT THE F06 GUARANTEE IS AND WHY IT IS UNCHANGED. Terminal settlement,
-- finish and every rolling authority take T(id) (or G) EXCLUSIVE and must
-- never interleave with a hand write they have to see or fence. That still
-- holds by the same mechanism: every guarded write holds G and T(id) shared
-- from BEFORE its row is written until its transaction ends, which an
-- exclusive holder cannot overlap. The holds are only longer (they now start
-- at the top of the RPC instead of at the guarded statement). A write that
-- used to be refused now waits for the authority to finish, and because
-- these are VOLATILE plpgsql bodies under READ COMMITTED its guarded
-- statement then runs on a fresh snapshot that sees what the authority
-- committed - a cancellation or abort fence raises
-- F06_CANCELLED_PREPARATION_FENCED / F06_ABORTED_HAND_FENCED exactly as
-- before. Neither guard is changed: a direct write that did not take the
-- lane first is still refused, not waited for.
--
-- WHY WAITING HERE CANNOT DEADLOCK THROUGH THE LANE. The wait happens while
-- the transaction holds no lock at all (each RPC is one PostgREST
-- transaction and the call precedes every lock it takes). Callers that
-- already hold the lane re-enter it without waiting: fn_project_hand_side_effects
-- (which now takes it first) for its nested post-commit call and trigger, and
-- fn_ca_resume_hand_submission / original_hand_correction_sources_match,
-- which hold T(id) exclusive (own locks never conflict). The retired drain
-- fn_ca_drain_orphaned_post_commit_envelopes is not scheduled and no code
-- calls it (tests/a-retired-compensation-job-is-never-scheduled-again).
-- Cash tables (tables.tournament_id IS NULL) take no lane, as before.
--
-- No money moves. No predicate, fence, receipt, grant or owner changes on the
-- four RPCs; each is a single insertion on its md5-pinned live text, the
-- reverse substitution reproduces the pin, and privileges are re-checked.
-- Qualified on PostgreSQL 17 against the exact live bodies by
-- scripts/dev/test-tournament-table-writers-wait-for-their-lane.py.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('smarter_private.f06_wait_table_lane(uuid)'::regprocedure)) = '4cd46ed5819cd9a91f87c93d4f112e45')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION smarter_private.f06_wait_table_lane(p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET lock_timeout TO '4s'
AS $function$
DECLARE t uuid;
BEGIN
  /* A TOURNAMENT TABLE'S WRITER WAITS FOR ITS SHARED LANE (2026-10-19).
     The F06 hand guards TRY G shared and T(id) shared inside the write and
     refuse on contention. A per-table writer calls this first, before any
     row or advisory lock, so it waits (at most 4 s) for an exclusive
     tournament authority instead of being refused by it; the guard's try
     then finds the locks already held by this transaction. A table without
     a tournament takes no lane, exactly as the guards. */
  IF p_table_id IS NULL THEN
    RETURN;
  END IF;
  SELECT tb.tournament_id INTO t FROM public.tables tb WHERE tb.id = p_table_id;
  IF t IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || t::text, 0));
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE = '55P03';
  END;
END
$function$;
REVOKE ALL ON FUNCTION smarter_private.f06_wait_table_lane(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION smarter_private.f06_wait_table_lane(uuid) TO service_role;
COMMENT ON FUNCTION smarter_private.f06_wait_table_lane(uuid) IS
  'Per-table writer lane: G and T(id) shared, waiting at most 4 s, taken before any other lock by insert_hole_cards, save_hand_state_snapshot, fn_ca_process_hand_post_commit_obligations and fn_project_hand_side_effects so the F06 hand guards'' try-locks find it held. Raises F06_RETRY_CANONICAL_LANE (55P03) on expiry.';

DO $subs$
DECLARE
  r record; v_sig regprocedure; v_def text; v_new_def text; v_n integer; v_after text;
  v_acl text; v_owner oid; v_definer boolean; v_config text[];
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.insert_hole_cards(uuid,integer,text)',
     'bea5a839f73901e7c50bfdc985746fcc',
     $old$BEGIN
  -- Parse the JSON string argument (server sends JSON.stringify'd array)
$old$,
     $new$BEGIN
  -- 20261019: this tournament's shared lane first, waiting, before any lock.
  PERFORM smarter_private.f06_wait_table_lane(p_table_id);

  -- Parse the JSON string argument (server sends JSON.stringify'd array)
$new$),
    ('public.save_hand_state_snapshot(uuid,integer,jsonb,jsonb,integer,jsonb,text,jsonb,jsonb)',
     '79d4ee1f0b4b448b3f8311e1028590fd',
     $old$  PERFORM pg_advisory_xact_lock(hashtextextended('hand-snapshot:' || p_table_id::text, 0));
$old$,
     $new$  -- 20261019: this tournament's shared lane first, waiting, before any lock.
  PERFORM smarter_private.f06_wait_table_lane(p_table_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('hand-snapshot:' || p_table_id::text, 0));
$new$),
    ('public.fn_ca_process_hand_post_commit_obligations(uuid)',
     '8d18dde12765610895b25e297a1f403f',
     $old$  PERFORM pg_advisory_xact_lock(
    hashtextextended('hand-post-commit:' || v_table_id::text, 0)
  );
$old$,
     $new$  /* 20261019: this tournament's shared lane first, waiting, before any
     lock (re-entered at once when the caller already holds it). */
  PERFORM smarter_private.f06_wait_table_lane(v_table_id);

  PERFORM pg_advisory_xact_lock(
    hashtextextended('hand-post-commit:' || v_table_id::text, 0)
  );
$new$),
    ('public.fn_project_hand_side_effects(uuid)',
     '5dbf4d0b1717a7ad0497f26c99ab2767',
     $old$  /* LOCK ORDER 2: every path that can consume the frozen post-commit envelope
$old$,
     $new$  /* LOCK ORDER 1b (20261019): this tournament's shared lane, waiting, before
     any lock, so the post-commit and projection writes below are never
     refused by a tournament authority mid-transaction. */
  PERFORM smarter_private.f06_wait_table_lane(v_table_id);

  /* LOCK ORDER 2: every path that can consume the frozen post-commit envelope
$new$)
  ) AS pins(signature, preimage, old_text, new_text)
  LOOP
    v_sig := r.signature::regprocedure;
    v_def := pg_get_functiondef(v_sig);
    IF md5(v_def) <> r.preimage THEN
      RAISE EXCEPTION 'tournament table writer lane: % is not the pinned text (md5 %)', r.signature, md5(v_def);
    END IF;
    v_n := (length(v_def) - length(replace(v_def, r.old_text, ''))) / length(r.old_text);
    IF v_n <> 1 OR position('f06_wait_table_lane' IN v_def) > 0 THEN
      RAISE EXCEPTION 'tournament table writer lane: % anchor occurs % times', r.signature, v_n;
    END IF;
    v_new_def := replace(v_def, r.old_text, r.new_text);
    IF replace(v_new_def, r.new_text, r.old_text) IS DISTINCT FROM v_def THEN
      RAISE EXCEPTION 'tournament table writer lane: % substitution is not reversible', r.signature;
    END IF;
    SELECT p.proacl::text, p.proowner, p.prosecdef, p.proconfig
      INTO v_acl, v_owner, v_definer, v_config FROM pg_proc p WHERE p.oid = v_sig;
    EXECUTE v_new_def;
    v_after := pg_get_functiondef(v_sig);
    IF v_after IS DISTINCT FROM v_new_def
       OR md5(replace(v_after, r.new_text, r.old_text)) <> r.preimage THEN
      RAISE EXCEPTION 'tournament table writer lane: % is not its intended post-image (md5 %)', r.signature, md5(v_after);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_sig
         AND p.proacl::text IS NOT DISTINCT FROM v_acl AND p.proowner = v_owner
         AND p.prosecdef = v_definer AND p.proconfig IS NOT DISTINCT FROM v_config)
       OR has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'tournament table writer lane: % metadata or privileges changed', r.signature;
    END IF;
    RAISE NOTICE '% post-image md5 %', r.signature, md5(v_after);
  END LOOP;
END $subs$;

DO $post$
DECLARE v_sig regprocedure := 'smarter_private.f06_wait_table_lane(uuid)'::regprocedure;
BEGIN
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE')
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_sig) <> 'postgres'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_sig)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_sig) IS DISTINCT FROM ARRAY['search_path=pg_catalog','lock_timeout=4s'] THEN
    RAISE EXCEPTION 'tournament table writer lane: helper metadata is not as declared';
  END IF;
  IF md5(pg_get_functiondef(v_sig)) <> '4cd46ed5819cd9a91f87c93d4f112e45' THEN
    RAISE EXCEPTION 'tournament table writer lane: helper is not its pinned text (md5 %)', md5(pg_get_functiondef(v_sig));
  END IF;
  -- The guards themselves are untouched: still try-locks, still refuse.
  IF md5(pg_get_functiondef('smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure)) <> '3219dd0db0c0de9e8f9c02f4609eaaf8'
     OR md5(pg_get_functiondef('smarter_private.f06_aborted_hand_guard()'::regprocedure)) <> '49046cee6eb91ce98c44564e0590e452' THEN
    RAISE EXCEPTION 'tournament table writer lane: an F06 hand guard is not its pinned text';
  END IF;
END $post$;

COMMIT;
