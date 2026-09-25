-- 20260921151618_lightning_phase_5_the_conversion_is_one_transaction_and_the_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0 - PHASE 5. THE ATOMIC MUST-MOVE -> LIGHTNING CONVERSION.
--
-- The specification's Phase 5 section is nine lines and has no numbered steps.
-- The twenty-four steps live in STATE MACHINE - LIGHTNING TRANSITION, and they
-- are what this file implements:
--
--    1 acquire authoritative Cluster lock      13 create next Cluster Epoch
--    2 verify current state = MUST_MOVE        14 detach physical assignments
--    3 compute live eligible population        15 preserve stack/baseline/stay
--    4 if below threshold, stop                   clock/rejoin/session identity
--    5 state = PENDING_ON                      16 preserve rake history
--    6 stop starting new assignments           17 initialize Pool Sessions
--    7 let started hands resolve               18 initialize fairness ledgers
--    8 do not abruptly kill active hands       19 eligible players -> pool
--    9 wait for conversion-safe boundary       20 create/prewarm matcher
--   10 recalculate population                  21 set state = LIGHTNING
--   11 if below, abort back to MUST_MOVE       22 emit lightning_on
--   12 snapshot stacks and member states       23 begin matcher operation
--                                              24 release Cluster lock
--
--   "NO MONEY MOVES AS A RESULT OF THIS TRANSITION."
--
-- Steps 18, 20 and 23 are Phase 6 and later and are named here as not-done
-- rather than quietly skipped; see THE CAPABILITY GATE below. Everything else
-- is in this file.
--
-- THE SHAPE, WHICH THE PRODUCT OWNER CHOSE: THE SEAT STAYS AS THE ANCHOR.
--
-- The table_seats row survives untouched. It keeps the stack, the custody
-- binding and its cash_player_session. The physical tables stop DEALING. The
-- pool is an overlay in lightning_pool_session that points at the SAME
-- cash_player_session the seat already had.
--
-- That choice is what makes the mandated invariants true by construction
-- rather than by enforcement. Read the specification's own list:
--
--   "The following values must not change solely because of conversion:
--    stack, baseline, stay clock, rejoin obligation, wallet balance, rake
--    rate, accumulated legitimate rake, player identity, cluster membership,
--    VPIP sample, cluster_join_at."
--
-- Every one of those lives on a row this transaction does not write. F12 (the
-- conversion chip invariant) is not checked by this file so much as made
-- unreachable by it: there is no UPDATE of table_seats.stack here to get
-- wrong, and the read-back asserts the total is byte-identical anyway, because
-- an invariant nobody measures is an invariant nobody knows about.
--
-- It also means the whole conversion is ONE transaction under ONE row lock,
-- and that reversing it is a matter of clearing two columns. Step 14's
-- "detach physical table assignments in a non-economic operation" is the one
-- line of the specification in tension with this, and the tension is
-- linguistic: the assignment is detached in the sense that matters - the table
-- no longer deals to the seat, and the matcher owns the player - without
-- destroying the record that proves whose chips those are. A design that
-- really deleted the seat row would have to re-derive custody on the way back
-- out, and Phase 10 (LIGHTNING -> MUST-MOVE, "THIS PHASE IS MANDATORY") would
-- become a reconstruction problem instead of a lookup.
--
-- THE ENGINE DID NOT KNOW ANY OF THIS EXISTED.
--
-- Before this file, nothing in server/src read cash_games.cluster_mode - zero
-- occurrences in the whole tree. Three layers were checked one at a time:
--
--   cash_tables_needing_engine, which decides who gets an engine, joins
--   table_seats to tables and never touches cash_games. Because this design
--   deliberately keeps every seat alive, every physical table of a converted
--   Cluster still qualifies on the next five-second sweep, and a reaped engine
--   is rebuilt into the same state.
--
--   isNextHandPaused(), which decides whether a table starts a hand, was seven
--   in-memory booleans, none of them ever set from Cluster state.
--
--   stopIfClusterTableClosed() returns early on seatedPlayers.length > 0. It
--   only stops an EMPTY table.
--
-- So a Cluster could have converted to LIGHTNING and its physical tables would
-- have gone on dealing, from the same seats, with the same chips, while the
-- pool believed it owned those players. That is the duplicate-player failure
-- F13, F14 and F15 are all written about, arriving not from a race but from an
-- engine that was never told.
--
-- tables.dealing_halted_at is the signal, and it says exactly one thing:
-- finish the hand you are in, and start no other. It does not close the table,
-- drop the engine, unseat anybody or touch a stack. The engine reads it
-- through the table row it already re-reads on a sixty-second throttle, and on
-- start(), so a rebuilt engine comes up halted immediately.
--
-- THE TICK AND THE BALANCER STAND DOWN, AND WHY THEY DID NOT ALREADY.
--
-- fn_cash_cluster_tick gates on `IF NOT g.must_move`, a BOOLEAN column that
-- says whether this game uses must-move seating at all. It is true throughout
-- a conversion and is supposed to be: Phase 10 reverts to must-move seating
-- using the existing table lifecycle rules, so a Cluster that turned that
-- column off on the way into Lightning would have nothing to turn back on.
-- cluster_mode is the state; must_move is the capability. The tick read the
-- capability and never the state, so it would have gone on opening feeders,
-- planning moves, balancing and reconciling Main 1 underneath a Lightning
-- pool.
--
-- Both are re-created by ASSERTED SUBSTITUTION rather than retyped: the body
-- is read from the catalogue, the anchor is asserted to occur exactly once,
-- one replacement is made, every sibling guard is asserted to have survived,
-- and the result is read BACK from the catalogue rather than from the
-- variable. fn_cash_cluster_tick is 40,443 characters. Retyping it to add four
-- lines would be the single most dangerous thing in this file.
--
-- MEMBERSHIP IS ONE PREDICATE, AND IT DOES NOT MENTION status.
--
-- Every query in this file that asks "which tables and which players belong to
-- this Cluster" asks it the same way: not deleted, and lifecycle not closed,
-- both coalesced. An earlier cut also required status IN ('waiting',
-- 'running', 'active'), and tables.status is NULLABLE - its CHECK constraint
-- does not stop that, because a CHECK that evaluates to NULL PASSES. `NULL IN
-- (...)` is NULL, so a NULL-status board was dropped from the halt AND from
-- every player-set query at once, and that is the worst possible combination:
-- both sides narrowed together, so the v_pool <> v_seated guard still agreed,
-- and the board went on dealing cash inside a Cluster that had become
-- Lightning, to players holding no pool session, with the tick and the
-- balancer stood down so nothing would ever come for them. It was reproduced
-- on a throwaway backend: a Cluster of 21 converted, 18 entered the pool, and
-- 3 kept playing. tables.lifecycle is nullable in the same way and had the
-- mirror of the same defect, with the halt coalescing it and the player
-- queries not.
--
-- status is an engine-facing field that can be NULL, 'paused' or a value added
-- next year. It must not decide who is in a Cluster. Halting a paused board
-- costs nothing; missing one costs a player.
--
-- A PENDING SEAT MOVE IS CANCELLED, BECAUSE ONE LOOP CANNOT SEE THE HALT.
--
-- The engine's start-up wait loop - where a cluster table below
-- minPlayersToDeal() lives - never re-reads its table row, so it cannot
-- observe the halt being set OR cleared; gating it on a flag it can never see
-- lift would wedge a quiet table permanently. It still runs
-- executeIdleSeatMoves(), so a cash_seat_moves row planned before PENDING_ON
-- would execute mid-conversion and write table_seats. The database owns that
-- hole rather than papering over it in the engine: entering PENDING_ON
-- cancels every pending move of the Cluster, and the stood-down tick and
-- balancer plan no more. state = 'cancelled' already exists in
-- cash_seat_moves_state_check; the reason vocabulary is untouched, because
-- cash_seat_moves_reason_check's four values are pinned in
-- server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts and a fifth
-- would break two assertions for no gain.
--
-- THE CONVERSION IS A RECORD, NOT AN EVENT.
--
-- "Every conversion must record: from_mode, to_mode, trigger_population,
-- on_threshold, off_threshold, epoch_before, epoch_after,
-- conversion_request_id, completion status." cash_cluster_conversion is that
-- row, and its partial unique index on (cluster_id) WHERE status = 'pending'
-- is F13's answer in the database rather than in a worker: two simultaneous
-- converters cannot both open one, so one commits and the other is told so and
-- returns. conversion_request_id is unique on its own, so a retry of the SAME
-- request is idempotent and answers with what already happened - which is the
-- difference between "no-op safely" and "no-op".
--
-- THE CAPABILITY GATE. NOTHING CONVERTS ITSELF, DELIBERATELY.
--
-- These three functions are called by nothing. That is not an oversight and
-- it is not a stub: a Cluster converted to LIGHTNING before Phase 6 exists
-- would strand every one of its eligible players in a pool with no matcher to
-- deal them a hand. The trigger that calls them belongs with the matcher.
-- Two independent gates hold until then - lightning_enabled is false on all
-- 166 Clusters, and nothing calls these - and the harness proves the
-- conversion works by calling them directly, which is how a transition is
-- tested before the thing that fires it exists.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT count(*) = 2 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tables' AND column_name IN ('dealing_halted_at', 'dealing_halted_reason'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.tables t JOIN public.cash_games g ON g.id = t.cluster_id WHERE t.dealing_halted_at IS NOT NULL AND g.cluster_mode = 'must_move'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.tables WHERE (dealing_halted_at IS NULL) <> (dealing_halted_reason IS NULL)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE g.cluster_mode IN ('pending_on', 'lightning') AND EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND coalesce(t.is_deleted, false) = false AND coalesce(t.lifecycle, '') <> 'closed' AND t.dealing_halted_at IS NULL)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_cluster_conversion WHERE status = 'committed' AND (epoch_after IS NULL OR epoch_after <= epoch_before)))
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ 'status IN')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ 'tb\.status IN')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'w\.status IN \(''waiting'', ''notified''\)')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE (public.fn_cash_cluster_population(g.id) ->> 'live_eligible')::integer > (public.fn_cash_cluster_population(g.id) -> 'counted' ->> 'seated_eligible')::integer))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE public.fn_cash_cluster_live_eligible(g.id) IS DISTINCT FROM (SELECT count(DISTINCT ts.user_id)::integer FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false AND coalesce(tb.lifecycle, '') <> 'closed' AND ts.left_at IS NULL AND ts.user_id IS NOT NULL AND coalesce(ts.is_sitting_out, false) = false AND coalesce(ts.leave_pending, false) = false AND coalesce(ts.stack, 0) > 0)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.dealing_halted_at IS NOT NULL AND ts.left_at IS NULL AND ts.user_id IS NOT NULL AND coalesce(ts.is_sitting_out, false) = false AND coalesce(ts.leave_pending, false) = false AND coalesce(ts.stack, 0) > 0 AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session s WHERE s.cluster_id = tb.cluster_id AND s.player_id = ts.user_id AND s.exited_at IS NULL)))
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'LIGHTNING_CONVERSION_STRANDED_A_PLAYER')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.lightning_pool_session s WHERE NOT EXISTS (SELECT 1 FROM public.cash_player_session c WHERE c.id = s.cash_player_session_id)))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g JOIN public.cash_cluster_conversion c ON c.cluster_id = g.id WHERE c.status = 'pending' AND g.cluster_mode NOT IN ('pending_on', 'pending_off')))
-- @live-proof: (SELECT count(*) = 0 FROM public.tables WHERE (dealing_halted_at IS NULL) <> (dealing_halted_reason IS NULL))
-- @live-proof: (SELECT to_regclass('public.cash_cluster_conversion') IS NOT NULL)
-- @live-proof: (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cash_cluster_conversion'::regclass)
-- @live-proof: (SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'cash_cluster_conversion' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%(cluster_id)%' AND indexdef LIKE '%pending%')
-- @live-proof: (SELECT count(*) = 3 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning'))
-- @live-proof: (SELECT bool_and(p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND routine_name IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning') AND grantee IN ('anon', 'authenticated', 'PUBLIC')))
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning'))
-- @live-proof: (SELECT bool_and(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_platform_frozen') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_commit_lightning'))
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'lightning_cluster_stands_down')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'IF NOT g\.must_move THEN RETURN')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') ~ 'cluster_mode')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ 'is_horse')
-- @live-proof: (SELECT regexp_replace(pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ 'is_horse')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname NOT IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_cash_cluster_begin_pending_on|fn_cash_cluster_commit_lightning'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'UPDATE public\.table_seats|UPDATE table_seats'))
-- @live-proof: (SELECT pg_get_constraintdef(oid) LIKE '%lightning_pending_on%' AND pg_get_constraintdef(oid) LIKE '%lightning%' FROM pg_constraint WHERE conname = 'tables_dealing_halt_is_explained')

BEGIN;

SET LOCAL lock_timeout = '8s';


-- ===========================================================================
-- 1. THE HALT FLAG THE ENGINE READS
-- ===========================================================================
-- Two columns, one ADD COLUMN per ALTER TABLE, because a multi-clause ALTER
-- rewrites its intent into one catalogue event and a reviewer reading the diff
-- cannot see which clause failed (club-arena CLAUDE.md).
--
-- dealing_halted_at is the load-bearing one: the engine tests it for NULL.
-- dealing_halted_reason exists so that an operator looking at a stopped table
-- at three in the morning is told WHY by the row itself, and so that a future
-- halt for some other cause cannot be mistaken for a Lightning conversion and
-- cleared by Phase 10's revert.

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS dealing_halted_at timestamptz;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS dealing_halted_reason text;

-- The two columns are set and cleared together, always. A halted table with no
-- reason is a table nobody can explain; a reason with no halt is a lie in the
-- row. The reason vocabulary is closed on purpose - a typo in a string that
-- the revert path matches on would leave a table halted forever.
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tables_dealing_halt_is_explained' AND conrelid = 'public.tables'::regclass) THEN
    EXECUTE $q$ALTER TABLE public.tables ADD CONSTRAINT tables_dealing_halt_is_explained CHECK (
    (dealing_halted_at IS NULL AND dealing_halted_reason IS NULL)
    OR (dealing_halted_at IS NOT NULL
        -- IS NOT NULL BEFORE THE IN, AND IT IS NOT REDUNDANT. `x IN (...)` with
        -- x NULL is NULL, not false, and a CHECK that evaluates to NULL PASSES.
        -- Without this line a halted table with no reason is accepted by a
        -- constraint written specifically to reject it - and because Phase 10's
        -- revert matches on the REASON, that table would stay halted for ever.
        AND dealing_halted_reason IS NOT NULL
        AND dealing_halted_reason IN ('lightning_pending_on', 'lightning')))$q$;
  END IF;
END $c$;

COMMENT ON COLUMN public.tables.dealing_halted_at IS
  'Set while this table must finish the hand it is in and start no other. It does NOT mean closed, and it does not mean the engine should stop, unseat anybody or touch a stack - every seat, stack and custody binding stays exactly as it is. Written only by the Lightning conversion functions; read by ServerTableEngineBase on start() and on its throttled table re-read, so a halt is observed within the hand in progress plus at most sixty seconds, and a rebuilt engine comes up halted at once.';

COMMENT ON COLUMN public.tables.dealing_halted_reason IS
  'Why this table stopped dealing: lightning_pending_on while a conversion is being decided, lightning once it has committed. Closed vocabulary, because the revert path matches on it and a typo would leave a table halted forever.';


-- ===========================================================================
-- 2. THE CONVERSION IS A ROW, AND THE ROW IS THE RACE GUARD
-- ===========================================================================
-- The specification requires every conversion to record nine things. All nine
-- are columns here. But the row does more than record: its partial unique
-- index is how F13 (DOUBLE CONVERSION RACE - "one conversion commits, all
-- others no-op/retry safely") is answered in the database rather than in a
-- worker that might be restarted, duplicated or run twice by a cron overlap.
--
-- Two indexes, two different jobs, and they are easy to confuse:
--
--   one_open_per_cluster  - at most one conversion in flight per Cluster.
--                           This is what makes a SECOND converter fail rather
--                           than open a rival conversion. It is a backstop,
--                           not the primary mechanism: the cash_games row lock
--                           already serialises them. It exists because a lock
--                           protects a transaction and an index protects the
--                           table, and the table outlives every transaction.
--
--   by_request            - the SAME request arriving twice is idempotent and
--                           is answered with what already happened. That is
--                           the difference between "no-op safely" and "no-op":
--                           a retrying worker must be told the conversion
--                           committed, not told nothing.

CREATE TABLE IF NOT EXISTS public.cash_cluster_conversion (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id            uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  conversion_request_id uuid NOT NULL,
  from_mode             text NOT NULL,
  to_mode               text NOT NULL,
  trigger_population    integer NOT NULL,
  on_threshold          integer NOT NULL,
  off_threshold         integer NOT NULL,
  epoch_before          integer NOT NULL,
  epoch_after           integer,
  status                text NOT NULL DEFAULT 'pending',
  abort_reason          text,
  opened_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at             timestamptz
);

DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'cash_cluster_conversion_status_check' AND conrelid = 'public.cash_cluster_conversion'::regclass) THEN
    EXECUTE $q$ALTER TABLE public.cash_cluster_conversion ADD CONSTRAINT cash_cluster_conversion_status_check CHECK (status IN ('pending', 'committed', 'aborted'))$q$;
  END IF;
END $c$;

-- A closed conversion is closed in every column that says so, or the row is
-- lying about its own state. An aborted one must say why - "aborted" with no
-- reason is the shape that turns a five-minute diagnosis into an afternoon.
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'cash_cluster_conversion_close_is_complete' AND conrelid = 'public.cash_cluster_conversion'::regclass) THEN
    EXECUTE $q$ALTER TABLE public.cash_cluster_conversion ADD CONSTRAINT cash_cluster_conversion_close_is_complete CHECK (
    (status = 'pending'   AND closed_at IS NULL AND epoch_after IS NULL AND abort_reason IS NULL)
 OR (status = 'committed' AND closed_at IS NOT NULL AND epoch_after IS NOT NULL AND abort_reason IS NULL)
 OR (status = 'aborted'   AND closed_at IS NOT NULL AND epoch_after IS NULL AND abort_reason IS NOT NULL))$q$;
  END IF;
END $c$;

-- The epoch goes forward or nowhere. An aborted conversion leaves epoch_after
-- NULL, which the constraint above already requires; a committed one may not
-- claim to have gone backwards.
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'cash_cluster_conversion_epoch_goes_forward' AND conrelid = 'public.cash_cluster_conversion'::regclass) THEN
    EXECUTE $q$ALTER TABLE public.cash_cluster_conversion ADD CONSTRAINT cash_cluster_conversion_epoch_goes_forward CHECK (epoch_after IS NULL OR epoch_after > epoch_before)$q$;
  END IF;
END $c$;

DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'cash_cluster_conversion_thresholds_are_hysteretic' AND conrelid = 'public.cash_cluster_conversion'::regclass) THEN
    EXECUTE $q$ALTER TABLE public.cash_cluster_conversion ADD CONSTRAINT cash_cluster_conversion_thresholds_are_hysteretic CHECK (on_threshold > off_threshold AND off_threshold >= 2)$q$;
  END IF;
END $c$;

CREATE UNIQUE INDEX IF NOT EXISTS cash_cluster_conversion_one_open_per_cluster
  ON public.cash_cluster_conversion (cluster_id) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS cash_cluster_conversion_by_request
  ON public.cash_cluster_conversion (conversion_request_id);

CREATE INDEX IF NOT EXISTS cash_cluster_conversion_by_cluster
  ON public.cash_cluster_conversion (cluster_id, opened_at DESC);

ALTER TABLE public.cash_cluster_conversion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cash_cluster_conversion FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cash_cluster_conversion TO service_role;

COMMENT ON TABLE public.cash_cluster_conversion IS
  'One row per attempted Cluster mode conversion, carrying the nine things the specification requires a conversion to record. The partial unique index on (cluster_id) WHERE status = pending is F13''s answer - two simultaneous converters cannot both open one - and the unique conversion_request_id makes a retry of the same request idempotent and answerable with what already happened rather than merely refused.';

-- ===========================================================================
-- 2b. THE BEFORE PICTURE, TAKEN BEFORE ANY OF THIS FILE'S BEHAVIOUR
-- ===========================================================================
-- Section 8 proves this migration changed nothing. An earlier cut proved the
-- estate was VIRGIN instead - no Cluster off must_move, no epoch moved, no
-- halt, no pool session - which is true today and becomes false the first time
-- Phase 6 drives a conversion, at which point this file stops being
-- re-appliable over the database it was written for.
--
-- THREE CHECKSUMS IN TRANSACTION-LOCAL SETTINGS, NOT THREE TEMP TABLES. A
-- CREATE TEMP TABLE is still DDL, it still fires this database's break-window
-- event trigger, and an assertion mechanism that can refuse the migration it
-- is asserting about is worse than no assertion. set_config(..., true) rolls
-- back with the transaction and fires nothing.
--
-- It is taken HERE, and not at the top, because two of the three read objects
-- that sections 1 and 2 create. Everything with behaviour is still ahead of
-- it, which is what the comparison is actually about.
DO $before$
BEGIN
  PERFORM set_config('ca.p5_tables',
    (SELECT coalesce(md5(string_agg(t.id::text || ':' || (t.dealing_halted_at IS NOT NULL)::text, ',' ORDER BY t.id)), 'empty')
       FROM public.tables t), true);
  PERFORM set_config('ca.p5_games',
    (SELECT coalesce(md5(string_agg(g.id::text || ':' || g.cluster_mode || ':' || g.cluster_epoch::text, ',' ORDER BY g.id)), 'empty')
       FROM public.cash_games g), true);
  PERFORM set_config('ca.p5_counts',
    (SELECT count(*) FROM public.lightning_pool_session)::text || ':' ||
    (SELECT count(*) FROM public.cash_cluster_conversion)::text, true);
END $before$;

-- ===========================================================================
-- 3. STEPS 1-6: MUST_MOVE -> PENDING_ON
-- ===========================================================================
-- This half decides. It does NOT convert: no epoch moves, no pool session is
-- created, no player is touched. All it does is stop the tables dealing and
-- write down that a decision is in progress, so that the boundary can be
-- waited for and the population asked again at step 10.
--
-- THE LOCK IS TAKEN IN THE TICK'S OWN ORDER, FIRST STATEMENT, ON PURPOSE.
-- fn_cash_cluster_tick's second statement is SELECT * FROM cash_games WHERE
-- id = ... FOR UPDATE, before it touches anything else. Taking the same lock
-- first here means the two can only ever BLOCK, never cycle. A previous
-- Lightning migration deadlocked in production by taking FOR KEY SHARE on
-- cash_games from a backfill while the tick held cash_cluster_events and
-- wanted cash_games; the lesson written down then was to take every lock in
-- the tick's order, up front, and it is obeyed here.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_begin_pending_on(
  p_game_id    uuid,
  p_request_id uuid DEFAULT gen_random_uuid())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g        record;
  v_state  jsonb;
  v_prior  record;
  v_halted integer;
  v_cancel integer;
