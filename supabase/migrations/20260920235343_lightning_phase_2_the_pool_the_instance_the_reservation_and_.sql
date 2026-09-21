-- 20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0, PHASE 2: DOMAIN / DATABASE EXTENSIONS.
-- "Add only missing entities/fields. Do not duplicate existing concepts."
--
-- Phase 1 gave the existing continuous cash session a Cluster. Phase 2 adds the
-- entities the rest of the build needs and nothing else: no matcher (Phase 6),
-- no population predicate (Phase 4), no conversion (Phase 5), no formation
-- (Phase 9). Every relation here is created empty and nothing writes to it yet.
-- That is the point of a schema phase; it is also why every invariant the later
-- phases depend on is encoded as a CONSTRAINT here rather than left to the code
-- that will eventually do the writing.
--
-- WHAT ALREADY EXISTED, AND IS THEREFORE NOT DUPLICATED.
--
-- Reconnaissance against the live catalog and the source established this
-- before a line was written:
--
--   * The continuous economic identity is public.cash_player_session. Phase 2
--     does NOT add stats to it. Its whole purpose is to be one stable row per
--     player per Cluster; a participation period that churns belongs beside it,
--     not inside it.
--   * public.session_history exists but is client-authored and non-authoritative
--     (src/services/SessionStatsService.ts buffers to localStorage and writes one
--     row on leave). It is not a foundation.
--   * public.ca_hand_player_stat and public.ca_hand_facts are per-hand analytics,
--     the wrong grain for a participation period.
--   * public.cash_seat_moves is the precedent for a reservation with a state and
--     an expiry, including its one-pending-per-player partial unique index. Its
--     SHAPE is copied; the table is not extended, because a Lightning
--     reservation reserves a seat in a transient instance, not a move between
--     two physical tables.
--   * Blind debt does NOT persist anywhere today. It lives in engine memory on
--     ServerTableEngineBase (returningFromSitout, postingBBToEnter, waitingForBB,
--     mustPostBB, postBBWhenClear) and is lost on every engine restart. Only the
--     entry hold survives, via table_seats.entry_hold. So there is nothing to
--     extend: the ledger is genuinely new.
--
-- TWO NAME COLLISIONS AVOIDED.
--
--   * `instance_id` is already taken and means something else: it is the ENGINE
--     PROCESS id (engine_table_leases.instance_id text, and the p_instance_id
--     lease fence on fn_ca_commit_hand_settlement). A Lightning column called
--     instance_id would be read as the process id by every existing author.
--     Everything here says lightning_instance_id.
--   * `seat_reservation` is taken by the live-venue Commander module
--     (commander_home_seat_reservations). Different namespace, not reused.
--
-- WHY THE HAND LINKAGE IS A SIDE TABLE AND NOT NEW COLUMNS.
--
-- The specification wants each Lightning hand to record cluster, epoch,
-- instance, pool session, seat, position, blind role, stacks and fold type.
-- The obvious home would be the existing hand tables. Measured:
--   hand_history        2,899,738 rows / 14 GB
--   hand_atomic_commits 2,851,032 rows / 11 GB
--   ca_hand_facts       9,397,778 rows / 8.6 GB
-- All three are on the live per-hand write path. Widening them is a different
-- risk class from creating an empty table, and non-Lightning hands would carry
-- nine permanently NULL columns forever. So Lightning's hand facts live in
-- their own two relations keyed by hand_id, written only for Lightning hands,
-- and the existing settlement path keeps its exact 12-argument signature.
--
-- WHAT IS DELIBERATELY NOT STORED.
--
-- hands_per_hour, average_wait and net_result-per-hour are DERIVED. Storing a
-- derived number is storing a number that can disagree with its inputs. The
-- inputs are stored - entered_at, exited_at, hands, wait_total_ms,
-- wait_samples - and the ratios are computed by whoever asks. p95 and p99 are
-- different: they cannot be recovered from a running total, so they are stored.
--
-- ONE RULE THIS SCHEMA CANNOT HOLD, STATED RATHER THAN ASSUMED. Nothing here
-- stops a hold being issued on a table the player has already closed, or a new
-- table being opened under a participation period that has already exited.
-- Both are cross-row conditions, so neither is expressible as a CHECK, and a
-- trigger that reached across levels on every insert would sit on the matcher's
-- hot path. The one-open indexes stop DUPLICATES while a parent is open; they
-- do not stop CREATION UNDER A CLOSED PARENT. Phase 6's matcher owns that rule
-- inside its own forming transaction, which is where it can be checked once
-- under the lock it already holds. It is written here so that phase inherits a
-- known obligation rather than an assumption. Concretely, Phase 6's own
-- harness owes two named checks - no pending hold against a closed slot, and
-- no slot opened under an exited session - because an obligation written in a
-- comment is an assumption with better manners. The exposure meanwhile is
-- bounded rather than open-ended: a stray hold expires within
-- expires_at - created_at, and lightning_reservation_pending_by_expiry already
-- exists for the sweep that collects it.
--
-- NO FOREIGN KEYS TO ANY EXISTING TABLE. Phase 1's reasoning applies unchanged:
-- this estate has already lost ~3.5 minutes of Postgres to an FK taking SHARE
-- ROW EXCLUSIVE for the length of a transaction (2026-09-08), and tables,
-- table_seats and the hand relations are all hot. Inside the Lightning family
-- there is exactly one FK, from a reservation to the participation period that
-- owns it, because both are player-scoped rather than per-hand and a dangling
-- reservation is a real defect rather than an audit question.
--
-- ONE TRANSACTION. Every DDL statement fires Supabase's schema-cache reload,
-- ~28s on this database, so all of it lands in one BEGIN/COMMIT
-- (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT count(*) = 7 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('lightning_pool_session','lightning_pool_slot','lightning_instance','lightning_reservation','lightning_blind_ledger','lightning_hand','lightning_hand_player'))
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_cluster_events' AND column_name = 'cluster_epoch'))
-- @live-proof: (SELECT bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('lightning_pool_session','lightning_pool_slot','lightning_instance','lightning_reservation','lightning_blind_ledger','lightning_hand','lightning_hand_player'))
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%' AND grantee IN ('anon','authenticated','PUBLIC')))
-- @live-proof: (SELECT to_regclass('public.lightning_pool_slot_one_open') IS NOT NULL AND to_regclass('public.lightning_pool_slot_oldest_bb') IS NOT NULL AND to_regclass('public.lightning_reservation_one_pending_per_slot') IS NOT NULL)
-- @live-proof: (SELECT count(*) = 7 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%' AND grantee = 'service_role' AND privilege_type = 'SELECT')
-- @live-proof: (SELECT to_regclass('public.lightning_reservation_one_seat_per_player_instance') IS NOT NULL)
-- @live-proof: (SELECT count(*) = 2 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND c.contype = 'f' AND t.relname IN ('lightning_pool_slot','lightning_reservation') AND array_length(c.conkey, 1) = 3)
-- @live-proof: (SELECT count(*) = 2 FROM information_schema.referential_constraints WHERE constraint_schema = 'public' AND constraint_name IN ('lightning_pool_slot_belongs_to_its_session','lightning_reservation_belongs_to_its_slot') AND unique_constraint_name IS NOT NULL)
-- @live-proof: (SELECT to_regclass('public.lightning_reservation_by_pool_slot') IS NOT NULL)
-- @live-proof: (SELECT c.confdeltype = 'r' FROM pg_constraint c WHERE c.conname = 'lightning_pool_slot_belongs_to_its_session')
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lightning_pool_slot' AND column_name = 'cluster_epoch'))
-- @live-proof: (SELECT count(*) = 0 FROM public.lightning_pool_session)

BEGIN;

-- ===========================================================================
-- 1. THE POOL SESSION: a participation period, subordinate to the cash identity
-- ===========================================================================
-- "A Lightning Pool Session is subordinate to the continuous Cash Player
-- Session. Entering/exiting Lightning does not create a new cash session."
--
-- cash_player_session_id is the link to that continuous identity. It is NOT a
-- foreign key: cash_player_session is a live, hot relation and Phase 1 already
-- declined to put an FK on one. The link is an index, and the owning
-- transaction in Phase 5 is what guarantees it resolves.

CREATE TABLE IF NOT EXISTS public.lightning_pool_session (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id              uuid NOT NULL,
  cluster_epoch           integer NOT NULL,
  player_id               uuid NOT NULL,
  cash_player_session_id  uuid NOT NULL,
  -- The PARTICIPATION-level state, and only that.
  --
  -- The specification's player state machine also has per-hand states -
  -- idle_pool, matching, reserved, in_instance, in_hand, folded, watching,
  -- ghost_bb. Those deliberately do NOT live here, because a player
  -- multi-tabling three Lightning tables is in_hand at one, folded at another
  -- and watching a third, and one column cannot say so. Per-hand state is
  -- DERIVED from where it already lives: a live lightning_reservation and the
  -- lightning_instance it names. One truth read two ways, never two truths.
  --
  -- Seated states are absent for a different reason: a player in MUST_MOVE is
  -- seated at a physical table and has no pool session at all.
  state                   text NOT NULL DEFAULT 'joining',
  entered_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  exited_at               timestamptz,
  exit_reason             text,
  -- Economic snapshot at the boundaries of the whole participation. The stack
  -- itself continues to live where it lives today; these are observations,
  -- never an authority. They belong here rather than per slot because the
  -- money is the identity's, not the table's.
  starting_stack          numeric(14,2),
  ending_stack            numeric(14,2),
  net_result              numeric(14,2) NOT NULL DEFAULT 0,
  updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lightning_pool_session_state_check CHECK (state IN (
    'joining', 'eligibility_check', 'active', 'sit_out',
    'disconnected', 'leaving', 'closed')),
  CONSTRAINT lightning_pool_session_epoch_nonneg CHECK (cluster_epoch >= 0),
  -- An exited session has a reason and cannot exit before it entered.
  CONSTRAINT lightning_pool_session_exit_is_explained CHECK (
    (exited_at IS NULL AND exit_reason IS NULL)
    OR (exited_at IS NOT NULL AND exit_reason IS NOT NULL AND exited_at >= entered_at)),
  -- The composite target the slot below references. A real UNIQUE constraint
  -- rather than a bare unique index: PostgreSQL accepts either as a foreign-key
  -- target, but information_schema.referential_constraints leaves
  -- unique_constraint_name NULL for an index, so every tool that introspects
  -- through the standard views instead of pg_catalog sees a key it cannot
  -- resolve. It costs nothing to be legible.
  CONSTRAINT lightning_pool_session_identity UNIQUE (id, player_id, cluster_id)
);

-- COUNTERS AND WAIT TIMES ARE NOT HERE. They were, in the first draft, and it
-- was wrong. hands and fast_folds do sum across a player's tables, but p95 and
-- p99 wait cannot be merged across slots by any arithmetic - whichever table
-- wrote last would win, which is the last-writer-wins failure that took the
-- per-hand states out of `state` above. And a multi-tabler WAITS at three
-- tables while playing the fourth, so a summed wait_total_ms can exceed the
-- elapsed session itself and inflate the derived mean by the table count.
-- All of it lives on lightning_pool_slot, per table, and the session-level
-- totals are derived by summing its slots.

CREATE UNIQUE INDEX IF NOT EXISTS lightning_pool_session_one_open
  ON public.lightning_pool_session (player_id, cluster_id)
  WHERE exited_at IS NULL;

CREATE INDEX IF NOT EXISTS lightning_pool_session_open_by_cluster
  ON public.lightning_pool_session (cluster_id, cluster_epoch)
  WHERE exited_at IS NULL;

CREATE INDEX IF NOT EXISTS lightning_pool_session_by_cash_session
  ON public.lightning_pool_session (cash_player_session_id);

-- RLS on, nothing for the browser roles, and the API role's access STATED
-- rather than inherited. service_role carries BYPASSRLS, which bypasses ROW
-- security and is not a table privilege, so without this GRANT the six
-- relations would be reachable only through the project's ALTER DEFAULT
-- PRIVILEGES - and would silently become unreachable the day those are
-- tightened. Every sibling table in this estate states it.
ALTER TABLE public.lightning_pool_session ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_pool_session FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_pool_session TO service_role;

COMMENT ON TABLE public.lightning_pool_session IS
  'A player''s participation period in Lightning, subordinate to the continuous cash_player_session. Entering or leaving Lightning creates one of these; it never creates a cash session.';
COMMENT ON COLUMN public.lightning_pool_session.cash_player_session_id IS
  'The continuous economic identity this participation belongs to. Not a foreign key: cash_player_session is hot, and the owning conversion transaction is what guarantees it resolves.';

-- ===========================================================================
-- 1b. THE PARTICIPATION SLOT: one of the player's simultaneous Lightning tables
-- ===========================================================================
-- P0 reconnaissance named this primitive and the first draft of Phase 2 missed
-- it: "one cluster cash identity and configurable simultaneous play must be
-- represented as distinct participation slots under that identity."
--
-- A slot is one table the player is playing at. It is subordinate to the pool
-- session the way the pool session is subordinate to the cash session: three
-- levels, one economic identity at the bottom of them. Everything that is true
-- of a TABLE rather than of a PLAYER lives here - the orbit position, the wait
-- percentiles, the per-table counters, and when that table opened and closed.
--
-- Without it a multi-tabling player is unrepresentable: one `state` for three
-- answers, one `hands_since_bb` for three independent orbits, one p95 for
-- three distributions, and no way to leave one table while playing the others.

CREATE TABLE IF NOT EXISTS public.lightning_pool_slot (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, not CASCADE. lightning_hand_player.pool_slot_id is the hand's
  -- only record of WHICH TABLE it was played at, and it deliberately carries no
  -- foreign key so that hand history outlives the pool. If a slot could cascade
  -- away with its session, every historical hand would be left pointing at a
  -- table that no longer exists and per-table statistics would be
  -- unreconstructable - which is the same rule as "instance destruction must
  -- never destroy hand history", one level down. A participation period is a
  -- record. It is closed, not deleted.
  pool_session_id  uuid NOT NULL,
  cluster_id       uuid NOT NULL,
  cluster_epoch    integer NOT NULL,
  player_id        uuid NOT NULL,
  slot             smallint NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at        timestamptz,
  close_reason     text,
  -- Per-table counters. The session-level total is the sum of these; it is not
  -- stored anywhere, because a stored sum can disagree with its addends.
  hands            integer NOT NULL DEFAULT 0,
  fast_folds       integer NOT NULL DEFAULT 0,
  normal_folds     integer NOT NULL DEFAULT 0,
  fold_and_watch   integer NOT NULL DEFAULT 0,
  showdowns        integer NOT NULL DEFAULT 0,
  -- Per-table wait. The running total and the sample count are stored so the
  -- mean can be derived. The percentiles are stored because they cannot be
  -- recovered from a running total - and they are per SLOT because they cannot
  -- be merged across slots either.
  wait_total_ms    bigint NOT NULL DEFAULT 0,
  wait_samples     integer NOT NULL DEFAULT 0,
  p95_wait_ms      integer,
  p99_wait_ms      integer,
  -- ORBIT POSITION. A player at three tables has three independent orbits;
  -- these cannot be per identity. The blind DEBT and the fairness TOTALS can,
  -- and they stay on lightning_blind_ledger.
  hands_since_bb   integer NOT NULL DEFAULT 0,
  hands_since_sb   integer NOT NULL DEFAULT 0,
  last_bb_at       timestamptz,
  last_sb_at       timestamptz,
  last_button_at   timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A generous sanity ceiling, not the product limit. The configured maximum
  -- simultaneous tables is configuration and belongs in the rule snapshot; this
  -- is the floor a misconfigured value falls through, the way seat_number <= 9
  -- backstops handedness.
  CONSTRAINT lightning_pool_slot_range CHECK (slot >= 1 AND slot <= 24),
  CONSTRAINT lightning_pool_slot_epoch_nonneg CHECK (cluster_epoch >= 0),
  CONSTRAINT lightning_pool_slot_counters_nonneg CHECK (
    hands >= 0 AND fast_folds >= 0 AND normal_folds >= 0
    AND fold_and_watch >= 0 AND showdowns >= 0
    AND wait_total_ms >= 0 AND wait_samples >= 0
    AND hands_since_bb >= 0 AND hands_since_sb >= 0),
  CONSTRAINT lightning_pool_slot_close_is_explained CHECK (
    (closed_at IS NULL AND close_reason IS NULL)
    OR (closed_at IS NOT NULL AND close_reason IS NOT NULL AND closed_at >= opened_at)),
  CONSTRAINT lightning_pool_slot_belongs_to_its_session
    FOREIGN KEY (pool_session_id, player_id, cluster_id)
    REFERENCES public.lightning_pool_session (id, player_id, cluster_id)
    ON DELETE RESTRICT,
  -- The composite target the hold references, same reasoning as above.
  CONSTRAINT lightning_pool_slot_identity UNIQUE (id, player_id, cluster_id)
);

-- THE COPIES MUST AGREE. player_id and cluster_id are denormalised onto the
-- slot and onto the hold so the indexes below can key on them without a join.
-- Denormalised copies that nothing checks are copies that drift, and the
-- indexes they feed are the ones that matter: lightning_pool_slot_one_open
-- would enforce one-open-table for the WRONG human, lightning_pool_slot_oldest_bb
-- would select blinds for the wrong human, and
-- lightning_reservation_one_seat_per_player_instance - the index that stops one
-- human holding two chairs at one instance - keys on the hold's own player_id,
-- so a mismatch silently reopens exactly the hole it exists to close.
--
-- So each level exposes (id, player_id, cluster_id) as a unique key and the
-- level below references all three columns together. The database then refuses
-- a child whose idea of the human or the cluster differs from its parent's.

-- One live table per slot number per player per cluster. A closed slot frees
-- its number for re-use, which is what "leave one table and open another" is.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_pool_slot_one_open
  ON public.lightning_pool_slot (player_id, cluster_id, slot)
  WHERE closed_at IS NULL;

-- "The primary BB candidate is the eligible player with the oldest unresolved
-- BB obligation." That question is asked of a TABLE, so it is asked of slots.
CREATE INDEX IF NOT EXISTS lightning_pool_slot_oldest_bb
  ON public.lightning_pool_slot (cluster_id, last_bb_at NULLS FIRST, player_id)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS lightning_pool_slot_by_session
  ON public.lightning_pool_slot (pool_session_id);

ALTER TABLE public.lightning_pool_slot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_pool_slot FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_pool_slot TO service_role;

COMMENT ON TABLE public.lightning_pool_slot IS
  'One of a player''s simultaneous Lightning tables, under one pool session, under one cash identity. Holds everything that is true of a table rather than of a player: orbit position, wait percentiles, per-table counters, and when that table opened and closed.';
COMMENT ON COLUMN public.lightning_pool_slot.hands_since_bb IS
  'Orbit position at THIS table. A player at three tables has three independent orbits, so this cannot be per identity; the blind debt and the fairness totals, which are owed by the human, stay on lightning_blind_ledger.';

-- ===========================================================================
-- 2. THE INSTANCE: a disposable execution container for one hand
-- ===========================================================================
-- "An Instance is NOT a player's permanent table, a lobby object, an economic
-- account, a buy-in boundary or a rejoin boundary."
--
-- It is deliberately not a row in public.tables. That relation is 273,037 rows
-- of durable tables with its own lifecycle, balancer and F06 readers; a
-- disposable one-hand container would arrive at hand rate and drag table_seats
-- with it.

CREATE TABLE IF NOT EXISTS public.lightning_instance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id     uuid NOT NULL,
  cluster_epoch  integer NOT NULL,
  state          text NOT NULL DEFAULT 'forming',
  -- "has one hand_id at a time"
  hand_id        uuid,
  target_size    smallint NOT NULL,
  max_size       smallint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at     timestamptz,
  completed_at   timestamptz,
  CONSTRAINT lightning_instance_state_check CHECK (state IN (
    'forming', 'reserved', 'dealing', 'settling', 'complete', 'abandoned')),
  CONSTRAINT lightning_instance_epoch_nonneg CHECK (cluster_epoch >= 0),
  -- "Never create a visible 1-player Lightning instance." Two is the floor and
  -- the existing handedness ceiling is nine.
  CONSTRAINT lightning_instance_sizes CHECK (
    target_size >= 2 AND max_size >= target_size AND max_size <= 9),
  CONSTRAINT lightning_instance_lifecycle_order CHECK (
    (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)))
);

