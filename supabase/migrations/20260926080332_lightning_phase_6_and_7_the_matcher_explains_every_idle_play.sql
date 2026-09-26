-- 20260926080332_lightning_phase_6_and_7_the_matcher_explains_every_idle_play.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASES 6 AND 7: THE MATCHER EXPLAINS EVERY IDLE PLAYER, AND THE
-- BLINDS ROTATE FAIRLY.
--
-- Built on remediation two (20260926072527, 20260926072551, 20260926072615,
-- 20260926072638: the seat is the anchor). Nothing
-- here is wired into a tick or a cron: the engine's Lightning worker calls
-- these functions, every one is executable by service_role only, and a
-- Cluster forms nothing unless its ruleset says worker_mode 'form' AND it is a
-- converted, enabled Lightning Cluster (the barrier refuses anything else).
--
-- WHAT THIS ADDS
--
-- 1. public.fn_lightning_config(cluster) - every matcher tunable, read from
--    cash_games.ruleset_snapshot -> 'lightning' with a default for each, type
--    checked and clamped; a bad value is replaced and reported under
--    'invalid'. The ON/OFF thresholds come from the SAME reader the population
--    uses (fn_cash_cluster_lightning_thresholds), and the diversity bands
--    default to them (thin from OFF, medium from ON, large from twice ON).
--    Instance size defaults to the table size (6-max 6, 9-max 9), minimum 2.
--
-- 2. public.fn_lightning_player_legality(cluster, now, disconnected) - P0.
--    One row per open pool session, ONE first-failing reason from ONE ordered
--    CASE. It reuses the estate's own checks instead of copying them:
--    fn_lightning_anchor_is_live_eligible (the population's seated predicate),
--    fn_lightning_pool_stack, fn_lightning_player_in_hand, fn_platform_frozen,
--    fn_ca_player_restricted(player, 'cash') gated by
--    ca_operator_policy.restrictions_enforced exactly as the table_seats door
--    fn_ca_refuse_restricted_entry gates it, and fn_rg_require_not_excluded,
--    which already answers without raising ({ok:false} for a self-exclusion
--    or a cooling-off), so no second reader of responsible_gaming_limits is
--    written. Variant, stake, table size and rule snapshot are properties of
--    the Cluster row every pool session is keyed to, so they are not
--    re-checked per player; the harness proves the keying instead.
--
-- 3. public.fn_lightning_group_sizes(legal, min, target, max) - P1, pure. The
--    fewest instances that seat every legal player inside [min, max] (P6: no
--    unnecessary instance), choosing among the feasible group counts the one
--    whose average is closest to the target, then sizes as equal as possible
--    (never differing by more than one, larger first). Nobody is left over
--    whenever a feasible split exists - with the default minimum of 2 that is
--    every count from 2 up - and no group is ever a single player. When no
--    split seats everyone (only a configured minimum above 2 can cause it),
--    the most players that can be seated are seated in full groups, and the
--    rest wait as WAITING_FOR_FORMATION.
--
-- 4. public.fn_lightning_match(cluster, now, disconnected, version) - the
--    planner. STABLE, writes nothing, deterministic for a snapshot. Its body
--    is public.fn_lightning_match_plan with the pass capacity left to the
--    configuration; fn_lightning_match_and_form calls the same planner with
--    its own p_max_hands, so a bounded pass never lets P5 trade a player
--    across the formed/unformed boundary (which would break P4). Lexicographic,
--    never one weighted formula:
--      P1 group sizes from the legal count (3).
--      P2 the k big blinds are the first k legal players in
--         fn_lightning_blind_order - the barrier's own key - so group j's big
--         blind is P2-first inside group j, which is what the barrier checks;
--         and of the players seated this pass the next k in that order are
--         the small blinds, one to a group (the classical orbit: the small
--         blind is the player next due for the big blind), which is the
--         barrier's own P2-second in each group.
--      P4 the other seats go to the non-blind legal players in queue order:
--         lightning_pool_slot.idle_since, lightning_pool_session.entered_at,
--         cash_player_session.opened_at (the Cluster join), player_id.
--      P5 only among the players seated THIS pass (all equally served, so
--         P4-equivalent): each is placed, in P4 order, in the group with the
--         fewest recent encounters, but moved from the group plain P4 order
--         would give only when weight x (encounters saved) >= 1. The weight
--         is by pool-size band (large 1, medium 0.5, thin 0, tiny 0), so a
--         thin or tiny pool is formed exactly as P4 alone forms it, and a
--         move never changes a group's size, so no hand is ever starved.
--      P3 advisory and last: inside a formed group it only orders the
--         non-blind seats - from the button backward, each seat to the member
--         who has held that position least (lightning_blind_ledger btn, co,
--         hj and utg counts) - never the membership and never the blinds,
--         and never delays anything.
--      P6 every group is a new instance; nothing is merged into a committed
--         hand (the barrier's latch refuses it anyway).
--    Every open-pool player is diagnosed exactly once: MATCHED iff grouped,
--    else WAITING_FOR_PLAYERS, WAITING_FOR_BB (the optional first-entry rule),
--    WAITING_FOR_FORMATION, WAITING_FOR_RECONNECT or BLOCKED_WITH_REASON.
--
-- 5. public.fn_lightning_match_and_form(cluster, now, disconnected,
--    max_hands, request_id) - the writer. Takes the Cluster row FOR UPDATE
--    SKIP LOCKED (a concurrent pass answers pass_in_progress and waits for
--    nothing), plans, forms each group through fn_lightning_form_hand with
--    that group's big blind, a request id derived from the pass's and a
--    formation time one microsecond after the previous group's (so the big
--    blinds of one pass queue in the order they were chosen and P2 is a
--    strict rotation rather than a re-sort by player_id), re-plans
--    after a retryable refusal (bounded by max_replans), stops at once on
--    formation_invariant_failed, and is bounded by max_hands, the admission
--    batch and a time budget. One matcher_assignment event per hand and one
--    matcher_pass event per pass (counts per state and reason, never a row
--    per player), both carrying matcher_version and request_id; the pass is
--    recorded in public.cash_cluster_matcher_pass under its request id, and a
--    retried request id answers with the recorded pass and forms nothing.
--
-- 6. lightning_pool_slot.idle_since (P4's first key): NOT NULL, the slot's
--    opened_at when it opens (a BEFORE INSERT trigger, because a column
--    default cannot name another column), and moved forward - never back -
--    to the resolution time whenever one of the slot's reservations is
--    released or expires (an AFTER UPDATE trigger on lightning_reservation).
--    A trigger rather than an edit of the release trigger's body because the
--    reaper's expiry is a second road back to the pool that the release
--    trigger never sees; one trigger on the row that records the end covers
--    both, and any future road, without touching an existing function.
--
-- 7. lightning_reservation_active_by_player: the multi-table count asks for a
--    player's live reservations in every OTHER Cluster, which no existing
--    index serves (the one-active index leads with cluster_id).
--
-- WHY NO fn_lightning_blind_ledger_record_hand. The ledger is already written
-- by the barrier at formation - bb_count, sb_count, btn/utg/hj/co counts,
-- last_bb_at, last_sb_at, last_button_at, hands_since_bb and hands_since_sb -
-- because the blinds are assigned there and are immutable afterwards
-- (trg_lightning_hand_player_is_immutable). A second write at completion
-- would count every blind twice. The completion path (begin_dealing, then
-- settling, then complete) releases the reservations, and the release now
-- also stamps idle_since.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse is matched,
-- blinded, queued and diversified exactly as a human is.
--
-- Every @live-proof below is containment or presence: it names what this file
-- put there, never the size of a set a later file may grow.
--
-- @live-proof: (SELECT p.provolatile = 's' AND NOT p.prosecdef AND p.prorettype = 'jsonb'::regtype AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND pg_get_functiondef(p.oid) ~ 'fn_cash_cluster_lightning_thresholds\(g\.id\)' AND pg_get_functiondef(p.oid) ~ '''invalid''' FROM pg_proc p WHERE p.oid = 'public.fn_lightning_config(uuid)'::regprocedure)
-- @live-proof: (SELECT p.provolatile = 's' AND NOT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND s ~ 'fn_lightning_anchor_is_live_eligible\(f\.anchor_seat_id, f\.cluster_id, f\.player_id\)' AND s ~ 'fn_ca_player_restricted\(f\.player_id, ''cash''\)' AND s ~ 'restrictions_enforced' AND s ~ 'fn_rg_require_not_excluded\(f\.player_id\)' AND s ~ 'fn_lightning_player_in_hand\(f\.player_id, f\.cluster_id\)' AND s ~ 'fn_platform_frozen\(\)' AND s ~ 'fn_lightning_pool_stack\(f\.pool_session_id\)' FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[])'::regprocedure)
-- @live-proof: (SELECT p.provolatile = 'i' AND NOT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND public.fn_lightning_group_sizes(13, 2, 6, 6) = ARRAY[5,4,4] AND public.fn_lightning_group_sizes(1, 2, 6, 6) = '{}'::integer[] AND public.fn_lightning_group_sizes(18, 2, 6, 6) = ARRAY[6,6,6] FROM pg_proc p WHERE p.oid = 'public.fn_lightning_group_sizes(integer,integer,integer,integer)'::regprocedure)
-- @live-proof: (SELECT p.provolatile = 's' AND NOT p.prosecdef AND p.prorettype = 'jsonb'::regtype AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND pg_get_functiondef(p.oid) ~ 'fn_lightning_match_plan\(p_cluster_id, p_now, p_disconnected, p_matcher_version, NULL\)' FROM pg_proc p WHERE p.oid = 'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)'::regprocedure)
-- @live-proof: (SELECT p.provolatile = 's' AND NOT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND s ~ 'fn_lightning_blind_order\(p_cluster_id, v_epoch' AND s ~ 'fn_lightning_player_legality\(p_cluster_id, v_now, p_disconnected\)' AND s ~ 'fn_lightning_group_sizes\(' AND s ~ '''WAITING_FOR_RECONNECT''' AND s ~ '''BLOCKED_WITH_REASON''' AND s !~ 'INSERT INTO' AND s !~ 'UPDATE public' FROM pg_proc p, LATERAL (SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') AS s) q WHERE p.oid = 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)'::regprocedure)
-- @live-proof: (SELECT p.provolatile = 'v' AND NOT p.prosecdef AND p.prorettype = 'jsonb'::regtype AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND s ~ 'FOR UPDATE SKIP LOCKED' AND s ~ 'public\.fn_lightning_form_hand\(' AND s ~ '''matcher_assignment''' AND s ~ '''matcher_pass''' AND s ~ 'formation_invariant_failed' AND s ~ 'cash_cluster_matcher_pass' FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)'::regprocedure)
-- @live-proof: (SELECT a.attnotnull AND a.atttypid = 'timestamptz'::regtype FROM pg_attribute a WHERE a.attrelid = 'public.lightning_pool_slot'::regclass AND a.attname = 'idle_since' AND NOT a.attisdropped) AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_slot'::regclass AND c.conname = 'lightning_pool_slot_idle_since_follows_open' AND c.convalidated)
-- @live-proof: (SELECT t.tgenabled = 'O' AND (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 4) <> 0 AND t.tgfoid = 'public.fn_lightning_pool_slot_idle_since_starts_at_open()'::regprocedure FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_pool_slot'::regclass AND t.tgname = 'trg_matcher_slot_idle_since_starts_at_open')
-- @live-proof: (SELECT t.tgenabled = 'O' AND (t.tgtype::integer & 2) = 0 AND (t.tgtype::integer & 16) <> 0 AND t.tgqual IS NOT NULL AND t.tgfoid = 'public.fn_lightning_reservation_end_marks_the_slot_idle()'::regprocedure AND pg_get_triggerdef(t.oid) ~ 'released' AND pg_get_triggerdef(t.oid) ~ 'expired' FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_reservation'::regclass AND t.tgname = 'trg_matcher_reservation_end_marks_the_slot_idle')
-- @live-proof: (SELECT pg_get_expr(i.indpred, i.indrelid) ~ 'pending' AND pg_get_expr(i.indpred, i.indrelid) ~ 'committed' AND pg_get_indexdef(i.indexrelid) ~ '\(player_id\)' FROM pg_index i WHERE i.indexrelid = 'public.lightning_reservation_active_by_player'::regclass)
-- @live-proof: (SELECT c.relrowsecurity AND has_table_privilege('service_role', c.oid, 'SELECT') AND has_table_privilege('service_role', c.oid, 'INSERT') AND NOT has_table_privilege('service_role', c.oid, 'DELETE') AND NOT has_table_privilege('service_role', c.oid, 'UPDATE') AND NOT has_table_privilege('anon', c.oid, 'SELECT') AND NOT has_table_privilege('authenticated', c.oid, 'SELECT') FROM pg_class c WHERE c.oid = 'public.cash_cluster_matcher_pass'::regclass)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_config', 'fn_lightning_config_number', 'fn_lightning_player_legality', 'fn_lightning_group_sizes', 'fn_lightning_match_plan', 'fn_lightning_match', 'fn_lightning_match_and_form', 'fn_lightning_pool_slot_idle_since_starts_at_open', 'fn_lightning_reservation_end_marks_the_slot_idle') AND (p.prosecdef OR pg_get_functiondef(p.oid) ~ 'is_horse' OR pg_get_functiondef(p.oid) ~ 'horse_id')))

BEGIN;

SET LOCAL lock_timeout = '8s';

-- ===========================================================================
-- SECTION 1. P4'S FIRST KEY: WHEN DID THIS TABLE LAST BECOME IDLE?
-- ===========================================================================

-- One ADD COLUMN per ALTER. lightning_pool_slot is empty in production and
-- dark everywhere else, so the backfill below reads nothing there.
ALTER TABLE public.lightning_pool_slot ADD COLUMN IF NOT EXISTS idle_since timestamptz;

-- THE BACKFILL, for an estate that already has slots: the later of the open
-- and the last time one of the slot's reservations ended.
UPDATE public.lightning_pool_slot sl
   SET idle_since = GREATEST(sl.opened_at,
                             coalesce((SELECT max(r.resolved_at)
                                         FROM public.lightning_reservation r
                                        WHERE r.pool_slot_id = sl.id
                                          AND r.state IN ('released', 'expired')),
                                      sl.opened_at))
 WHERE sl.idle_since IS NULL;

ALTER TABLE public.lightning_pool_slot ALTER COLUMN idle_since SET NOT NULL;

DO $idle_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.lightning_pool_slot'::regclass
                    AND conname = 'lightning_pool_slot_idle_since_follows_open') THEN
    ALTER TABLE public.lightning_pool_slot
      ADD CONSTRAINT lightning_pool_slot_idle_since_follows_open
      CHECK (idle_since >= opened_at);
  END IF;
END
$idle_check$;

COMMENT ON COLUMN public.lightning_pool_slot.idle_since IS
  'P4 queue fairness, first key: when this table last became free to be dealt in. The slot''s opened_at when it opens (trg_matcher_slot_idle_since_starts_at_open) and moved forward to resolved_at whenever one of its reservations is released or expires (trg_matcher_reservation_end_marks_the_slot_idle). Never moves backward and never precedes opened_at.';

CREATE OR REPLACE FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- A column default cannot name another column, so the default is here: a
  -- slot is idle from the moment it opens unless its writer says later.
  NEW.idle_since := GREATEST(coalesce(NEW.idle_since, NEW.opened_at), NEW.opened_at);
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- Released by an instance reaching complete or abandoned (the release
  -- trigger), or expired by the reaper: either way the player is back in the
  -- pool from resolved_at, and P4 queues them from then. Forward only.
  UPDATE public.lightning_pool_slot sl
     SET idle_since = GREATEST(sl.idle_since, coalesce(NEW.resolved_at, clock_timestamp()))
   WHERE sl.id = NEW.pool_slot_id
     AND sl.closed_at IS NULL
     AND sl.idle_since < coalesce(NEW.resolved_at, clock_timestamp());
  RETURN NULL;
END
$fn$;

DO $idle_triggers$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.lightning_pool_slot'::regclass
                   AND tgname = 'trg_matcher_slot_idle_since_starts_at_open') THEN
    CREATE TRIGGER trg_matcher_slot_idle_since_starts_at_open
      BEFORE INSERT ON public.lightning_pool_slot
      FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.lightning_reservation'::regclass
                   AND tgname = 'trg_matcher_reservation_end_marks_the_slot_idle') THEN
    CREATE TRIGGER trg_matcher_reservation_end_marks_the_slot_idle
      AFTER UPDATE OF state ON public.lightning_reservation
      FOR EACH ROW
      WHEN (OLD.state IN ('pending', 'committed') AND NEW.state IN ('released', 'expired'))
      EXECUTE FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle();
  END IF;
END
$idle_triggers$;

-- The multi-table count: a player's live reservations in every other Cluster.
CREATE INDEX IF NOT EXISTS lightning_reservation_active_by_player
  ON public.lightning_reservation (player_id)
  WHERE state IN ('pending', 'committed');

COMMENT ON INDEX public.lightning_reservation_active_by_player IS
  'P0 MULTI_TABLE_LIMIT: the live Lightning hands a player holds in OTHER Clusters. lightning_reservation_one_active_per_player leads with cluster_id and cannot answer it.';

-- ===========================================================================
-- SECTION 2. THE PASS RECORD. Idempotency for fn_lightning_match_and_form: a
-- retried request id answers with the pass it recorded. Its own small table,
-- not an index on cash_cluster_events: building one there would hold a SHARE
-- lock on a hot 140 MB table for the whole scan. No foreign key to cash_games
-- (CLAUDE.md, production DDL policy 7).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.cash_cluster_matcher_pass (
  request_id      uuid        NOT NULL,
  cluster_id      uuid        NOT NULL,
  cluster_epoch   integer     NOT NULL,
  matcher_version text        NOT NULL,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL,
  hands_formed    integer     NOT NULL,
  result          jsonb       NOT NULL,
  CONSTRAINT cash_cluster_matcher_pass_pkey PRIMARY KEY (request_id),
  CONSTRAINT cash_cluster_matcher_pass_hands_nonneg CHECK (hands_formed >= 0),
  CONSTRAINT cash_cluster_matcher_pass_finishes_after_start CHECK (finished_at >= started_at),
  CONSTRAINT cash_cluster_matcher_pass_version_is_named CHECK (length(btrim(matcher_version)) > 0)
);

CREATE INDEX IF NOT EXISTS cash_cluster_matcher_pass_by_cluster
  ON public.cash_cluster_matcher_pass (cluster_id, started_at DESC);

ALTER TABLE public.cash_cluster_matcher_pass ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cash_cluster_matcher_pass FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.cash_cluster_matcher_pass TO service_role;

COMMENT ON TABLE public.cash_cluster_matcher_pass IS
  'One row per Lightning matcher pass that ran (fn_lightning_match_and_form), keyed by the caller''s request id: what the pass saw and what it formed. A retried request id is answered from here and forms nothing. Append only: service_role may read and insert, never update or delete.';

-- ===========================================================================
-- SECTION 3. CONFIGURATION. Every tunable has a default here and nowhere
-- else; the matcher reads nothing but this.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_config_number(
  p_cfg     jsonb,
  p_key     text,
  p_default numeric,
  p_lo      numeric,
  p_hi      numeric,
  p_integer boolean)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_raw jsonb;
  v     numeric;
  v_use numeric;
BEGIN
  IF jsonb_typeof(p_cfg) IS DISTINCT FROM 'object' OR NOT (p_cfg ? p_key)
     OR jsonb_typeof(p_cfg -> p_key) = 'null' THEN
    RETURN jsonb_build_object('value', p_default);
  END IF;
  v_raw := p_cfg -> p_key;
  IF jsonb_typeof(v_raw) IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('value', p_default, 'invalid', jsonb_build_object(
      'key', p_key, 'given', v_raw, 'reason', 'wrong_type', 'used', p_default));
  END IF;
  -- The threshold reader's own integer rule: digits, optionally .0.
  IF p_integer AND (v_raw #>> '{}') !~ '^-?[0-9]{1,9}(\.0+)?$' THEN
    RETURN jsonb_build_object('value', p_default, 'invalid', jsonb_build_object(
      'key', p_key, 'given', v_raw, 'reason', 'not_an_integer', 'used', p_default));
  END IF;
  v := (v_raw #>> '{}')::numeric;
  IF p_integer THEN v := trunc(v); END IF;
  IF v < p_lo OR v > p_hi THEN
    v_use := LEAST(GREATEST(v, p_lo), p_hi);
    RETURN jsonb_build_object('value', v_use, 'invalid', jsonb_build_object(
      'key', p_key, 'given', v_raw, 'reason', 'out_of_range_clamped', 'used', v_use,
      'range', jsonb_build_array(p_lo, p_hi)));
  END IF;
  RETURN jsonb_build_object('value', v);
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_config(p_cluster_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g          record;
  v_cfg      jsonb;
  v_inv      jsonb := '[]'::jsonb;
  v_thr      jsonb;
  v_on       integer;
  v_off      integer;
  v_size     integer;
  r          jsonb;
  v_text     text;
  v_version  text;
  v_mode     text;
  v_rule     text;
  v_p3       boolean;
  v_interval integer;
  v_budget   integer;
  v_keep     integer;
  v_max      integer;
  v_target   integer;
  v_min      integer;
  v_ttl      integer;
  v_form     integer;
  v_deal     integer;
  v_win_h    integer;
  v_win_s    integer;
  v_thin     integer;
  v_medium   integer;
  v_large    integer;
  v_w_large  numeric;
  v_w_medium numeric;
  v_mtl      integer;
  v_batch    integer;
  v_replans  integer;
BEGIN
  SELECT cg.id, cg.handedness, cg.ruleset_snapshot INTO g
    FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'cluster_id', p_cluster_id);
  END IF;

  v_cfg := g.ruleset_snapshot -> 'lightning';
  IF v_cfg IS NULL OR jsonb_typeof(v_cfg) = 'null' THEN
    v_cfg := '{}'::jsonb;
  ELSIF jsonb_typeof(v_cfg) <> 'object' THEN
    v_inv := v_inv || jsonb_build_object('key', 'lightning', 'given', v_cfg, 'reason', 'not_an_object');
    v_cfg := '{}'::jsonb;
  END IF;

  -- THE POPULATION'S OWN THRESHOLD READER, not a second copy of its rule.
  v_thr := public.fn_cash_cluster_lightning_thresholds(g.id);
  v_on  := (v_thr ->> 'on')::integer;
  v_off := (v_thr ->> 'off')::integer;
  v_size := LEAST(GREATEST(coalesce(g.handedness, 6), 2), 9);

  -- matcher_version: a short name, recorded on every hand.
  v_version := 'm1';
  IF v_cfg ? 'matcher_version' AND jsonb_typeof(v_cfg -> 'matcher_version') <> 'null' THEN
    v_text := CASE WHEN jsonb_typeof(v_cfg -> 'matcher_version') = 'string' THEN v_cfg ->> 'matcher_version' END;
    IF v_text IS NOT NULL AND v_text ~ '^[A-Za-z0-9._:-]{1,32}$' THEN
      v_version := v_text;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'matcher_version', 'given', v_cfg -> 'matcher_version',
                                           'reason', 'not_a_version_name', 'used', v_version);
    END IF;
  END IF;

  -- worker_mode: off (the default: the worker does nothing), shadow (plans
  -- and compares, forms nothing) or form.
  v_mode := 'off';
  IF v_cfg ? 'worker_mode' AND jsonb_typeof(v_cfg -> 'worker_mode') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'worker_mode') = 'string' AND (v_cfg ->> 'worker_mode') IN ('off', 'shadow', 'form') THEN
      v_mode := v_cfg ->> 'worker_mode';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'worker_mode', 'given', v_cfg -> 'worker_mode',
                                           'reason', 'not_off_shadow_or_form', 'used', v_mode);
    END IF;
  END IF;

  -- first_entry_rule: any_seat (the default) or big_blind (a player new to
  -- the Cluster's blind ledger is dealt in only as a big blind, while that
  -- does not cost the pass a hand).
  v_rule := 'any_seat';
  IF v_cfg ? 'first_entry_rule' AND jsonb_typeof(v_cfg -> 'first_entry_rule') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'first_entry_rule') = 'string' AND (v_cfg ->> 'first_entry_rule') IN ('any_seat', 'big_blind') THEN
      v_rule := v_cfg ->> 'first_entry_rule';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'first_entry_rule', 'given', v_cfg -> 'first_entry_rule',
                                           'reason', 'not_any_seat_or_big_blind', 'used', v_rule);
    END IF;
  END IF;

  -- position_fairness: P3 on or off. Advisory either way.
  v_p3 := true;
  IF v_cfg ? 'position_fairness' AND jsonb_typeof(v_cfg -> 'position_fairness') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'position_fairness') = 'boolean' THEN
      v_p3 := (v_cfg ->> 'position_fairness')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'position_fairness', 'given', v_cfg -> 'position_fairness',
                                           'reason', 'wrong_type', 'used', v_p3);
    END IF;
  END IF;

  r := public.fn_lightning_config_number(v_cfg, 'pass_interval_ms', 1000, 100, 60000, true);
  v_interval := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  r := public.fn_lightning_config_number(v_cfg, 'pass_time_budget_ms', LEAST(750, v_interval), 50, v_interval, true);
  v_budget := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  r := public.fn_lightning_config_number(v_cfg, 'keepalive_interval_ms', 5000, 500, 60000, true);
  v_keep := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- INSTANCE SIZE: the table size is the maximum and the target; the minimum
  -- is two, because a one-player Lightning instance must never exist.
  r := public.fn_lightning_config_number(v_cfg, 'instance_max', v_size, 2, v_size, true);
  v_max := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'instance_target', v_max, 2, v_max, true);
  v_target := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'instance_min', 2, 2, v_target, true);
  v_min := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- The barrier's and begin_dealing's own defaults and floors.
  r := public.fn_lightning_config_number(v_cfg, 'reservation_ttl_ms', 20000, 5000, 120000, true);
  v_ttl := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'form_window_ms', 45000, 5000, 300000, true);
  v_form := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'deal_window_ms', 600000, 30000, 3600000, true);
  v_deal := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- P5's memory: the Cluster's most recent hands, no older than the seconds.
  r := public.fn_lightning_config_number(v_cfg, 'recent_opponent_window_hands', 60, 1, 5000, true);
  v_win_h := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'recent_opponent_window_seconds', 900, 1, 86400, true);
  v_win_s := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- POOL-SIZE BANDS, by legal count: tiny below thin_min, thin below
  -- medium_min, medium below large_min, large from large_min. Defaults from
  -- the population's thresholds: OFF, ON and twice ON.
  r := public.fn_lightning_config_number(v_cfg, 'diversity_thin_min', v_off, 2, 100000, true);
  v_thin := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'diversity_medium_min', v_on, 2, 100000, true);
  v_medium := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'diversity_large_min', 2 * v_on, 2, 100000, true);
  v_large := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  IF NOT (v_thin <= v_medium AND v_medium <= v_large) THEN
    v_inv := v_inv || jsonb_build_object('key', 'diversity_bands',
      'given', jsonb_build_array(v_thin, v_medium, v_large), 'reason', 'bands_out_of_order',
      'used', jsonb_build_array(v_off, v_on, 2 * v_on));
    v_thin := v_off; v_medium := v_on; v_large := 2 * v_on;
  END IF;

  r := public.fn_lightning_config_number(v_cfg, 'diversity_weight_large', 1, 0, 1, false);
  v_w_large := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'diversity_weight_medium', 0.5, 0, 1, false);
  v_w_medium := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- Thin and tiny are zero by rule, not by default: a thin pool prioritises
  -- formation and a tiny one makes the hand if it is legal.
  IF v_cfg ? 'diversity_weight_thin' THEN
    v_inv := v_inv || jsonb_build_object('key', 'diversity_weight_thin', 'given', v_cfg -> 'diversity_weight_thin',
                                         'reason', 'zero_by_rule', 'used', 0);
  END IF;
  IF v_cfg ? 'diversity_weight_tiny' THEN
    v_inv := v_inv || jsonb_build_object('key', 'diversity_weight_tiny', 'given', v_cfg -> 'diversity_weight_tiny',
                                         'reason', 'zero_by_rule', 'used', 0);
  END IF;

  r := public.fn_lightning_config_number(v_cfg, 'multi_table_limit', 4, 1, 24, true);
  v_mtl := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- The admission batch: the most hands one pass forms, so a join burst is
  -- admitted in deterministic micro-batches rather than all at once.
  r := public.fn_lightning_config_number(v_cfg, 'admission_batch_hands', 32, 1, 500, true);
  v_batch := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'max_replans', 3, 0, 20, true);
  v_replans := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'cluster_id', g.id,
    'handedness', g.handedness,
    'matcher_version', v_version,
    'worker_mode', v_mode,
    'pass_interval_ms', v_interval,
    'pass_time_budget_ms', v_budget,
    'keepalive_interval_ms', v_keep,
    'instance_min', v_min,
    'instance_target', v_target,
    'instance_max', v_max,
    'reservation_ttl_ms', v_ttl,
    'form_window_ms', v_form,
    'deal_window_ms', v_deal,
    'recent_opponent_window_hands', v_win_h,
    'recent_opponent_window_seconds', v_win_s,
    'diversity_thin_min', v_thin,
    'diversity_medium_min', v_medium,
    'diversity_large_min', v_large,
    'diversity_weight_large', v_w_large,
    'diversity_weight_medium', v_w_medium,
    'diversity_weight_thin', 0,
    'diversity_weight_tiny', 0,
    'multi_table_limit', v_mtl,
    'admission_batch_hands', v_batch,
    'max_replans', v_replans,
    'first_entry_rule', v_rule,
    'position_fairness', v_p3,
    'on_threshold', v_on,
    'off_threshold', v_off,
    'threshold_source', v_thr ->> 'source',
    'invalid', v_inv);
