-- 20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 6 (DATABASE HALF OF DEALING): THE HAND IS NUMBERED, FOLDS
-- FREE A PLAYER AT ONCE, AND THE HAND SETTLES ONTO ITS ANCHOR SEATS THROUGH
-- THE PHYSICAL SETTLEMENT PATH.
--
-- Built on the matcher (20260926080332) and remediation two (20260926072615,
-- 20260926072638: the seat is the anchor). Nothing here is wired into a tick
-- or a cron; the engine's Lightning host calls these doors.
--
-- WHAT THIS ADDS
--
-- 1. fn_lightning_bind_hand_number(instance, number) - service_role. Binds the
--    physical allocator's global hand number (fn_next_hand_number) and the
--    Cluster's front table (fn_cash_cluster_front_table) to a DEALING hand,
--    once: the same number again answers the same receipt, a different one is
--    refused, and fn_lightning_hand_is_immutable now refuses a re-bind.
--
-- 2. fn_lightning_fast_fold(hand, player, request, fold_type, committed) -
--    service_role. 'fast' and 'normal' record the fold and release ONLY that
--    player's committed reservation; the reservation-end trigger stamps
--    idle_since, so the player is legal for the matcher at once (the release
--    is what takes them out of fn_lightning_player_in_hand, so a fold-released
--    participant of a still-dealing hand is never IN_HAND). 'fold_watch'
--    records the fold and keeps the reservation until the hand ends. No money
--    moves. Idempotent on (hand, player). Emits fast_fold, normal_fold or
--    fold_and_watch.
--
-- 3. fn_lightning_settle_hand(...) - SECURITY DEFINER, service_role. One
--    transaction: the instance locked; 'complete' with the same request hash
--    answers the stored receipt, 'abandoned' is refused; the host table lease
--    pre-checked by the same predicate the physical door uses; every
--    participant named exactly once; conservation sum(stack_before) =
--    sum(stack_after) + rake + bbj with every stack_after >= 0. A
--    disagreement freezes the Cluster through the formation barrier's freeze
--    path (stack_invariant_failed, cluster_frozen, a critical alert) and
--    answers frozen - it does NOT raise, because a raise would roll the
--    freeze back with it. The anchors are locked FOR UPDATE in player order
--    and the hand is then committed through the UNCHANGED physical door,
--    fn_ca_commit_hand_settlement, at the front table under the bound number:
--    lease fence, settlement_idempotency_keys, ca_settlements, the delta-mode
--    stack write and its conservation identity, hand_history,
--    hand_projection_outbox, hand_atomic_commits with its post-commit
--    envelope, and cash_hand_provenance_receipts. The engine then calls
--    fn_ca_process_hand_post_commit_obligations(hand_history_id) exactly as it
--    does for a physical hand, and atomic_distribute_rake and
--    bbj_record_contribution run from that envelope. Then the Lightning
--    records: lightning_hand_player stack_after, net_result and fold, the pool
--    session and slot counters, the hand's receipt, the instance to complete
--    (whose trigger releases the remaining reservations and emits
--    instance_completed), and hand_settled.
--
-- 4. fn_lightning_my_session(cluster) - authenticated. The caller's open pool
--    session {pool_session_id, state, cluster_mode, stack, in_hand, hand_id?}
--    or {pool_session_id: null}. Never an instance id. SECURITY DEFINER with a
--    pinned search_path; it consults auth.uid() and reads nothing else of
--    anyone.
--
-- 5. fn_lightning_hand_view_access(pool_session, user) - service_role. True
--    iff that user owns that open pool session.
--
-- THE SETTLEMENT MARKER REPLACES A FORGEABLE SETTING. The anchor guard let a
-- stack change through when a session-settable GUC named the hand. Any
-- service_role session could SET it. public.lightning_settlement_marker holds
-- (transaction id, seat) rows that only fn_lightning_settle_hand writes - no
-- role holds any privilege on the table, so only a SECURITY DEFINER function
-- owned by its owner can write it - and it deletes its rows before it
-- returns. The guard accepts a stack change only when a row names THIS seat
-- for THIS transaction (pg_current_xact_id_if_assigned), and never a change
-- of departure or occupant.
--
-- THE NARROWEST ADAPTER, AND WHY. The physical stack core and its door scope
-- seats by `table_id = p_table_id`: fn_ca_settle_hand_stacks_absolute in its
-- exact-generation seat read, its two exact stack writes and its no-op proof,
-- and fn_ca_commit_hand_settlement in its three time-bank statements. A
-- Lightning hand's anchors sit at several tables of the Cluster while the
-- hand is recorded at the front table, so those seven predicates are the only
-- thing between a Lightning hand and the physical path. Each becomes
-- `table_id = COALESCE((v_lightning_seats ->> <user>)::uuid, p_table_id)`,
-- where v_lightning_seats is read ONCE per call from the marker
-- (fn_lightning_settlement_seats) and is '{}' for every physical hand, so
-- every physical predicate still compares to p_table_id and stays an index
-- condition on a parameter. Nothing else in either function changes, a
-- Lightning roster must be exact-generation delta mode naming every anchor,
-- and the substitution is asserted anchor by anchor against the live body.
--
-- ONE ANCHOR IN TWO HANDS (the concurrency choice). A fast folder is dealt
-- into a second hand while the first is still being played. Settlement
-- applies (stack_after - stack_before) as a DELTA to the anchor under FOR
-- UPDATE (the physical core's delta mode), so the two settlements commute.
-- A new hand's stack_before is fn_lightning_pool_stack, which now subtracts
-- fn_lightning_pool_exposure: for every live hand the player was released
-- from by a fold, the chips they put in that pot (p_committed of the fold)
-- or, when the engine did not say, everything they brought into it. The
-- folder therefore never waits for the old hand, can never be dealt chips
-- that are already in the old pot, and the anchor can never go negative
-- whichever hand settles first. The anchor guard holds the seat (no cashout,
-- no departure) while ANY hand the player is in is live, including one they
-- folded out of (fn_lightning_player_live_hand).
--
-- FIVE EARLIER @live-proofs ARE SUPERSEDED, deliberately. 20260926072615
-- line 147 required the guard to read ca.lightning_settlement_hand; that
-- setting is the forgeable authority this file removes. 20260925215731 lines
-- 379 and 381 and 20260926023047 lines 380 and 381 required that no
-- fn_lightning_ function be SECURITY DEFINER or executable by a browser role;
-- this phase's contract needs a definer settlement (it writes the marker no
-- role may write) and a definer browser reader of the caller's own session.
-- Their intent holds as containment, proved by the harness: every
-- fn_lightning_ function is executable by service_role, exactly one
-- (fn_lightning_my_session, which asks auth.uid()) by authenticated and none
-- by anon, exactly five are definers, and all pin their search_path.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse folds, is
-- released, is re-dealt and is settled exactly as a human is.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. One ADD
-- COLUMN per ALTER. Every constraint guarded; every function CREATE OR
-- REPLACE or asserted substitution that leaves an already-substituted body
-- alone, so the file is re-appliable. No lock on `tables` or `table_seats`:
-- replacing a function, including a trigger's, takes none. No foreign key to
-- any table. Every function p.prokind = 'f' with a pinned search_path.
--
-- @live-proof: (SELECT count(*) = 9 FROM pg_attribute a WHERE NOT a.attisdropped AND ((a.attrelid = 'public.lightning_hand'::regclass AND a.attname IN ('hand_number', 'host_table_id', 'settle_request_id', 'settle_request_hash', 'hand_history_id', 'settle_receipt')) OR (a.attrelid = 'public.lightning_hand_player'::regclass AND a.attname IN ('net_result', 'folded_at', 'committed_at_fold'))))
-- @live-proof: (SELECT i.indisunique AND pg_get_indexdef(i.indexrelid) ~ '\(hand_number\)' FROM pg_index i WHERE i.indexrelid = 'public.lightning_hand_one_per_hand_number'::regclass) AND (SELECT count(*) = 5 FROM pg_constraint c WHERE c.conname IN ('lightning_hand_number_in_range', 'lightning_hand_binds_number_and_host_together', 'lightning_hand_settlement_is_whole', 'lightning_hand_player_fold_is_dated', 'lightning_hand_player_commitment_is_a_fold'))
-- @live-proof: (SELECT c.relrowsecurity AND NOT has_table_privilege('service_role', c.oid, 'SELECT') AND NOT has_table_privilege('service_role', c.oid, 'INSERT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') AND NOT has_table_privilege('anon', c.oid, 'SELECT') FROM pg_class c WHERE c.oid = 'public.lightning_settlement_marker'::regclass)
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE') AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE') AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')) FROM unnest(ARRAY['public.fn_lightning_bind_hand_number(uuid,bigint)', 'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)', 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)', 'public.fn_lightning_hand_view_access(uuid,uuid)', 'public.fn_lightning_pool_exposure(uuid,uuid)', 'public.fn_lightning_player_live_hand(uuid,uuid)']) f)
-- @live-proof: (SELECT p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND pg_get_functiondef(p.oid) ~ 'auth\.uid\(\)' AND p.proconfig::text ~ 'search_path' FROM pg_proc p WHERE p.oid = 'public.fn_lightning_my_session(uuid)'::regprocedure)
-- @live-proof: (SELECT bool_and(p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_settlement_seats(uuid,bigint)'::regprocedure, 'public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)'::regprocedure)) AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)
-- @live-proof: (SELECT s ~ 'lightning_settlement_marker' AND s ~ 'pg_current_xact_id_if_assigned\(\)' AND s ~ 'fn_lightning_player_live_hand\(v_player, v_cluster\)' AND s !~ 'current_setting' AND s ~ 'LIGHTNING_HAND_IN_PROGRESS' AND s ~ 'LIGHTNING_ANCHOR_SEAT_IS_IN_THE_POOL' FROM (SELECT pg_get_functiondef('public.fn_table_seats_lightning_anchor_guard()'::regprocedure) AS s) q)
-- @live-proof: (SELECT (length(s) - length(replace(s, 'COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)', ''))) / length('COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)') = 4 AND s ~ 'fn_lightning_settlement_seats\(p_table_id, p_hand_number\)' FROM (SELECT pg_get_functiondef('public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure) AS s) q)
-- @live-proof: (SELECT (length(s) - length(replace(s, 'COALESCE((v_lightning_seats->>(v_item->>''user_id''))::uuid, p_table_id)', ''))) / length('COALESCE((v_lightning_seats->>(v_item->>''user_id''))::uuid, p_table_id)') = 3 AND s ~ 'fn_lightning_settlement_seats\(p_table_id, p_hand_number\)' FROM (SELECT pg_get_functiondef('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ 'fn_lightning_pool_exposure\(s\.player_id, s\.cluster_id\)' AND s ~ 'ts\.left_at IS NOT NULL' FROM (SELECT pg_get_functiondef('public.fn_lightning_pool_stack(uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s1 ~ 'LIGHTNING_HAND_NUMBER_IS_WRITE_ONCE' AND s1 ~ 'LIGHTNING_HAND_IS_SETTLED' AND s2 ~ 'LIGHTNING_FOLD_IS_FINAL' AND s2 ~ 'LIGHTNING_HAND_PLAYER_IS_SETTLED' FROM (SELECT pg_get_functiondef('public.fn_lightning_hand_is_immutable()'::regprocedure) AS s1, pg_get_functiondef('public.fn_lightning_hand_player_is_immutable()'::regprocedure) AS s2) q)
-- @live-proof: (SELECT d.note ~ 'lightning_settlement_marker' FROM public.ca_declared_money_triggers d WHERE d.table_name = 'table_seats' AND d.trigger_name = 'trg_table_seats_lightning_anchor_guard')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_bind_hand_number', 'fn_lightning_fast_fold', 'fn_lightning_settle_hand', 'fn_lightning_my_session', 'fn_lightning_hand_view_access', 'fn_lightning_pool_exposure', 'fn_lightning_player_live_hand', 'fn_lightning_settlement_seats', 'fn_lightning_settlement_freeze', 'fn_lightning_pool_stack', 'fn_table_seats_lightning_anchor_guard') AND (regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id' OR p.proconfig IS NULL)))

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. THE COLUMNS. One ADD COLUMN per ALTER. Both tables are empty in
--    production and are written only by the Lightning doors.
-- ===========================================================================
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS hand_number bigint;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS host_table_id uuid;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS settle_request_id uuid;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS settle_request_hash text;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS hand_history_id uuid;
ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS settle_receipt jsonb;
ALTER TABLE public.lightning_hand_player ADD COLUMN IF NOT EXISTS net_result numeric(14,2);
ALTER TABLE public.lightning_hand_player ADD COLUMN IF NOT EXISTS folded_at timestamp with time zone;
ALTER TABLE public.lightning_hand_player ADD COLUMN IF NOT EXISTS committed_at_fold numeric(14,2);

-- A global hand number names one hand, Lightning or physical.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_hand_one_per_hand_number
  ON public.lightning_hand (hand_number) WHERE hand_number IS NOT NULL;

DO $constraints$
BEGIN
  -- The physical allocator's range, and the downstream integer contract
  -- (hand_history.hand_number is integer; the post-commit rake writer refuses
  -- a number above 2147483647).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lightning_hand'::regclass
                   AND conname = 'lightning_hand_number_in_range') THEN
    ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_number_in_range
      CHECK (hand_number IS NULL OR hand_number BETWEEN 1000000 AND 2147483647);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lightning_hand'::regclass
                   AND conname = 'lightning_hand_binds_number_and_host_together') THEN
    ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_binds_number_and_host_together
      CHECK ((hand_number IS NULL) = (host_table_id IS NULL));
  END IF;
  -- A settled hand carries its whole receipt, and an unsettled one none of it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lightning_hand'::regclass
                   AND conname = 'lightning_hand_settlement_is_whole') THEN
    ALTER TABLE public.lightning_hand ADD CONSTRAINT lightning_hand_settlement_is_whole
      CHECK ((settled_at IS NULL AND settle_request_id IS NULL AND settle_request_hash IS NULL
              AND hand_history_id IS NULL AND settle_receipt IS NULL)
          OR (settled_at IS NOT NULL AND settle_request_id IS NOT NULL AND settle_request_hash IS NOT NULL
              AND hand_history_id IS NOT NULL AND settle_receipt IS NOT NULL AND hand_number IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lightning_hand_player'::regclass
                   AND conname = 'lightning_hand_player_fold_is_dated') THEN
    ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_fold_is_dated
      CHECK (folded_at IS NULL OR fold_type <> 'none');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lightning_hand_player'::regclass
                   AND conname = 'lightning_hand_player_commitment_is_a_fold') THEN
    ALTER TABLE public.lightning_hand_player ADD CONSTRAINT lightning_hand_player_commitment_is_a_fold
      CHECK (committed_at_fold IS NULL OR (folded_at IS NOT NULL AND committed_at_fold >= 0));
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.lightning_hand.hand_number IS
  'The global hand number (fn_next_hand_number) this hand is recorded under in hand_history and hand_atomic_commits, bound once by fn_lightning_bind_hand_number while the instance is dealing. Write-once (fn_lightning_hand_is_immutable).';
COMMENT ON COLUMN public.lightning_hand.host_table_id IS
  'The Cluster''s front table (fn_cash_cluster_front_table) at bind time: the physical table the hand is recorded at, whose engine lease fences its settlement and whose club receives its rake. Bound with hand_number, write-once.';
COMMENT ON COLUMN public.lightning_hand.settle_receipt IS
  'What fn_lightning_settle_hand answered, stored so a retry with the same request hash answers it again. Written once, with settled_at, settle_request_id, settle_request_hash and hand_history_id.';
COMMENT ON COLUMN public.lightning_hand_player.committed_at_fold IS
  'The chips this player had put in the pot when they folded (fn_lightning_fast_fold p_committed). While the hand is live and the player was released by a fast or normal fold, fn_lightning_pool_exposure holds this much (or all of stack_before when it is NULL) out of the stack the next hand is dealt from.';

-- ===========================================================================
-- 2. THE SETTLEMENT MARKER. No role holds any privilege on it; only the
--    SECURITY DEFINER settlement writes it, and it removes its rows before it
--    returns. Row level security on, no policy.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.lightning_settlement_marker (
  txid            xid8        NOT NULL,
  seat_id         uuid        NOT NULL,
  anchor_table_id uuid        NOT NULL,
  player_id       uuid        NOT NULL,
  hand_id         uuid        NOT NULL,
  host_table_id   uuid        NOT NULL,
  hand_number     bigint      NOT NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lightning_settlement_marker_pkey PRIMARY KEY (txid, seat_id)
);
ALTER TABLE public.lightning_settlement_marker ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_settlement_marker FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.lightning_settlement_marker IS
  'The unforgeable settlement authority of a Lightning anchor seat. fn_lightning_settle_hand writes one row per anchor it settles, keyed by its own transaction id, and deletes them before it returns; trg_table_seats_lightning_anchor_guard lets a stack change through to an anchor in a live Lightning hand only when a row names that seat for the current transaction, and fn_lightning_settlement_seats tells the physical stack core and door which table each anchor is at. No role holds a privilege on it.';

-- ===========================================================================
-- 3. THE READERS THE GUARD, THE POOL STACK AND THE PHYSICAL CORE USE.
-- ===========================================================================

-- The chips a player has in live hands they were released from by a fold.
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_exposure(p_player_id uuid, p_cluster_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(sum(coalesce(hp.committed_at_fold, hp.stack_before, 0)), 0)::numeric
    FROM public.lightning_instance i
    JOIN public.lightning_hand_player hp ON hp.hand_id = i.hand_id AND hp.player_id = p_player_id
   WHERE i.cluster_id = p_cluster_id
     AND i.state IN ('forming', 'reserved', 'dealing', 'settling')
     AND hp.folded_at IS NOT NULL
     AND hp.fold_type IN ('fast', 'normal');
$function$;

-- The newest live hand that holds this player's anchor: one they hold a
-- committed reservation in, or one they are a participant of (a fast or
-- normal fold releases the reservation but not the chips in the pot). NULL
-- when there is none. An instance that has no hand yet answers its own id.
CREATE OR REPLACE FUNCTION public.fn_lightning_player_live_hand(p_player_id uuid, p_cluster_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x.hand
    FROM (SELECT coalesce(i.hand_id, i.id) AS hand, i.created_at, i.id
            FROM public.lightning_reservation r
            JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
           WHERE r.cluster_id = p_cluster_id AND r.player_id = p_player_id AND r.state = 'committed'
             AND i.state IN ('forming', 'reserved', 'dealing', 'settling')
          UNION ALL
          SELECT i.hand_id, i.created_at, i.id
            FROM public.lightning_instance i
            JOIN public.lightning_hand_player hp ON hp.hand_id = i.hand_id AND hp.player_id = p_player_id
           WHERE i.cluster_id = p_cluster_id
             AND i.state IN ('forming', 'reserved', 'dealing', 'settling')) x
   ORDER BY x.created_at DESC, x.id
   LIMIT 1;
$function$;

-- {player_id: anchor table} for the anchors this transaction is settling for
-- (table, hand number); '{}' for every physical hand. Read once per call by
-- the physical stack core and its door.
CREATE OR REPLACE FUNCTION public.fn_lightning_settlement_seats(p_table_id uuid, p_hand_number bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_object_agg(m.player_id::text, m.anchor_table_id), '{}'::jsonb)
    FROM public.lightning_settlement_marker m
   WHERE m.txid = pg_current_xact_id_if_assigned()
     AND m.host_table_id = p_table_id
     AND m.hand_number = p_hand_number;
$function$;

-- ===========================================================================
-- 4. ASSERTED SUBSTITUTIONS. Each reads the live body, asserts every anchor
--    occurs exactly as often as expected, replaces, EXECUTEs and reads back.
--    A body that already carries the substitution is left alone.
-- ===========================================================================

-- 4a. fn_lightning_pool_stack: the stack the next hand is dealt from is the
--     anchor's stack less the chips held in live hands the player folded out
--     of.
DO $sub_pool_stack$
DECLARE
  v_sig constant text := 'public.fn_lightning_pool_stack(uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[$a$              ELSE round(coalesce(ts.stack, 0), 2) END$a$];
  b text[] := ARRAY[$b$              ELSE GREATEST(round(coalesce(ts.stack, 0), 2) - public.fn_lightning_pool_exposure(s.player_id, s.cluster_id), 0::numeric) END$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('fn_lightning_pool_exposure(s.player_id, s.cluster_id)' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(a[1] in v_src) > 0 THEN
    RAISE EXCEPTION '% does not read back with the exposure subtracted', v_sig;
  END IF;
END
$sub_pool_stack$;

-- 4b. fn_table_seats_lightning_anchor_guard: held by every live hand the
--     player is in, released only by the settlement marker.
DO $sub_guard$
DECLARE
  v_sig constant text := 'public.fn_table_seats_lightning_anchor_guard()';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  IF NOT public.fn_lightning_player_in_hand(v_player, v_cluster) THEN
    RETURN NEW;
  END IF;

  SELECT i.hand_id INTO v_hand
    FROM public.lightning_reservation r
    JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
   WHERE r.cluster_id = v_cluster AND r.player_id = v_player AND r.state = 'committed'
     AND i.state IN ('forming', 'reserved', 'dealing', 'settling')
   ORDER BY i.created_at DESC, i.id
   LIMIT 1;
$a$,
$a$  -- THE ONE WRITER ALLOWED THROUGH is the settlement of THAT hand, which names
  -- it in ca.lightning_settlement_hand for its own transaction. Any other
  -- value, or none, is refused.
  IF v_hand IS NOT NULL
     AND nullif(current_setting('ca.lightning_settlement_hand', true), '') IS NOT DISTINCT FROM v_hand::text THEN
    RETURN NEW;
  END IF;
$a$];
  b text[] := ARRAY[
$b$  -- LIGHTNING PHASE 6 (20261001154813): EVERY LIVE HAND THE PLAYER IS IN
  -- HOLDS THE ANCHOR, including one they folded out of. A fast or normal fold
  -- releases the reservation so they can be dealt again at once, but the
  -- chips they put in that pot leave the seat only through that hand's
  -- settlement.
  v_hand := public.fn_lightning_player_live_hand(v_player, v_cluster);
  IF v_hand IS NULL THEN
    RETURN NEW;
  END IF;
$b$,
$b$  -- THE ONE WRITER ALLOWED THROUGH is a Lightning settlement, recognised by a
  -- row of lightning_settlement_marker naming THIS seat for THIS transaction.
  -- Only fn_lightning_settle_hand, a SECURITY DEFINER function, can write that
  -- table (no role holds a privilege on it), and it removes its rows before it
  -- returns. A value any session can set is not an authority, and none is
  -- read here. A settlement moves the stack only: never the departure or the
  -- occupant.
  IF NEW.left_at IS NOT DISTINCT FROM OLD.left_at
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND EXISTS (SELECT 1 FROM public.lightning_settlement_marker m
                  WHERE m.txid = pg_current_xact_id_if_assigned()
                    AND m.seat_id = OLD.id) THEN
    RETURN NEW;
  END IF;
$b$];
  c integer[] := ARRAY[1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('lightning_settlement_marker' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(b[2] in v_src) = 0
     OR position('current_setting' in v_src) > 0
     OR position('LIGHTNING_ANCHOR_SEAT_IS_IN_THE_POOL' in v_src) = 0
     OR position('LIGHTNING_HAND_IN_PROGRESS' in v_src) = 0
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
    RAISE EXCEPTION '% does not read back as the marker guard', v_sig;
  END IF;
END
$sub_guard$;

UPDATE public.ca_declared_money_triggers
   SET note = 'Lightning remediation two (file D), authority replaced by Lightning Phase 6 (20261001154813). BEFORE UPDATE, WHEN stack, left_at or user_id changes: refuses (LIGHTNING_HAND_IN_PROGRESS, SQLSTATE PLT01) any change to a seat that anchors an open Lightning pool session whose player is in ANY live Lightning hand (fn_lightning_player_live_hand, a hand they folded out of included), unless a lightning_settlement_marker row written by fn_lightning_settle_hand names that seat for the current transaction, and then a stack change only. Writes nothing; one index probe for every other seat.'
 WHERE table_name = 'table_seats' AND trigger_name = 'trg_table_seats_lightning_anchor_guard'
   AND note IS DISTINCT FROM 'Lightning remediation two (file D), authority replaced by Lightning Phase 6 (20261001154813). BEFORE UPDATE, WHEN stack, left_at or user_id changes: refuses (LIGHTNING_HAND_IN_PROGRESS, SQLSTATE PLT01) any change to a seat that anchors an open Lightning pool session whose player is in ANY live Lightning hand (fn_lightning_player_live_hand, a hand they folded out of included), unless a lightning_settlement_marker row written by fn_lightning_settle_hand names that seat for the current transaction, and then a stack change only. Writes nothing; one index probe for every other seat.';

-- 4c. fn_lightning_hand_is_immutable: the bound number and the settlement
--     receipt are written once.
DO $sub_hand$
DECLARE
  v_sig constant text := 'public.fn_lightning_hand_is_immutable()';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[$a$  -- THE LATCH IS ONE-WAY. Clearing it would unlock every rule in
$a$];
  b text[] := ARRAY[$b$  -- LIGHTNING PHASE 6 (20261001154813): THE NUMBER A HAND IS RECORDED UNDER
  -- AND THE RECEIPT IT SETTLED WITH ARE WRITTEN ONCE. A re-bound number is a
  -- second physical hand wearing this one's identity; a rewritten receipt is
  -- a settlement that can be answered two ways.
  IF OLD.hand_number IS NOT NULL
     AND ROW(NEW.hand_number, NEW.host_table_id) IS DISTINCT FROM ROW(OLD.hand_number, OLD.host_table_id) THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_NUMBER_IS_WRITE_ONCE: hand % was bound to hand number % at host table % and may not be re-bound to % at %',
      OLD.hand_id, OLD.hand_number, OLD.host_table_id, NEW.hand_number, NEW.host_table_id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.settled_at IS NOT NULL
     AND ROW(NEW.settled_at, NEW.settle_request_id, NEW.settle_request_hash, NEW.hand_history_id, NEW.settle_receipt)
         IS DISTINCT FROM ROW(OLD.settled_at, OLD.settle_request_id, OLD.settle_request_hash, OLD.hand_history_id, OLD.settle_receipt) THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_IS_SETTLED: hand % settled at % as hand history % and its receipt may not be rewritten',
      OLD.hand_id, OLD.settled_at, OLD.hand_history_id USING ERRCODE = 'check_violation';
  END IF;

  -- THE LATCH IS ONE-WAY. Clearing it would unlock every rule in
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('LIGHTNING_HAND_NUMBER_IS_WRITE_ONCE' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position('LIGHTNING_HAND_IS_BORN_UNLOCKED' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back with the write-once number and receipt', v_sig;
  END IF;
END
$sub_hand$;

-- 4d. fn_lightning_hand_player_is_immutable: a fold is final, and a settled
--     participant is a receipt.
DO $sub_hand_player$
DECLARE
  v_sig constant text := 'public.fn_lightning_hand_player_is_immutable()';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[$a$  -- Everything not named above stays writable, and the two that matter are
$a$];
  b text[] := ARRAY[$b$  -- LIGHTNING PHASE 6 (20261001154813): A FOLD IS FINAL, AND A SETTLED
  -- PARTICIPANT IS A RECEIPT. The fold and the chips committed at it decide
  -- what the next hand may deal the player, so they are written once; once
  -- the hand is settled its outcome columns are its record.
  IF OLD.folded_at IS NOT NULL
     AND ROW(NEW.fold_type, NEW.folded_at, NEW.committed_at_fold)
         IS DISTINCT FROM ROW(OLD.fold_type, OLD.folded_at, OLD.committed_at_fold) THEN
    RAISE EXCEPTION 'LIGHTNING_FOLD_IS_FINAL: player % folded (%) out of hand % at % and the fold may not be rewritten',
      OLD.player_id, OLD.fold_type, v_hand, OLD.folded_at USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_hand sh WHERE sh.hand_id = v_hand AND sh.settled_at IS NOT NULL)
     AND ROW(NEW.stack_after, NEW.net_result, NEW.fold_type, NEW.folded_at, NEW.committed_at_fold)
         IS DISTINCT FROM ROW(OLD.stack_after, OLD.net_result, OLD.fold_type, OLD.folded_at, OLD.committed_at_fold) THEN
    RAISE EXCEPTION 'LIGHTNING_HAND_PLAYER_IS_SETTLED: hand % is settled and player %''s outcome may not be rewritten',
      v_hand, OLD.player_id USING ERRCODE = 'check_violation';
  END IF;

  -- Everything not named above stays writable, and the two that matter are
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('LIGHTNING_FOLD_IS_FINAL' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position('LIGHTNING_NO_PARTICIPANT_SUBSTITUTION' in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back with the final fold and the settled receipt', v_sig;
  END IF;
END
$sub_hand_player$;

-- 4e. fn_ca_settle_hand_stacks_absolute: the narrowest adapter. The four
--     exact-generation seat predicates compare to the anchor's table when this
--     transaction's settlement marker names the player, and to p_table_id
--     otherwise. A Lightning roster must be exact-generation delta mode and
--     name every anchor.
DO $sub_stack_core$
DECLARE
  v_sig constant text := 'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)';
  v_src text; v_new text; k integer; v_n integer;
  v_pred constant text := 'COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)';
  a text[] := ARRAY[
$a$  v_tb jsonb;
BEGIN
$a$,
$a$  v_delta_mode := COALESCE(v_delta_mode, false);
$a$,
$a$           AND ts.joined_at = v_exact_seat_joined_at
           AND ts.table_id = p_table_id
$a$,
$a$             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = p_table_id
$a$,
$a$           WHERE ts.table_id = p_table_id
             AND ts.user_id = v_uid
             AND ts.stack = v_target
$a$];
  b text[] := ARRAY[
$b$  v_tb jsonb;
  -- LIGHTNING PHASE 6 (20261001154813): {player: anchor table} for the
  -- anchors a Lightning settlement in THIS transaction names, '{}' otherwise.
  v_lightning_seats jsonb := '{}'::jsonb;
BEGIN
$b$,
$b$  v_delta_mode := COALESCE(v_delta_mode, false);
  -- LIGHTNING PHASE 6 (20261001154813): THE ONE ADAPTER. A Lightning hand is
  -- recorded at its Cluster's front table while each anchor seat sits at its
  -- own table of the Cluster. fn_lightning_settle_hand names every anchor in
  -- lightning_settlement_marker for this transaction, and only the four
  -- exact-generation seat predicates below read the answer; for every
  -- physical hand it is '{}' and each still compares to p_table_id.
  v_lightning_seats := public.fn_lightning_settlement_seats(p_table_id, p_hand_number);
  IF v_lightning_seats <> '{}'::jsonb
     AND (NOT v_exact_seat_generation OR NOT v_delta_mode
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_canonical) x
                      WHERE NOT (v_lightning_seats ? (x->>'user_id')))) THEN
    RAISE EXCEPTION 'Lightning hand settlement must name every anchor by its exact seat generation in delta mode'
      USING ERRCODE = '22023';
  END IF;
$b$,
$b$           AND ts.joined_at = v_exact_seat_joined_at
           AND ts.table_id = COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)
$b$,
$b$             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)
$b$,
$b$           WHERE ts.table_id = COALESCE((v_lightning_seats->>v_uid::text)::uuid, p_table_id)
             AND ts.user_id = v_uid
             AND ts.stack = v_target
$b$];
  c integer[] := ARRAY[1, 1, 1, 2, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('fn_lightning_settlement_seats(p_table_id, p_hand_number)' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF (length(v_src) - length(replace(v_src, v_pred, ''))) / length(v_pred) IS DISTINCT FROM 4
     OR position(b[2] in v_src) = 0
     OR position('conservation violation: stack deltas % != inflow % - rake % - bbj %' in v_src) = 0
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
    RAISE EXCEPTION '% does not read back with exactly the four adapted seat predicates', v_sig;
  END IF;
END
$sub_stack_core$;

-- 4f. fn_ca_commit_hand_settlement: the same adapter on the door's three
--     time-bank statements, read after the stack core has returned.
DO $sub_door$
DECLARE
  v_sig constant text := 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)';
  v_src text; v_new text; k integer; v_n integer;
  v_pred constant text := $p$COALESCE((v_lightning_seats->>(v_item->>'user_id'))::uuid, p_table_id)$p$;
  a text[] := ARRAY[
$a$  v_exact_seat_generation boolean := false;
BEGIN
$a$,
$a$  PERFORM set_config('app.ca_hand_time_banks', '', true);
$a$,
$a$WHERE s.table_id = p_table_id
$a$];
  b text[] := ARRAY[
$b$  v_exact_seat_generation boolean := false;
  -- LIGHTNING PHASE 6 (20261001154813): see fn_ca_settle_hand_stacks_absolute.
  v_lightning_seats jsonb := '{}'::jsonb;
BEGIN
$b$,
$b$  PERFORM set_config('app.ca_hand_time_banks', '', true);
  -- LIGHTNING PHASE 6 (20261001154813): the anchors a Lightning settlement in
  -- this transaction names, so the three time-bank statements below find each
  -- at its own table; '{}' for every physical hand.
  v_lightning_seats := public.fn_lightning_settlement_seats(p_table_id, p_hand_number);
$b$,
$b$WHERE s.table_id = COALESCE((v_lightning_seats->>(v_item->>'user_id'))::uuid, p_table_id)
$b$];
  c integer[] := ARRAY[1, 1, 3];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('fn_lightning_settlement_seats(p_table_id, p_hand_number)' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF (length(v_src) - length(replace(v_src, v_pred, ''))) / length(v_pred) IS DISTINCT FROM 3
     OR position(b[2] in v_src) = 0
     OR position('fn_ca_commit_hand_settlement_exact_before_obligations(' in v_src) = 0
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
    RAISE EXCEPTION '% does not read back with exactly the three adapted time-bank predicates', v_sig;
  END IF;
END
$sub_door$;

-- ===========================================================================
-- 5. THE DOORS.
-- ===========================================================================

-- 5a. THE NUMBER.
CREATE OR REPLACE FUNCTION public.fn_lightning_bind_hand_number(p_instance_id uuid, p_hand_number bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  i      record;
  h      record;
  v_host uuid;
BEGIN
  IF p_instance_id IS NULL OR p_hand_number IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  END IF;

  SELECT li.id, li.state, li.hand_id, li.cluster_id, li.cluster_epoch
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT lh.hand_id, lh.hand_number, lh.host_table_id
    INTO h FROM public.lightning_hand lh WHERE lh.hand_id = i.hand_id;
  IF i.hand_id IS NULL OR h.hand_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_has_no_hand');
  END IF;

  -- WRITE-ONCE: the same number answers the same receipt, in any state.
  IF h.hand_number IS NOT NULL THEN
    IF h.hand_number = p_hand_number THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'hand_id', h.hand_id,
                                'hand_number', h.hand_number, 'host_table_id', h.host_table_id);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_number_already_bound',
                              'hand_id', h.hand_id, 'hand_number', h.hand_number);
  END IF;
  IF i.state IS DISTINCT FROM 'dealing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_not_dealing', 'state', i.state);
  END IF;
  IF p_hand_number < 1000000 OR p_hand_number > 2147483647 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_number_out_of_range');
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_hand x WHERE x.hand_number = p_hand_number)
     OR EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.hand_number = p_hand_number)
     OR EXISTS (SELECT 1 FROM public.hand_atomic_commits c WHERE c.hand_number = p_hand_number) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_number_taken', 'hand_number', p_hand_number);
  END IF;

  v_host := public.fn_cash_cluster_front_table(i.cluster_id);
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cluster_has_no_front_table');
  END IF;

  BEGIN
    UPDATE public.lightning_hand
       SET hand_number = p_hand_number, host_table_id = v_host
     WHERE hand_id = h.hand_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_number_taken', 'hand_number', p_hand_number);
  END;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (i.cluster_id, 'hand_number_bound', jsonb_build_object(
    'cluster_id', i.cluster_id, 'cluster_epoch', i.cluster_epoch, 'hand_id', h.hand_id,
    'hand_number', p_hand_number, 'host_table_id', v_host, 'at', clock_timestamp()), i.cluster_epoch);

  RETURN jsonb_build_object('ok', true, 'hand_id', h.hand_id, 'hand_number', p_hand_number,
                            'host_table_id', v_host);
END
$function$;

-- 5b. THE FOLD.
CREATE OR REPLACE FUNCTION public.fn_lightning_fast_fold(p_hand_id uuid, p_player_id uuid, p_request_id uuid,
                                                         p_fold_type text, p_committed numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  h          record;
  i          record;
  hp         record;
  v_now      timestamptz := clock_timestamp();
  v_released integer := 0;
  v_kind     text;
BEGIN
  IF p_hand_id IS NULL OR p_player_id IS NULL OR p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  END IF;
  IF p_fold_type IS NULL OR p_fold_type NOT IN ('fast', 'normal', 'fold_watch') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_fold_type');
  END IF;
  IF p_committed IS NOT NULL AND (p_committed < 0 OR p_committed <> round(p_committed, 2)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_committed');
  END IF;

  SELECT lh.hand_id, lh.lightning_instance_id, lh.cluster_id, lh.cluster_epoch
    INTO h FROM public.lightning_hand lh WHERE lh.hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_not_found');
  END IF;
  -- The instance first, as every door that changes a live hand takes it.
  SELECT li.id, li.state INTO i FROM public.lightning_instance li
   WHERE li.id = h.lightning_instance_id FOR UPDATE;
  SELECT x.player_id, x.fold_type, x.folded_at, x.stack_before, x.pool_slot_id
    INTO hp FROM public.lightning_hand_player x
   WHERE x.hand_id = p_hand_id AND x.player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_participant');
  END IF;

  -- IDEMPOTENT ON (hand, player): a fold is recorded once.
  IF hp.folded_at IS NOT NULL THEN
    IF hp.fold_type = p_fold_type THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'hand_id', p_hand_id, 'player_id', p_player_id,
                                'fold_type', hp.fold_type, 'released', hp.fold_type IN ('fast', 'normal'));
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_folded', 'fold_type', hp.fold_type);
  END IF;
  IF i.state IS DISTINCT FROM 'dealing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_not_dealing', 'state', i.state);
  END IF;
  IF p_committed IS NOT NULL AND p_committed > coalesce(hp.stack_before, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'committed_exceeds_stack_before',
                              'stack_before', hp.stack_before);
  END IF;

  UPDATE public.lightning_hand_player
     SET fold_type = p_fold_type, folded_at = v_now, committed_at_fold = p_committed
   WHERE hand_id = p_hand_id AND player_id = p_player_id;

  -- 'fast' and 'normal' free the player now: their committed reservation,
  -- and only theirs, is released, and the reservation-end trigger stamps
  -- idle_since because this instance was dealt. 'fold_watch' keeps it until
  -- the hand ends.
  IF p_fold_type IN ('fast', 'normal') THEN
    UPDATE public.lightning_reservation r
       SET state = 'released', resolved_at = v_now, reason = p_fold_type || '_fold'
     WHERE r.lightning_instance_id = i.id AND r.player_id = p_player_id AND r.state = 'committed';
    GET DIAGNOSTICS v_released = ROW_COUNT;
  END IF;

  v_kind := CASE p_fold_type WHEN 'fast' THEN 'fast_fold' WHEN 'normal' THEN 'normal_fold' ELSE 'fold_and_watch' END;
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES (h.cluster_id, v_kind, jsonb_build_object(
    'cluster_id', h.cluster_id, 'cluster_epoch', h.cluster_epoch, 'hand_id', p_hand_id,
    'player_id', p_player_id, 'fold_type', p_fold_type, 'released', v_released > 0,
    'committed', p_committed, 'at', v_now), h.cluster_epoch, p_request_id);

  RETURN jsonb_build_object('ok', true, 'hand_id', p_hand_id, 'player_id', p_player_id,
                            'fold_type', p_fold_type, 'released', v_released > 0);
END
$function$;

-- 5c. THE FREEZE, the formation barrier's path for an impossible state:
--     the Cluster to frozen through its own cluster_mode, a critical alert in
--     its own sub-block (its failure never costs the freeze), and the two
--     events an operator looks for. Called by the settlement only.
CREATE OR REPLACE FUNCTION public.fn_lightning_settlement_freeze(p_cluster_id uuid, p_cluster_epoch integer, p_hand_id uuid,
                                                                 p_instance_id uuid, p_request_id uuid, p_invariant text,
                                                                 p_evidence jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_alert_id    uuid;
  v_alert_error text;
BEGIN
  UPDATE public.cash_games cg
     SET cluster_mode = 'frozen', updated_at = now()
   WHERE cg.id = p_cluster_id AND cg.cluster_mode = 'lightning';
  BEGIN
    v_alert_id := public.fn_raise_server_financial_alert(
      'critical', 'lightning_settlement',
      format('LIGHTNING_CLUSTER_FROZEN: Cluster %s froze at epoch %s settling hand %s: %s',
             p_cluster_id, p_cluster_epoch, p_hand_id, p_invariant),
      jsonb_build_object('cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'hand_id', p_hand_id,
                         'instance_id', p_instance_id, 'invariant', p_invariant,
                         'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'),
      'lightning_cluster_frozen:' || p_cluster_id, p_cluster_id::text);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_alert_error = MESSAGE_TEXT;
  END;
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES
    (p_cluster_id, 'stack_invariant_failed', jsonb_build_object(
       'cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'hand_id', p_hand_id,
       'instance_id', p_instance_id, 'stage', 'settlement', 'invariant', p_invariant,
       'evidence', p_evidence, 'at', clock_timestamp()), p_cluster_epoch, p_request_id),
    (p_cluster_id, 'cluster_frozen', jsonb_build_object(
       'cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'from_mode', 'lightning', 'to_mode', 'frozen',
       'reason', 'stack_invariant_failed', 'invariant', p_invariant, 'hand_id', p_hand_id,
       'instance_id', p_instance_id, 'alert_id', v_alert_id, 'alert_error', v_alert_error,
       'at', clock_timestamp()), p_cluster_epoch, p_request_id);
  RETURN jsonb_build_object('ok', false, 'frozen', true, 'retry', false,
                            'reason', 'settlement_invariant_failed', 'invariant', p_invariant,
                            'hand_id', p_hand_id, 'cluster_id', p_cluster_id,
                            'alerted', v_alert_id IS NOT NULL);
END
$function$;

-- 5d. THE SETTLEMENT.
CREATE OR REPLACE FUNCTION public.fn_lightning_settle_hand(p_hand_id uuid, p_request_id uuid, p_host_table_id uuid,
                                                           p_lease_instance text, p_lease_generation uuid,
                                                           p_results jsonb, p_rake numeric, p_bbj numeric,
                                                           p_hand_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_instance uuid;
  h          record;
  i          record;
  l          record;
  t          record;
  a          record;
  s          record;
  v_now      timestamptz := clock_timestamp();
  v_rake     numeric := round(coalesce(p_rake, 0), 2);
  v_bbj      numeric := round(coalesce(p_bbj, 0), 2);
  v_row_in   jsonb := coalesce(p_hand_row, '{}'::jsonb);
  v_results  jsonb;
  v_hash     text;
  v_p        jsonb;
  v_n        integer;
  v_before   numeric;
  v_after    numeric;
  v_why      text;
  v_stacks   jsonb := '[]'::jsonb;
  v_banks    jsonb := '[]'::jsonb;
  v_contrib  jsonb;
  v_returned jsonb;
  v_promo    jsonb;
  v_players  jsonb;
  v_pot      numeric;
  v_bb       numeric;
  v_sb       numeric;
  v_max_buy  numeric;
  v_row      jsonb;
  v_env      jsonb;
  v_res      jsonb;
  v_hh       uuid;
  v_deltas   jsonb;
  v_receipt  jsonb;
  v_msg      text;
  v_detail   text;
BEGIN
  -- 0. THE SHAPE. Nothing is read or locked for a call that cannot settle.
  IF p_hand_id IS NULL OR p_request_id IS NULL OR p_host_table_id IS NULL
     OR nullif(btrim(coalesce(p_lease_instance, '')), '') IS NULL OR p_lease_generation IS NULL
     OR jsonb_typeof(p_results) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_row_in) IS DISTINCT FROM 'object'
     OR coalesce(p_rake, 0) < 0 OR coalesce(p_bbj, 0) < 0
     OR coalesce(p_rake, 0) <> v_rake OR coalesce(p_bbj, 0) <> v_bbj THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_results) x
              WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
                 OR jsonb_typeof(x -> 'player_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(x -> 'stack_after') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(x -> 'contributed') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(x -> 'won') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(x -> 'showed') IS DISTINCT FROM 'boolean'
                 OR coalesce(x ->> 'fold_type', '') NOT IN ('none', 'normal', 'fast', 'fold_watch')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_results');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_results) x
              WHERE NOT pg_input_is_valid(x ->> 'player_id', 'uuid')
                 OR (x ->> 'stack_after')::numeric < 0
                 OR (x ->> 'stack_after')::numeric <> round((x ->> 'stack_after')::numeric, 2)
                 OR (x ->> 'contributed')::numeric < 0
                 OR (x ->> 'won')::numeric < 0)
     OR (SELECT count(DISTINCT (x ->> 'player_id')::uuid) FROM jsonb_array_elements(p_results) x)
        IS DISTINCT FROM jsonb_array_length(p_results)::bigint THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_results');
  END IF;
  IF v_row_in ? 'returned_uncalled'
     AND (jsonb_typeof(v_row_in -> 'returned_uncalled') IS DISTINCT FROM 'object'
          OR EXISTS (SELECT 1 FROM jsonb_each(v_row_in -> 'returned_uncalled') e
                      WHERE NOT pg_input_is_valid(e.key, 'uuid') OR jsonb_typeof(e.value) IS DISTINCT FROM 'number')
          OR EXISTS (SELECT 1 FROM jsonb_each(v_row_in -> 'returned_uncalled') e
                      WHERE jsonb_typeof(e.value) = 'number' AND (e.value::text)::numeric < 0)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_returned_uncalled');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'player_id', (x ->> 'player_id')::uuid,
           'stack_after', round((x ->> 'stack_after')::numeric, 2),
           'contributed', round((x ->> 'contributed')::numeric, 2),
           'won', round((x ->> 'won')::numeric, 2),
           'fold_type', x ->> 'fold_type',
           'showed', (x ->> 'showed')::boolean) ORDER BY (x ->> 'player_id')::uuid)
    INTO v_results FROM jsonb_array_elements(p_results) x;
  -- The request: everything that decides the outcome. The lease is not in it,
  -- so a retry after a renewal still answers the stored receipt.
  v_hash := encode(sha256(convert_to(jsonb_build_object(
              'hand_id', p_hand_id, 'request_id', p_request_id, 'host_table_id', p_host_table_id,
              'results', v_results, 'rake', v_rake, 'bbj', v_bbj, 'hand_row', v_row_in)::text, 'UTF8')), 'hex');

  -- 1. THE INSTANCE, LOCKED, as every door that changes a live hand takes it.
  SELECT lh.lightning_instance_id INTO v_instance FROM public.lightning_hand lh WHERE lh.hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_not_found');
  END IF;
  SELECT li.id, li.state, li.started_at, li.abandon_reason, li.cluster_id, li.cluster_epoch
    INTO i FROM public.lightning_instance li WHERE li.id = v_instance FOR UPDATE;
  SELECT lh.hand_id, lh.cluster_id, lh.cluster_epoch, lh.hand_number, lh.host_table_id,
         lh.settle_request_hash, lh.settle_receipt, lh.hand_history_id
    INTO h FROM public.lightning_hand lh WHERE lh.hand_id = p_hand_id;

  IF i.state = 'complete' THEN
    IF h.settle_request_hash IS NOT DISTINCT FROM v_hash AND h.settle_receipt IS NOT NULL THEN
      RETURN h.settle_receipt || jsonb_build_object('ok', true, 'replay', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_settled', 'hand_id', p_hand_id,
                              'hand_history_id', h.hand_history_id);
  END IF;
  IF i.state = 'abandoned' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_abandoned', 'abandon_reason', i.abandon_reason);
  END IF;
  IF i.state IS DISTINCT FROM 'dealing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_not_dealing', 'state', i.state);
  END IF;
  IF h.hand_number IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_number_not_bound');
  END IF;
  IF h.host_table_id IS DISTINCT FROM p_host_table_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'host_table_mismatch', 'host_table_id', h.host_table_id);
  END IF;

  -- 2. THE HOST LEASE, by the predicate the physical door fences with
  --    (fn_ca_commit_hand_settlement_exact_before_obligations), read-only so a
  --    stale engine is refused before anything is locked. The door re-checks
  --    it under its own lock.
  SELECT el.instance_id, el.lease_generation, el.protocol_version, el.heartbeat_at
    INTO l FROM public.engine_table_leases el WHERE el.table_id = p_host_table_id;
  IF NOT FOUND
     OR l.protocol_version IS DISTINCT FROM 2
     OR l.instance_id IS DISTINCT FROM p_lease_instance
     OR l.lease_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_lease_lost');
  END IF;
  IF l.heartbeat_at < clock_timestamp() - make_interval(secs => public.fn_engine_lease_stale_seconds()) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_lease_stale');
  END IF;

  SELECT tb.id, tb.club_id, tb.tournament_id, tb.small_blind, tb.big_blind, tb.max_buy_in,
         tb.game_variant, tb.cluster_id, coalesce(cl.asset, 'chips') AS asset
    INTO t FROM public.tables tb LEFT JOIN public.clubs cl ON cl.id = tb.club_id
   WHERE tb.id = p_host_table_id;
  IF NOT FOUND OR t.cluster_id IS DISTINCT FROM h.cluster_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'host_table_not_in_cluster');
  END IF;
  IF t.tournament_id IS NOT NULL OR t.club_id IS NULL OR t.asset IS DISTINCT FROM 'chips' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'host_table_cannot_record_a_chip_cash_hand');
  END IF;

  -- 3. EVERY PARTICIPANT, NAMED ONCE, with the result the engine reports.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id', hp.player_id, 'pool_slot_id', hp.pool_slot_id,
           'pool_session_id', sl.pool_session_id, 'anchor_seat_id', ps.anchor_seat_id,
           'seat', hp.seat, 'stack_before', hp.stack_before,
           'recorded_fold', hp.fold_type, 'folded_at', hp.folded_at,
           'committed_at_fold', hp.committed_at_fold,
           'stack_after', rr.r -> 'stack_after', 'contributed', rr.r -> 'contributed',
           'won', rr.r -> 'won', 'fold_type', rr.r -> 'fold_type', 'showed', rr.r -> 'showed',
           'has_result', rr.r IS NOT NULL) ORDER BY hp.player_id),
         count(*)
    INTO v_p, v_n
    FROM public.lightning_hand_player hp
    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
    JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
    LEFT JOIN LATERAL (SELECT x AS r FROM jsonb_array_elements(v_results) x
                        WHERE (x ->> 'player_id')::uuid = hp.player_id) rr ON true
   WHERE hp.hand_id = p_hand_id;
  IF coalesce(v_n, 0) < 2
     OR v_n IS DISTINCT FROM jsonb_array_length(v_results)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x WHERE (x ->> 'has_result')::boolean IS DISTINCT FROM true) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'results_do_not_name_every_participant',
                              'participants', v_n, 'results', jsonb_array_length(v_results));
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x
              WHERE x ->> 'recorded_fold' <> 'none' AND x ->> 'fold_type' IS DISTINCT FROM x ->> 'recorded_fold') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'fold_type_disagrees_with_the_recorded_fold');
  END IF;

  -- 4. THE MONEY. Any disagreement is an impossible state: the Cluster
  --    freezes and the hand is answered frozen, never raised (a raise would
  --    roll the freeze back with it).
  SELECT sum((x ->> 'stack_before')::numeric), sum((x ->> 'stack_after')::numeric)
    INTO v_before, v_after FROM jsonb_array_elements(v_p) x;
  v_why := CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x WHERE jsonb_typeof(x -> 'stack_before') IS DISTINCT FROM 'number')
      THEN 'stack_before_missing'
    WHEN round(v_before, 2) IS DISTINCT FROM round(v_after + v_rake + v_bbj, 2)
      THEN 'conservation'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x
                  WHERE jsonb_typeof(x -> 'committed_at_fold') = 'number'
                    AND (x ->> 'stack_after')::numeric
                        IS DISTINCT FROM (x ->> 'stack_before')::numeric - (x ->> 'committed_at_fold')::numeric)
      THEN 'fold_commitment'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x
                  WHERE x ->> 'recorded_fold' IN ('fast', 'normal')
                    AND (x ->> 'stack_after')::numeric > (x ->> 'stack_before')::numeric)
      THEN 'released_folder_gained'
  END;
  IF v_why IS NOT NULL THEN
    RETURN public.fn_lightning_settlement_freeze(h.cluster_id, h.cluster_epoch, p_hand_id, i.id, p_request_id, v_why,
      jsonb_build_object('stack_before_total', v_before, 'stack_after_total', v_after,
                         'rake', v_rake, 'bbj', v_bbj, 'participants', v_p));
  END IF;

  BEGIN
    -- 5. THE ANCHORS, FOR UPDATE, IN PLAYER ORDER, each named in the marker
    --    for this transaction. Anchors before pool slots and sessions: the
    --    formation barrier's own order.
    FOR a IN SELECT (x ->> 'player_id')::uuid AS player_id, (x ->> 'anchor_seat_id')::uuid AS seat_id,
                    round((x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric, 2) AS delta,
                    x AS item
               FROM jsonb_array_elements(v_p) x
              ORDER BY (x ->> 'player_id')::uuid LOOP
      SELECT ts.id, ts.table_id, ts.user_id, ts.left_at, ts.joined_at, ts.stack,
             ts.time_bank_uses_remaining, ts.time_bank_remaining
        INTO s FROM public.table_seats ts WHERE ts.id = a.seat_id FOR UPDATE;
      IF NOT FOUND OR s.left_at IS NOT NULL OR s.user_id IS DISTINCT FROM a.player_id OR s.joined_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'PLT04', MESSAGE = 'anchor_not_live',
          DETAIL = jsonb_build_object('player_id', a.player_id, 'seat_id', a.seat_id)::text;
      END IF;
      IF coalesce(s.stack, 0) + a.delta < 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'PLT04', MESSAGE = 'anchor_would_go_negative',
          DETAIL = jsonb_build_object('player_id', a.player_id, 'seat_id', a.seat_id,
                                      'stack', s.stack, 'delta', a.delta)::text;
      END IF;
      INSERT INTO public.lightning_settlement_marker
        (txid, seat_id, anchor_table_id, player_id, hand_id, host_table_id, hand_number)
      VALUES (pg_current_xact_id(), s.id, s.table_id, a.player_id, p_hand_id, p_host_table_id, h.hand_number);
      v_stacks := v_stacks || jsonb_build_array(jsonb_build_object(
        'user_id', a.player_id, 'seat_id', s.id, 'seat_joined_at', to_jsonb(s.joined_at) #>> '{}',
        'stack', a.item -> 'stack_after', 'stack_before', a.item -> 'stack_before'));
      -- The time banks are carried as they stand: a Lightning hand does not
      -- spend the anchor table's bank.
      v_banks := v_banks || jsonb_build_array(jsonb_build_object(
        'user_id', a.player_id, 'seat_id', s.id, 'seat_joined_at', to_jsonb(s.joined_at) #>> '{}',
        'uses_remaining', GREATEST(coalesce(s.time_bank_uses_remaining, 4), 0),
        'seconds_remaining', GREATEST(coalesce(s.time_bank_remaining, 30), 0)));
    END LOOP;

    -- 6. THE PHYSICAL RECORD AND ITS POST-COMMIT ENVELOPE, built exactly as the
    --    engine builds them for a physical hand at the host table.
    SELECT coalesce(jsonb_object_agg(x ->> 'player_id', (x ->> 'contributed')::numeric)
                      FILTER (WHERE (x ->> 'contributed')::numeric > 0), '{}'::jsonb)
      INTO v_contrib FROM jsonb_array_elements(v_p) x;
    SELECT coalesce(jsonb_object_agg(lower(e.key), e.value), '{}'::jsonb)
      INTO v_returned FROM jsonb_each(coalesce(v_row_in -> 'returned_uncalled', '{}'::jsonb)) e;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_returned) k
                WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x WHERE x ->> 'player_id' = k)) THEN
      RAISE EXCEPTION USING ERRCODE = 'PLT03', MESSAGE = 'returned_uncalled_names_a_stranger';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('club_id', t.club_id, 'user_id', e.key, 'wagered', e.value)
                              ORDER BY e.key), '[]'::jsonb)
      INTO v_promo FROM jsonb_each(v_contrib) e;
    v_pot := CASE WHEN jsonb_typeof(v_row_in -> 'pot_size') = 'number' THEN (v_row_in ->> 'pot_size')::numeric
                  ELSE (SELECT coalesce(sum((x ->> 'contributed')::numeric), 0) FROM jsonb_array_elements(v_p) x) END;
    v_bb := CASE WHEN jsonb_typeof(v_row_in -> 'big_blind') = 'number' AND (v_row_in ->> 'big_blind')::numeric > 0
                 THEN (v_row_in ->> 'big_blind')::numeric ELSE t.big_blind END;
    v_sb := CASE WHEN jsonb_typeof(v_row_in -> 'small_blind') = 'number'
                 THEN (v_row_in ->> 'small_blind')::numeric ELSE t.small_blind END;
    v_max_buy := round(coalesce(nullif(t.max_buy_in, 0), coalesce(v_bb, 2) * 200), 2);
    v_players := CASE WHEN jsonb_typeof(v_row_in -> 'players') = 'array' THEN v_row_in -> 'players'
                      ELSE (SELECT jsonb_agg(jsonb_build_object('userId', x ->> 'player_id', 'seat', (x ->> 'seat')::integer,
                                                                'stack', x -> 'stack_after') ORDER BY (x ->> 'seat')::integer)
                              FROM jsonb_array_elements(v_p) x) END;
    v_row := (v_row_in - ARRAY['id', 'created_at', 'reported', 'reported_at', '_accepted_post_commit_facts',
                               'returned_uncalled', 'table_id', 'hand_number', 'tournament_id'])
             || jsonb_build_object(
                  'table_id', p_host_table_id, 'hand_number', h.hand_number, 'tournament_id', NULL,
                  'pot_size', v_pot, 'big_blind', v_bb, 'small_blind', v_sb,
                  'game_variant', coalesce(v_row_in ->> 'game_variant', t.game_variant, 'nlh'),
                  'rake_amount', v_rake, 'bbj_amount', v_bbj,
                  'started_at', coalesce(v_row_in -> 'started_at', to_jsonb(i.started_at)),
                  'ended_at', coalesce(v_row_in -> 'ended_at', to_jsonb(v_now)),
                  'players', v_players,
                  '_accepted_post_commit_facts', jsonb_build_object(
                    'contributions', v_contrib, 'returned_uncalled', v_returned, 'insurance', '[]'::jsonb));
    v_env := jsonb_build_object(
      'version', 1,
      'time_banks', v_banks,
      'rake', CASE WHEN v_rake > 0 THEN jsonb_build_object(
                'club_id', t.club_id, 'amount', v_rake, 'bbj', v_bbj, 'pot', v_pot,
                'num_players', (SELECT count(*) FROM jsonb_object_keys(v_contrib)),
                'contributions', v_contrib, 'returned_uncalled', v_returned,
                'tournament_id', NULL, 'method', 'WEIGHTED_CONTRIBUTED') ELSE 'null'::jsonb END,
      'bbj_contribution', CASE WHEN v_bbj > 0 THEN jsonb_build_object(
                'club_id', t.club_id, 'amount', v_bbj, 'big_blind', v_bb) ELSE 'null'::jsonb END,
      'promo_playthrough', v_promo,
      'insurance', '[]'::jsonb,
      'pending_addons', jsonb_build_object('enabled', true, 'max_buy_in', v_max_buy));

    -- THE UNCHANGED PHYSICAL DOOR: lease fence, idempotency key, ca_settlements,
    -- the delta-mode stack write and its conservation identity (through the
    -- adapter, at each anchor), hand_history, hand_projection_outbox,
    -- hand_atomic_commits with the envelope, the provenance receipt.
    v_res := public.fn_ca_commit_hand_settlement(
      p_host_table_id, h.hand_number, v_stacks, v_rake, v_bbj, 'lightning:' || p_hand_id::text,
      0::numeric, v_row, '[]'::jsonb, p_lease_instance, p_lease_generation, v_env);
    IF coalesce((v_res ->> 'replay')::boolean, false) THEN
      RAISE EXCEPTION USING ERRCODE = 'PLT03', MESSAGE = 'physical_hand_already_committed', DETAIL = v_res::text;
    END IF;
    IF coalesce((v_res ->> 'success')::boolean, false) IS NOT TRUE
       OR coalesce((v_res ->> 'atomic_hand_commit')::boolean, false) IS NOT TRUE
       OR coalesce((v_res ->> 'post_commit_obligations')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = 'PLT03', MESSAGE = coalesce(v_res ->> 'reason', 'physical_settlement_refused'),
        DETAIL = v_res::text;
    END IF;
    v_hh := (v_res ->> 'history_id')::uuid;
    DELETE FROM public.lightning_settlement_marker m WHERE m.txid = pg_current_xact_id();

    -- 7. THE LIGHTNING RECORD.
    UPDATE public.lightning_hand_player hp
       SET stack_after = (x ->> 'stack_after')::numeric,
           net_result = (x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric,
           fold_type = CASE WHEN hp.fold_type = 'none' THEN x ->> 'fold_type' ELSE hp.fold_type END,
           folded_at = CASE WHEN hp.folded_at IS NULL AND x ->> 'fold_type' <> 'none' THEN v_now ELSE hp.folded_at END
      FROM jsonb_array_elements(v_p) x
     WHERE hp.hand_id = p_hand_id AND hp.player_id = (x ->> 'player_id')::uuid;

    UPDATE public.lightning_pool_session ps
       SET hands = ps.hands + 1,
           fast_folds = ps.fast_folds + (q.fold = 'fast')::integer,
           normal_folds = ps.normal_folds + (q.fold = 'normal')::integer,
           fold_and_watch = ps.fold_and_watch + (q.fold = 'fold_watch')::integer,
           showdowns = ps.showdowns + q.showed::integer,
           net_result = ps.net_result + q.net,
           updated_at = clock_timestamp()
      FROM (SELECT (x ->> 'pool_session_id')::uuid AS sid, x ->> 'fold_type' AS fold,
                   (x ->> 'showed')::boolean AS showed,
                   (x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric AS net
              FROM jsonb_array_elements(v_p) x) q
     WHERE ps.id = q.sid;
    UPDATE public.lightning_pool_slot sl
       SET hands = sl.hands + 1,
           fast_folds = sl.fast_folds + (q.fold = 'fast')::integer,
           normal_folds = sl.normal_folds + (q.fold = 'normal')::integer,
           fold_and_watch = sl.fold_and_watch + (q.fold = 'fold_watch')::integer,
           showdowns = sl.showdowns + q.showed::integer,
           updated_at = clock_timestamp()
      FROM (SELECT (x ->> 'pool_slot_id')::uuid AS slot_id, x ->> 'fold_type' AS fold,
                   (x ->> 'showed')::boolean AS showed
              FROM jsonb_array_elements(v_p) x) q
     WHERE sl.id = q.slot_id;

    SELECT jsonb_object_agg(x ->> 'player_id',
                            round((x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric, 2))
      INTO v_deltas FROM jsonb_array_elements(v_p) x;
    v_receipt := jsonb_build_object(
      'ok', true, 'hand_id', p_hand_id, 'hand_history_id', v_hh, 'hand_number', h.hand_number,
      'host_table_id', p_host_table_id, 'deltas', v_deltas, 'rake', v_rake, 'bbj', v_bbj,
      'request_id', p_request_id, 'request_hash', v_hash,
      'commit_hash', v_res ->> 'commit_hash', 'post_commit_payload_hash', v_res ->> 'post_commit_payload_hash');
    v_receipt := v_receipt || jsonb_build_object(
      'receipt_hash', encode(sha256(convert_to(v_receipt::text, 'UTF8')), 'hex'));
    UPDATE public.lightning_hand
       SET settled_at = v_now, settle_request_id = p_request_id, settle_request_hash = v_hash,
           hand_history_id = v_hh, settle_receipt = v_receipt
     WHERE hand_id = p_hand_id;

    -- dealing -> settling -> complete, through the discipline trigger; the
    -- release trigger hands back every reservation still held (the players
    -- who played on, and fold-and-watch) and emits instance_completed.
    UPDATE public.lightning_instance SET state = 'settling' WHERE id = i.id;
    UPDATE public.lightning_instance
       SET state = 'complete', completed_at = GREATEST(clock_timestamp(), i.started_at)
     WHERE id = i.id;

    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (h.cluster_id, 'hand_settled', jsonb_build_object(
      'cluster_id', h.cluster_id, 'cluster_epoch', h.cluster_epoch, 'hand_id', p_hand_id,
      'hand_number', h.hand_number, 'host_table_id', p_host_table_id, 'hand_history_id', v_hh,
      'deltas', v_deltas, 'rake', v_rake, 'bbj', v_bbj, 'players', v_n, 'at', v_now),
      h.cluster_epoch, p_request_id);
  EXCEPTION
    WHEN SQLSTATE 'PLT03' THEN
      -- A definite refusal by the physical path: everything since the block
      -- opened, the marker included, is rolled back and nothing moved.
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      RETURN jsonb_build_object('ok', false, 'reason', v_msg,
                                'detail', CASE WHEN pg_input_is_valid(v_detail, 'jsonb') THEN v_detail::jsonb END);
    WHEN SQLSTATE 'PLT04' THEN
      -- An anchor the guard should have held is not where the hand left it.
      -- The block is rolled back and its seat locks released before the
      -- Cluster freezes.
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      RETURN public.fn_lightning_settlement_freeze(h.cluster_id, h.cluster_epoch, p_hand_id, i.id, p_request_id, v_msg,
        CASE WHEN pg_input_is_valid(v_detail, 'jsonb') THEN v_detail::jsonb END);
    WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg LIKE 'atomic hand commit refused%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'physical_settlement_refused', 'detail', to_jsonb(v_msg));
      END IF;
      RAISE;
  END;

  RETURN v_receipt;
END
$function$;

-- 5e. THE PLAYER'S OWN SESSION.
CREATE OR REPLACE FUNCTION public.fn_lightning_my_session(p_cluster_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  s      record;
  v_hand uuid;
BEGIN
  IF v_uid IS NULL OR p_cluster_id IS NULL THEN
    RETURN jsonb_build_object('pool_session_id', NULL);
  END IF;
  SELECT ps.id, ps.state, cg.cluster_mode
    INTO s
    FROM public.lightning_pool_session ps
    JOIN public.cash_games cg ON cg.id = ps.cluster_id
   WHERE ps.player_id = v_uid AND ps.cluster_id = p_cluster_id AND ps.exited_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('pool_session_id', NULL);
  END IF;
  -- The hand the caller is playing: one they hold a committed reservation in.
  -- A fast or normal fold released it, so the next hand is the one shown.
  SELECT i.hand_id INTO v_hand
    FROM public.lightning_reservation r
    JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
   WHERE r.cluster_id = p_cluster_id AND r.player_id = v_uid AND r.state = 'committed'
     AND i.state IN ('reserved', 'dealing', 'settling') AND i.hand_id IS NOT NULL
   ORDER BY i.created_at DESC, i.id
   LIMIT 1;
  RETURN jsonb_build_object('pool_session_id', s.id, 'state', s.state, 'cluster_mode', s.cluster_mode,
                            'stack', public.fn_lightning_pool_stack(s.id),
                            'in_hand', v_hand IS NOT NULL)
         || CASE WHEN v_hand IS NOT NULL THEN jsonb_build_object('hand_id', v_hand) ELSE '{}'::jsonb END;
END
$function$;

-- 5f. WHO MAY WATCH A ROOM.
CREATE OR REPLACE FUNCTION public.fn_lightning_hand_view_access(p_pool_session_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_pool_session_id IS NOT NULL AND p_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                  WHERE ps.id = p_pool_session_id AND ps.player_id = p_user_id AND ps.exited_at IS NULL);
$function$;

COMMENT ON FUNCTION public.fn_lightning_bind_hand_number(uuid, bigint) IS
  'Lightning Phase 6. Binds the global hand number (fn_next_hand_number) and the Cluster''s front table to a dealing hand, once; the same number again answers the same receipt, any other is refused. Answers {ok, hand_id, hand_number, host_table_id}. service_role only.';
COMMENT ON FUNCTION public.fn_lightning_fast_fold(uuid, uuid, uuid, text, numeric) IS
  'Lightning Phase 6. Records a fold of a dealing hand, idempotent on (hand, player). fast and normal release that player''s committed reservation at once (idle_since is stamped, the matcher may deal them again); fold_watch keeps it until the hand ends. p_committed is the chips the player put in the pot; while the hand is live it is held out of the next hand''s stack (all of stack_before when it is NULL). Moves no money. Emits fast_fold, normal_fold or fold_and_watch. service_role only.';
COMMENT ON FUNCTION public.fn_lightning_settle_hand(uuid, uuid, uuid, text, uuid, jsonb, numeric, numeric, jsonb) IS
  'Lightning Phase 6. Settles a dealing hand in one transaction through the physical door fn_ca_commit_hand_settlement at the bound host table and hand number, applying stack_after - stack_before to each anchor seat under the settlement marker; conservation sum(stack_before) = sum(stack_after) + rake + bbj or the Cluster freezes. Idempotent on the request hash; refuses an abandoned instance and a stale host lease. Answers {ok, hand_id, hand_history_id, hand_number, deltas, receipt_hash}. The caller then runs fn_ca_process_hand_post_commit_obligations(hand_history_id). SECURITY DEFINER, service_role only.';
COMMENT ON FUNCTION public.fn_lightning_my_session(uuid) IS
  'Lightning Phase 6. The calling player''s (auth.uid()) open pool session in the Cluster: {pool_session_id, state, cluster_mode, stack, in_hand, hand_id?}, or {pool_session_id: null}. Never an instance id. SECURITY DEFINER, authenticated.';
COMMENT ON FUNCTION public.fn_lightning_hand_view_access(uuid, uuid) IS
  'Lightning Phase 6. True iff the user owns that open pool session: who may be admitted to a Lightning room. service_role only.';
COMMENT ON FUNCTION public.fn_lightning_pool_exposure(uuid, uuid) IS
  'Lightning Phase 6. The chips a player has in live hands of the Cluster they were released from by a fast or normal fold (committed_at_fold, or stack_before when the fold did not say). fn_lightning_pool_stack subtracts it.';
COMMENT ON FUNCTION public.fn_lightning_player_live_hand(uuid, uuid) IS
  'Lightning Phase 6. The newest live hand holding the player''s anchor: a committed reservation, or participation in a hand they folded out of. The anchor guard holds the seat while it is not NULL.';
COMMENT ON FUNCTION public.fn_lightning_settlement_seats(uuid, bigint) IS
  'Lightning Phase 6. {player: anchor table} for the anchors a Lightning settlement in the current transaction names for (table, hand number); ''{}'' otherwise. Read once per call by fn_ca_settle_hand_stacks_absolute and fn_ca_commit_hand_settlement. service_role, never a browser.';
COMMENT ON FUNCTION public.fn_lightning_settlement_freeze(uuid, integer, uuid, uuid, uuid, text, jsonb) IS
  'Lightning Phase 6. The settlement''s freeze path: Cluster to frozen, a critical alert, stack_invariant_failed and cluster_frozen. service_role, never a browser.';

-- ===========================================================================
-- 6. GRANTS. Supabase grants anon and authenticated explicitly by default, so
--    each is revoked by name.
-- ===========================================================================
REVOKE ALL ON FUNCTION public.fn_lightning_bind_hand_number(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_bind_hand_number(uuid, bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_fast_fold(uuid, uuid, uuid, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_fast_fold(uuid, uuid, uuid, text, numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_settle_hand(uuid, uuid, uuid, text, uuid, jsonb, numeric, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_settle_hand(uuid, uuid, uuid, text, uuid, jsonb, numeric, numeric, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_hand_view_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_hand_view_access(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_exposure(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_exposure(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_player_live_hand(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_player_live_hand(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_my_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_my_session(uuid) TO authenticated, service_role;
-- The marker reader answers only for the caller's own transaction, and the
-- freeze is what service_role can already do to cash_games directly; both
-- stay inside the Lightning family's rule that service_role executes every
-- fn_lightning_ function and no browser role does.
REVOKE ALL ON FUNCTION public.fn_lightning_settlement_seats(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_settlement_seats(uuid, bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_settlement_freeze(uuid, integer, uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_settlement_freeze(uuid, integer, uuid, uuid, uuid, text, jsonb) TO service_role;

-- ===========================================================================
-- 7. READ BACK.
-- ===========================================================================
DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('nine columns', (SELECT count(*) = 9 FROM pg_attribute a WHERE NOT a.attisdropped
       AND ((a.attrelid = 'public.lightning_hand'::regclass AND a.attname IN ('hand_number', 'host_table_id', 'settle_request_id', 'settle_request_hash', 'hand_history_id', 'settle_receipt'))
         OR (a.attrelid = 'public.lightning_hand_player'::regclass AND a.attname IN ('net_result', 'folded_at', 'committed_at_fold'))))),
    ('five constraints', (SELECT count(*) = 5 FROM pg_constraint c WHERE c.conname IN ('lightning_hand_number_in_range',
       'lightning_hand_binds_number_and_host_together', 'lightning_hand_settlement_is_whole',
       'lightning_hand_player_fold_is_dated', 'lightning_hand_player_commitment_is_a_fold'))),
    ('the hand number index', to_regclass('public.lightning_hand_one_per_hand_number') IS NOT NULL),
    ('the marker is nobody''s', (SELECT c.relrowsecurity AND NOT has_table_privilege('service_role', c.oid, 'INSERT')
       AND NOT has_table_privilege('service_role', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
       FROM pg_class c WHERE c.oid = 'public.lightning_settlement_marker'::regclass)),
    ('service_role doors', (SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'))
       FROM unnest(ARRAY['public.fn_lightning_bind_hand_number(uuid,bigint)', 'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)',
                         'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)',
                         'public.fn_lightning_hand_view_access(uuid,uuid)', 'public.fn_lightning_pool_exposure(uuid,uuid)',
                         'public.fn_lightning_player_live_hand(uuid,uuid)']) f)),
    ('the browser door', (SELECT p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = 'public.fn_lightning_my_session(uuid)'::regprocedure)),
    ('service_role definers', (SELECT bool_and(p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
       FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_settlement_seats(uuid,bigint)'::regprocedure,
                                      'public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)'::regprocedure))),
    ('pinned search paths', (SELECT bool_and(p.proconfig IS NOT NULL AND p.proconfig::text ~ 'search_path')
       FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_bind_hand_number(uuid,bigint)'::regprocedure,
         'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure,
         'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure,
         'public.fn_lightning_my_session(uuid)'::regprocedure, 'public.fn_lightning_hand_view_access(uuid,uuid)'::regprocedure,
         'public.fn_lightning_settlement_seats(uuid,bigint)'::regprocedure,
         'public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)'::regprocedure))),
    ('the guard note', (SELECT d.note ~ 'lightning_settlement_marker' FROM public.ca_declared_money_triggers d
       WHERE d.table_name = 'table_seats' AND d.trigger_name = 'trg_table_seats_lightning_anchor_guard'))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_PHASE_6_SETTLEMENT_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