-- One live instance per hand. A hand belongs to exactly one container, and a
-- container runs one hand at a time.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_instance_one_per_hand
  ON public.lightning_instance (hand_id)
  WHERE hand_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lightning_instance_live_by_cluster
  ON public.lightning_instance (cluster_id, cluster_epoch)
  WHERE state IN ('forming', 'reserved', 'dealing', 'settling');

ALTER TABLE public.lightning_instance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_instance FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_instance TO service_role;

COMMENT ON TABLE public.lightning_instance IS
  'A disposable execution container for one Lightning hand. Never exposed to players and never a permanent table. Deliberately not a row in public.tables, which is durable, hot and read by the balancer.';

-- ===========================================================================
-- 3. THE RESERVATION: a matcher hold that expires safely
-- ===========================================================================
-- Shape copied from public.cash_seat_moves, including its one-pending-per-player
-- partial unique index, which is this estate's proven way of saying "at most one
-- active hold per player".

CREATE TABLE IF NOT EXISTS public.lightning_reservation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id            uuid NOT NULL,
  cluster_epoch         integer NOT NULL,
  player_id             uuid NOT NULL,
  -- A hold belongs to ONE TABLE the player is at, not to the player. This is
  -- what makes multi-tabling representable: one pending hold per slot, and a
  -- player may hold several slots at once. cash_seat_moves can afford its
  -- global one-per-player index because a human can only be offered one
  -- physical chair at a time; a Lightning player can legitimately be in eight
  -- hands at once.
  -- CASCADE is right here and RESTRICT is right one level up: a hold is a
  -- transient claim that a closed table should never keep, whereas a slot is a
  -- record that a hand still points at.
  pool_slot_id          uuid NOT NULL,
  lightning_instance_id uuid,
  seat_number           smallint,
  state                 text NOT NULL DEFAULT 'pending',
  reason                text,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at            timestamptz NOT NULL,
  resolved_at           timestamptz,
  CONSTRAINT lightning_reservation_state_check CHECK (state IN (
    'pending', 'committed', 'released', 'expired')),
  CONSTRAINT lightning_reservation_epoch_nonneg CHECK (cluster_epoch >= 0),
  CONSTRAINT lightning_reservation_expires_after_creation CHECK (expires_at > created_at),
  CONSTRAINT lightning_reservation_seat_range CHECK (
    seat_number IS NULL OR (seat_number >= 1 AND seat_number <= 9)),
  -- A resolved reservation says when, and a pending one has not resolved.
  CONSTRAINT lightning_reservation_resolution CHECK (
    (state = 'pending' AND resolved_at IS NULL)
    OR (state <> 'pending' AND resolved_at IS NOT NULL)),
  -- A committed reservation names the instance it committed to.
  CONSTRAINT lightning_reservation_committed_names_its_instance CHECK (
    state <> 'committed' OR lightning_instance_id IS NOT NULL),
  CONSTRAINT lightning_reservation_belongs_to_its_slot
    FOREIGN KEY (pool_slot_id, player_id, cluster_id)
    REFERENCES public.lightning_pool_slot (id, player_id, cluster_id)
    ON DELETE CASCADE
);

