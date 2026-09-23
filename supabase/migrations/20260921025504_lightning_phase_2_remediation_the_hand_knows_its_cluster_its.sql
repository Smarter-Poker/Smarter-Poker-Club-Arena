-- 20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0 - PHASE 2 REMEDIATION. An adversarial audit of the merged
-- 20260920235343 found two holes that a schema phase exists to close and did
-- not. Both are cheap to close right now for one reason and it will not last:
-- all seven Lightning relations are EMPTY (verified 2026-09-21 02:57 UTC:
-- 0 / 0 / 0 / 0 / 0 / 0 / 0 rows), so every ALTER below is a catalogue edit
-- with no rewrite and no validation scan. After the first Lightning hand is
-- dealt the same repair needs a backfill and a maintenance window.
--
-- HOLE 1: THE HAND FAMILY IS JOINED TO NOTHING.
--
-- 20260920235343 wrote two foreign keys, both in the pool family
-- (slot -> session, reservation -> slot), and its own commentary states the
-- principle they encode: "each level exposes (id, player_id, cluster_id) as a
-- unique key and the level below references all three columns together. The
-- database then refuses a child whose idea of the human or the cluster differs
-- from its parent's." The instance / hand / hand_player family got the
-- columns and none of the keys. Measured consequences, each demonstrated
-- against a throwaway PostgreSQL 17 backend carrying that migration:
--
--   * lightning_hand.cluster_id and .cluster_epoch could disagree with the
--     lightning_instance the same row names. A hand could claim to be in
--     cluster A epoch 4 while its instance was in cluster B epoch 1, and the
--     history reader that groups by (cluster_id, cluster_epoch) - the
--     lightning_hand_by_cluster_epoch index exists for exactly that read -
--     would put it under the wrong seating regime forever.
--   * lightning_hand.lightning_instance_id is NOT NULL and referenced nothing.
--     A hand could name an instance that does not exist.
--   * lightning_hand_player.pool_slot_id is NOT NULL and referenced nothing,
--     so a participation row could point at ANOTHER PLAYER'S table. Every
--     per-table statistic reads lightning_hand_player_by_pool_slot; the
--     column exists, in that migration's own words, so that "per-table
--     statistics could [be] reconstructed", and nothing made the slot the
--     player's own.
--   * lightning_hand_player.hand_id is NOT NULL and referenced nothing. A
--     participation row could outlive, or precede, any hand.
--
-- The fix carries the SAME principle one level further rather than inventing a
-- second one: every level exposes its identity as a real UNIQUE constraint and
-- the level below references the whole tuple.
--
-- HOLE 2: cluster_epoch HAD NO AUTHORITY.
--
-- Six relations carry a cluster_epoch. Nothing said what an epoch IS, nothing
-- said which epochs exist, and nothing tied a Lightning row's epoch to its
-- cluster's. cash_games.cluster_epoch is a single mutable integer: the moment
-- Phase 5 bumps it, every row written under the old value is unanchored and
-- unrecoverable, because the only record that the old epoch ever existed was
-- the integer that just changed.
--
-- So the epoch becomes a ROW. public.cash_cluster_epoch is append-only
-- history: one row per (cluster, epoch), the mode it ran under, when it
-- started and when it ended. cash_games.cluster_epoch stays exactly what it is
-- - the pointer to the current one - and this table is what it points AT.
--
-- WHY NOT FOREIGN-KEY THE LIGHTNING ROWS TO cash_games (id, cluster_epoch)
-- DIRECTLY. That was the first draft and it is wrong. cash_games.cluster_epoch
-- is mutable by design; a foreign key onto it would refuse Phase 5's bump for
-- as long as any historical Lightning row still named the old value, which is
-- forever, because history is never deleted. An epoch row is never deleted and
-- never renumbered, so it can be referenced safely.
--
-- HOLE 2b: THE EVENT LEDGER'S DEFAULT WAS ABOUT TO BECOME A LIE.
--
-- 20260920235343 gave cash_cluster_events.cluster_epoch DEFAULT 0 so that all
-- of the existing insert shapes kept compiling. That is right today, when
-- every cluster is at epoch 0, and wrong on the first bump: 33 insert sites
-- across the estate name no epoch, and each one would silently file its event
-- under the genesis epoch of a cluster that had moved on. A DEFAULT cannot
-- read another row, so the fill happens in a BEFORE INSERT trigger instead,
-- and it is deliberately narrow: it only supplies the cluster's current epoch
-- when the row arrives carrying 0 and the cluster is NOT at 0. An author who
-- names an epoch explicitly is obeyed.
--
-- WHAT THIS DOES NOT DO, STATED SO IT IS NOT MISTAKEN FOR DONE.
--
--   * The FORMATION BARRIER is not enforced here and cannot be. "A committed
--     hand has at least two players" and "no seat exceeds its instance's
--     max_size" are statements about a SET of rows, which no CHECK constraint
--     can see. They belong to the formation function of spec Phase 9 (build
--     phase 5), which is the only writer that will ever see the whole set at
--     once. What this migration does is make that function's job possible:
--     after it, a hand cannot be formed in a cluster its instance is not in,
--     and a seat cannot be filled by a player who is not at that table.
--     tests/lightning-phase-2-domain.test.ts carried a case named "locks the
--     participant set of a committed hand" that asserted only the primary key
--     and the unique-seat index; it is renamed there in this change, because a
--     test that claims a barrier it does not test is worse than no test.
--   * lightning_blind_ledger is deliberately left without an epoch. A blind
--     obligation is owed by a human to a Cluster and survives a change of
--     seating regime; keying it by epoch would forgive every debt at
--     conversion, which is the opposite of what the ledger is for.
--
-- SUPERSEDES ONE PROOF LINE ON 20260920235343. That file's eighth @live-proof
-- reads `array_length(c.conkey, 1) = 3` over the two pool-family foreign keys.
-- After this migration both are four-column keys and that line is false.
-- Migration files are immutable, so it is not edited; it is superseded here
-- and in a dated Correction in docs/changelog/2026-09-21-lightning-phase-2-
-- domain-extensions.md. The proofs below state the new truth.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT to_regclass('public.cash_cluster_epoch') IS NOT NULL)
-- @live-proof: (SELECT count(*) = (SELECT count(*) FROM public.cash_games) FROM public.cash_cluster_epoch WHERE epoch = 0)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id AND e.epoch = g.cluster_epoch AND e.ended_at IS NULL)))
-- @live-proof: (SELECT to_regclass('public.cash_cluster_epoch_current') IS NOT NULL)
-- @live-proof: (SELECT count(*) = 3 FROM pg_constraint c WHERE c.contype = 'f' AND c.conname IN ('lightning_pool_slot_belongs_to_its_session','lightning_reservation_belongs_to_its_slot','lightning_hand_player_sits_in_its_own_slot') AND array_length(c.conkey, 1) = 4)
-- @live-proof: (SELECT count(*) = 2 FROM pg_constraint c WHERE c.contype = 'f' AND c.conname IN ('lightning_hand_belongs_to_its_instance','lightning_hand_player_belongs_to_its_hand') AND array_length(c.conkey, 1) = 3)
-- @live-proof: (SELECT count(*) = 8 FROM information_schema.referential_constraints WHERE constraint_schema = 'public' AND constraint_name IN ('lightning_pool_slot_belongs_to_its_session','lightning_reservation_belongs_to_its_slot','lightning_hand_belongs_to_its_instance','lightning_hand_player_belongs_to_its_hand','lightning_hand_player_sits_in_its_own_slot','lightning_pool_session_runs_in_a_declared_epoch','lightning_instance_runs_in_a_declared_epoch','cash_cluster_epoch_belongs_to_a_cluster') AND unique_constraint_name IS NOT NULL)
-- @live-proof: (SELECT count(*) = 2 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lightning_hand_player' AND column_name IN ('cluster_id','cluster_epoch'))
-- @live-proof: (SELECT count(*) = 4 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND c.contype = 'u' AND c.conname IN ('lightning_pool_session_identity','lightning_pool_slot_identity','lightning_instance_identity','lightning_hand_identity'))
-- @live-proof: (SELECT bool_and(array_length(c.conkey, 1) = 4) FROM pg_constraint c WHERE c.conname IN ('lightning_pool_session_identity','lightning_pool_slot_identity'))
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cash_cluster_events'::regclass AND tgname = 'trg_cash_cluster_events_take_the_clusters_epoch' AND NOT tgisinternal))
-- @live-proof: (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cash_cluster_epoch')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'cash_cluster_epoch' AND grantee IN ('anon','authenticated','PUBLIC')))

BEGIN;

-- ===========================================================================
-- 0. THE TWO HOT TABLES ARE LOCKED FIRST, IN THE ORDER THE TICK LOCKS THEM
-- ===========================================================================
-- MEASURED, NOT ANTICIPATED. The first attempt at this migration reached
-- section 2 and died:
--
--   ERROR: deadlock detected
--   Process A waits for AccessExclusiveLock on public.cash_cluster_events;
--     blocked by process B.
--   Process B waits for ShareLock on transaction <A>; blocked by process A.
--
-- The cycle is exact. fn_cash_cluster_tick runs every five seconds for each of
-- 166 clusters and takes its locks in one order: `SELECT * INTO g FROM
-- public.cash_games ... FOR UPDATE` first, an INSERT into
-- public.cash_cluster_events later. This migration took them in the opposite
-- order: the genesis backfill below INSERTs into a table with a foreign key to
-- cash_games, which takes FOR KEY SHARE on all 166 referenced rows, and only
-- afterwards does section 2 ask for the ACCESS EXCLUSIVE lock that DROP
-- TRIGGER needs on cash_cluster_events. A tick that had already written an
-- event and then reached its FOR UPDATE closed the loop.
--
-- So both locks are taken here, before any work, in the tick's own order. Once
-- a transaction holds every lock it will ever need, it cannot be half of a
-- cycle. EXCLUSIVE rather than SHARE ROW EXCLUSIVE on cash_games because the
-- lock that has to be prevented is the tick's `FOR UPDATE`, which needs only
-- table-level ROW SHARE, and SHARE ROW EXCLUSIVE does not conflict with it.
-- EXCLUSIVE does, and still lets every ordinary reader through: a lobby read
-- of cash_games needs ACCESS SHARE and is not blocked.
--
-- lock_timeout bounds the wait. If a tick is mid-flight the migration waits at
-- most eight seconds and then refuses cleanly, having changed nothing, which
-- is a state to re-run from once - never in a retry loop.
SET LOCAL lock_timeout = '8s';
LOCK TABLE public.cash_games IN EXCLUSIVE MODE;
LOCK TABLE public.cash_cluster_events IN ACCESS EXCLUSIVE MODE;

-- ===========================================================================
-- 1. THE EPOCH BECOMES A ROW
-- ===========================================================================
-- An epoch is a period during which one Cluster ran under one seating regime.
-- The specification asks every conversion to record epoch_before and
-- epoch_after, every hand to record its epoch, and the event ledger to emit
-- cluster_epoch_started. None of that is expressible against a single mutable
-- integer, and none of it is this migration's job to emit; what is this
-- migration's job is to make the integer point at something durable.

CREATE TABLE IF NOT EXISTS public.cash_cluster_epoch (
  cluster_id  uuid        NOT NULL,
  epoch       integer     NOT NULL,
  -- The Cluster mode this epoch ran under. Same vocabulary as
  -- cash_games.cluster_mode (20260920172736) and named separately rather than
  -- joined, because the mode of a FINISHED epoch must not change when the
  -- cluster's current mode does.
  mode        text        NOT NULL,
  -- Why this epoch began. 'genesis' is the epoch a cluster is created with;
  -- the conversion reasons arrive with spec Phase 5 and Phase 10. Left as free
  -- text under a NOT NULL rather than a CHECK, so a new conversion reason is
  -- not a migration.
  started_by  text        NOT NULL DEFAULT 'genesis',
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at    timestamptz,
  CONSTRAINT cash_cluster_epoch_pkey PRIMARY KEY (cluster_id, epoch),
  CONSTRAINT cash_cluster_epoch_nonneg CHECK (epoch >= 0),
  CONSTRAINT cash_cluster_epoch_mode_check CHECK (mode IN (
    'created', 'opening', 'must_move', 'pending_on', 'lightning',
    'pending_off', 'draining', 'paused', 'frozen', 'dead')),
  CONSTRAINT cash_cluster_epoch_ends_after_it_starts CHECK (
    ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT cash_cluster_epoch_belongs_to_a_cluster
    FOREIGN KEY (cluster_id) REFERENCES public.cash_games (id) ON DELETE CASCADE
);

-- A cluster has exactly one epoch running at a time. This is the invariant
-- that makes "the current epoch" a question with one answer, and it is what a
-- conversion will contend on: end the old row and insert the new one in the
-- same transaction or neither happens.
CREATE UNIQUE INDEX IF NOT EXISTS cash_cluster_epoch_current
  ON public.cash_cluster_epoch (cluster_id)
  WHERE ended_at IS NULL;

ALTER TABLE public.cash_cluster_epoch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cash_cluster_epoch FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cash_cluster_epoch TO service_role;

COMMENT ON TABLE public.cash_cluster_epoch IS
  'Append-only history of a Cluster''s seating regimes: one row per (cluster, epoch), the mode it ran under, when it started and when it ended. cash_games.cluster_epoch is the pointer to the current one; this is what it points at. Rows are never deleted and never renumbered, which is what makes them safe to reference from Lightning history.';

COMMENT ON COLUMN public.cash_cluster_epoch.started_by IS
  'Why this epoch began: genesis for the epoch a Cluster is created with, and the conversion reason thereafter. Free text under a NOT NULL rather than a CHECK, so a new conversion reason is not a migration.';

-- GENESIS. Every cluster that already exists has been running its one and only
-- epoch since it was created, under whatever mode it is in now. 166 rows at
-- the time of writing; ON CONFLICT DO NOTHING so a re-run is a no-op.
INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
SELECT g.id, g.cluster_epoch, g.cluster_mode, 'genesis', g.created_at
  FROM public.cash_games g
ON CONFLICT (cluster_id, epoch) DO NOTHING;

DO $$
DECLARE v_missing bigint;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.cash_games g
   WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                      WHERE e.cluster_id = g.id AND e.epoch = g.cluster_epoch
                        AND e.ended_at IS NULL);
  IF v_missing IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'the genesis backfill left % cluster(s) whose current epoch has no open row; the foreign keys below would refuse every future Lightning write for them', v_missing;
  END IF;
END $$;

-- ===========================================================================
-- 2. THE EVENT LEDGER TAKES ITS CLUSTER'S EPOCH
-- ===========================================================================
-- DEFAULT 0 is right while every cluster is at 0 and becomes a silent
-- misfiling on the first bump. The trigger is deliberately narrow: it supplies
-- the cluster's current epoch ONLY when the row arrives carrying 0 and the
-- cluster is not at 0. An author who names an epoch is obeyed, including an
-- author who deliberately names 0 on a cluster still at 0.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_event_takes_the_clusters_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_epoch integer;
BEGIN
  IF NEW.cluster_epoch IS DISTINCT FROM 0 THEN
    RETURN NEW;
  END IF;
  SELECT g.cluster_epoch INTO v_epoch FROM public.cash_games g WHERE g.id = NEW.game_id;
  IF v_epoch IS NOT NULL AND v_epoch <> 0 THEN
    NEW.cluster_epoch := v_epoch;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_event_takes_the_clusters_epoch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_cash_cluster_events_take_the_clusters_epoch ON public.cash_cluster_events;
CREATE TRIGGER trg_cash_cluster_events_take_the_clusters_epoch
  BEFORE INSERT ON public.cash_cluster_events
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_cash_cluster_event_takes_the_clusters_epoch();

COMMENT ON FUNCTION public.fn_cash_cluster_event_takes_the_clusters_epoch() IS
  'Fills cash_cluster_events.cluster_epoch from the event''s own cluster when the row arrives at the column default of 0 and the cluster has moved past 0. 33 insert sites across the estate name no epoch; without this each one files its event under a genesis epoch the cluster has left.';

-- ===========================================================================
-- 3. THE EPOCH JOINS THE IDENTITY TUPLE
-- ===========================================================================
-- 20260920235343 stated the principle - each level exposes its identity as a
-- unique key and the level below references the whole tuple - and stopped the
-- tuple at (id, player_id, cluster_id). A slot under a session from a
-- different epoch satisfied every one of those keys. The epoch joins them.
--
-- ORDER MATTERS: a UNIQUE constraint that is a foreign key's target cannot be
-- dropped while the key exists, so each child key comes off before its
-- parent's identity is rebuilt, and goes back on after.

-- EVERY CHILD KEY COMES OFF FIRST - INCLUDING THE THREE THIS FILE ITSELF ADDS
-- IN SECTION 4. The first draft dropped only the two keys 20260920235343 wrote,
-- which is enough for a first application and not for a second: on the re-run,
-- lightning_pool_slot_identity is the target of the
-- lightning_hand_player_sits_in_its_own_slot key that section 4 added on the
-- first run, and PostgreSQL refuses to drop a unique constraint an existing
-- foreign key depends on. The same was true of lightning_instance_identity
-- (depended on by lightning_hand_belongs_to_its_instance) and of
-- lightning_hand_identity (depended on by lightning_hand_player_belongs_to_its_hand).
-- A migration that cannot be applied twice cannot be re-applied after a partial
-- failure, so the drops are gathered here, children before parents, and the
-- per-statement DROP IF EXISTS lines further down are left in place as no-ops
-- that keep each ADD self-contained.
ALTER TABLE public.lightning_hand_player
  DROP CONSTRAINT IF EXISTS lightning_hand_player_sits_in_its_own_slot;
ALTER TABLE public.lightning_hand_player
  DROP CONSTRAINT IF EXISTS lightning_hand_player_belongs_to_its_hand;
ALTER TABLE public.lightning_hand
  DROP CONSTRAINT IF EXISTS lightning_hand_belongs_to_its_instance;
ALTER TABLE public.lightning_reservation
  DROP CONSTRAINT IF EXISTS lightning_reservation_belongs_to_its_slot;
ALTER TABLE public.lightning_pool_slot
  DROP CONSTRAINT IF EXISTS lightning_pool_slot_belongs_to_its_session;

ALTER TABLE public.lightning_hand
  DROP CONSTRAINT IF EXISTS lightning_hand_identity;
ALTER TABLE public.lightning_instance
  DROP CONSTRAINT IF EXISTS lightning_instance_identity;
ALTER TABLE public.lightning_pool_slot
  DROP CONSTRAINT IF EXISTS lightning_pool_slot_identity;
ALTER TABLE public.lightning_pool_session
  DROP CONSTRAINT IF EXISTS lightning_pool_session_identity;

ALTER TABLE public.lightning_pool_session
  ADD CONSTRAINT lightning_pool_session_identity
  UNIQUE (id, player_id, cluster_id, cluster_epoch);

ALTER TABLE public.lightning_pool_slot
  ADD CONSTRAINT lightning_pool_slot_belongs_to_its_session
  FOREIGN KEY (pool_session_id, player_id, cluster_id, cluster_epoch)
  REFERENCES public.lightning_pool_session (id, player_id, cluster_id, cluster_epoch)
  ON DELETE RESTRICT;

ALTER TABLE public.lightning_pool_slot
  ADD CONSTRAINT lightning_pool_slot_identity
  UNIQUE (id, player_id, cluster_id, cluster_epoch);

ALTER TABLE public.lightning_reservation
  ADD CONSTRAINT lightning_reservation_belongs_to_its_slot
  FOREIGN KEY (pool_slot_id, player_id, cluster_id, cluster_epoch)
  REFERENCES public.lightning_pool_slot (id, player_id, cluster_id, cluster_epoch)
  ON DELETE CASCADE;

-- The two roots of the two families answer to the epoch history directly.
-- Everything below them inherits it through the keys above and below.
ALTER TABLE public.lightning_pool_session
  DROP CONSTRAINT IF EXISTS lightning_pool_session_runs_in_a_declared_epoch;
ALTER TABLE public.lightning_pool_session
  ADD CONSTRAINT lightning_pool_session_runs_in_a_declared_epoch
  FOREIGN KEY (cluster_id, cluster_epoch)
  REFERENCES public.cash_cluster_epoch (cluster_id, epoch)
  ON DELETE RESTRICT;

ALTER TABLE public.lightning_instance
  DROP CONSTRAINT IF EXISTS lightning_instance_runs_in_a_declared_epoch;
ALTER TABLE public.lightning_instance
  ADD CONSTRAINT lightning_instance_runs_in_a_declared_epoch
  FOREIGN KEY (cluster_id, cluster_epoch)
  REFERENCES public.cash_cluster_epoch (cluster_id, epoch)
  ON DELETE RESTRICT;

-- ===========================================================================
-- 4. THE HAND FAMILY IS JOINED
-- ===========================================================================

-- The instance exposes its identity, the same way the session and the slot do.
ALTER TABLE public.lightning_instance
  DROP CONSTRAINT IF EXISTS lightning_instance_identity;
ALTER TABLE public.lightning_instance
  ADD CONSTRAINT lightning_instance_identity
  UNIQUE (id, cluster_id, cluster_epoch);

-- A hand is IN the cluster and epoch its instance is in. Not "records the
-- same" - cannot differ.
ALTER TABLE public.lightning_hand
  DROP CONSTRAINT IF EXISTS lightning_hand_belongs_to_its_instance;
ALTER TABLE public.lightning_hand
  ADD CONSTRAINT lightning_hand_belongs_to_its_instance
  FOREIGN KEY (lightning_instance_id, cluster_id, cluster_epoch)
  REFERENCES public.lightning_instance (id, cluster_id, cluster_epoch)
  ON DELETE RESTRICT;

-- hand_id is already this table's primary key, so this adds no uniqueness.
-- It exists because a foreign key must name a key over the EXACT tuple it
-- references, and lightning_hand_player references the cluster and the epoch
-- alongside the hand so that its own copies cannot drift from the hand's.
ALTER TABLE public.lightning_hand
  DROP CONSTRAINT IF EXISTS lightning_hand_identity;
ALTER TABLE public.lightning_hand
  ADD CONSTRAINT lightning_hand_identity
  UNIQUE (hand_id, cluster_id, cluster_epoch);

-- lightning_hand_player learns which cluster and epoch it is in, for the same
-- reason lightning_pool_slot carries player_id and cluster_id: so the keys
-- below can be composite, and the database - not the writer - is what makes
-- the copies agree. One ADD COLUMN per ALTER TABLE: the applied-check anchors
-- each column to its own statement.
--
-- The tables are empty, so NOT NULL with no default is free. It is also the
-- right shape: a participation row that cannot say which cluster it is in is
-- the defect being closed, and a default would manufacture an answer.
ALTER TABLE public.lightning_hand_player
  ADD COLUMN IF NOT EXISTS cluster_id uuid NOT NULL;

ALTER TABLE public.lightning_hand_player
  ADD COLUMN IF NOT EXISTS cluster_epoch integer NOT NULL;

ALTER TABLE public.lightning_hand_player
  DROP CONSTRAINT IF EXISTS lightning_hand_player_epoch_nonneg;
ALTER TABLE public.lightning_hand_player
  ADD CONSTRAINT lightning_hand_player_epoch_nonneg CHECK (cluster_epoch >= 0);

-- Half one of the participation's anchoring: the hand exists, and this row is
-- in the same cluster and epoch as it.
ALTER TABLE public.lightning_hand_player
  DROP CONSTRAINT IF EXISTS lightning_hand_player_belongs_to_its_hand;
ALTER TABLE public.lightning_hand_player
  ADD CONSTRAINT lightning_hand_player_belongs_to_its_hand
  FOREIGN KEY (hand_id, cluster_id, cluster_epoch)
  REFERENCES public.lightning_hand (hand_id, cluster_id, cluster_epoch)
  ON DELETE RESTRICT;

-- Half two, and the one the audit found: the table this hand was played at is
-- THIS player's table, in THIS cluster, in THIS epoch. Without it,
-- lightning_hand_player_by_pool_slot - the index every per-table statistic
-- reads - could aggregate one player's hands onto another player's table.
ALTER TABLE public.lightning_hand_player
  DROP CONSTRAINT IF EXISTS lightning_hand_player_sits_in_its_own_slot;
ALTER TABLE public.lightning_hand_player
  ADD CONSTRAINT lightning_hand_player_sits_in_its_own_slot
  FOREIGN KEY (pool_slot_id, player_id, cluster_id, cluster_epoch)
  REFERENCES public.lightning_pool_slot (id, player_id, cluster_id, cluster_epoch)
  ON DELETE RESTRICT;

COMMENT ON TABLE public.lightning_hand_player IS
  'One player''s participation in one Lightning hand, at one of that player''s tables. Keyed to the hand and to the player''s own pool slot by composite foreign keys, so a participation cannot name another player''s table, a hand in another cluster, or an epoch its hand did not run in. The formation barrier itself - at least two players, no seat past the instance''s max_size - is a statement about the whole set and belongs to the formation function of spec Phase 9.';

COMMENT ON COLUMN public.lightning_hand_player.cluster_id IS
  'Denormalised from the hand and from the slot so that both composite foreign keys can key on it. It cannot disagree with either: the database refuses the row.';

COMMENT ON COLUMN public.lightning_hand_player.cluster_epoch IS
  'Denormalised from the hand and from the slot, same reasoning as cluster_id. A participation cannot be filed under a seating regime its hand did not run in.';

-- ===========================================================================
-- 5. THE SMALLER CORRECTIONS
-- ===========================================================================

-- lightning_pool_slot_oldest_bb served (cluster_id, last_bb_at, player_id) and
-- so mixed two seating regimes into one answer. The BB candidate is chosen
-- among the players in the CURRENT epoch; an index that spans epochs offers
-- rows from a regime that has ended. NULLS FIRST is kept and is correct: a
-- slot that has never posted a big blind holds the OLDEST unresolved
-- obligation there is, so it sorts before every timestamp.
DROP INDEX IF EXISTS public.lightning_pool_slot_oldest_bb;
CREATE INDEX IF NOT EXISTS lightning_pool_slot_oldest_bb
  ON public.lightning_pool_slot (cluster_id, cluster_epoch, last_bb_at NULLS FIRST, player_id)
  WHERE closed_at IS NULL;

COMMENT ON INDEX public.lightning_pool_slot_oldest_bb IS
  'The primary big-blind candidate is the eligible player with the oldest unresolved obligation, asked of one Cluster in one epoch. NULLS FIRST because a table that has never posted one is owed longest. Serves ORDER BY last_bb_at NULLS FIRST only; a query written NULLS LAST will not use it, which is intended.';

-- The reservation's own comment described a one-pending-per-PLAYER rule. The
-- index is lightning_reservation_one_pending_per_slot and is per TABLE, which
-- is the whole reason multi-tabling is representable. The comment is corrected
-- to the code.
COMMENT ON TABLE public.lightning_reservation IS
  'A transient claim on one seat in one forming instance, held by one of a player''s tables. One PENDING hold per SLOT, not per player: a Lightning player may legitimately be holding a seat at each of several tables at once, which is what lightning_reservation_one_pending_per_slot allows and lightning_reservation_one_seat_per_player_instance still forbids within any single instance.';

COMMIT;