END
$fn$;

-- ===========================================================================
-- SECTION 4. P0: LEGALITY. One ordered CASE, one first-failing reason.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_player_legality(
  p_cluster_id   uuid,
  p_now          timestamp with time zone,
  p_disconnected uuid[])
RETURNS TABLE (
  player_id       uuid,
  pool_session_id uuid,
  pool_slot_id    uuid,
  legal           boolean,
  reason_code     text,
  detail          jsonb)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  -- MATERIALIZED, twice: an inlined CTE substitutes its expressions into
  -- every reference, which would ask the configuration once per player and
  -- run the whole reason chain once per use of its answer.
  WITH g AS MATERIALIZED (
    SELECT cg.id AS cluster_id, cg.cluster_mode, coalesce(cg.lightning_enabled, false) AS enabled,
           cg.cluster_epoch,
           EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                    WHERE e.cluster_id = cg.id AND e.epoch = cg.cluster_epoch AND e.ended_at IS NULL) AS epoch_open,
           public.fn_platform_frozen() AS platform_frozen,
           -- THE SEAT DOOR'S GATE: fn_ca_refuse_restricted_entry refuses only
           -- when the operator policy enforces restrictions, and otherwise
           -- only observes. The matcher follows the door.
           coalesce((SELECT op.restrictions_enforced FROM public.ca_operator_policy op LIMIT 1), false) AS restrictions_enforced,
           (public.fn_lightning_config(cg.id) ->> 'multi_table_limit')::integer AS multi_table_limit
      FROM public.cash_games cg
     WHERE cg.id = p_cluster_id
  ), f AS (
    SELECT g.cluster_id, g.cluster_mode, g.enabled, g.cluster_epoch, g.epoch_open, g.platform_frozen,
           g.restrictions_enforced, g.multi_table_limit,
           ps.player_id, ps.id AS pool_session_id, ps.state AS pool_state, ps.cluster_epoch AS pool_epoch,
           ps.anchor_seat_id,
           sl.id AS slot_id, sl.cluster_epoch AS slot_epoch, sl.pool_session_id AS slot_session_id,
           cps.id AS cash_session_id, cps.closed_at AS cash_session_closed_at,
           ts.id AS seat_id, ts.left_at AS seat_left_at, ts.user_id AS seat_user_id,
           coalesce(ts.is_sitting_out, false) AS seat_sitting_out,
           coalesce(ts.leave_pending, false) AS seat_leave_pending,
           tb.cluster_id AS seat_cluster_id, coalesce(tb.is_deleted, false) AS table_deleted,
           coalesce(tb.lifecycle, '') AS table_lifecycle
      FROM g
      JOIN public.lightning_pool_session ps
        ON ps.cluster_id = g.cluster_id AND ps.exited_at IS NULL
      LEFT JOIN public.lightning_pool_slot sl
        ON sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id AND sl.closed_at IS NULL
      LEFT JOIN public.cash_player_session cps ON cps.id = ps.cash_player_session_id
      LEFT JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
      LEFT JOIN public.tables tb ON tb.id = ts.table_id
  ), c AS MATERIALIZED (
    SELECT f.*, CASE
        WHEN coalesce(f.cluster_mode, '') NOT IN ('lightning', 'frozen', 'paused') THEN 'CLUSTER_NOT_LIGHTNING'
        WHEN f.cluster_mode IN ('frozen', 'paused') THEN 'CLUSTER_FROZEN'
        WHEN NOT f.enabled THEN 'LIGHTNING_DISABLED'
        WHEN f.platform_frozen THEN 'PLATFORM_FROZEN'
        WHEN f.pool_epoch IS DISTINCT FROM f.cluster_epoch OR NOT f.epoch_open THEN 'WRONG_EPOCH'
        WHEN f.cash_session_id IS NULL OR f.cash_session_closed_at IS NOT NULL
             OR f.pool_state = 'closed' THEN 'SESSION_CLOSED'
        WHEN f.pool_state IN ('joining', 'eligibility_check') THEN 'POOL_SESSION_NOT_ACTIVE'
        WHEN f.pool_state = 'leaving' OR f.seat_leave_pending THEN 'CASHOUT_PENDING'
        WHEN f.seat_id IS NULL OR f.seat_left_at IS NOT NULL
             OR f.seat_user_id IS DISTINCT FROM f.player_id
             OR f.seat_cluster_id IS DISTINCT FROM f.cluster_id
             OR f.table_deleted OR f.table_lifecycle = 'closed' THEN 'ANCHOR_LEFT'
        WHEN f.pool_state = 'sit_out' OR f.seat_sitting_out THEN 'SITTING_OUT'
        WHEN coalesce(public.fn_lightning_pool_stack(f.pool_session_id), 0) <= 0 THEN 'NO_STACK'
        -- THE POPULATION'S PREDICATE HAS THE LAST WORD ON THE ANCHOR: anything
        -- it refuses that the four arms above did not name is still refused.
        WHEN NOT public.fn_lightning_anchor_is_live_eligible(f.anchor_seat_id, f.cluster_id, f.player_id) THEN 'ANCHOR_LEFT'
        WHEN f.restrictions_enforced AND public.fn_ca_player_restricted(f.player_id, 'cash') THEN 'RESTRICTED'
        WHEN (public.fn_rg_require_not_excluded(f.player_id) ->> 'ok')::boolean IS DISTINCT FROM true THEN 'RG_EXCLUDED'
        WHEN f.pool_state = 'disconnected'
             OR f.player_id = ANY (coalesce(p_disconnected, ARRAY[]::uuid[])) THEN 'DISCONNECTED'
        WHEN f.pool_state IS DISTINCT FROM 'active' THEN 'POOL_SESSION_NOT_ACTIVE'
        WHEN EXISTS (SELECT 1 FROM public.lightning_reservation r
                      WHERE r.cluster_id = f.cluster_id AND r.player_id = f.player_id
                        AND r.state IN ('pending', 'committed'))
             AND NOT public.fn_lightning_player_in_hand(f.player_id, f.cluster_id) THEN 'ALREADY_RESERVED'
        WHEN public.fn_lightning_player_in_hand(f.player_id, f.cluster_id) THEN 'IN_HAND'
        WHEN f.slot_id IS NULL OR f.slot_epoch IS DISTINCT FROM f.cluster_epoch
             OR f.slot_session_id IS DISTINCT FROM f.pool_session_id THEN 'SLOT_NOT_OPEN'
        WHEN (SELECT count(DISTINCT r.cluster_id)
                FROM public.lightning_reservation r
                JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
               WHERE r.player_id = f.player_id AND r.cluster_id <> f.cluster_id
                 AND r.state = 'committed'
                 AND i.state IN ('forming', 'reserved', 'dealing', 'settling')) >= f.multi_table_limit THEN 'MULTI_TABLE_LIMIT'
      END AS code
      FROM f
  )
  SELECT c.player_id, c.pool_session_id, c.slot_id,
         c.code IS NULL,
         c.code,
         jsonb_strip_nulls(jsonb_build_object(
           'cluster_mode', c.cluster_mode, 'cluster_epoch', c.cluster_epoch,
           'pool_epoch', c.pool_epoch, 'slot_epoch', c.slot_epoch, 'pool_state', c.pool_state,
           'anchor_seat_id', c.anchor_seat_id))
         || CASE c.code
              WHEN 'RG_EXCLUDED' THEN jsonb_build_object('responsible_gaming', public.fn_rg_require_not_excluded(c.player_id))
              WHEN 'RESTRICTED' THEN jsonb_build_object('restriction_scope', 'cash',
                'restriction_reason', (public.fn_ca_player_restriction_for(c.player_id, 'cash')).reason_code)
              WHEN 'MULTI_TABLE_LIMIT' THEN jsonb_build_object('multi_table_limit', c.multi_table_limit,
                'live_hands_elsewhere', (SELECT count(DISTINCT r.cluster_id)
                                           FROM public.lightning_reservation r
                                           JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
                                          WHERE r.player_id = c.player_id AND r.cluster_id <> c.cluster_id
                                            AND r.state = 'committed'
                                            AND i.state IN ('forming', 'reserved', 'dealing', 'settling')))
              WHEN 'DISCONNECTED' THEN jsonb_build_object('reported_disconnected',
                c.player_id = ANY (coalesce(p_disconnected, ARRAY[]::uuid[])))
              ELSE '{}'::jsonb
            END
    FROM c
   ORDER BY c.player_id;