BEGIN
  -- IDEMPOTENCY IS ASKED FIRST, BEFORE THE FREEZE AND BEFORE THE LOCK. A
  -- worker retrying a request that already succeeded must be told so even
  -- during a break; answering 'platform_frozen' to a retry makes it keep
  -- retrying for the length of the window, which is the opposite of what the
  -- freeze is for. The read is cheap and does not queue behind a tick.
  --
  -- AND cluster_id = p_game_id IS NOT DECORATION. Without it, a request id
  -- belonging to Cluster A, replayed against Cluster B, answered
  -- {"ok": true, "status": "pending", "cluster_mode": "pending_on"} - about A -
  -- while B was never touched and stayed must_move. The caller was told a
  -- conversion was in progress on a Cluster that had none.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE conversion_request_id = p_request_id AND cluster_id = p_game_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_known',
      'conversion_id', v_prior.id, 'status', v_prior.status,
      'cluster_mode', (SELECT cluster_mode FROM public.cash_games WHERE id = p_game_id));
  END IF;

  -- The same id against a DIFFERENT Cluster is a caller bug, not a retry, and
  -- it is named rather than silently opening a second conversion - which the
  -- unique index would refuse anyway, with an error nobody could read.
  IF EXISTS (SELECT 1 FROM public.cash_cluster_conversion
              WHERE conversion_request_id = p_request_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'request_id_belongs_to_another_cluster');
  END IF;

  -- THE FREEZE IS TOTAL. server/src/maintenance/theFreezeIsTotal.law.test.ts
  -- forbids any path that seats, registers or moves chips during the break.
  -- A conversion moves no chips, but it stops every table in a Cluster from
  -- dealing, which is emphatically an engine-affecting act, and the break
  -- exists so that the engine is doing exactly one thing at a time.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Step 2: verify current state = MUST_MOVE. A Cluster already in pending_on
  -- is not an error to the caller - it is the answer to "is a conversion in
  -- progress" - so it is reported as such rather than raised.
  -- ASK AGAIN, NOW THAT THE LOCK IS HELD. The pre-read above runs under READ
  -- COMMITTED on a snapshot taken before the lock, so two callers sharing a
  -- request id can both miss the row: the first inserts and commits, the
  -- second blocks on the lock, wakes, and would answer 'wrong_state' about the
  -- conversion IT asked for - in precisely the case the unique
  -- conversion_request_id exists to make idempotent. A worker told wrong_state
  -- retries; a worker told already_known stops.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE conversion_request_id = p_request_id AND cluster_id = p_game_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_known',
      'conversion_id', v_prior.id, 'status', v_prior.status,
      'cluster_mode', g.cluster_mode);
  END IF;

  IF g.cluster_mode <> 'must_move' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_state',
      'cluster_mode', g.cluster_mode);
  END IF;

  -- Steps 3 and 4. The verdict is the one reader the lobby already embeds, so
  -- the number that triggers a conversion is the same number a player was
  -- shown. It answers in pending_on as well as must_move, which is what makes
  -- step 10's re-ask possible at all - before 20260921142954 it did not, and
  -- this function would have aborted every conversion it ever started.
  v_state := public.fn_cash_cluster_lightning_state(g.id);
  IF NOT coalesce((v_state -> 'verdict' ->> 'would_turn_on')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'threshold_not_reached',
      'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
  END IF;

  -- Step 5. NO EPOCH BUMP HERE. The specification creates the next Epoch at
  -- step 13, after the re-check, and that ordering is the whole reason an
  -- abort is cheap: an aborted conversion leaves the epoch where it was, so
  -- nothing that binds to an epoch - a pool session, an instance, a hand - can
  -- have been created against an epoch that then has to be unwound.
  UPDATE public.cash_games SET cluster_mode = 'pending_on', updated_at = now()
   WHERE id = g.id;

  -- Step 6, and the reason this file exists. Stop the tables dealing. Seats,
  -- stacks and sessions are not touched; a table already halted for some other
  -- reason is left as it is rather than overwritten.
  UPDATE public.tables
     SET dealing_halted_at = clock_timestamp(), dealing_halted_reason = 'lightning_pending_on'
   WHERE cluster_id = g.id
     AND dealing_halted_at IS NULL
     AND coalesce(is_deleted, false) = false
     AND coalesce(lifecycle, '') <> 'closed';
  GET DIAGNOSTICS v_halted = ROW_COUNT;

  -- The hole the engine cannot close. Its start-up wait loop - where a table
  -- below minPlayersToDeal() lives - never re-reads its table row, so it can
  -- neither see this halt set nor see it lifted, and it still runs
  -- executeIdleSeatMoves(). A move planned a second before PENDING_ON would
  -- otherwise execute mid-conversion and write table_seats. Cancelling is
  -- correct rather than merely convenient: the destination table is about to
  -- stop dealing, so the move has nowhere useful to land.
  UPDATE public.cash_seat_moves
     SET state = 'cancelled', resolved_at = clock_timestamp(),
         note = coalesce(note || ' | ', '') || 'cancelled by lightning pending_on'
   WHERE game_id = g.id AND state = 'pending';
  GET DIAGNOSTICS v_cancel = ROW_COUNT;

  INSERT INTO public.cash_cluster_conversion (
    cluster_id, conversion_request_id, from_mode, to_mode, trigger_population,
    on_threshold, off_threshold, epoch_before)
  VALUES (
    g.id, p_request_id, 'must_move', 'lightning',
    coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0),
    coalesce((v_state -> 'thresholds' ->> 'on')::integer, 0),
    coalesce((v_state -> 'thresholds' ->> 'off')::integer, 0),
    g.cluster_epoch)
  RETURNING * INTO v_prior;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (g.id, 'lightning_pending_on', jsonb_build_object(
    'conversion_id', v_prior.id, 'conversion_request_id', p_request_id,
    'trigger_population', v_prior.trigger_population,
    'on_threshold', v_prior.on_threshold, 'off_threshold', v_prior.off_threshold,
    'epoch_before', g.cluster_epoch,
    'tables_halted', v_halted, 'seat_moves_cancelled', v_cancel));

  RETURN jsonb_build_object('ok', true, 'reason', 'pending_on',
    'conversion_id', v_prior.id, 'conversion_request_id', p_request_id,
    'cluster_mode', 'pending_on', 'tables_halted', v_halted,
    'seat_moves_cancelled', v_cancel,
    'trigger_population', v_prior.trigger_population,
    'thresholds', v_state -> 'thresholds');
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_begin_pending_on(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_begin_pending_on(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_begin_pending_on(uuid, uuid) IS
  'Steps 1 to 6 of the specification''s MUST-MOVE -> LIGHTNING sequence: lock the Cluster in the tick''s own lock order, verify MUST_MOVE, ask the verdict, stop if below the ON threshold, set PENDING_ON, halt dealing on every live table of the Cluster and cancel its pending seat moves. It converts nothing: no epoch moves and no pool session is created, because the specification creates the Epoch at step 13 after the re-check, which is what makes an abort cheap. Idempotent on conversion_request_id.';

-- ===========================================================================
-- 4. STEP 11: PENDING_ON -> MUST_MOVE. THE ABORT, WHICH IS TEST F04
-- ===========================================================================
-- "TEST F04 - 18TH PLAYER LEAVES DURING PENDING_ON. Expected: conversion
-- canceled, state returns to MUST_MOVE, regular tables resume, no Lightning
-- player stranded."
--
-- No Lightning player can be stranded by this path, because no Lightning
-- player exists yet: PENDING_ON creates no pool session. That is not luck, it
-- is the step ordering the specification chose and section 3 obeys. What this
-- has to get right is the other three: the state goes back, the tables resume,
-- and the record says what happened and why.
--
-- The tables resume by having their halt CLEARED, not by being restarted. The
-- engine is still running, still seated, still holding its chips; it has been
-- declining to start a hand. Clearing the column lets it start one again
-- within its throttled re-read, and the seat it deals to is the same seat,
-- with the same stack, that it had before the conversion was considered.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_abort_pending_on(
  p_game_id    uuid,
  p_request_id uuid,
  p_reason     text DEFAULT 'population_fell_below_on_threshold')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g        record;
  v_conv   record;
  v_resume integer;
BEGIN
  -- Deliberately NOT gated on fn_platform_frozen(). A Cluster stuck in
  -- PENDING_ON with every table halted is exactly the state an operator needs
  -- to be able to leave during an incident, and the break is when incidents
  -- are handled. The asymmetry is the same one the verdict carries: entering
  -- Lightning is gated, leaving it never is.
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_conv FROM public.cash_cluster_conversion
   WHERE cluster_id = g.id AND conversion_request_id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_such_conversion');
  END IF;
  IF v_conv.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conversion_already_closed',
      'status', v_conv.status);
  END IF;
  IF g.cluster_mode <> 'pending_on' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_state',
      'cluster_mode', g.cluster_mode);
  END IF;

  UPDATE public.cash_games SET cluster_mode = 'must_move', updated_at = now()
   WHERE id = g.id;

  -- Only OUR halt is lifted. A table halted for some other reason - a reason
  -- this vocabulary does not yet contain - is not a table this conversion
  -- stopped, and clearing it here would be a Lightning conversion silently
  -- restarting a table somebody else deliberately stopped.
  UPDATE public.tables
     SET dealing_halted_at = NULL, dealing_halted_reason = NULL
   WHERE cluster_id = g.id AND dealing_halted_reason = 'lightning_pending_on';
  GET DIAGNOSTICS v_resume = ROW_COUNT;

  UPDATE public.cash_cluster_conversion
     SET status = 'aborted', abort_reason = coalesce(nullif(btrim(p_reason), ''), 'unstated'),
         closed_at = clock_timestamp()
   WHERE id = v_conv.id;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (g.id, 'lightning_pending_on_aborted', jsonb_build_object(
    'conversion_id', v_conv.id, 'conversion_request_id', p_request_id,
    'abort_reason', coalesce(nullif(btrim(p_reason), ''), 'unstated'),
    'tables_resumed', v_resume,
    'live_eligible', public.fn_cash_cluster_live_eligible(g.id)));

  RETURN jsonb_build_object('ok', true, 'reason', 'aborted',
    'conversion_id', v_conv.id, 'cluster_mode', 'must_move',
    'tables_resumed', v_resume);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_abort_pending_on(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_abort_pending_on(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_abort_pending_on(uuid, uuid, text) IS
  'Step 11 and acceptance test F04: return a PENDING_ON Cluster to MUST_MOVE, lift the halt this conversion placed and only that halt, and close the conversion record with a reason. No Lightning player can be stranded here because PENDING_ON creates no pool session - the specification creates the Epoch and the sessions at step 13 and after, which is what makes an abort a two-column clear rather than an unwind. Not gated on the platform freeze, deliberately: leaving a half-converted state must always be possible.';

-- ===========================================================================
-- 5. STEPS 9-22: PENDING_ON -> LIGHTNING. THE CONVERSION ITSELF
-- ===========================================================================
-- One transaction, under the lock already described, doing the whole of the
-- rest of the sequence.
--
-- STEP 9, THE CONVERSION-SAFE HAND BOUNDARY. The phrase appears exactly once
-- in the specification and is never defined there, so it is defined here and
-- the definition is stated rather than assumed: NO TABLE OF THIS CLUSTER HAS
-- A HAND IN FLIGHT. A hand in flight is a hand_history row with ended_at NULL
-- that started recently. "Recently" is doing real work - an abandoned row from
-- a crashed engine has ended_at NULL forever, and a boundary test that waited
-- for it would wait for ever and no Cluster would convert again. Six hours is
-- far beyond any real hand and far inside any plausible abandonment.
--
-- The halt placed at step 6 is what makes this boundary ARRIVE rather than
-- merely be tested for: no new hand starts, so the set of in-flight hands only
-- shrinks. The caller polls this function; it is not this function's job to
-- block, because blocking would hold the Cluster lock while tables finish
-- their hands and the tick would queue behind it for the length of a river.
--
-- STEPS 10 AND 11 ARE THE WHOLE REASON THE PREVIOUS MIGRATION EXISTED. The
-- population is asked AGAIN here, in pending_on, and the verdict has to be
-- able to answer in that state. Until 20260921142954 it could not - it
-- required cluster_mode = 'must_move' - so this re-check would have returned
-- false unconditionally and every conversion would have aborted at its own
-- safety check. Nothing in the estate could have shown that, because no
-- Cluster had ever been in pending_on.
--
-- STEP 12'S SNAPSHOT IS TAKEN AND COMPARED, NOT JUST TAKEN. The chip total is
-- read before the writes and again after them and the two must be identical.
-- That assertion cannot fail as this function is written - it never touches
-- table_seats - and it is here precisely so that it starts failing the day
-- somebody adds a write that does.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_commit_lightning(
  p_game_id    uuid,
  p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g          record;
  v_conv     record;
  v_state    jsonb;
  v_inflight integer;
  v_before   numeric;
  v_after    numeric;
  v_seated   integer;
  v_pool     integer;
  v_orphan   integer;
  v_stranded integer;
  v_epoch    integer;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'platform_frozen');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_conv FROM public.cash_cluster_conversion
   WHERE cluster_id = g.id AND conversion_request_id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'no_such_conversion');
  END IF;

  -- F13, the half a lock cannot give you. A retry of a request that already
  -- committed is answered with what happened, not refused: a worker that is
  -- told "no" retries, and a worker that is told "committed at epoch 3"
  -- stops.
  IF v_conv.status = 'committed' THEN
    RETURN jsonb_build_object('ok', true, 'converted', true, 'reason', 'already_committed',
      'conversion_id', v_conv.id, 'epoch_after', v_conv.epoch_after,
      'cluster_mode', g.cluster_mode);
  END IF;
  IF v_conv.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'conversion_already_closed',
      'status', v_conv.status);
  END IF;
  IF g.cluster_mode <> 'pending_on' THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'wrong_state',
      'cluster_mode', g.cluster_mode);
  END IF;

  -- Step 9.
  SELECT count(*)::integer INTO v_inflight
    FROM public.hand_history h
    JOIN public.tables tb ON tb.id = h.table_id
   WHERE tb.cluster_id = g.id
     -- THE SAME TABLE FILTERS THE REST OF THIS FILE CARRIES. Without them an
     -- abandoned ended_at IS NULL row on a CLOSED or soft-deleted table blocks
     -- the conversion for six hours and no operator can clear it, because
     -- nothing will ever end a hand at a table that is gone. That is the exact
     -- wedge the six-hour window was chosen to prevent, arriving by a
     -- different door.
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND h.ended_at IS NULL
     AND h.started_at > clock_timestamp() - interval '6 hours';
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'hands_in_flight',
      'hands_in_flight', v_inflight);
  END IF;

  -- Steps 10 and 11.
  v_state := public.fn_cash_cluster_lightning_state(g.id);
  IF NOT coalesce((v_state -> 'verdict' ->> 'would_turn_on')::boolean, false) THEN
    -- 'converted' EXISTS BECAUSE 'ok' CANNOT CARRY THIS. A successful abort is
    -- ok: the function did exactly what it should. But a caller that branches
    -- on ok alone would read a self-abort as a conversion, so the one question
    -- a caller actually has - did this Cluster become Lightning - is answered
    -- by its own boolean rather than by reading a reason string.
    RETURN public.fn_cash_cluster_abort_pending_on(
      g.id, p_request_id, 'population_fell_below_on_threshold_at_boundary')
      || jsonb_build_object('converted', false);
  END IF;

  -- A pool session MUST name a cash session; the column is NOT NULL, and the
  -- subordination is the point: "Entering/exiting Lightning does not create a
  -- new cash session." So a seated eligible player with no open Cluster
  -- session cannot enter the pool, and this refuses the whole conversion
  -- rather than converting around them - leaving an eligible player seated at
  -- a table that has stopped dealing, in a Cluster that believes it is a pool,
  -- is the stranding the specification forbids.
  --
  -- Measured before this was written: on the busiest live Cluster, all 34
  -- eligible players carry an open session with cluster_id set, and the estate
  -- has 174 open Cluster sessions against 169 live Cluster chairs. This is
  -- therefore a refusal that should never fire, which is exactly the kind that
  -- must be counted rather than assumed.
  -- PER PLAYER, NOT PER SEAT, AND ASKING THE INSERT'S OWN QUESTION. An earlier
  -- cut counted seat ROWS, so a player seated on two member boards whose only
  -- open session was scoped to one of them was counted an orphan against the
  -- other seat - and refused the whole Cluster's conversion while the INSERT
  -- would happily have found their session. Both now ask: does this PLAYER
  -- have an open session reachable from ANY of their seats in this Cluster.
  SELECT count(*)::integer INTO v_orphan FROM (
    SELECT ts.user_id
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
       AND coalesce(tb.lifecycle, '') <> 'closed'
       AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND coalesce(ts.is_sitting_out, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0
     GROUP BY ts.user_id
    HAVING NOT EXISTS (
       SELECT 1 FROM public.cash_player_session s
        WHERE s.player_id = ts.user_id AND s.closed_at IS NULL
          AND (s.cluster_id = g.id
               OR s.scope_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id)
               OR s.table_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id)))
  ) o;
  IF v_orphan > 0 THEN
    RETURN public.fn_cash_cluster_abort_pending_on(
      g.id, p_request_id, format('%s eligible seated player(s) have no open cash session', v_orphan))
      || jsonb_build_object('converted', false);
  END IF;

  -- Step 12, first half.
  SELECT coalesce(sum(ts.stack), 0) INTO v_before
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;

  -- Step 13. ca.epoch_reason is read by fn_cash_cluster_epoch_follows_its_game
  -- for cash_cluster_epoch.started_by; without it the row records 'unstated',
  -- and an epoch nobody can explain is an epoch nobody can audit.
  PERFORM set_config('ca.epoch_reason', 'lightning_on', true);
  v_epoch := g.cluster_epoch + 1;
  UPDATE public.cash_games
     SET cluster_mode = 'lightning', cluster_epoch = v_epoch, updated_at = now()
   WHERE id = g.id;

  -- Steps 14 to 19. THE ONLY WRITE THAT CREATES ANYTHING FOR A PLAYER, AND IT
  -- POINTS AT WHAT THEY ALREADY HAD. cash_player_session_id is the player's
  -- EXISTING open session - not a new one. "A Lightning Pool Session is
  -- subordinate to the continuous Cash Player Session. Entering/exiting
  -- Lightning does not create a new cash session."
  --
  -- The eligibility predicate is fn_cash_cluster_live_eligible's seated half,
  -- restated here because that function returns a COUNT and this needs the
  -- SET. They must agree exactly: a player counted toward the threshold who
  -- did not enter the pool is a player the conversion left behind, and one who
  -- entered without being counted is a player who arrived from nowhere. The
  -- read-back asserts the two agree rather than trusting that they do.
  --
  -- NO is_horse ANYWHERE. Law 10.5: a horse counts exactly like a human, and
  -- is pinned twice in TheTablesOpenAndCloseThemselves.law.test.ts against the
  -- worklist and the balancer. A horse over the threshold enters the pool like
  -- anyone else.
  INSERT INTO public.lightning_pool_session (
    cluster_id, cluster_epoch, player_id, cash_player_session_id,
    state, entered_at, starting_stack)
  SELECT DISTINCT ON (ts.user_id)
         g.id, v_epoch, ts.user_id,
         (SELECT s.id FROM public.cash_player_session s
           WHERE s.player_id = ts.user_id AND s.closed_at IS NULL
             AND (s.cluster_id = g.id
                  OR s.scope_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id)
                  OR s.table_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id))
           -- coalesce, NOT a bare boolean DESC. cash_player_session.cluster_id
           -- is a nullable added column, so for a session matched only by its
           -- table scope the key is NULL - and DESC implies NULLS FIRST, which
           -- put exactly the session this ORDER BY exists to deprioritise at
           -- the top. A player holding both an open cluster-scoped session and
           -- an open table-scoped one - a shape cash_player_session_one_open
           -- explicitly permits - got the wrong parent on their pool session.
           ORDER BY coalesce(s.cluster_id = g.id, false) DESC, s.opened_at DESC, s.id LIMIT 1),
         'active', clock_timestamp(), ts.stack
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND ts.left_at IS NULL
     AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0
   ORDER BY ts.user_id, ts.joined_at, ts.id;
  GET DIAGNOSTICS v_pool = ROW_COUNT;

  -- The halt is re-stamped rather than lifted. The tables are still not
  -- dealing, and now they are not dealing because the Cluster IS Lightning
  -- rather than because it is deciding - which is the difference Phase 10's
  -- revert will match on.
  --
  -- IT ALSO CATCHES A TABLE THAT ARRIVED AFTER step 6. An earlier cut matched
  -- only rows already carrying 'lightning_pending_on', so a table opened
  -- between PENDING_ON and here would have joined a Lightning Cluster and gone
  -- on dealing. The stood-down tick should make that unreachable; "should be
  -- unreachable" is the reason a guard is cheap, not the reason to omit it.
  UPDATE public.tables
     SET dealing_halted_at = coalesce(dealing_halted_at, clock_timestamp()),
         dealing_halted_reason = 'lightning'
   WHERE cluster_id = g.id
     AND coalesce(is_deleted, false) = false
     AND coalesce(lifecycle, '') <> 'closed'
     -- ONLY A HALT THIS CONVERSION PLACED, OR NO HALT AT ALL. `IS DISTINCT FROM
     -- 'lightning'` alone would rewrite a halt somebody else put there into
     -- one of ours, and Phase 10's revert - which matches on the reason -
     -- would then lift it. begin_pending_on already leaves a foreign halt
     -- alone and abort_pending_on already lifts only its own; this is the
     -- third of the three and it was the one that did not.
     AND (dealing_halted_at IS NULL OR dealing_halted_reason = 'lightning_pending_on');

  -- Step 12, second half. This cannot fail as written; it is here so that it
  -- starts failing the day somebody adds a write to table_seats above it.
  SELECT coalesce(sum(ts.stack), 0) INTO v_after
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'LIGHTNING_CONVERSION_MOVED_MONEY: cluster % chip total went from % to %, and a mode change is a seating transition, not an economic transaction',
      g.id, v_before, v_after USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(DISTINCT ts.user_id)::integer INTO v_seated
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0;

  -- Nobody eligible may be left behind. This is the F15 half that a count
  -- cannot see: a Fast Fold storm at the threshold changes who is eligible,
  -- and the set that entered the pool must be the set that was counted.
  IF v_pool <> v_seated THEN
    RAISE EXCEPTION 'LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND: cluster % counted % eligible seated players and created % pool sessions',
      g.id, v_seated, v_pool USING ERRCODE = 'check_violation';
  END IF;

  -- AND THE ASSERTION THAT COUNTING CANNOT MAKE. v_pool and v_seated share a
  -- predicate, so a predicate that wrongly EXCLUDES a table makes both numbers
  -- smaller and they still agree - which is exactly how the nullable
  -- tables.lifecycle nearly stranded people here: the halt coalesced the NULL
  -- and the player-set queries did not, so a NULL-lifecycle table was stopped
  -- while its seated players were left out of the pool, at a table that was no
  -- longer dealing, in a Cluster that believed it owned them.
  --
  -- This asks the question from the OTHER side, over the tables this
  -- conversion actually halted, and it cannot be satisfied by a filter that
  -- narrows: if we stopped a table, every eligible player sitting at it must
  -- have somewhere to play.
  SELECT count(DISTINCT ts.user_id)::integer INTO v_stranded
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id
     AND tb.dealing_halted_at IS NOT NULL
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session s
                      WHERE s.cluster_id = g.id AND s.player_id = ts.user_id
                        AND s.cluster_epoch = v_epoch AND s.exited_at IS NULL);
  IF v_stranded > 0 THEN
    RAISE EXCEPTION 'LIGHTNING_CONVERSION_STRANDED_A_PLAYER: cluster % stopped a table with % eligible player(s) on it who have no pool session',
      g.id, v_stranded USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.cash_cluster_conversion
     SET status = 'committed', epoch_after = v_epoch, closed_at = clock_timestamp()
   WHERE id = v_conv.id;

  -- Step 22.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (g.id, 'lightning_on', jsonb_build_object(
    'conversion_id', v_conv.id, 'conversion_request_id', p_request_id,
    'from_mode', 'must_move', 'to_mode', 'lightning',
    'trigger_population', coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0),
    'on_threshold', coalesce((v_state -> 'thresholds' ->> 'on')::integer, 0),
    'off_threshold', coalesce((v_state -> 'thresholds' ->> 'off')::integer, 0),
    'epoch_before', g.cluster_epoch, 'epoch_after', v_epoch,
    'pool_sessions', v_pool, 'chip_total', v_before));

  RETURN jsonb_build_object('ok', true, 'converted', true, 'reason', 'lightning',
    'conversion_id', v_conv.id, 'cluster_mode', 'lightning',
    'epoch_before', g.cluster_epoch, 'epoch_after', v_epoch,
    'pool_sessions', v_pool, 'chip_total', v_before,
    'trigger_population', coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0));
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_commit_lightning(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_commit_lightning(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_commit_lightning(uuid, uuid) IS
  'Steps 9 to 22 of the MUST-MOVE -> LIGHTNING sequence, in one transaction under the Cluster row lock: wait for the conversion-safe hand boundary (defined here, because the specification names it once and never defines it: no hand_history row of this Cluster with ended_at NULL that started within six hours), re-ask the population and abort if it fell, bump the Epoch with a stated reason, create one Lightning Pool Session per eligible seated player pointing at the cash session they ALREADY had, re-stamp the halt and emit lightning_on. It writes no table_seats row at all, and asserts the chip total is unchanged and that every counted player entered the pool.';

-- ===========================================================================
-- 5b. THE AUTHORISING NUMBER USES THE SAME MEMBERSHIP PREDICATE
-- ===========================================================================
-- fn_cash_cluster_live_eligible is the number that decides whether a Cluster
-- may convert at all. It carried the uncoalesced form this file has just
-- finished repairing in its own queries: `tb.status IN ('waiting', 'running',
-- 'active') AND tb.lifecycle <> 'closed'`, both against NULLABLE columns, both
-- evaluating to NULL rather than true.
--
-- Leaving it would not strand anybody - Phase 5's own queries are coalesced
-- now, and the stranding assertion asks from the halted side - but it would
-- make the authorising number and the audit record wrong in two ways that
-- matter:
--
--   A Cluster whose players sit on a NULL-status or NULL-lifecycle board is
--   told threshold_not_reached and NEVER CONVERTS, however many people are
--   playing on it.
--
--   When it does convert, trigger_population is written short - the
--   conversion record would say 18 over a pool of 21 - and that record is
--   what an operator reads afterwards to understand what happened.
--
-- Two readers of one population that disagree is the defect 20260921064717
-- was restructured to make impossible, and this is the last place they still
-- did. Everything else about the function is unchanged, including the doubled
-- UNION and count(DISTINCT) guard and the comment explaining why both are
-- there.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_live_eligible(
  p_game_id       uuid,
  p_now           timestamp with time zone DEFAULT clock_timestamp(),
  p_disconnected  integer DEFAULT NULL::integer)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  -- ONE count(DISTINCT) OVER THE UNION OF BOTH HALVES, not the sum of two
  -- counts. The halves are disjoint while a Cluster is cleanly in one regime,
  -- and they are NOT disjoint in the window a Phase 5 conversion opens - a
  -- player seated with chips whose pool session has already been created is in
  -- both relations at once, and that window is precisely when the threshold is
  -- being read. The guard is doubled on purpose: UNION deduplicates the rows
  -- and count(DISTINCT) deduplicates the count, and mutation testing showed
  -- that either alone still answers correctly on every board this estate can
  -- build. Neither is load-bearing by itself; together they make the double
  -- count unreachable by any single edit.
  --
  -- MEMBERSHIP IS coalesce(tb.lifecycle, '') <> 'closed' AND NOTHING ELSE
  -- (2026-09-21, Phase 5). It used to be `tb.status IN ('waiting', 'running',
  -- 'active') AND tb.lifecycle <> 'closed'`. Both columns are nullable -
  -- tables.status has a CHECK, but a CHECK that evaluates to NULL PASSES - so
  -- both comparisons yielded NULL rather than true and silently dropped the
  -- whole board. A Cluster with players on such a board was told it had not
  -- reached its threshold however many people were playing, and any conversion
  -- it did make recorded a trigger_population short of the truth. status is an
  -- engine-facing field that may be NULL, 'paused', or a value added next
  -- year; it must not decide who is in a Cluster.
  --
  -- p_now takes part in nothing here: neither half has a time predicate, and
  -- the parameter exists because the specification names the function
  -- getLiveEligiblePopulation(cluster, now) and a later category may need it.
  -- fn_cash_cluster_population DOES honour it, for the hold expiry.
  SELECT GREATEST(0,
      (SELECT count(DISTINCT u.player_id)::integer
         FROM (
           SELECT ts.user_id AS player_id
             FROM public.table_seats ts
             JOIN public.tables tb ON tb.id = ts.table_id
            WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
              AND coalesce(tb.lifecycle, '') <> 'closed'
              AND ts.left_at IS NULL
              AND ts.user_id IS NOT NULL
              AND coalesce(ts.is_sitting_out, false) = false
              AND coalesce(ts.leave_pending, false) = false
              AND coalesce(ts.stack, 0) > 0
           UNION
           SELECT s.player_id
             FROM public.lightning_pool_session s
            WHERE s.cluster_id = g.id AND s.cluster_epoch = g.cluster_epoch
              AND s.exited_at IS NULL AND s.state = 'active'
         ) u)
    - GREATEST(0, coalesce(p_disconnected, 0)))
    FROM public.cash_games g
   WHERE g.id = p_game_id;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_live_eligible(uuid, timestamp with time zone, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_live_eligible(uuid, timestamp with time zone, integer) TO service_role;

-- ===========================================================================
-- 5c. AND THE BREAKDOWN THAT SITS BESIDE IT, BY ASSERTED SUBSTITUTION
-- ===========================================================================
-- fn_cash_cluster_population is the nine-statement breakdown the operator
-- console reads: seated_total, seated_eligible, sitting_out, leave_pending,
-- busted, capacity, tables, and live_eligible delegated to the reader 5b just
-- re-cut. It carries the same uncoalesced membership predicate in FIVE places.
--
-- Leaving it would have left one function contradicting its own headline
-- number. On the very board this file's harness builds, it reported
-- live_eligible 24 beside seated_total 18, seated_eligible 18 and tables 1,
-- over three live boards and a hundred and twenty seats - because the
-- delegated number had been fixed and the five hand-written ones had not.
-- That is worse than the original defect: an operator reading a console with
-- two numbers on it believes the smaller one.
--
-- 20260921064717's own @live-proof asserts this predicate occurs exactly five
-- times in this function. That proof is KNOWINGLY SUPERSEDED here, and a dated
-- Correction is appended to that file's changelog rather than the proof being
-- quietly reworded - the same treatment 20260920235343 #8 was given. A proof
-- that pins a defect in place is still a proof, and it is retired out loud.
--
-- Substituted rather than retyped, for the reason section 6 gives at length:
-- the body is 224 lines, the anchor is asserted to occur exactly five times,
-- and the result is read back from the CATALOGUE.

DO $pop$
DECLARE
  v_src  text := pg_get_functiondef('public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'::regprocedure);
  v_old  constant text := 'tb.status IN (''waiting'', ''running'', ''active'') AND tb.lifecycle <> ''closed''';
  v_new_pred constant text := 'coalesce(tb.lifecycle, '''') <> ''closed''';
  v_new  text;
  v_live text;
  v_n    integer;
BEGIN
  v_n := (SELECT count(*) FROM regexp_matches(v_src, 'tb\.status IN \(''waiting'', ''running'', ''active''\) AND tb\.lifecycle <> ''closed''', 'g'));
  IF v_n = 0 AND v_src ~ 'coalesce\(tb\.lifecycle' THEN
    RAISE NOTICE 'fn_cash_cluster_population already uses the coalesced membership predicate; leaving it alone';
    RETURN;
  END IF;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'fn_cash_cluster_population carries the uncoalesced membership predicate % time(s), not the five this migration expects; refusing to substitute blind', v_n;
  END IF;

  v_new := replace(v_src, v_old, v_new_pred);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'the substitution into fn_cash_cluster_population changed nothing';
  END IF;
  EXECUTE v_new;

  v_live := pg_get_functiondef('public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'::regprocedure);
  IF v_live ~ 'tb\.status IN \(' THEN
    RAISE EXCEPTION 'the live breakdown still decides membership by a nullable status column';
  END IF;
  -- tb.status, NOT status. A broader rule looked right and was wrong: this
  -- function's last statement counts the WAITLIST, and `w.status IN
  -- ('waiting', 'notified')` is a waitlist state, not a table membership
  -- predicate. Widening the proof to any `status IN` reported the repair as
  -- incomplete while it was complete, and a proof that cries wolf is one a
  -- future agent learns to silence. The waitlist filter is asserted to have
  -- SURVIVED, which is the half that catches a substitution that ate it.
  IF v_live !~ 'w\.status IN \(''waiting'', ''notified''\)' THEN
    RAISE EXCEPTION 'the substitution into fn_cash_cluster_population ate the waitlist status filter, which was never a membership predicate';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_live, 'coalesce\(tb\.lifecycle, ''''\) <> ''''closed''''', 'g')) <> 5
     AND (SELECT count(*) FROM regexp_matches(v_live, 'coalesce\(tb\.lifecycle', 'g')) <> 5 THEN
    RAISE EXCEPTION 'the live breakdown does not carry the coalesced predicate in all five places';
  END IF;
  IF v_live !~ 'fn_cash_cluster_live_eligible' OR v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'the substitution into fn_cash_cluster_population lost its delegation, or introduced is_horse and broke Law 10.5';
  END IF;
  -- THE TWO NUMBERS IN ONE ANSWER NOW AGREE, on every Cluster in the estate.
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE (public.fn_cash_cluster_population(g.id) ->> 'live_eligible')::integer
         > (public.fn_cash_cluster_population(g.id) -> 'counted' ->> 'seated_eligible')::integer;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% cluster(s) report more live-eligible players than seated-eligible ones, so the breakdown still disagrees with its own headline', v_n;
  END IF;
END $pop$;

-- ===========================================================================
-- 6. THE TICK STANDS DOWN, BY ASSERTED SUBSTITUTION
-- ===========================================================================
-- fn_cash_cluster_tick is 40,443 characters of table lifecycle, must-move
-- planning, feeder windows, opening holds and reconciliation, re-cut by at
-- least eight migrations and pinned by a dozen assertions across
-- TheTablesOpenAndCloseThemselves.law.test.ts. Retyping it to insert four
-- lines would be the single most dangerous act in this file.
--
-- So it is not retyped. The body is read from the CATALOGUE, the anchor is
-- asserted to occur exactly once, one replacement is made, every sibling
-- guard is asserted to have survived the edit, and the result is read BACK
-- from the catalogue rather than from the variable that was just built - the
-- variable is what the migration INTENDED, and only the catalogue is what the
-- database HAS.
--
-- WHY THE EXISTING GUARD WAS NOT ENOUGH, since it looks like it should have
-- been. `must_move` is a boolean capability: does this game use must-move
-- seating at all. `cluster_mode` is the state: what is it doing right now. A
-- converting Cluster keeps the capability - Phase 10 reverts to must-move
-- seating using the existing table lifecycle rules, so a Cluster that turned
-- the capability off on the way in would have nothing to turn back on - and
-- changes only the state. The tick read the capability and never the state.
--
-- The guard goes AFTER the must_move test and before everything else, so that
-- a manual game still answers 'manual_game' (pinned) and a Lightning Cluster
-- answers for itself.

DO $tick$
DECLARE
  v_src    text := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  v_anchor constant text := '  IF NOT g.must_move THEN RETURN jsonb_build_object(''ok'', false, ''reason'', ''manual_game''); END IF;';
  v_new    text;
  v_live   text;
BEGIN
  IF v_src ~ 'lightning_cluster_stands_down' THEN
    RAISE NOTICE 'the tick already stands down for a Lightning Cluster; leaving it alone';
    RETURN;
  END IF;

  IF (SELECT count(*) FROM regexp_matches(v_src, regexp_replace(v_anchor, '([().*+?\[\]{}|^$\\])', '\\\1', 'g'), 'g')) <> 1 THEN
    RAISE EXCEPTION 'the must_move guard is not where this migration expects it in fn_cash_cluster_tick; refusing to substitute blind';
  END IF;

  v_new := replace(v_src, v_anchor, v_anchor || chr(10) ||
'  -- LIGHTNING 2.0 PHASE 5. must_move is the CAPABILITY - does this game use' || chr(10) ||
'  -- must-move seating at all - and cluster_mode is the STATE. A Cluster that' || chr(10) ||
'  -- is converting, or has converted, keeps the capability and changes the' || chr(10) ||
'  -- state, because Phase 10 reverts to must-move seating using these very' || chr(10) ||
'  -- rules and a Cluster that had turned the capability off would have nothing' || chr(10) ||
'  -- to turn back on. This function read the capability and never the state,' || chr(10) ||
'  -- so it would have gone on opening feeders, planning moves, balancing and' || chr(10) ||
'  -- reconciling Main 1 underneath a Lightning pool.' || chr(10) ||
'  IF g.cluster_mode IS DISTINCT FROM ''must_move'' THEN' || chr(10) ||
'    RETURN jsonb_build_object(''ok'', false, ''reason'', ''lightning_cluster_stands_down'',' || chr(10) ||
'      ''cluster_mode'', g.cluster_mode, ''cluster_epoch'', g.cluster_epoch);' || chr(10) ||
'  END IF;');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'the substitution into fn_cash_cluster_tick changed nothing';
  END IF;

  EXECUTE v_new;

  -- READ BACK FROM THE CATALOGUE, not from v_new.
  v_live := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  IF v_live !~ 'lightning_cluster_stands_down' THEN
    RAISE EXCEPTION 'the live tick does not stand down for a Lightning Cluster after the substitution';
  END IF;
  -- EVERY SIBLING GUARD SURVIVED. These are the ones other law tests pin; a
  -- replace() that ate one would be invisible until a Cluster misbehaved.
  IF v_live !~ 'IF NOT g\.must_move THEN RETURN'
     OR v_live !~ 'manual_game'
     OR v_live !~ 'fn_platform_frozen'
     OR v_live !~ 'FOR UPDATE'
     OR v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'the substitution into fn_cash_cluster_tick lost a guard that was there before it';
  END IF;
  IF length(v_live) <= length(v_src) THEN
    RAISE EXCEPTION 'the live tick did not grow; the substitution cannot have been additive';
  END IF;
END $tick$;

-- ===========================================================================
-- 7. THE BALANCER STANDS DOWN TOO, FOR A REASON WORTH STATING
-- ===========================================================================
-- fn_cash_clusters_tick_all calls fn_cash_cluster_balance(game_id, now) AFTER
-- each tick, in the same transaction, INDEPENDENTLY of what the tick returned.
-- Standing the tick down therefore does not stand the balancer down: a
-- Lightning Cluster would still have its census taken and a cash_seat_moves
-- row planned every five seconds, moving players between tables that are not
-- dealing, in a Cluster whose players the pool believes it owns.
--
-- Law 10.5 is pinned against this function's text - a horse is balanced
-- exactly like a human, and the pin asserts the SQL does not mention
-- is_horse. The guard added here mentions cluster_mode and nothing else, and
-- the read-back asserts is_horse is still absent.

DO $bal$
DECLARE
  v_src    text := pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure);
  v_anchor constant text := 'BEGIN' || chr(10) || '  v_census := public.fn_cash_cluster_census(p_game_id, p_now);';
  v_new    text;
  v_live   text;
BEGIN
  IF v_src ~ 'cluster_mode' THEN
    RAISE NOTICE 'the balancer already reads cluster_mode; leaving it alone';
    RETURN;
  END IF;

  IF (SELECT count(*) FROM regexp_matches(v_src, 'v_census := public\.fn_cash_cluster_census\(p_game_id, p_now\);', 'g')) <> 1
     OR position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION 'the census call is not where this migration expects it in fn_cash_cluster_balance; refusing to substitute blind';
  END IF;

  v_new := replace(v_src, v_anchor,
'BEGIN' || chr(10) ||
'  -- LIGHTNING 2.0 PHASE 5. tick_all calls this after every tick, in the same' || chr(10) ||
'  -- transaction, whatever the tick returned - so standing the tick down does' || chr(10) ||
'  -- not stand this down. A Lightning Cluster would go on having a seat move' || chr(10) ||
'  -- planned every five seconds, between tables that are not dealing, for' || chr(10) ||
'  -- players the pool believes it owns. Zero moves planned, not an exception:' || chr(10) ||
'  -- this returns a count and the honest count is zero.' || chr(10) ||
'  IF EXISTS (SELECT 1 FROM public.cash_games cg' || chr(10) ||
'              WHERE cg.id = p_game_id AND cg.cluster_mode IS DISTINCT FROM ''must_move'') THEN' || chr(10) ||
'    RETURN 0;' || chr(10) ||
'  END IF;' || chr(10) ||
'  v_census := public.fn_cash_cluster_census(p_game_id, p_now);');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'the substitution into fn_cash_cluster_balance changed nothing';
  END IF;

  EXECUTE v_new;

  v_live := pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure);
  IF v_live !~ 'cluster_mode' THEN
    RAISE EXCEPTION 'the live balancer does not read cluster_mode after the substitution';
  END IF;
  IF v_live !~ 'fn_cash_cluster_census\(p_game_id, p_now\)' OR v_live ~ 'is_horse' THEN
    RAISE EXCEPTION 'the substitution into fn_cash_cluster_balance lost the census, or introduced is_horse and broke Law 10.5';
  END IF;
  IF length(v_live) <= length(v_src) THEN
    RAISE EXCEPTION 'the live balancer did not grow; the substitution cannot have been additive';
  END IF;
END $bal$;

-- ===========================================================================
-- 8. POST-APPLY READ-BACK FROM THE CATALOGUE AND THE ESTATE
-- ===========================================================================
-- Everything asserted here is read back from the running database, never from
-- a variable this file built. The estate assertions are the ones that matter
-- most on the day of the apply: this migration must change no Cluster, halt no
-- table, create no pool session and move no chip.

DO $assert$
DECLARE
  v_tick  text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_bal   text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_begin text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_begin_pending_on(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_abort text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_abort_pending_on(uuid,uuid,text)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_commit text := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g');
  v_bad   bigint;
BEGIN
  -- THE STAND-DOWNS ARE LIVE, AND LAW 10.5 SURVIVED BOTH OF THEM.
  IF v_tick !~ 'lightning_cluster_stands_down' OR v_tick !~ 'IF NOT g\.must_move THEN RETURN' THEN
    RAISE EXCEPTION 'the live tick lost either its Lightning stand-down or its manual_game guard';
  END IF;
  IF v_bal !~ 'cluster_mode' OR v_bal !~ 'fn_cash_cluster_census' THEN
    RAISE EXCEPTION 'the live balancer lost either its stand-down or its census';
  END IF;
  IF v_tick ~ 'is_horse' OR v_bal ~ 'is_horse' THEN
    RAISE EXCEPTION 'LAW 10.5: a horse counts exactly like a human, and one of the stood-down functions now mentions is_horse';
  END IF;

  -- NOT ONE OF THE THREE CONVERSION FUNCTIONS WRITES A SEAT. This is the
  -- design in one assertion: the seat is the anchor, so nothing here may move
  -- it. It is checked on the comment-stripped text because three proofs in
  -- this project have already gone false purely because a comment quoted the
  -- string the proof forbade.
  IF v_begin ~ 'UPDATE public\.table_seats|UPDATE table_seats|DELETE FROM public\.table_seats'
     OR v_abort ~ 'UPDATE public\.table_seats|UPDATE table_seats|DELETE FROM public\.table_seats'
     OR v_commit ~ 'UPDATE public\.table_seats|UPDATE table_seats|DELETE FROM public\.table_seats' THEN
    RAISE EXCEPTION 'a conversion function writes table_seats, and the seat is supposed to be the one thing a conversion never touches';
  END IF;

  -- THE FREEZE IS HONOURED ON THE WAY IN AND NOT ON THE WAY OUT.
  IF v_begin !~ 'fn_platform_frozen' OR v_commit !~ 'fn_platform_frozen' THEN
    RAISE EXCEPTION 'a Cluster can be driven into Lightning during the maintenance break';
  END IF;
  IF v_abort ~ 'fn_platform_frozen' THEN
    RAISE EXCEPTION 'the abort is gated on the freeze, so a half-converted Cluster could not be recovered during an incident';
  END IF;

  -- THE COMMIT RE-ASKS, RATHER THAN TRUSTING THE DECISION MADE AT PENDING_ON.
  IF v_commit !~ 'fn_cash_cluster_lightning_state' OR v_commit !~ 'would_turn_on' THEN
    RAISE EXCEPTION 'the commit does not re-ask the population at the boundary, which is specification steps 10 and 11';
  END IF;
  IF v_commit !~ 'ended_at IS NULL' THEN
    RAISE EXCEPTION 'the commit does not test the conversion-safe hand boundary';
  END IF;
  IF v_commit !~ 'ca\.epoch_reason' THEN
    RAISE EXCEPTION 'the commit bumps the Epoch without saying why, so cash_cluster_epoch.started_by would record unstated';
  END IF;

  -- THIS MIGRATION CHANGED NOTHING, MEASURED RATHER THAN ASSUMED. An earlier
  -- cut asserted the estate was VIRGIN - no Cluster off must_move, no epoch
  -- moved, no halt, no pool session - which is true today and becomes false
  -- the first time Phase 6 drives a conversion, at which point this file stops
  -- being re-appliable over the database it was written for. What it actually
  -- needs to prove is that IT changed nothing, so the counts are taken at the
  -- top of this same transaction, before any of its own DDL, and compared.
  IF (SELECT coalesce(md5(string_agg(t.id::text || ':' || (t.dealing_halted_at IS NOT NULL)::text, ',' ORDER BY t.id)), 'empty') FROM public.tables t)
     IS DISTINCT FROM current_setting('ca.p5_tables', true) THEN
    RAISE EXCEPTION 'the halt state of some table changed during a migration that halts nothing';
  END IF;
  IF (SELECT coalesce(md5(string_agg(g.id::text || ':' || g.cluster_mode || ':' || g.cluster_epoch::text, ',' ORDER BY g.id)), 'empty') FROM public.cash_games g)
     IS DISTINCT FROM current_setting('ca.p5_games', true) THEN
    RAISE EXCEPTION 'some Cluster changed mode or epoch during a migration that converts nothing';
  END IF;
  IF ((SELECT count(*) FROM public.lightning_pool_session)::text || ':' ||
      (SELECT count(*) FROM public.cash_cluster_conversion)::text)
     IS DISTINCT FROM current_setting('ca.p5_counts', true) THEN
    RAISE EXCEPTION 'a pool session or conversion record was created by a migration that creates none';
  END IF;

  -- AND THE INVARIANTS THAT MUST HOLD WHATEVER STATE THE ESTATE IS IN, so that
  -- this file keeps saying something true after Phase 6 exists.
  SELECT count(*) INTO v_bad FROM public.tables t
    JOIN public.cash_games g ON g.id = t.cluster_id
   WHERE t.dealing_halted_at IS NOT NULL AND g.cluster_mode = 'must_move';
  IF v_bad <> 0 THEN RAISE EXCEPTION '% table(s) are halted under a must_move Cluster, which nothing can explain', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM public.cash_cluster_conversion
   WHERE status = 'committed' AND (epoch_after IS NULL OR epoch_after <= epoch_before);
  IF v_bad <> 0 THEN RAISE EXCEPTION '% committed conversion(s) did not move the epoch forward', v_bad; END IF;

  -- THE CAPABILITY GATE IS SHUT, AND NOTHING CALLS THE CONVERSION. Two
  -- independent gates, asserted independently, because the whole safety
  -- argument for shipping a conversion before its matcher rests on both.
  SELECT count(*) INTO v_bad FROM public.cash_games WHERE lightning_enabled;
  IF v_bad <> 0 THEN RAISE EXCEPTION '% cluster(s) are lightning_enabled and the matcher does not exist yet', v_bad; END IF;
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     -- p.prokind = 'f' IS LOAD-BEARING, NOT TIDINESS. n.nspname is a JOIN qual,
     -- so the planner pushes only the p.* quals into the pg_proc scan and
     -- evaluates pg_get_functiondef over EVERY catalogue row it touches -
     -- including aggregates, for which it raises '"array_agg" is an aggregate
     -- function'. Without this the migration cannot apply at all, anywhere, and
     -- EXPLAIN says so rather than it being a matter of luck.
     AND p.prokind = 'f'
     AND p.proname NOT IN ('fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on', 'fn_cash_cluster_commit_lightning')
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_cash_cluster_begin_pending_on|fn_cash_cluster_commit_lightning';
  IF v_bad <> 0 THEN RAISE EXCEPTION '% function(s) already call the conversion, and the matcher does not exist yet', v_bad; END IF;

  -- THE TICK STILL ANSWERS FOR EVERY LIVE CLUSTER. A stand-down that stood
  -- everything down would pass every assertion above.
  SELECT count(*) INTO v_bad FROM public.cash_games g
   WHERE g.cluster_mode = 'must_move' AND g.must_move
     AND public.fn_cash_cluster_lightning_state(g.id) IS NULL;
  IF v_bad <> 0 THEN RAISE EXCEPTION '% must_move cluster(s) stopped answering their own state', v_bad; END IF;
END $assert$;

COMMIT;
