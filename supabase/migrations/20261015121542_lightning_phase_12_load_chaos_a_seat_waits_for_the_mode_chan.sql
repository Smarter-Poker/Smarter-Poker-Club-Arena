-- 20261015121542_lightning_phase_12_load_chaos_a_seat_waits_for_the_mode_chan.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 12 LOAD AND CHAOS: A SEAT WAITS FOR THE MODE CHANGE IN
-- FLIGHT. A WRITE-SKEW RACE BETWEEN A SEAT ARRIVAL AND A CLUSTER MODE CHANGE
-- LEFT AN ELIGIBLE SEATED PLAYER OUT OF A LIGHTNING POOL FOR GOOD.
--
-- THE DEFECT (P1, A PLAYER LEFT BEHIND). Whether a seated player is in the
-- pool is decided by two writers that never saw each other:
--
--   * the deferred seat trigger fn_table_seats_lightning_pool_follows_seat
--     (trg_table_seats_lightning_pool_on_insert / _follows_seat, DEFERRABLE
--     INITIALLY DEFERRED, so it runs at the arrival's COMMIT) enters the seat
--     only if it reads cash_games.cluster_mode = 'lightning'; and
--   * the conversion fn_cash_cluster_commit_lightning (and
--     fn_cash_cluster_abort_pending_off) sets the mode to 'lightning' and
--     enters every seat visible in ITS snapshot.
--
-- Nothing ordered them. An arrival whose trigger ran while a conversion was
-- in flight read the committed 'pending_on' (or 'pending_off') and entered
-- nothing; the conversion, whose INSERT had already run, could not see the
-- uncommitted seat. Both committed, and the Cluster was LIGHTNING with an
-- eligible seated player and no pool session at its current epoch, for ever:
-- the table is halted, the pool does not know them, nobody deals to them.
-- Caught by scripts/dev/test-lightning-phase12-load-chaos.sh, scenario C4,
-- invariant no_ghost_and_nobody_left_behind ("5 eligible seated players a
-- LIGHTNING Cluster never entered into its current epoch's pool"). The
-- Phase 12 seat FOR SHARE (20261009151825) closed the DEPARTURE half of this
-- race; a row lock cannot stop an INSERT, so the ARRIVAL half stayed open.
--
-- The mirror is fn_cash_cluster_commit_must_move. Where the reversion runs in
-- the same transaction that opened PENDING_OFF (the Phase 13 drain), an
-- arrival reads the committed 'lightning', opens a pool session at the old
-- epoch the reversion cannot see, and commits it after the reversion has
-- closed every session it could see: an open session in a MUST MOVE Cluster
-- that no reversion will ever close (LIGHTNING_REVERSION_LEFT_A_POOL_SESSION_OPEN
-- on the next one).
--
-- THE FIX, AT THE ROOT, IN THE LIVE PATH. One transaction-scoped advisory
-- lock per Cluster, key hashtextextended('lightning_cluster_mode:' ||
-- cluster_id, 0), in the estate's 'lightning_<what>:' || id convention
-- ('lightning_player:', 'lightning_matcher:', 'lightning_operator_request:'
-- are taken; this prefix is new, so no key collides by construction).
--
--   * The seat trigger takes it SHARED, first thing, for the Cluster of the
--     seat's table (and of its old table on an UPDATE), then reads the mode,
--     the epoch and the open pool sessions in statements that start AFTER
--     the lock is granted (READ COMMITTED takes a fresh snapshot per
--     statement in this VOLATILE function), so a trigger that waited reads
--     the conversion's committed mode, epoch and pool. It is taken before
--     the departure branch too: a seat that arrived during a conversion's
--     wait is not under the conversion's FOR SHARE, and its departure must
--     see the pool session the conversion committed on it, or it would be
--     the Phase 12 ghost again by the other door.
--   * fn_cash_cluster_commit_lightning, fn_cash_cluster_abort_pending_off and
--     fn_cash_cluster_commit_must_move take it EXCLUSIVE immediately after
--     their existing live-seat FOR SHARE (commit_must_move: after its seat,
--     cash-session and blind-ledger FOR SHARE) and before the statements that
--     read the seats into the pool or close the pool. Each later statement
--     takes a fresh snapshot, so every arrival whose trigger got in first has
--     committed and is entered (or, in the reversion, closed); every arrival
--     whose trigger comes after waits for this commit and then reads the new
--     mode itself. Neither side can be missed by the other any more.
--
-- WHY THE LOCK COMES AFTER THE SEAT FOR SHARE AND NEVER BEFORE IT. A seat
-- writer holds its seat's row lock from its own statement until it commits,
-- and its deferred trigger asks for the shared lock only at that commit. A
-- conversion that held the exclusive lock while it waited for a seat row
-- would deadlock with exactly that writer. So the conversion takes every seat
-- row it will ever wait for first, then the advisory lock, and after the lock
-- it takes no row lock on a seat, a cash session or the blind ledger.
-- Conversely, a trigger holding the shared lock needs nothing a waiting
-- conversion holds: no foreign key from lightning_pool_session,
-- lightning_pool_slot or cash_cluster_events references cash_games or
-- table_seats (read from PokerIQ-Production 2026-10-15), pool entry reads the
-- Cluster row without locking it, and a conversion waiting for the lock has
-- not yet touched a pool session, slot or epoch row. Formation does not take
-- this lock (it serialises on the Cluster row, which every conversion
-- already holds FOR UPDATE before it gets here), so formation's order -
-- cash_games FOR UPDATE, then anchor seats - cannot form a cycle with it.
-- Shared holders never conflict with each other, and a transaction takes the
-- exclusive lock only for the one Cluster it converts.
--
-- AND A NEWCOMER WITHOUT A CASH SESSION. commit_lightning's orphan check runs
-- before the seat FOR SHARE, as it always has. An arrival with no open cash
-- session that committed in the window after it (the window existed before
-- this file; the lock wait can widen it) makes the pool INSERT fail on
-- cash_player_session_id NOT NULL: the conversion rolls back whole, the drive
-- records lightning_drive_error, and the next pass's orphan check refuses it
-- cleanly through fn_cash_cluster_abort_pending_on. Nobody is stranded on
-- that path, so it is left as it is. (A second orphan check here was tried
-- and would have falsified 20260925204249's proof that the conversion has
-- exactly two refusal answers.) The live buy-in writes the seat and its cash
-- session in one transaction, so the shape does not arise from it.
--
-- MONEY. Nothing here moves a chip. The money guards are unchanged and stay
-- consistent: commit_lightning's chip total and commit_must_move's digests
-- still cover exactly the rows each locked (plus any row it wrote), and an
-- arrival admitted during the wait is outside both halves of each comparison.
-- v_pool = v_seated and LIGHTNING_CONVERSION_STRANDED_A_PLAYER now see the
-- same population, because no eligibility change (every one fires the seat
-- trigger) can commit between them once the lock is held.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. No
-- table, column, trigger or grant is created or altered. Every body is an
-- asserted substitution into the body the database carries: its md5(prosrc)
-- must be one this file was written against or the file refuses, each anchor
-- must occur exactly once, and the result must have the md5(prosrc) the
-- substitution was measured to produce. Accepted preimages, read with
-- pg_get_functiondef from PokerIQ-Production on 2026-10-15 and from the
-- harness chain:
--   a506c61b41dccf416800a20957344b36 fn_table_seats_lightning_pool_follows_seat
--   4aafd940b0809cd1fa7c56be91fcb285 fn_cash_cluster_commit_lightning
--   03eca9fc45f23e982acdda1bd9b97316 fn_cash_cluster_abort_pending_off
--   85079fdc6fead3e1b1a8ac6e802ee20d fn_cash_cluster_commit_must_move (production,
--     and the chain through Phase 13 20261009235505)
--   8358cfa5a405fdaa284af28a31b5c548 fn_cash_cluster_commit_must_move (the load
--     and chaos harness's default chain, which stops before Phase 13)
-- Measured postimages (md5 of the substituted prosrc, the same on both chains
-- except commit_must_move): b6c664923a5407e83a1f41de840fa9a7 (seat trigger),
-- 4d0f4e028c7a0411ac19ca598167a0cb (commit_lightning),
-- 4ed812c85c1e419f1d6e868463409629 (abort_pending_off),
-- 0fa9c8d280bcbfd48a72375869b5cf87 / d188ace1b98b2c1e9a784e7286a35545
-- (commit_must_move, production / harness default chain).
-- A body already carrying its marker is left alone if its md5 is a known
-- postimage, so the file is re-appliable (the harness applies it twice).
-- Owner, SECURITY DEFINER, search_path, the comment and the ACL are read back
-- and must be unchanged.
--
-- No sweep, repair job or re-entry pass is added (CLAUDE.md 10.11/10.12):
-- the live path itself can no longer produce the outcome.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id; a horse's seat waits,
-- is entered and is released exactly as a human's.
--
-- @live-proof: (SELECT position('pg_advisory_xact_lock_shared(' in s) > 0 AND s ~ '''lightning_cluster_mode:''' AND position('pg_advisory_xact_lock_shared(' in s) < position('UPDATE public.lightning_pool_session' in s) AND position('pg_advisory_xact_lock_shared(' in s) < position('g.cluster_mode = ''lightning''' in s) AND position('v_now := clock_timestamp();' in s) > position('pg_advisory_xact_lock_shared(' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_table_seats_lightning_pool_follows_seat()'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT position('pg_advisory_xact_lock(' in s) > position('FOR SHARE) x;' in s) AND position('FOR SHARE) x;' in s) > 0 AND position('pg_advisory_xact_lock(' in s) < position('SET cluster_mode = ''lightning''' in s) AND position('pg_advisory_xact_lock(' in s) < position('INSERT INTO public.lightning_pool_session' in s) AND s ~ '''lightning_cluster_mode:''' AND (SELECT count(*) FROM regexp_matches(s, 'jsonb_build_object\(''ok'', false, ''converted'', false\)', 'g')) = 2 FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT position('pg_advisory_xact_lock(' in s) > position('FOR SHARE;' in s) AND position('FOR SHARE;' in s) > 0 AND position('pg_advisory_xact_lock(' in s) < position('public.fn_lightning_pool_enter(s.id' in s) AND s ~ '''lightning_cluster_mode:''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT position('pg_advisory_xact_lock(' in s) > position('INTO v_locked_sessions' in s) AND position('INTO v_locked_sessions' in s) > 0 AND position('pg_advisory_xact_lock(' in s) < position('INTO v_before FROM' in s) AND position('pg_advisory_xact_lock(' in s) < position('UPDATE public.lightning_pool_session' in s) AND position('pg_advisory_xact_lock(' in s) < position('SET cluster_mode = ''must_move''' in s) AND s ~ '''lightning_cluster_mode:''' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT bool_and(p.prosecdef AND p.proconfig::text ~ 'search_path' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) AND count(*) = 3 FROM pg_proc p WHERE p.oid IN ('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure, 'public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)'::regprocedure, 'public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_table_seats_lightning_pool_follows_seat', 'fn_cash_cluster_commit_lightning', 'fn_cash_cluster_abort_pending_off', 'fn_cash_cluster_commit_must_move') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $mode_lock$
DECLARE
  w          record;
  v_src      text;
  v_def      text;
  v_new      text;
  v_md5      text;
  v_n        integer;
  k          integer;
  v_acl      aclitem[];
  v_owner    oid;
  v_secdef   boolean;
  v_config   text[];
  v_comment  text;
BEGIN
  FOR w IN
    SELECT * FROM (VALUES
    -- -----------------------------------------------------------------------
    -- 1. THE SEAT TRIGGER waits, SHARED, for a mode change in flight before
    --    it reads the mode, the epoch or the pool.
    -- -----------------------------------------------------------------------
    ('public.fn_table_seats_lightning_pool_follows_seat()',
     'A SEAT WAITS FOR THE MODE CHANGE IN FLIGHT',
     ARRAY['a506c61b41dccf416800a20957344b36'],
     ARRAY['b6c664923a5407e83a1f41de840fa9a7'],
     ARRAY[
$a$  v_now   timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE'
$a$],
     ARRAY[
$b$  v_now   timestamptz := clock_timestamp();
  v_lock_cluster uuid;
  v_old_table    uuid;
BEGIN
  -- A SEAT WAITS FOR THE MODE CHANGE IN FLIGHT (2026-10-15, Lightning Phase
  -- 12 load and chaos): the Cluster's mode lock, SHARED, before anything
  -- below reads the mode, the epoch or the pool. A conversion or reversion
  -- holds it EXCLUSIVE from just after its seat FOR SHARE to its commit, so
  -- this waits for one in flight and then reads what it committed; one that
  -- comes after waits for this commit and then sees this seat. Without it an
  -- arrival read 'pending_on', entered nothing, and the conversion that could
  -- not see the uncommitted seat left the player out of the pool for good.
  IF TG_OP = 'UPDATE' THEN v_old_table := OLD.table_id; END IF;
  FOR v_lock_cluster IN
    SELECT DISTINCT tb.cluster_id FROM public.tables tb
     WHERE tb.id IN (NEW.table_id, v_old_table) AND tb.cluster_id IS NOT NULL
     ORDER BY tb.cluster_id
  LOOP
    PERFORM pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('lightning_cluster_mode:' || v_lock_cluster::text, 0));
  END LOOP;
  v_now := clock_timestamp();

  IF TG_OP = 'UPDATE'
$b$],
     ARRAY[1]),
    -- -----------------------------------------------------------------------
    -- 2. MUST MOVE -> LIGHTNING takes the lock EXCLUSIVE after its seat FOR
    --    SHARE, asks the orphan question again, then enters the pool.
    -- -----------------------------------------------------------------------
    ('public.fn_cash_cluster_commit_lightning(uuid,uuid)',
     'THE MODE CHANGES UNDER THE CLUSTER''S MODE LOCK',
     ARRAY['4aafd940b0809cd1fa7c56be91fcb285'],
     ARRAY['4d0f4e028c7a0411ac19ca598167a0cb'],
     ARRAY[
$a$  -- Step 12, first half.
$a$],
     ARRAY[
$b$  -- THE MODE CHANGES UNDER THE CLUSTER'S MODE LOCK (2026-10-15, Lightning
  -- Phase 12 load and chaos): EXCLUSIVE, after the seat FOR SHARE above (a
  -- seat writer holds its row until its commit, where its deferred trigger
  -- asks for this lock SHARED; waiting for a seat while holding this would
  -- deadlock with it) and before anything below reads the seats into the
  -- pool. Every arrival whose seat trigger got in first has committed by the
  -- time this returns, and each statement below takes a fresh snapshot, so
  -- the pool INSERT enters it; every arrival after waits for this commit and
  -- reads 'lightning' itself. Nothing below takes a seat row lock.
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('lightning_cluster_mode:' || g.id::text, 0));

  -- Step 12, first half.
$b$],
     ARRAY[1]),
    -- -----------------------------------------------------------------------
    -- 3. PENDING_OFF -> LIGHTNING takes the lock EXCLUSIVE after its seat
    --    FOR SHARE and before the loop that enters whoever sat down.
    -- -----------------------------------------------------------------------
    ('public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)',
     'THE MODE CHANGES UNDER THE CLUSTER''S MODE LOCK',
     ARRAY['03eca9fc45f23e982acdda1bd9b97316'],
     ARRAY['4ed812c85c1e419f1d6e868463409629'],
     ARRAY[
$a$  -- WHOEVER SAT DOWN DURING THE DRAIN IS IN THE POOL NOW. The seat trigger
$a$],
     ARRAY[
$b$  -- THE MODE CHANGES UNDER THE CLUSTER'S MODE LOCK (2026-10-15, Lightning
  -- Phase 12 load and chaos): EXCLUSIVE, after the seat FOR SHARE above and
  -- before the loop below reads who sat down. An arrival whose seat trigger
  -- read 'pending_off' first has committed when this returns and the loop
  -- enters it; one after waits for this commit and reads 'lightning'.
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('lightning_cluster_mode:' || g.id::text, 0));

  -- WHOEVER SAT DOWN DURING THE DRAIN IS IN THE POOL NOW. The seat trigger
$b$],
     ARRAY[1]),
    -- -----------------------------------------------------------------------
    -- 4. PENDING_OFF -> MUST MOVE takes the lock EXCLUSIVE after its row
    --    locks and before its digests and the pool close.
    -- -----------------------------------------------------------------------
    ('public.fn_cash_cluster_commit_must_move(uuid,uuid)',
     'THE MODE CHANGES UNDER THE CLUSTER''S MODE LOCK',
     ARRAY['85079fdc6fead3e1b1a8ac6e802ee20d', '8358cfa5a405fdaa284af28a31b5c548'],
     ARRAY['0fa9c8d280bcbfd48a72375869b5cf87', 'd188ace1b98b2c1e9a784e7286a35545'],
     ARRAY[
$a$  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_before FROM (
$a$],
     ARRAY[
$b$  -- THE MODE CHANGES UNDER THE CLUSTER'S MODE LOCK (2026-10-15, Lightning
  -- Phase 12 load and chaos): EXCLUSIVE, after the row locks above and
  -- before the pool is closed. An arrival whose seat trigger read
  -- 'lightning' first (the drain opens PENDING_OFF and reverts in one
  -- transaction) has committed its pool session when this returns, and the
  -- close below sees it; one after waits for this commit and reads
  -- 'must_move'. No pool session at the old epoch outlives the reversion.
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('lightning_cluster_mode:' || g.id::text, 0));

  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) INTO v_before FROM (
$b$],
     ARRAY[1])
    ) t(sig, marker, pre_md5, post_md5, anchors, replacements, counts)
  LOOP
    SELECT p.prosrc, pg_get_functiondef(p.oid), md5(p.prosrc), p.proacl, p.proowner, p.prosecdef,
           p.proconfig, obj_description(p.oid, 'pg_proc')
      INTO v_src, v_def, v_md5, v_acl, v_owner, v_secdef, v_config, v_comment
      FROM pg_proc p WHERE p.oid = w.sig::regprocedure;

    IF position(w.marker in v_src) > 0 THEN
      -- Already carries the change: accepted only as a known postimage.
      IF NOT (v_md5 = ANY (w.post_md5)) THEN
        RAISE EXCEPTION 'LIGHTNING_MODE_LOCK: % carries % but its body (md5 %) is not a postimage this file produces', w.sig, w.marker, v_md5;
      END IF;
      CONTINUE;
    END IF;
    IF NOT (v_md5 = ANY (w.pre_md5)) THEN
      RAISE EXCEPTION 'LIGHTNING_MODE_LOCK: % body md5 % is not a preimage this file was written against (%); refusing to substitute blind', w.sig, v_md5, w.pre_md5;
    END IF;

    v_new := v_def;
    FOR k IN 1 .. array_length(w.anchors, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, w.anchors[k], ''))) / length(w.anchors[k]);
      IF v_n IS DISTINCT FROM w.counts[k] THEN
        RAISE EXCEPTION 'LIGHTNING_MODE_LOCK: % carries anchor % % time(s) rather than %; refusing to substitute blind', w.sig, k, v_n, w.counts[k];
      END IF;
      v_new := replace(v_new, w.anchors[k], w.replacements[k]);
    END LOOP;

    EXECUTE v_new;

    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = w.sig::regprocedure
                     AND p.proacl IS NOT DISTINCT FROM v_acl AND p.proowner = v_owner
                     AND p.prosecdef = v_secdef AND p.proconfig IS NOT DISTINCT FROM v_config
                     AND obj_description(p.oid, 'pg_proc') IS NOT DISTINCT FROM v_comment) THEN
      RAISE EXCEPTION 'LIGHTNING_MODE_LOCK: % did not keep its owner, definer, search_path, ACL and comment', w.sig;
    END IF;
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = w.sig::regprocedure;
    IF NOT (v_md5 = ANY (w.post_md5)) THEN
      RAISE EXCEPTION 'LIGHTNING_MODE_LOCK: % reads back with md5 % rather than a measured postimage (%)', w.sig, v_md5, w.post_md5;
    END IF;
  END LOOP;
END
$mode_lock$;

COMMIT;