-- "A player can never have more than one active Lightning reservation within
-- the same logical gaming session." The logical gaming session IS the slot, so
-- the key is the slot and nothing else: the slot row already carries the
-- player and the cluster, and keying on it cannot disagree with itself.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_reservation_one_pending_per_slot
  ON public.lightning_reservation (pool_slot_id)
  WHERE state = 'pending';

-- One seat in one instance is held by at most one player.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_reservation_one_seat_per_instance
  ON public.lightning_reservation (lightning_instance_id, seat_number)
  WHERE state IN ('pending', 'committed') AND lightning_instance_id IS NOT NULL AND seat_number IS NOT NULL;

-- ONE PLAYER, ONE SEAT, PER INSTANCE - whatever the slot.
-- lightning_reservation_one_seat_per_instance stops two PLAYERS sharing a
-- chair. This stops one player holding two chairs at the same instance under
-- two different slots, which the slot dimension would otherwise permit. It is
-- not a nicety: lightning_hand_player is keyed (hand_id, player_id), so such a
-- pair is committable at the reservation layer and impossible at the hand
-- layer. The matcher would hand out both holds, form the instance, and fail on
-- the primary key at the moment a hold is most expensive to unwind. Refuse it
-- where it is cheap.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_reservation_one_seat_per_player_instance
  ON public.lightning_reservation (player_id, lightning_instance_id)
  WHERE state IN ('pending', 'committed') AND lightning_instance_id IS NOT NULL;