$fn$;

-- ===========================================================================
-- SECTION 5. P1: GROUP SIZES. Pure arithmetic, so it can be proved for every
-- count.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_group_sizes(
  p_legal  integer,
  p_min    integer,
  p_target integer,
  p_max    integer)
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_max    integer := LEAST(GREATEST(coalesce(p_max, 2), 2), 9);
  v_min    integer;
  v_target integer;
  v_n      integer := GREATEST(coalesce(p_legal, 0), 0);
  v_lo     integer;
  v_hi     integer;
  v_k      integer;
  v_best   numeric;
  v_d      numeric;
  v_seat   integer;
  v_q      integer;
  v_r      integer;
  k        integer;
  v_out    integer[] := ARRAY[]::integer[];
BEGIN
  v_min    := LEAST(GREATEST(coalesce(p_min, 2), 2), v_max);
  v_target := LEAST(GREATEST(coalesce(p_target, v_max), v_min), v_max);
  -- Fewer legal players than the smallest hand: no hand, never a lone seat.
  IF v_n < v_min THEN
    RETURN v_out;
  END IF;
  v_lo := ceil(v_n::numeric / v_max)::integer;   -- fewest groups that fit everyone under max
  v_hi := floor(v_n::numeric / v_min)::integer;  -- most groups that keep everyone at min or more
  IF v_lo <= v_hi THEN
    -- Everyone is seated. Among the feasible group counts, the one whose
    -- average size is closest to the target; a tie keeps the fewer groups
    -- (P6: no unnecessary instance).
    v_k := v_lo;
    v_best := abs(v_n::numeric / v_lo - v_target);
    FOR k IN v_lo + 1 .. v_hi LOOP
      v_d := abs(v_n::numeric / k - v_target);
      IF v_d < v_best THEN
        v_best := v_d;
        v_k := k;
      END IF;
    END LOOP;
    v_seat := v_n;
  ELSE
    -- No split seats everyone (a configured minimum above two can cause it):
    -- the most players that can be seated, in full groups.
    v_k := v_hi;
    v_seat := v_hi * v_max;
  END IF;
  v_q := v_seat / v_k;
  v_r := v_seat % v_k;
  FOR k IN 1 .. v_k LOOP
    v_out := v_out || (v_q + CASE WHEN k <= v_r THEN 1 ELSE 0 END);
  END LOOP;
  RETURN v_out;
