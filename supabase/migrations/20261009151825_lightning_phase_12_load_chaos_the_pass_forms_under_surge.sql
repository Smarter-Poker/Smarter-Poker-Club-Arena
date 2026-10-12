-- 20261009151825_lightning_phase_12_load_chaos_the_pass_forms_under_surge.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 12 (SPECIFICATION PHASE 20, LOAD / STRESS / CHAOS, AND
-- SURGE PROTECTION), THE DATABASE SIDE: THREE DEFECTS THE LOAD AND CHAOS
-- HARNESS (scripts/dev/test-lightning-phase12-load-chaos.sh) FOUND IN
-- PRODUCTION BODIES, EACH CLOSED BY THE SMALLEST CHANGE.
--
-- DEFECT 1 (P1, SURGE): A BIG POOL WAS NEVER DEALT. fn_lightning_match_and_form
-- measured its pass_time_budget_ms (750) from the start of the pass, and the
-- first thing a pass does under the Cluster lock is plan:
-- fn_lightning_match_plan evaluates fn_lightning_player_legality for every
-- open player, about 0.22 ms each on PostgreSQL 17 (dominated by the
-- per-player fn_lightning_pool_stack -> fn_lightning_pool_exposure calls).
-- Measured under the harness's concurrent load: the pass spent about 0.13 s
-- planning at 1,000 eligible players, 1.09 s at 5,000 and 2.39 s at 10,000.
-- From roughly 3,000 players the plan alone outlasted the budget, so the
-- budget check at the top of the first group ended EVERY pass with
-- stopped_reason 'time_budget' and formed 0 hands: at 5,000 and 10,000
-- eligible players the matcher formed nothing at all, pass after pass (only
-- a direct barrier caller dealt anybody). Surge protection requires the
-- opposite. The budget now runs from the end of the FIRST plan: it bounds the
-- forming a pass does, which is what it was for, and a plan that alone
-- outlasts it no longer starves the Cluster. A pass that forms quickly is
-- unchanged (the Phase 6 harness's one slow formation still stops the pass
-- after one hand), replans stay inside the same budget, max_hands and the
-- admission batch still cap the pass, and nothing about who is matched, in
-- what order or with which blinds changes (fn_lightning_match_plan,
-- fn_lightning_player_legality and fn_lightning_form_hand are untouched).
--
-- The plan's cost is itself cut: legality evaluates
-- fn_lightning_pool_exposure once per open player, and as a SQL function with
-- a pinned search_path it could not be inlined and was planned again on
-- every call (EXPLAIN: 0.73 ms planning for 0.11 ms execution). It becomes
-- the same query in PL/pgSQL, whose plan the session caches; same answer,
-- STABLE, same pinned search_path, same grants. Measured on the same 5,000
-- player Cluster: legality 787 ms -> 424 ms.
--
-- DEFECT 2 (P1, CONVERSION STORM): A DEPARTURE RACING A CONVERSION LEFT A
-- GHOST IN THE POOL THAT NO REVERSION COULD EVER GET PAST. Both writers that
-- enter every seated player into the pool, fn_cash_cluster_commit_lightning
-- (MUST MOVE -> LIGHTNING) and fn_cash_cluster_abort_pending_off (PENDING_OFF
-- -> LIGHTNING, "whoever sat down during the drain is in the pool now"),
-- read the live seats WITHOUT locking them. A player standing up at the same
-- moment (table_seats.left_at written, the seat trigger
-- trg_table_seats_lightning_pool_follows_seat deferred to that transaction's
-- commit) was still live in the writer's snapshot, so the writer opened a
-- pool session on the departing seat; the departure's trigger, running
-- before that session committed, could not see it to close it. The result,
-- caught by the harness's conversion storm with no fault injected: an open,
-- 'active' pool session anchored on a seat that had already left (entered
-- 10:27:48.383, its anchor left 10:27:48.381). It can never be dealt (its
-- pool stack is 0), and every later reversion refuses at
-- LIGHTNING_REVERSION_STRANDED_A_PLAYER (nine times in two seconds on one
-- Cluster), so the Cluster could never return to MUST MOVE, the stuck-
-- conversion reaper included, short of an operator unfreeze. Both writers
-- now take the Cluster's live seats FOR SHARE in seat-id order (the order
-- and the lock fn_cash_cluster_commit_must_move already takes since
-- 20261007222717) before they read them: a departure already in flight is
-- waited for and then no longer live; one that comes after waits for the
-- conversion to commit and then its own trigger closes the session it now
-- sees. Who enters the pool, and how, is unchanged. The conversion also
-- leaves the commit's chip total over exactly the seats it locked (and any
-- row the commit itself wrote), so an arrival committing between the two
-- halves of Step 12 is not mistaken for moved money.
--
-- DEFECT 3 (P2, FALSE FINANCIAL ALARM): THE REVERSION'S MONEY GUARD TRIPPED ON
-- AN ARRIVAL. fn_cash_cluster_commit_must_move takes the live seats, open
-- cash sessions and blind ledger FOR SHARE (20261007222717) and compares an
-- md5 of them before and after the reversion. A row lock cannot stop an
-- INSERT: a player who sat down during the drain and whose seat and cash
-- session committed between the two digests made them differ, and the guard
-- raised LIGHTNING_REVERSION_MOVED_MONEY although the reversion had moved
-- nothing (caught in the chaos run: seven seats inserted at 10:49:14.871,
-- committed during the reversion at 10:49:15.108; the reversion refused,
-- the population then rose and the drain aborted). A false MOVED_MONEY is a
-- false financial alarm in the evidence and the alert stream. The two
-- digests now cover exactly the seats and open sessions the reversion
-- locked, by id, plus any row this transaction itself wrote (xmin), so a
-- write by the reversion is still caught and a stranger's arrival is not.
--
-- MONEY. Neither change moves a chip; the harness's chip conservation,
-- per-seat reconciliation and every other invariant hold before and after.
-- LIGHTNING IS OFF EVERYWHERE (lightning_enabled false on all 166 Clusters,
-- no open pool session), so neither change is reachable in production until
-- a Cluster is enabled. Non-Lightning cash play is untouched.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. No
-- table or column is created or altered (Phase 2's seven-tables proof
-- stands). Every body is an asserted substitution into the body production
-- carries (read with pg_get_functiondef from PokerIQ-Production on
-- 2026-10-09, byte for byte the bodies the chain builds: md5
-- b83e1454bc30b2cd6378ffc1d552546a fn_lightning_match_and_form,
-- 9726dc71a7a0d071f574e4fa29d9838a fn_cash_cluster_commit_lightning,
-- 5e153ae569e51d7b4466c2d67b2b6d73 fn_cash_cluster_abort_pending_off,
-- 37c0a8ebdc82b383e12d32e85fc3611a fn_cash_cluster_commit_must_move,
-- 41e7354e51cf6f50ccc1e1eabe1b84ed fn_lightning_pool_exposure): each
-- anchor must appear exactly as often as stated or the file refuses, and a
-- body already carrying its marker is left alone, so the file is
-- re-appliable. Every signature is kept, so each ACL is kept by
-- CREATE OR REPLACE and read back per role with has_function_privilege. No
-- predecessor live proof is falsified (the anti-manipulation pin over the
-- matcher holds: no integrity, shadow, quality or latency term enters it).
-- Untouched: fn_lightning_config, fn_lightning_pool_status,
-- fn_lightning_pool_enter, fn_lightning_player_legality and every
-- operator/alert door.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id; a horse is planned,
-- formed, entered into the pool and released exactly as a human.
--
-- @live-proof: (SELECT NOT p.prosecdef AND p.provolatile = 'v' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'v_form_started := clock_timestamp\(\)' AND s ~ 'IF clock_timestamp\(\) - v_form_started >= v_budget THEN' AND s !~ 'clock_timestamp\(\) - v_started >= v_budget' AND s ~ '''time_budget''' AND s ~ 'pg_try_advisory_xact_lock' AND s ~ '''cluster_row_busy''' AND s ~ 'public\.fn_lightning_form_hand\(' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure)
-- @live-proof: (SELECT position('IF v_first IS NULL THEN v_first := v_plan; v_form_started := clock_timestamp(); END IF;' in s) > 0 AND position('IF v_first IS NULL THEN v_first := v_plan; v_form_started := clock_timestamp(); END IF;' in s) < position('IF clock_timestamp() - v_form_started >= v_budget THEN' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') !~ 'integrity|shadow_comparison|quality_|latency') AND count(*) = 1 FROM pg_proc p WHERE p.oid = 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure)
-- @live-proof: (SELECT bool_and(p.prosecdef AND p.proconfig::text ~ 'search_path' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'ts\.left_at IS NULL\s+AND ts\.table_id IN \(SELECT tb\.id FROM public\.tables tb WHERE tb\.cluster_id = g\.id\)\s+ORDER BY ts\.id\s+FOR SHARE') AND count(*) = 2 FROM pg_proc p WHERE p.oid IN ('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure, 'public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)'::regprocedure))
-- @live-proof: (SELECT position('ORDER BY ts.id' in s) > 0 AND position('ORDER BY ts.id' in s) < position('INSERT INTO public.lightning_pool_session' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT position('FOR SHARE' in s) > 0 AND position('FOR SHARE' in s) < position('public.fn_lightning_pool_enter(s.id' in s) FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT l.lanname = 'plpgsql' AND p.provolatile = 's' AND NOT p.prosecdef AND p.proconfig::text ~ 'search_path' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND pg_get_functiondef(p.oid) ~ 'coalesce\(sum\(coalesce\(hp\.committed_at_fold, hp\.stack_before, 0\)\), 0\)::numeric' AND pg_get_functiondef(p.oid) ~ 'hp\.fold_type IN \(''fast'', ''normal''\)' FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.fn_lightning_pool_exposure(uuid,uuid)'::regprocedure)
-- @live-proof: (SELECT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'LIGHTNING_REVERSION_MOVED_MONEY' AND s ~ 'INTO v_locked_seats' AND s ~ 'INTO v_locked_sessions' AND (length(s) - length(replace(s, 'ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid', ''))) / length('ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid') = 2 AND (length(s) - length(replace(s, 's.id = ANY (v_locked_sessions) OR s.xmin = pg_current_xact_id()::xid', ''))) / length('s.id = ANY (v_locked_sessions) OR s.xmin = pg_current_xact_id()::xid') = 2 FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure)
-- @live-proof: (SELECT s ~ 'LIGHTNING_CONVERSION_MOVED_MONEY' AND (length(s) - length(replace(s, 'ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid', ''))) / length('ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid') = 2 FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_match_and_form', 'fn_cash_cluster_commit_lightning', 'fn_cash_cluster_abort_pending_off', 'fn_cash_cluster_commit_must_move', 'fn_lightning_pool_exposure') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))

BEGIN;
SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. THE REWRITER, in the shape 20261008111425 cut it: an asserted
--    substitution into the body production carries. Every anchor must
--    appear exactly as often as stated or the file refuses. Every change
--    keeps its signature; a body already carrying the marker is left
--    alone, so the file is re-appliable.
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.lp12c_rewrite(p_sig text, p_marker text,
                                     p_from text[], p_to text[], p_counts integer[])
RETURNS void LANGUAGE plpgsql AS $rw$
DECLARE
  v_src     text;
  v_new     text;
  v_n       integer;
  k         integer;
  v_roles   constant text[] := ARRAY['anon', 'authenticated', 'service_role'];
  v_had     boolean[];
  v_bad     text;
BEGIN
  v_src := pg_get_functiondef(p_sig::regprocedure);
  IF position(p_marker in v_src) > 0 THEN
    RETURN;
  END IF;
  v_new := v_src;
  FOR k IN 1 .. array_length(p_from, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_from[k], ''))) / length(p_from[k]);
    IF v_n IS DISTINCT FROM p_counts[k] THEN
      RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', p_sig, k, v_n, p_counts[k];
    END IF;
    v_new := replace(v_new, p_from[k], p_to[k]);
  END LOOP;
  SELECT array_agg(has_function_privilege(t.r, p_sig::regprocedure, 'EXECUTE') ORDER BY t.ord)
    INTO v_had FROM unnest(v_roles) WITH ORDINALITY t(r, ord);
  EXECUTE v_new;
  -- WHO MAY EXECUTE IS KEPT, read back per role (never acl::text):
  -- production's autorevoke trigger fires on CREATE FUNCTION, and a door
  -- that silently lost or gained a role is a refusal here.
  SELECT string_agg(t.r || ': had ' || v_had[t.ord] || ', has '
                    || has_function_privilege(t.r, p_sig::regprocedure, 'EXECUTE'), '; ')
    INTO v_bad
    FROM unnest(v_roles) WITH ORDINALITY t(r, ord)
   WHERE has_function_privilege(t.r, p_sig::regprocedure, 'EXECUTE') IS DISTINCT FROM v_had[t.ord];
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '% did not keep who may execute it (%)', p_sig, v_bad;
  END IF;
  IF position(p_marker in pg_get_functiondef(p_sig::regprocedure)) = 0 THEN
    RAISE EXCEPTION '% does not read back carrying %', p_sig, p_marker;
  END IF;
END
$rw$;

-- ===========================================================================
-- 2. THE PASS FORMS UNDER SURGE: the budget runs from the end of the first
--    plan.
-- ===========================================================================

SELECT pg_temp.lp12c_rewrite(
  'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)',
  'THE BUDGET BOUNDS THE FORMING, NOT THE PLAN',
  ARRAY[
$a$  v_started   timestamptz := clock_timestamp();
$a$,
$a$    IF v_first IS NULL THEN v_first := v_plan; END IF;
$a$,
$a$      IF clock_timestamp() - v_started >= v_budget THEN
$a$],
  ARRAY[
$b$  v_started   timestamptz := clock_timestamp();
  v_form_started timestamptz;
$b$,
$b$    -- THE BUDGET BOUNDS THE FORMING, NOT THE PLAN (2026-10-09, Phase 12 load
    -- and chaos): it runs from the end of the first plan. A plan that alone
    -- outlasted the budget (about 3,000 eligible players and up) used to end
    -- every pass at its first group with nothing formed, so a big pool was
    -- never dealt; now every pass forms what its budget allows after it has
    -- planned, replans included.
    IF v_first IS NULL THEN v_first := v_plan; v_form_started := clock_timestamp(); END IF;
$b$,
$b$      IF clock_timestamp() - v_form_started >= v_budget THEN
$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 3. A CONVERSION LOCKS THE SEATS IT ENTERS: both writers take the Cluster's
--    live seats FOR SHARE in seat-id order before they read them.
-- ===========================================================================

SELECT pg_temp.lp12c_rewrite(
  'public.fn_cash_cluster_commit_lightning(uuid,uuid)',
  'A CONVERSION LOCKS THE SEATS IT ENTERS',
  ARRAY[
$a$  v_after    numeric;
$a$,
$a$  -- Step 12, first half.
$a$,
$a$   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;
$a$],
  ARRAY[
$b$  v_after    numeric;
  v_locked_seats uuid[];
$b$,
$b$  -- A CONVERSION LOCKS THE SEATS IT ENTERS (2026-10-09, Phase 12 load and
  -- chaos): the live seats FOR SHARE in seat-id order, the order
  -- fn_cash_cluster_commit_must_move takes, before anything below reads
  -- them. A player standing up at this moment either finishes first (and is
  -- then no longer live here) or waits for this commit (and the seat
  -- trigger then closes the pool session it can now see). Without it the
  -- departing seat entered the pool after its own trigger had run, and the
  -- ghost session refused every later reversion. The chip total is taken
  -- over exactly the seats locked here (and any row this transaction wrote),
  -- so an arrival committing in between is not mistaken for moved money.
  SELECT coalesce(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_locked_seats FROM (
    SELECT ts.id FROM public.table_seats ts
     WHERE ts.left_at IS NULL
       AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = g.id)
     ORDER BY ts.id
       FOR SHARE) x;

  -- Step 12, first half.
$b$,
$b$   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
     AND (ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid);
$b$],
  ARRAY[1, 1, 2]);

SELECT pg_temp.lp12c_rewrite(
  'public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)',
  'A CONVERSION LOCKS THE SEATS IT ENTERS',
  ARRAY[
$a$  -- WHOEVER SAT DOWN DURING THE DRAIN IS IN THE POOL NOW. The seat trigger
$a$],
  ARRAY[
$b$  -- A CONVERSION LOCKS THE SEATS IT ENTERS (2026-10-09, Phase 12 load and
  -- chaos): the live seats FOR SHARE in seat-id order before the loop below
  -- reads them, so a departure racing the abort either finishes first or
  -- waits and then closes the session it sees; no pool session is ever
  -- opened on a seat that is leaving.
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.left_at IS NULL
     AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = g.id)
   ORDER BY ts.id
     FOR SHARE;

  -- WHOEVER SAT DOWN DURING THE DRAIN IS IN THE POOL NOW. The seat trigger
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 3b. THE REVERSION'S MONEY GUARD COMPARES THE ROWS IT LOCKED: its two
--     digests cover exactly the seats and open cash sessions it took FOR
--     SHARE (and any row this transaction wrote), so an arrival committing
--     between them is no longer a LIGHTNING_REVERSION_MOVED_MONEY alarm.
-- ===========================================================================

SELECT pg_temp.lp12c_rewrite(
  'public.fn_cash_cluster_commit_must_move(uuid,uuid)',
  'THE REVERSION COMPARES THE ROWS IT LOCKED',
  ARRAY[
$a$  v_open       integer := 0;
$a$,
$a$  PERFORM 1 FROM public.table_seats ts
   WHERE ts.left_at IS NULL
     AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = g.id)
   ORDER BY ts.id
   FOR SHARE;
  PERFORM 1 FROM public.cash_player_session s
   WHERE s.cluster_id = g.id AND s.closed_at IS NULL
   ORDER BY s.id
   FOR SHARE;
$a$,
$a$       WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
      UNION ALL
$a$,
$a$       WHERE s.cluster_id = g.id AND s.closed_at IS NULL
      UNION ALL
$a$],
  ARRAY[
$b$  v_open       integer := 0;
  v_locked_seats    uuid[];
  v_locked_sessions uuid[];
$b$,
$b$  -- THE REVERSION COMPARES THE ROWS IT LOCKED (2026-10-09, Phase 12 load
  -- and chaos): the same locks in the same order, and the ids they took are
  -- kept, so both digests below cover exactly those rows (and any row this
  -- transaction wrote). A row lock cannot stop an INSERT: a player arriving
  -- during the drain whose seat and cash session committed between the two
  -- digests tripped LIGHTNING_REVERSION_MOVED_MONEY although nothing here
  -- moved (measured in the conversion storm, a false financial alarm).
  SELECT coalesce(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_locked_seats FROM (
    SELECT ts.id FROM public.table_seats ts
     WHERE ts.left_at IS NULL
       AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = g.id)
     ORDER BY ts.id
       FOR SHARE) x;
  SELECT coalesce(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_locked_sessions FROM (
    SELECT s.id FROM public.cash_player_session s
     WHERE s.cluster_id = g.id AND s.closed_at IS NULL
     ORDER BY s.id
       FOR SHARE) x;
$b$,
$b$       WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
         AND (ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid)
      UNION ALL
$b$,
$b$       WHERE s.cluster_id = g.id AND s.closed_at IS NULL
         AND (s.id = ANY (v_locked_sessions) OR s.xmin = pg_current_xact_id()::xid)
      UNION ALL
$b$],
  ARRAY[1, 1, 2, 2]);

-- ===========================================================================
-- 4. THE EXPOSURE READER KEEPS ITS PLAN: the same query, in PL/pgSQL.
-- ===========================================================================

SELECT pg_temp.lp12c_rewrite(
  'public.fn_lightning_pool_exposure(uuid,uuid)',
  'THE EXPOSURE READER KEEPS ITS PLAN',
  ARRAY[
$a$ LANGUAGE sql
$a$,
$a$AS $function$
$a$,
$a$     AND hp.fold_type IN ('fast', 'normal');
$function$$a$],
  ARRAY[
$b$ LANGUAGE plpgsql
$b$,
$b$AS $function$
-- THE EXPOSURE READER KEEPS ITS PLAN (2026-10-09, Phase 12 load and chaos):
-- the same query and the same answer, in PL/pgSQL, whose statement plan is
-- cached for the session. As a SQL function with a pinned search_path it
-- could not be inlined and was planned again on every call (0.7 ms of
-- planning for 0.1 ms of execution), and legality calls it once per open
-- player on every pass.
BEGIN
  RETURN (
$b$,
$b$     AND hp.fold_type IN ('fast', 'normal'));
END
$function$$b$],
  ARRAY[1, 1, 1]);

-- ===========================================================================
-- 5. READ BACK.
-- ===========================================================================

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the pass budget runs from the end of the first plan', (SELECT s ~ 'v_form_started := clock_timestamp\(\)'
       AND s ~ 'IF clock_timestamp\(\) - v_form_started >= v_budget THEN' AND s !~ 'clock_timestamp\(\) - v_started >= v_budget'
       AND s ~ '''time_budget''' AND s ~ 'pg_try_advisory_xact_lock' AND s ~ '''cluster_row_busy'''
       AND s !~ 'integrity|shadow_comparison|quality_|latency'
       FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q2)),
    ('the pass is the engine''s alone', (SELECT NOT p.prosecdef
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       FROM pg_proc p WHERE p.oid = 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure)),
    ('both pool writers lock the seats they enter, and stay the service''s alone', (SELECT bool_and(p.prosecdef
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'ORDER BY ts\.id\s+FOR SHARE') AND count(*) = 2
       FROM pg_proc p WHERE p.oid IN ('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure,
                                      'public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)'::regprocedure))),
    ('the reversion and the conversion compare the rows they locked', (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'ts\.id = ANY \(v_locked_seats\) OR ts\.xmin = pg_current_xact_id\(\)::xid')
       AND count(*) = 2
       FROM pg_proc p WHERE p.oid IN ('public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure,
                                      'public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure))),
    ('the exposure reader is the same query in PL/pgSQL, STABLE, the service''s alone', (SELECT l.lanname = 'plpgsql' AND p.provolatile = 's'
       AND p.proconfig::text ~ 'search_path' AND NOT p.prosecdef
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND pg_get_functiondef(p.oid) ~ 'coalesce\(sum\(coalesce\(hp\.committed_at_fold, hp\.stack_before, 0\)\), 0\)::numeric'
       AND pg_get_functiondef(p.oid) ~ 'i\.state IN \(''forming'', ''reserved'', ''dealing'', ''settling''\)'
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.fn_lightning_pool_exposure(uuid,uuid)'::regprocedure)),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.proname IN ('fn_lightning_match_and_form', 'fn_cash_cluster_commit_lightning', 'fn_cash_cluster_abort_pending_off', 'fn_cash_cluster_commit_must_move', 'fn_lightning_pool_exposure')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P12_LOAD_CHAOS_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