-- THE CASCADE NEEDS THIS, and it is not the partial index above.
-- lightning_reservation_one_pending_per_slot is partial on state = 'pending',
-- so it cannot serve the referential check that runs when a slot is closed -
-- and that check looks at holds in every state, most of which will be expired
-- or released, because that is what a hold becomes. Without an unpartial index
-- the ON DELETE CASCADE sequentially scans the highest-churn relation in the
-- family (one hold per table per hand) while holding the delete's lock, and it
-- gets worse exactly as Lightning gets busier. Measured on a 20,000-row table:
-- 19,990 rows scanned to find 10. The session -> slot hop already has its
-- mirror in lightning_pool_slot_by_session.
CREATE INDEX IF NOT EXISTS lightning_reservation_by_pool_slot
  ON public.lightning_reservation (pool_slot_id);

-- The expiry sweep reads this. It is a bounded index on live holds only, so it
-- never grows with history.
CREATE INDEX IF NOT EXISTS lightning_reservation_pending_by_expiry
  ON public.lightning_reservation (expires_at)
  WHERE state = 'pending';

ALTER TABLE public.lightning_reservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_reservation FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_reservation TO service_role;

COMMENT ON TABLE public.lightning_reservation IS
  'A temporary matcher hold on a player and a seat in a forming instance. Shape copied from cash_seat_moves, including its one-pending-per-player partial unique index. Expiry is a state transition owned by the matcher, never a background repair job.';