END
$fn$;

-- ===========================================================================
-- SECTION 6. THE PLANNER. Reads everything, writes nothing.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_match_plan(
  p_cluster_id      uuid,
  p_now             timestamp with time zone,
  p_disconnected    uuid[],
  p_matcher_version text,
  p_max_groups      integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_now       timestamptz := coalesce(p_now, now());
  v_cfg       jsonb;
  v_version   text;
  v_epoch     integer;
  v_min       integer;
  v_target    integer;
  v_max       integer;
  v_cap       integer;
  v_rule      text;
  v_p3        boolean;
  v_rows      jsonb;
  v_info      jsonb := '{}'::jsonb;
  v_legal     uuid[] := ARRAY[]::uuid[];
  v_newcomer  uuid[] := ARRAY[]::uuid[];
  v_seatable  uuid[];
  v_next      uuid[];
  v_held      uuid[] := ARRAY[]::uuid[];
  v_sizes     integer[];
  v_sizes2    integer[];
  v_g         integer;
  v_g2        integer;
  v_bbs       uuid[];
  v_rest_all  uuid[];
  v_rest      uuid[];
  v_sbs       uuid[];
  v_wait      uuid[];
  v_need      integer;
  v_sizing_left integer;
  v_n         integer;
  v_band      text;
  v_w         numeric;
  v_enc       jsonb := '{}'::jsonb;
  v_recent_sets jsonb := '{}'::jsonb;
  v_grp       jsonb;
  v_capleft   integer[];
  v_moved     integer[];
  v_default   integer;
  v_best      integer;
  v_best_pen  integer;
  v_def_pen   integer;
  pen         record;
  p           uuid;
  j           integer;
  v_members   uuid[];
  v_bb        uuid;
  v_sb        uuid;
  v_order     uuid[];
  v_left      uuid[];
  v_pick      uuid;
  v_label     text;
  v_size      integer;
  v_seat_no   integer;
  v_groups    jsonb := '[]'::jsonb;
  v_diag      jsonb;
  v_pairs     integer := 0;
  v_repeat_pairs integer := 0;
  v_gpairs    integer;
  v_grepeat   integer;
  v_genc      integer;
  v_matched   uuid[] := ARRAY[]::uuid[];
  v_capacity_reason text;
  v_win_h     integer;
  v_win_s     integer;
BEGIN
  v_cfg := public.fn_lightning_config(p_cluster_id);
  v_version := coalesce(nullif(btrim(coalesce(p_matcher_version, '')), ''), v_cfg ->> 'matcher_version', 'm1');
  SELECT cg.cluster_epoch INTO v_epoch FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF coalesce((v_cfg ->> 'ok')::boolean, false) IS DISTINCT FROM true OR v_epoch IS NULL THEN
    RETURN jsonb_build_object('matcher_version', v_version, 'generated_at', v_now, 'legal_count', 0,
                              'groups', '[]'::jsonb, 'diagnosis', '[]'::jsonb, 'pool_diversity_score', 1);
  END IF;
  v_min    := (v_cfg ->> 'instance_min')::integer;
  v_target := (v_cfg ->> 'instance_target')::integer;
  v_max    := (v_cfg ->> 'instance_max')::integer;
  v_rule   := v_cfg ->> 'first_entry_rule';
  v_p3     := (v_cfg ->> 'position_fairness')::boolean;
  v_win_h  := (v_cfg ->> 'recent_opponent_window_hands')::integer;
  v_win_s  := (v_cfg ->> 'recent_opponent_window_seconds')::integer;
  v_cap    := LEAST(GREATEST(coalesce(p_max_groups, (v_cfg ->> 'admission_batch_hands')::integer), 0),
                    (v_cfg ->> 'admission_batch_hands')::integer);

  -- P0, once. Every open-pool player, ordered by player_id.
  SELECT coalesce(jsonb_agg(jsonb_build_object('player_id', l.player_id, 'legal', l.legal,
                                               'reason_code', l.reason_code) ORDER BY l.player_id), '[]'::jsonb)
    INTO v_rows
    FROM public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected) l;

  -- THE KEYS OF EVERY LEGAL PLAYER. P2 is the barrier's own order; P4 is
  -- idle_since, pool entry, Cluster join, player_id.
  WITH lg AS (
    SELECT (x ->> 'player_id')::uuid AS pid
      FROM jsonb_array_elements(v_rows) x
     WHERE (x ->> 'legal')::boolean
  ), bo AS (
    SELECT b.* FROM public.fn_lightning_blind_order(p_cluster_id, v_epoch,
                      coalesce((SELECT array_agg(lg.pid) FROM lg), ARRAY[]::uuid[])) b
  ), k AS (
    SELECT bo.p2_rank, bo.player_id, bo.pool_slot_id, bo.bb_unresolved, bo.last_bb_at, bo.debt_age,
           sl.idle_since, ps.entered_at, cps.opened_at AS joined_at,
           (bl.player_id IS NULL) AS newcomer,
           coalesce(bl.btn_count, 0) AS btn, coalesce(bl.co_count, 0) AS co,
           coalesce(bl.hj_count, 0) AS hj, coalesce(bl.utg_count, 0) AS utg,
           row_number() OVER (ORDER BY sl.idle_since, ps.entered_at, cps.opened_at, bo.player_id) AS p4
      FROM bo
      JOIN public.lightning_pool_slot sl ON sl.id = bo.pool_slot_id
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
      LEFT JOIN public.cash_player_session cps ON cps.id = ps.cash_player_session_id
      LEFT JOIN public.lightning_blind_ledger bl ON bl.cluster_id = sl.cluster_id AND bl.player_id = sl.player_id
  )
  SELECT coalesce(array_agg(k.player_id ORDER BY k.p2_rank), ARRAY[]::uuid[]),
         coalesce(array_agg(k.player_id ORDER BY k.p2_rank) FILTER (WHERE k.newcomer), ARRAY[]::uuid[]),
         coalesce(jsonb_object_agg(k.player_id::text, jsonb_build_object(
           'p2', k.p2_rank, 'p4', k.p4, 'slot', k.pool_slot_id,
           'bb_unresolved', k.bb_unresolved, 'last_bb_at', k.last_bb_at, 'debt_age', k.debt_age,
           'idle_since', k.idle_since, 'entered_at', k.entered_at, 'joined_at', k.joined_at,
           'btn', k.btn, 'co', k.co, 'hj', k.hj, 'utg', k.utg)), '{}'::jsonb)
    INTO v_legal, v_newcomer, v_info
    FROM k;

  v_n := cardinality(v_legal);

  -- P5's band, by the legal count.
  v_band := CASE WHEN v_n >= (v_cfg ->> 'diversity_large_min')::integer THEN 'large'
                 WHEN v_n >= (v_cfg ->> 'diversity_medium_min')::integer THEN 'medium'
                 WHEN v_n >= (v_cfg ->> 'diversity_thin_min')::integer THEN 'thin'
                 ELSE 'tiny' END;
  v_w := CASE v_band WHEN 'large' THEN (v_cfg ->> 'diversity_weight_large')::numeric
                     WHEN 'medium' THEN (v_cfg ->> 'diversity_weight_medium')::numeric
                     ELSE 0 END;

  -- P1: sizes from the legal count. P2: the first g legal players in P2
  -- order are the g big blinds.
  v_seatable := v_legal;
  v_sizes := public.fn_lightning_group_sizes(cardinality(v_seatable), v_min, v_target, v_max);
  v_g := LEAST(cardinality(v_sizes), v_cap);

  -- THE FIRST-ENTRY RULE, when configured: a player new to the Cluster's
  -- ledger waits to be dealt in as a big blind - but only while holding them
  -- costs the pass no hand (P1 outranks it).
  IF v_rule = 'big_blind' AND v_g > 0 THEN
    v_bbs := v_seatable[1:v_g];
    v_next := ARRAY(SELECT u.pid FROM unnest(v_seatable) WITH ORDINALITY u(pid, ord)
                     WHERE NOT (u.pid = ANY (v_newcomer)) OR u.pid = ANY (v_bbs)
                     ORDER BY u.ord);
    IF cardinality(v_next) < cardinality(v_seatable) THEN
      v_sizes2 := public.fn_lightning_group_sizes(cardinality(v_next), v_min, v_target, v_max);
      v_g2 := LEAST(cardinality(v_sizes2), v_cap);
      IF v_g2 = v_g THEN
        v_held := ARRAY(SELECT u.pid FROM unnest(v_seatable) WITH ORDINALITY u(pid, ord)
                         WHERE NOT (u.pid = ANY (v_next)) ORDER BY u.ord);
        v_seatable := v_next;
        v_sizes := v_sizes2;
      END IF;
    END IF;
  END IF;

  v_bbs := CASE WHEN v_g > 0 THEN v_seatable[1:v_g] ELSE ARRAY[]::uuid[] END;

  -- P4: the non-blind seats of this pass go to the non-blind seatable
  -- players in queue order; the rest wait for formation.
  v_rest_all := ARRAY(SELECT u.pid FROM unnest(v_seatable) u(pid)
                       WHERE NOT (u.pid = ANY (v_bbs))
                       ORDER BY (v_info -> u.pid::text ->> 'p4')::integer);
  v_need := coalesce((SELECT sum(s) FROM unnest(v_sizes[1:v_g]) s), 0)::integer - v_g;
  v_rest := v_rest_all[1:v_need];
  v_wait := coalesce(v_rest_all[v_need + 1:cardinality(v_rest_all)], ARRAY[]::uuid[]);
  v_sizing_left := cardinality(v_seatable) - coalesce((SELECT sum(s) FROM unnest(v_sizes) s), 0)::integer;

  -- P5's MEMORY: pair encounters among this pass's seated players in the
  -- Cluster's most recent hands, and the recent full-table compositions.
  IF v_g > 0 THEN
    WITH recent AS (
      SELECT h.hand_id
        FROM public.lightning_hand h
       WHERE h.cluster_id = p_cluster_id AND h.cluster_epoch = v_epoch
         AND h.formed_at <= v_now
         AND h.formed_at > v_now - make_interval(secs => v_win_s)
       ORDER BY h.formed_at DESC, h.hand_id
       LIMIT v_win_h
    ), hp AS (
      SELECT hp.hand_id, hp.player_id
        FROM recent JOIN public.lightning_hand_player hp ON hp.hand_id = recent.hand_id
    )
    SELECT coalesce((SELECT jsonb_object_agg(q.pair, q.n)
                       FROM (SELECT a.player_id::text || '/' || b.player_id::text AS pair, count(*)::integer AS n
                               FROM hp a JOIN hp b ON b.hand_id = a.hand_id AND a.player_id < b.player_id
                              WHERE a.player_id = ANY (v_bbs || v_rest) AND b.player_id = ANY (v_bbs || v_rest)
                              GROUP BY a.player_id, b.player_id) q), '{}'::jsonb),
           coalesce((SELECT jsonb_object_agg(s.members, true)
                       FROM (SELECT DISTINCT string_agg(hp.player_id::text, ',' ORDER BY hp.player_id) AS members
                               FROM hp GROUP BY hp.hand_id) s), '{}'::jsonb)
      INTO v_enc, v_recent_sets;
  END IF;

  -- P2 FOR THE SMALL BLIND: of the players seated this pass, the next g in
  -- P2 order are the small blinds, one to a group - the classical orbit, in
  -- which the small blind is the player next due for the big blind. Every one
  -- of them is seated this pass either way, so which group each sits in is a
  -- choice among P4-equivalents; and each ranks above every other non-blind
  -- member of its group, so the barrier's own P2-second is this player.
  v_sbs := ARRAY(SELECT u.pid FROM unnest(v_rest) u(pid)
                  ORDER BY (v_info -> u.pid::text ->> 'p2')::integer LIMIT v_g);
  v_rest := ARRAY(SELECT u.pid FROM unnest(v_rest) WITH ORDINALITY u(pid, ord)
                   WHERE NOT (u.pid = ANY (v_sbs)) ORDER BY u.ord);

  -- THE ASSIGNMENT. Each group starts with its big and small blinds; each
  -- other seated player, in P4 order, goes to the first group with room
  -- (plain P4) unless P5 saves weight x encounters >= 1 elsewhere.
  v_grp := '[]'::jsonb;
  v_capleft := ARRAY[]::integer[];
  v_moved := ARRAY[]::integer[];
  FOR j IN 1 .. v_g LOOP
    v_grp := v_grp || jsonb_build_array(jsonb_build_array(v_bbs[j], v_sbs[j]));
    v_capleft := v_capleft || (v_sizes[j] - 2);
    v_moved := v_moved || 0;
  END LOOP;

  FOREACH p IN ARRAY coalesce(v_rest, ARRAY[]::uuid[]) LOOP
    v_default := NULL;
    FOR j IN 1 .. v_g LOOP
      IF v_capleft[j] > 0 THEN v_default := j; EXIT; END IF;
    END LOOP;
    v_best := v_default;
    IF v_w > 0 AND v_enc <> '{}'::jsonb THEN
      v_def_pen := NULL;
      v_best_pen := NULL;
      FOR pen IN
        SELECT t.j::integer AS j,
               coalesce(sum(coalesce((v_enc ->> (LEAST(p, m.pid::uuid)::text || '/' || GREATEST(p, m.pid::uuid)::text))::integer, 0)), 0)::integer AS n
          FROM jsonb_array_elements(v_grp) WITH ORDINALITY t(arr, j)
          CROSS JOIN LATERAL jsonb_array_elements_text(t.arr) m(pid)
         GROUP BY t.j
         ORDER BY t.j
      LOOP
        IF v_capleft[pen.j] > 0 THEN
          IF pen.j = v_default THEN v_def_pen := pen.n; END IF;
          IF v_best_pen IS NULL OR pen.n < v_best_pen THEN
            v_best_pen := pen.n;
            v_best := pen.j;
          END IF;
        END IF;
      END LOOP;
      IF NOT (v_w * (v_def_pen - v_best_pen) >= 1) THEN
        v_best := v_default;
      END IF;
    END IF;
    v_grp := jsonb_set(v_grp, ARRAY[(v_best - 1)::text], (v_grp -> (v_best - 1)) || to_jsonb(p));
    v_capleft[v_best] := v_capleft[v_best] - 1;
    IF v_best <> v_default THEN v_moved[v_best] := v_moved[v_best] + 1; END IF;
  END LOOP;

  -- EACH GROUP: P3's advisory order of the non-blind seats, and the evidence.
  FOR j IN 1 .. v_g LOOP
    v_bb := v_bbs[j];
    v_members := ARRAY(SELECT m.pid::uuid FROM jsonb_array_elements_text(v_grp -> (j - 1)) m(pid));
    -- The small blind, placed above; the barrier's own P2-second in the group.
    v_sb := v_sbs[j];
    -- P3, ADVISORY, AND ONLY THE ORDER OF THE NON-BLIND SEATS. The barrier
    -- seats the caller's order from seat 3 onward and names the positions by
    -- seat (the last is the button, then the cut-off, the hijack, and seat 3
    -- under-the-gun). Filled from the button backward, each seat goes to the
    -- remaining member who has held that position least; a tie - and every
    -- seat when P3 is off - keeps queue order.
    v_left := ARRAY(SELECT m FROM unnest(v_members) m
                     WHERE m <> v_bb AND m IS DISTINCT FROM v_sb
                     ORDER BY (v_info -> m::text ->> 'p4')::integer);
    v_order := ARRAY[]::uuid[];
    v_size := cardinality(v_members);
    FOR v_seat_no IN REVERSE v_size .. 3 LOOP
      v_label := CASE WHEN v_seat_no = v_size THEN 'btn'
                      WHEN v_seat_no = v_size - 1 THEN 'co'
                      WHEN v_seat_no = v_size - 2 THEN 'hj'
                      WHEN v_seat_no = 3 THEN 'utg'
                      ELSE NULL END;
      SELECT u.m INTO v_pick FROM unnest(v_left) WITH ORDINALITY u(m, o)
       ORDER BY CASE WHEN v_p3 AND v_label IS NOT NULL THEN (v_info -> u.m::text ->> v_label)::integer ELSE 0 END,
                u.o DESC
       LIMIT 1;
      v_order := v_pick || v_order;
      v_left := array_remove(v_left, v_pick);
    END LOOP;
    SELECT count(*)::integer,
           coalesce(sum(CASE WHEN coalesce((v_enc ->> (a.m::text || '/' || b.m::text))::integer, 0) > 0 THEN 1 ELSE 0 END), 0)::integer,
           coalesce(sum(coalesce((v_enc ->> (a.m::text || '/' || b.m::text))::integer, 0)), 0)::integer
      INTO v_gpairs, v_grepeat, v_genc
      FROM unnest(v_members) a(m) JOIN unnest(v_members) b(m) ON a.m < b.m;
    v_pairs := v_pairs + v_gpairs;
    v_repeat_pairs := v_repeat_pairs + v_grepeat;
    v_matched := v_matched || v_members;
    v_groups := v_groups || jsonb_build_array(jsonb_build_object(
      'players', to_jsonb(ARRAY[v_bb] || CASE WHEN v_sb IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_sb] END || v_order),
      'bb', v_bb,
      'keys', jsonb_build_object(
        'size', cardinality(v_members),
        'instance', jsonb_build_object('min', v_min, 'target', v_target, 'max', v_max),
        'p2', jsonb_build_object('bb', v_bb, 'bb_p2_rank', (v_info -> v_bb::text -> 'p2'),
                                 'bb_unresolved', (v_info -> v_bb::text -> 'bb_unresolved'),
                                 'bb_last_bb_at', (v_info -> v_bb::text -> 'last_bb_at'),
                                 'bb_debt_age', (v_info -> v_bb::text -> 'debt_age'),
                                 'sb', v_sb, 'sb_p2_rank', (v_info -> v_sb::text -> 'p2')),
        -- Heads-up, the small blind is the button (the barrier's own rule).
        'p3', jsonb_build_object('applied', v_p3,
                                 'btn', coalesce(v_order[cardinality(v_order)], v_sb),
                                 'btn_count_before', (v_info -> (coalesce(v_order[cardinality(v_order)], v_sb))::text -> 'btn'),
                                 'order', to_jsonb(v_order)),
        'p4', jsonb_build_object('ranks', (SELECT jsonb_agg((v_info -> m::text -> 'p4') ORDER BY (v_info -> m::text ->> 'p4')::integer)
                                             FROM unnest(v_members) m WHERE m <> v_bb),
                                 'oldest_idle_since', (SELECT min((v_info -> m::text ->> 'idle_since')::timestamptz)
                                                         FROM unnest(v_members) m)),
        'p5', jsonb_build_object('band', v_band, 'weight', v_w, 'pairs', v_gpairs,
                                 'repeat_pairs', v_grepeat, 'pair_encounters', v_genc,
                                 'moved_here', v_moved[j],
                                 'repeat_full_table', v_recent_sets ? (SELECT string_agg(m::text, ',' ORDER BY m) FROM unnest(v_members) m)),
        'p6', jsonb_build_object('new_instance', true, 'merged_into_committed_hand', false))));
  END LOOP;

  -- THE DIAGNOSIS: every open-pool player, exactly once.
  v_capacity_reason := CASE WHEN v_g < cardinality(v_sizes) THEN 'PASS_CAPACITY' ELSE 'GROUP_SIZING' END;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'player_id', d.pid,
           'state', CASE
             WHEN d.pid = ANY (v_matched) THEN 'MATCHED'
             WHEN d.code = 'DISCONNECTED' THEN 'WAITING_FOR_RECONNECT'
             WHEN d.code IS NOT NULL THEN 'BLOCKED_WITH_REASON'
             WHEN d.pid = ANY (v_held) THEN 'WAITING_FOR_BB'
             WHEN v_n < v_min THEN 'WAITING_FOR_PLAYERS'
             ELSE 'WAITING_FOR_FORMATION' END,
           'reason_code', CASE
             WHEN d.pid = ANY (v_matched) THEN NULL
             WHEN d.code IS NOT NULL THEN d.code
             WHEN d.pid = ANY (v_held) THEN 'FIRST_ENTRY_WAITS_FOR_BB'
             WHEN v_n < v_min THEN 'NOT_ENOUGH_LEGAL_PLAYERS'
             -- The sizing leftovers are the last in queue order.
             WHEN v_sizing_left > 0
                  AND array_position(v_wait, d.pid) > cardinality(v_wait) - v_sizing_left THEN 'GROUP_SIZING'
             ELSE v_capacity_reason END) ORDER BY d.pid), '[]'::jsonb)
    INTO v_diag
    FROM (SELECT (x ->> 'player_id')::uuid AS pid, x ->> 'reason_code' AS code
            FROM jsonb_array_elements(v_rows) x) d;

  RETURN jsonb_build_object(
    'matcher_version', v_version,
    'generated_at', v_now,
    'legal_count', v_n,
    'groups', v_groups,
    'diagnosis', v_diag,
    'pool_diversity_score', CASE WHEN v_pairs = 0 THEN 1
                                 ELSE round(1 - v_repeat_pairs::numeric / v_pairs, 4) END);
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_lightning_match(
  p_cluster_id      uuid,
  p_now             timestamp with time zone,
  p_disconnected    uuid[],
  p_matcher_version text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  -- The pass capacity is the configured admission batch.
  SELECT public.fn_lightning_match_plan(p_cluster_id, p_now, p_disconnected, p_matcher_version, NULL);
$fn$;

-- ===========================================================================
-- SECTION 7. THE WRITER. Plans, forms through the barrier, records.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_lightning_match_and_form(
  p_cluster_id   uuid,
  p_now          timestamp with time zone,
  p_disconnected uuid[],
  p_max_hands    integer,
  p_request_id   uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_now       timestamptz := coalesce(p_now, clock_timestamp());
  v_group_now timestamptz;
  v_prev      record;
  v_cfg       jsonb;
  v_version   text;
  v_epoch     integer;
  v_budget    interval;
  v_max_hands integer;
  v_replans   integer := 0;
  v_max_replans integer;
  v_plan      jsonb;
  v_first     jsonb;
  v_group     jsonb;
  v_r         jsonb;
  v_req       uuid;
  v_ordinal   integer := 0;
  v_hands     jsonb := '[]'::jsonb;
  v_formed    integer := 0;
  v_retries   jsonb := '[]'::jsonb;
  v_retry     boolean;
  v_stopped   text;
  v_frozen    boolean := false;
  v_result    jsonb;
  v_locked    boolean;
BEGIN
  IF p_cluster_id IS NULL OR p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'cluster_and_request_id_required');
  END IF;

  -- A RETRIED REQUEST IS ANSWERED WITH THE PASS IT RAN.
  SELECT mp.cluster_id, mp.result INTO v_prev
    FROM public.cash_cluster_matcher_pass mp WHERE mp.request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.cluster_id IS DISTINCT FROM p_cluster_id THEN
      RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'request_id_belongs_to_another_cluster',
                                'request_id', p_request_id);
    END IF;
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  v_cfg := public.fn_lightning_config(p_cluster_id);
  IF coalesce((v_cfg ->> 'ok')::boolean, false) IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'not_found', 'cluster_id', p_cluster_id);
  END IF;
  -- DARK BY DEFAULT: only a Cluster whose ruleset says form is formed by the
  -- worker. shadow plans through fn_lightning_match and forms nothing.
  IF (v_cfg ->> 'worker_mode') IS DISTINCT FROM 'form' THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'worker_mode_is_not_form',
                              'worker_mode', v_cfg ->> 'worker_mode', 'cluster_id', p_cluster_id);
  END IF;

  -- ONE PASS PER CLUSTER AT A TIME, and a second one waits for nothing. The
  -- barrier takes this same row FOR UPDATE first, so the lock order is
  -- unchanged: the Cluster, then the anchors, then the slots.
  SELECT true INTO v_locked FROM public.cash_games cg WHERE cg.id = p_cluster_id FOR UPDATE SKIP LOCKED;
  IF NOT coalesce(v_locked, false) THEN
    RETURN jsonb_build_object('ok', true, 'formed', 0, 'skipped', true, 'reason', 'pass_in_progress',
                              'cluster_id', p_cluster_id, 'request_id', p_request_id);
  END IF;
  -- The same request may have finished while this one waited for nothing.
  SELECT mp.cluster_id, mp.result INTO v_prev
    FROM public.cash_cluster_matcher_pass mp WHERE mp.request_id = p_request_id;
  IF FOUND THEN
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  SELECT cg.cluster_epoch INTO v_epoch FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  v_version := v_cfg ->> 'matcher_version';
  v_budget := make_interval(secs => (v_cfg ->> 'pass_time_budget_ms')::numeric / 1000);
  v_max_replans := (v_cfg ->> 'max_replans')::integer;
  v_max_hands := LEAST(GREATEST(coalesce(p_max_hands, (v_cfg ->> 'admission_batch_hands')::integer), 0),
                       (v_cfg ->> 'admission_batch_hands')::integer);

  <<pass>>
  LOOP
    IF v_formed >= v_max_hands THEN
      v_stopped := coalesce(v_stopped, 'max_hands');
      EXIT pass;
    END IF;
    v_plan := public.fn_lightning_match_plan(p_cluster_id, v_now, p_disconnected, v_version, v_max_hands - v_formed);
    IF v_first IS NULL THEN v_first := v_plan; END IF;
    IF jsonb_array_length(v_plan -> 'groups') = 0 THEN
      v_stopped := coalesce(v_stopped, 'plan_exhausted');
      EXIT pass;
    END IF;
    v_retry := false;
    FOR v_group IN SELECT x FROM jsonb_array_elements(v_plan -> 'groups') x LOOP
      IF clock_timestamp() - v_started >= v_budget THEN
        v_stopped := 'time_budget';
        EXIT pass;
      END IF;
      v_ordinal := v_ordinal + 1;
      -- THE GROUP'S REQUEST ID, derived from the pass's: the same pass
      -- replayed asks the barrier for the same hands.
      v_req := md5(p_request_id::text || '/matcher_group/' || v_ordinal)::uuid;
      -- EACH GROUP IS FORMED ITS OWN MICROSECOND LATER. The barrier stamps
      -- last_bb_at with this time, and P2 orders by it; if every big blind of
      -- a pass shared one instant, the next tie-breaks (the slot's open, then
      -- player_id) would re-sort each batch by id, and the low ids would come
      -- round again first - measured at 60 rounds of fifty players, a stable
      -- cohort on 12 big blinds against another on 10. Stamped in the order
      -- they were chosen, the big blinds queue as they were served: a strict
      -- rotation.
      v_group_now := v_now + (v_ordinal - 1) * interval '1 microsecond';
      v_r := public.fn_lightning_form_hand(
        p_cluster_id,
        ARRAY(SELECT e.pid::uuid FROM jsonb_array_elements_text(v_group -> 'players') WITH ORDINALITY e(pid, ord)
               ORDER BY e.ord),
        (v_group -> 'keys' ->> 'size')::smallint,
        ((v_group -> 'keys' -> 'instance') ->> 'max')::smallint,
        (v_group ->> 'bb')::uuid,
        make_interval(secs => (v_cfg ->> 'reservation_ttl_ms')::numeric / 1000),
        make_interval(secs => (v_cfg ->> 'form_window_ms')::numeric / 1000),
        v_group_now,
        v_version,
        v_req);
      IF coalesce((v_r ->> 'formed')::boolean, false) THEN
        v_formed := v_formed + 1;
        v_hands := v_hands || jsonb_build_array(jsonb_build_object(
          'hand_id', v_r -> 'hand_id', 'instance_id', v_r -> 'instance_id', 'request_id', v_req,
          'bb', v_r -> 'bb', 'sb', v_r -> 'sb', 'btn', v_r -> 'btn', 'players', v_group -> 'players'));
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
        VALUES (p_cluster_id, 'matcher_assignment', jsonb_build_object(
          'cluster_id', p_cluster_id, 'cluster_epoch', v_r -> 'cluster_epoch',
          'hand_id', v_r -> 'hand_id', 'instance_id', v_r -> 'instance_id',
          'players', v_group -> 'players', 'bb', v_r -> 'bb', 'sb', v_r -> 'sb', 'btn', v_r -> 'btn',
          'keys', v_group -> 'keys', 'matcher_version', v_version,
          'request_id', v_req, 'pass_request_id', p_request_id, 'at', v_group_now),
          coalesce((v_r ->> 'cluster_epoch')::integer, v_epoch), v_req);
        IF v_formed >= v_max_hands THEN
          v_stopped := 'max_hands';
          EXIT pass;
        END IF;
      ELSIF (v_r ->> 'reason') = 'formation_invariant_failed' OR coalesce((v_r ->> 'frozen')::boolean, false) THEN
        -- THE BARRIER FROZE THE CLUSTER. Nothing more is attempted.
        v_frozen := true;
        v_stopped := 'frozen';
        v_retries := v_retries || jsonb_build_array(v_r || jsonb_build_object('request_id', v_req));
        EXIT pass;
      ELSIF coalesce((v_r ->> 'retry')::boolean, false) THEN
        -- A RACE: the world moved between the plan and the barrier. Plan again.
        v_retries := v_retries || jsonb_build_array(jsonb_build_object(
          'reason', v_r ->> 'reason', 'sqlstate', v_r ->> 'sqlstate', 'request_id', v_req));
        v_retry := true;
        EXIT;
      ELSE
        -- A refusal no retry can cure (the Cluster is not Lightning, or the
        -- plan disagreed with the barrier). Stop, and say so.
        v_stopped := 'refused:' || coalesce(v_r ->> 'reason', 'unknown');
        v_retries := v_retries || jsonb_build_array(v_r || jsonb_build_object('request_id', v_req));
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
        VALUES (p_cluster_id, 'matcher_failure', jsonb_build_object(
          'cluster_id', p_cluster_id, 'reason', v_r ->> 'reason', 'answer', v_r,
          'players', v_group -> 'players', 'bb', v_group -> 'bb',
          'matcher_version', v_version, 'request_id', v_req, 'pass_request_id', p_request_id, 'at', v_now),
          v_epoch, v_req);
        EXIT pass;
      END IF;
    END LOOP;
    EXIT pass WHEN NOT v_retry;
    v_replans := v_replans + 1;
    IF v_replans > v_max_replans THEN
      v_stopped := 'max_replans';
      EXIT pass;
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'ok', NOT v_frozen AND coalesce(v_stopped, '') NOT LIKE 'refused:%',
    'replayed', false,
    'cluster_id', p_cluster_id,
    'cluster_epoch', v_epoch,
    'request_id', p_request_id,
    'matcher_version', v_version,
    'formed', v_formed,
    'hands', v_hands,
    'planned_groups', jsonb_array_length(coalesce(v_first -> 'groups', '[]'::jsonb)),
    'legal_count', coalesce((v_first ->> 'legal_count')::integer, 0),
    'replans', v_replans,
    'retries', v_retries,
    'stopped_reason', coalesce(v_stopped, 'plan_exhausted'),
    'frozen', v_frozen,
    'max_hands', v_max_hands,
    'states', coalesce((SELECT jsonb_object_agg(s.state, s.n)
                          FROM (SELECT d ->> 'state' AS state, count(*) AS n
                                  FROM jsonb_array_elements(v_first -> 'diagnosis') d GROUP BY 1) s), '{}'::jsonb),
    'reasons', coalesce((SELECT jsonb_object_agg(s.code, s.n)
                           FROM (SELECT d ->> 'reason_code' AS code, count(*) AS n
                                   FROM jsonb_array_elements(v_first -> 'diagnosis') d
                                  WHERE d ->> 'reason_code' IS NOT NULL GROUP BY 1) s), '{}'::jsonb),
    'pool_diversity_score', v_first -> 'pool_diversity_score',
    'duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000, 1));

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES (p_cluster_id, 'matcher_pass', v_result || jsonb_build_object('at', v_now), v_epoch, p_request_id);

  INSERT INTO public.cash_cluster_matcher_pass
    (request_id, cluster_id, cluster_epoch, matcher_version, started_at, finished_at, hands_formed, result)
  VALUES (p_request_id, p_cluster_id, v_epoch, v_version, v_started, clock_timestamp(), v_formed, v_result)
  ON CONFLICT (request_id) DO NOTHING;

  RETURN v_result;