-- ===========================================================================
-- 4. THE BLIND AND POSITION LEDGER: fairness that survives a restart
-- ===========================================================================
-- Today none of this persists. Blind debt lives in engine memory on
-- ServerTableEngineBase and is lost on every restart; only table_seats.entry_hold
-- survives. Pool-wide blind fairness cannot be built on RAM that a deploy
-- clears, so the ledger is a table, one row per player per Cluster.
--
-- The ledger is NOT per epoch. Blind burden is owed by a player to a Cluster;
-- a mode conversion is a seating change, not a debt forgiveness.

CREATE TABLE IF NOT EXISTS public.lightning_blind_ledger (
  cluster_id       uuid NOT NULL,
  player_id        uuid NOT NULL,
  bb_count         integer NOT NULL DEFAULT 0,
  sb_count         integer NOT NULL DEFAULT 0,
  btn_count        integer NOT NULL DEFAULT 0,
  utg_count        integer NOT NULL DEFAULT 0,
  hj_count         integer NOT NULL DEFAULT 0,
  co_count         integer NOT NULL DEFAULT 0,
  -- ORBIT POSITION IS NOT HERE. hands_since_bb, last_bb_at and their siblings
  -- are per table and live on lightning_pool_slot. Keeping them here would
  -- have meant one integer standing in for three independent orbits, and an
  -- "oldest unresolved BB" index that answered the wrong question: for a
  -- multi-tabler last_bb_at would be the most recent BB at ANY table, so
  -- posting at one table would instantly deprioritise them at the others,
  -- where they may genuinely owe one.
  --
  -- What IS here is owed by the human to the Cluster, and aggregates properly.
  -- Debt is a count of obligations missed; owed is the money those obligations
  -- represent. They are different questions and the specification names both.
  missed_bb_debt   integer NOT NULL DEFAULT 0,
  missed_sb_debt   integer NOT NULL DEFAULT 0,
  bb_owed          numeric(14,2) NOT NULL DEFAULT 0,
  sb_owed          numeric(14,2) NOT NULL DEFAULT 0,
  first_seen_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lightning_blind_ledger_pkey PRIMARY KEY (cluster_id, player_id),
  CONSTRAINT lightning_blind_ledger_counts_nonneg CHECK (
    bb_count >= 0 AND sb_count >= 0 AND btn_count >= 0
    AND utg_count >= 0 AND hj_count >= 0 AND co_count >= 0),
  CONSTRAINT lightning_blind_ledger_debt_nonneg CHECK (
    missed_bb_debt >= 0 AND missed_sb_debt >= 0
    AND bb_owed >= 0 AND sb_owed >= 0)
);

CREATE INDEX IF NOT EXISTS lightning_blind_ledger_owing
  ON public.lightning_blind_ledger (cluster_id)
  WHERE missed_bb_debt > 0 OR missed_sb_debt > 0;

ALTER TABLE public.lightning_blind_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_blind_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_blind_ledger TO service_role;

COMMENT ON TABLE public.lightning_blind_ledger IS
  'Pool-wide blind and position fairness state, one row per player per Cluster. Nothing persisted this before Lightning: blind debt lived in engine memory and was lost on every restart. Not epoch-scoped, because a mode conversion is a seating change and not a forgiveness of debt.';
COMMENT ON COLUMN public.lightning_blind_ledger.missed_bb_debt IS
  'Count of big blinds the player owes. Distinct from bb_owed, which is the money those obligations represent; the specification names both.';

-- ===========================================================================
-- 5. THE HAND LINKAGE: a side table, not nine columns on a 14 GB relation
-- ===========================================================================
-- "Instance destruction must never destroy hand history." The hand itself stays
-- exactly where it is, in hand_history and hand_atomic_commits, written by the
-- existing settlement path with its existing signature. These two relations add
-- the Lightning dimensions to it, and exist only for Lightning hands.

CREATE TABLE IF NOT EXISTS public.lightning_hand (
  hand_id               uuid PRIMARY KEY,
  cluster_id            uuid NOT NULL,
  cluster_epoch         integer NOT NULL,
  lightning_instance_id uuid NOT NULL,
  -- The formation barrier: once this is set the participant set is locked and
  -- no substitution, seat swap, blind reassignment or insertion is permitted.
  formed_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at            timestamptz,
  CONSTRAINT lightning_hand_epoch_nonneg CHECK (cluster_epoch >= 0),
  CONSTRAINT lightning_hand_settles_after_formation CHECK (
    settled_at IS NULL OR settled_at >= formed_at)
);