END
$fn$;

-- ===========================================================================
-- SECTION 8. GRANTS AND COMMENTS. service_role only; none SECURITY DEFINER:
-- every table these read is readable by service_role, and
-- fn_ca_player_restricted, the one definer they call, is granted to it.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.fn_lightning_config_number(jsonb, text, numeric, numeric, numeric, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_config_number(jsonb, text, numeric, numeric, numeric, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_config(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_config(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_player_legality(uuid, timestamp with time zone, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_player_legality(uuid, timestamp with time zone, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_group_sizes(integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_group_sizes(integer, integer, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_match_plan(uuid, timestamp with time zone, uuid[], text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_match_plan(uuid, timestamp with time zone, uuid[], text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_match(uuid, timestamp with time zone, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_match(uuid, timestamp with time zone, uuid[], text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_match_and_form(uuid, timestamp with time zone, uuid[], integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_match_and_form(uuid, timestamp with time zone, uuid[], integer, uuid) TO service_role;
-- Trigger functions cannot be called as an RPC; the family's rule is still
-- that service_role holds EXECUTE and no browser role does.
REVOKE ALL ON FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open() TO service_role;
REVOKE ALL ON FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle() TO service_role;

COMMENT ON FUNCTION public.fn_lightning_config(uuid) IS
  'Every Lightning matcher tunable for one Cluster, from cash_games.ruleset_snapshot -> ''lightning'' with a default for each: type checked and clamped, a bad value replaced and listed under invalid. ON/OFF thresholds from fn_cash_cluster_lightning_thresholds; diversity bands default to OFF, ON and twice ON; instance size defaults to the table size with a minimum of two.';
COMMENT ON FUNCTION public.fn_lightning_player_legality(uuid, timestamp with time zone, uuid[]) IS
  'Matcher P0. One row per open Lightning pool session of the Cluster with exactly one first-failing reason_code from one ordered CASE (NULL when legal): CLUSTER_NOT_LIGHTNING, CLUSTER_FROZEN, LIGHTNING_DISABLED, PLATFORM_FROZEN, WRONG_EPOCH, SESSION_CLOSED, POOL_SESSION_NOT_ACTIVE, CASHOUT_PENDING, ANCHOR_LEFT, SITTING_OUT, NO_STACK, RESTRICTED, RG_EXCLUDED, DISCONNECTED, ALREADY_RESERVED, IN_HAND, SLOT_NOT_OPEN, MULTI_TABLE_LIMIT. Reuses fn_lightning_anchor_is_live_eligible, fn_lightning_pool_stack, fn_lightning_player_in_hand, fn_platform_frozen, fn_ca_player_restricted (gated by ca_operator_policy.restrictions_enforced as the seat door gates it) and fn_rg_require_not_excluded.';
COMMENT ON FUNCTION public.fn_lightning_group_sizes(integer, integer, integer, integer) IS
  'Matcher P1. Group sizes for a legal count: the fewest instances that seat everyone inside [min, max], choosing among feasible counts the average closest to the target, sizes within one of each other, larger first. Empty below the minimum; never a one-player group. When no split seats everyone, the most that can be seated, in full groups.';
COMMENT ON FUNCTION public.fn_lightning_match_plan(uuid, timestamp with time zone, uuid[], text, integer) IS
  'The Lightning matcher planner behind fn_lightning_match and fn_lightning_match_and_form, with the pass capacity (groups formed together) as its last argument, so P5 only ever trades players among groups formed in the same pass. Writes nothing.';
COMMENT ON FUNCTION public.fn_lightning_match(uuid, timestamp with time zone, uuid[], text) IS
  'The Lightning matcher (spec Phase 6), lexicographic P0 to P6. STABLE, writes nothing, deterministic for a snapshot. Returns {matcher_version, generated_at, legal_count, groups: [{players, bb, keys}], diagnosis: [{player_id, state, reason_code}], pool_diversity_score}. players is the order to hand the barrier: big blind, small blind, then seat 3 onward with the button last.';
COMMENT ON FUNCTION public.fn_lightning_match_and_form(uuid, timestamp with time zone, uuid[], integer, uuid) IS
  'One Lightning matcher pass that forms hands: only when worker_mode is form; the Cluster row FOR UPDATE SKIP LOCKED (pass_in_progress otherwise); plans with fn_lightning_match_plan, forms each group through fn_lightning_form_hand with its big blind and a request id derived from p_request_id, re-plans after a retryable refusal up to max_replans, stops at once when the barrier freezes the Cluster, bounded by p_max_hands, admission_batch_hands and pass_time_budget_ms. Writes matcher_assignment per hand and matcher_pass per pass to cash_cluster_events and the pass to cash_cluster_matcher_pass; a retried request id is answered from there.';
COMMENT ON FUNCTION public.fn_lightning_pool_slot_idle_since_starts_at_open() IS
  'BEFORE INSERT on lightning_pool_slot: idle_since starts at opened_at (a column default cannot name another column).';
COMMENT ON FUNCTION public.fn_lightning_reservation_end_marks_the_slot_idle() IS
  'AFTER UPDATE OF state on lightning_reservation, when a pending or committed reservation is released or expires: moves its open slot''s idle_since forward to resolved_at. Covers the release trigger and the reaper''s expiry alike.';

-- ===========================================================================
-- SECTION 9. THE READ-BACK. What the catalogue now says, not what this file
-- meant.
-- ===========================================================================

DO $readback$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('lightning_pool_slot.idle_since NOT NULL', EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = 'public.lightning_pool_slot'::regclass AND a.attname = 'idle_since'
          AND a.attnotnull AND NOT a.attisdropped)),
    ('idle_since never precedes opened_at', EXISTS (SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.lightning_pool_slot'::regclass
          AND c.conname = 'lightning_pool_slot_idle_since_follows_open' AND c.convalidated)),
    ('the two idle triggers', (SELECT count(*) = 2 FROM pg_trigger t
        WHERE t.tgname IN ('trg_matcher_slot_idle_since_starts_at_open', 'trg_matcher_reservation_end_marks_the_slot_idle')
          AND t.tgenabled = 'O')),
    ('the multi-table index', to_regclass('public.lightning_reservation_active_by_player') IS NOT NULL),
    ('the pass record', to_regclass('public.cash_cluster_matcher_pass') IS NOT NULL),
    ('the pass record is append only for service_role', has_table_privilege('service_role', 'public.cash_cluster_matcher_pass', 'INSERT')
        AND NOT has_table_privilege('service_role', 'public.cash_cluster_matcher_pass', 'UPDATE')
        AND NOT has_table_privilege('service_role', 'public.cash_cluster_matcher_pass', 'DELETE')),
    ('the seven functions', (SELECT count(*) = 7 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND p.oid IN ('public.fn_lightning_config_number(jsonb,text,numeric,numeric,numeric,boolean)'::regprocedure,
                        'public.fn_lightning_config(uuid)'::regprocedure,
                        'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[])'::regprocedure,
                        'public.fn_lightning_group_sizes(integer,integer,integer,integer)'::regprocedure,
                        'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)'::regprocedure,
                        'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)'::regprocedure,
                        'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)'::regprocedure))),
    ('no new function is a definer, mentions a horse, or is executable by a browser role', NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND p.proname IN ('fn_lightning_config_number', 'fn_lightning_config', 'fn_lightning_player_legality',
                             'fn_lightning_group_sizes', 'fn_lightning_match_plan', 'fn_lightning_match',
                             'fn_lightning_match_and_form', 'fn_lightning_pool_slot_idle_since_starts_at_open',
                             'fn_lightning_reservation_end_marks_the_slot_idle')
           AND (p.prosecdef OR pg_get_functiondef(p.oid) ~ 'is_horse' OR pg_get_functiondef(p.oid) ~ 'horse_id'
                OR has_function_privilege('anon', p.oid, 'EXECUTE')
                OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')))),
    ('the sizes are the documented ones', public.fn_lightning_group_sizes(13, 2, 6, 6) = ARRAY[5,4,4]
        AND public.fn_lightning_group_sizes(7, 4, 6, 6) = ARRAY[6]
        AND public.fn_lightning_group_sizes(27, 2, 9, 9) = ARRAY[9,9,9])
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_PHASE_6_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