CREATE INDEX IF NOT EXISTS lightning_hand_by_cluster_epoch
  ON public.lightning_hand (cluster_id, cluster_epoch, formed_at DESC);

CREATE INDEX IF NOT EXISTS lightning_hand_by_instance
  ON public.lightning_hand (lightning_instance_id);

ALTER TABLE public.lightning_hand ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_hand FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_hand TO service_role;

COMMENT ON TABLE public.lightning_hand IS
  'The Lightning dimensions of one hand: which Cluster, which epoch, which instance. A side table keyed by hand_id rather than columns on hand_history (2.9M rows, 14 GB) and hand_atomic_commits (2.85M rows, 11 GB), so non-Lightning hands carry no permanently NULL columns and the hot settlement path keeps its exact signature.';

CREATE TABLE IF NOT EXISTS public.lightning_hand_player (
  hand_id          uuid NOT NULL,
  player_id        uuid NOT NULL,
  -- WHICH TABLE this hand was played at, not merely which player. Two
  -- concurrent Lightning hands for one multi-tabling player would otherwise
  -- point at the same participation with nothing distinguishing them, and
  -- per-table statistics could never be reconstructed.
  pool_slot_id     uuid NOT NULL,
  seat             smallint NOT NULL,
  position         text,
  blind_role       text,
  stack_before     numeric(14,2),
  stack_after      numeric(14,2),
  -- The fold taxonomy. Nothing in this estate distinguished these before:
  -- ca_hand_player_stat.folded is a single boolean.
  fold_type        text NOT NULL DEFAULT 'none',
  CONSTRAINT lightning_hand_player_pkey PRIMARY KEY (hand_id, player_id),
  CONSTRAINT lightning_hand_player_fold_type_check CHECK (fold_type IN (
    'none', 'normal', 'fast', 'fold_watch')),
  CONSTRAINT lightning_hand_player_position_check CHECK (position IS NULL OR position IN (
    'utg', 'hj', 'co', 'btn', 'sb', 'bb')),
  CONSTRAINT lightning_hand_player_blind_role_check CHECK (blind_role IS NULL OR blind_role IN (
    'none', 'sb', 'bb', 'both', 'dead_sb', 'straddle')),
  CONSTRAINT lightning_hand_player_seat_range CHECK (seat >= 1 AND seat <= 9)
);

-- One seat per hand, held by one player. The other half of the formation
-- barrier: two players cannot occupy the same chair in a committed hand.
CREATE UNIQUE INDEX IF NOT EXISTS lightning_hand_player_one_per_seat
  ON public.lightning_hand_player (hand_id, seat);

-- Keyed by the SLOT, so per-table statistics read only that table's hands.
CREATE INDEX IF NOT EXISTS lightning_hand_player_by_pool_slot
  ON public.lightning_hand_player (pool_slot_id);

ALTER TABLE public.lightning_hand_player ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lightning_hand_player FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.lightning_hand_player TO service_role;

COMMENT ON COLUMN public.lightning_hand_player.fold_type IS
  'none, normal, fast or fold_watch. New vocabulary: the existing per-hand analytics carry only a single folded boolean, which cannot distinguish a Fast Fold from an ordinary one.';

-- ===========================================================================
-- 6. THE EVENT LEDGER LEARNS THE EPOCH
-- ===========================================================================
-- Every material Lightning event carries a cluster_epoch in the specification's
-- event metadata, and cash_cluster_events has no such column: (id, game_id,
-- table_id, kind, payload, at). The id already gives a total order; the epoch is
-- what lets events be GROUPED by the seating regime they happened under.
--
-- 299,817 rows / 110 MB, and a NOT NULL column with a constant default is a
-- catalog-only operation on PostgreSQL 11+, so there is no rewrite. The default
-- of 0 keeps all four existing insert shapes compiling untouched; there are 35
-- migration files that write to this table and none of them needs to change.
-- kind has no CHECK constraint, so new Lightning event kinds need no migration.

ALTER TABLE public.cash_cluster_events
  ADD COLUMN IF NOT EXISTS cluster_epoch integer NOT NULL DEFAULT 0;

ALTER TABLE public.cash_cluster_events
  DROP CONSTRAINT IF EXISTS cash_cluster_events_epoch_nonneg;
ALTER TABLE public.cash_cluster_events
  ADD CONSTRAINT cash_cluster_events_epoch_nonneg CHECK (cluster_epoch >= 0);

COMMENT ON COLUMN public.cash_cluster_events.cluster_epoch IS
  'The Cluster Epoch this event happened under. Defaults to 0, which is the epoch every existing cluster is at, so all four existing insert shapes keep working unchanged.';

COMMIT;
