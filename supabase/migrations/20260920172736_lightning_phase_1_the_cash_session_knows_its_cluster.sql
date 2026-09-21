-- 20260920172736_lightning_phase_1_the_cash_session_knows_its_cluster.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0, PHASE 1: CASH SESSION / CLUSTER INTEGRATION. NO MATCHER.
--
-- The Lightning specification's economic boundary is the CLUSTER, not the
-- chair. "One player has one continuous cash identity per Cluster" (P2), and
-- "Movement within the same Cluster is not a leave" (P6). Phase 0 recon found
-- that the estate does not actually have that identity yet, and named the gap
-- as the Phase 1 assignment:
--
--   "Phase 1 must connect existing cash sessions to the cluster, retain
--    session IDs/baseline/stay and rejoin obligations, and account for
--    currently open table-scoped sessions. It cannot silently open a second
--    economic identity."
--
-- WHY A cluster_id COLUMN AND NOT scope_type = 'cluster'.
--
-- cash_player_session has carried CHECK (scope_type IN ('table','cluster'))
-- since 20260904120000, and the comment there promises a "Slice 6 cutover"
-- that rewrites every open row to 'cluster'. That cutover has never happened,
-- and today there are 0 rows with scope_type='cluster' against 194 open
-- 'table' rows. Flipping the scope now would be a silent catastrophe, because
-- every reader and writer of a session filters scope_type = 'table':
--
--   fn_cash_session_evaluate, fn_cash_session_add_baseline, fn_cash_leave_check,
--   fn_cash_session_close, fn_cash_session_open's own stale-retire and fallback
--   read, the ON CONFLICT inference target, trg_fn_close_sessions_when_table_closes,
--   trg_fn_close_session_when_seat_vacated, and the move/swap re-points.
--
-- A cluster-scoped row is invisible to all of them: the stay clock would never
-- settle, leave_locked would never be computed, the rejoin floor and the VPIP
-- bar would never be written, and NEITHER close trigger could ever reach the
-- row, so it would stay open forever. That is precisely the leak that
-- 20260910011838 and 20260910012522 were written to close, and it would
-- violate docs/laws.d/a-session-cannot-outlive-its-seat.md.
--
-- Phase 0 also recorded the reason the cutover cannot be done yet:
-- "cash_player_session.table_id is currently required. Removing a physical
-- seat before a safe detached-stack owner exists risks losing the authoritative
-- location of chips." That owner is Phase 5 work, not Phase 1 work.
--
-- So Phase 1 gives the EXISTING continuous session a durable pointer to its
-- Cluster. Same row, same id, same baseline, same stay clock, same rejoin
-- window, same closure path. The chair still holds the chips and still closes
-- the session. What is new is that the session now knows which economic
-- boundary it belongs to, which is the thing every later phase reads.
--
-- WHY THE CLUSTER MODE IS NOT cash_games.state.
--
-- cash_games.state is DERIVED, not configured. fn_cash_cluster_tick section 7
-- recomputes it on every 5-second pass from two inputs and writes it back
-- unconditionally:
--
--   v_new_state := CASE WHEN v_seated_total = 0 AND coalesce(p_eligible_horses, 0) = 0
--                       THEN 'dormant' ELSE 'live' END;
--   IF g.state IS DISTINCT FROM v_new_state THEN UPDATE ... END IF;
--
-- A Lightning mode parked in that column would be destroyed within five
-- seconds. The specification requires the opposite: "the authoritative mode
-- must always be derivable from persistent state". So the Cluster state
-- machine gets its own column, beside must_move and enabled, which are the
-- other two things about a cluster that are configured rather than observed.
--
-- WHAT DELIBERATELY DOES NOT CHANGE HERE.
--
-- Nothing in this migration alters runtime behaviour. cluster_mode defaults to
-- 'must_move' and lightning_enabled to false, which is exactly what every
-- existing cluster already is. No threshold is evaluated (Phase 4), no
-- conversion is performed (Phase 5), no matcher exists (Phase 6), and the
-- feeder-first creation change (Phase 3) is untouched: creation still opens
-- Main 1. fn_cash_cluster_tick is not edited at all, so the hot 5-second pass
-- is byte-identical.
--
-- THE EPOCH. The specification creates a new Cluster Epoch at each mode
-- conversion and binds instances and hands to it. Nothing bumps it in Phase 1;
-- it is laid at 0 so that later phases have a monotonic counter on the row the
-- tick already locks FOR UPDATE, making the bump free and serialised.
--
-- ONE TRANSACTION. Every DDL statement fires Supabase's schema-cache reload,
-- ~28s on this database, so all of it lands in one BEGIN/COMMIT
-- (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_games' AND column_name IN ('cluster_mode','lightning_enabled','cluster_epoch'))
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_player_session' AND column_name = 'cluster_id'))
-- @live-proof: (SELECT position('cluster_id' in pg_get_functiondef('public.fn_cash_session_open(uuid,uuid,numeric)'::regprocedure)) > 0)
-- Proof 4 is deliberately a CORRUPTION check and not a completeness check.
-- The backfill is one-shot: fn_cash_session_open writes cluster_id on INSERT
-- only, and its ON CONFLICT DO NOTHING fallback returns the existing row
-- untouched, so a table adopted into a cluster while somebody is already
-- seated would leave that open session's cluster_id NULL forever. Measured:
-- not reachable today, because the only NULL -> cluster adoption of a seated
-- table was the one-shot DO block in 20260905034937, which has already run,
-- and the move/swap re-points are confined to one game by
-- cash_seat_moves.game_id. It BECOMES reachable in Phase 3 (feeder-first
-- creation) and Phase 5 (conversion), which re-parent tables: whichever of
-- those re-parents a table with live sessions owns re-binding them, and this
-- proof is written so it stays true meanwhile. An unbound session is a gap
-- for a later phase to close; a session bound to the WRONG cluster is
-- corruption, and that is what this refuses.
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_player_session s JOIN public.tables t ON t.id = s.table_id WHERE s.closed_at IS NULL AND s.cluster_id IS NOT NULL AND t.cluster_id IS NOT NULL AND s.cluster_id <> t.cluster_id))
-- @live-proof: (SELECT to_regclass('public.cash_player_session_open_by_cluster') IS NOT NULL)

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. CLUSTER STATE: the authoritative Lightning-compatible Cluster mode.
-- ---------------------------------------------------------------------------
-- One ADD COLUMN per statement: scripts/ci/check-migrations-applied.mjs anchors
-- each added column to its own ALTER TABLE, so a comma-separated list would
-- declare only the first one and the gate would not see the rest.

ALTER TABLE public.cash_games
  ADD COLUMN IF NOT EXISTS cluster_mode text NOT NULL DEFAULT 'must_move';

ALTER TABLE public.cash_games
  ADD COLUMN IF NOT EXISTS lightning_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.cash_games
  ADD COLUMN IF NOT EXISTS cluster_epoch integer NOT NULL DEFAULT 0;

-- The ten states of the specification's Cluster state machine. Named, because
-- an inline CHECK gets a system-generated name that a later migration cannot
-- address. Every existing cluster is MUST_MOVE, which is what it already is.
ALTER TABLE public.cash_games
  DROP CONSTRAINT IF EXISTS cash_games_cluster_mode_check;
ALTER TABLE public.cash_games
  ADD CONSTRAINT cash_games_cluster_mode_check
  CHECK (cluster_mode IN (
    'created', 'opening', 'must_move', 'pending_on', 'lightning',
    'pending_off', 'draining', 'paused', 'frozen', 'dead'));

ALTER TABLE public.cash_games
  DROP CONSTRAINT IF EXISTS cash_games_cluster_epoch_nonneg;
ALTER TABLE public.cash_games
  ADD CONSTRAINT cash_games_cluster_epoch_nonneg CHECK (cluster_epoch >= 0);

COMMENT ON COLUMN public.cash_games.cluster_mode IS
  'Lightning 2.0 Cluster state machine. Authoritative and configured, unlike cash_games.state which fn_cash_cluster_tick derives from occupancy every pass. Phase 1 lays it at must_move for every cluster; Phase 5 owns the transitions.';
COMMENT ON COLUMN public.cash_games.lightning_enabled IS
  'Whether this Cluster may ever convert to LIGHTNING. A precondition of the MUST_MOVE -> PENDING_ON trigger, not a mode. Default false: Phase 1 enables nothing.';
COMMENT ON COLUMN public.cash_games.cluster_epoch IS
  'Monotonic Cluster Epoch. A new epoch is created at each mode conversion so hands and instances remain attributable after a seating-model change. Nothing bumps it before Phase 5.';

-- ---------------------------------------------------------------------------
-- 2. SESSION IDENTITY: the continuous cash session learns its Cluster.
-- ---------------------------------------------------------------------------
-- Nullable, because a cash table outside a cluster has none, and because the
-- session row must keep working exactly as it does today for every one of the
-- scope_type='table' readers listed in the header.

ALTER TABLE public.cash_player_session
  ADD COLUMN IF NOT EXISTS cluster_id uuid;

COMMENT ON COLUMN public.cash_player_session.cluster_id IS
  'The Cluster this continuous cash session belongs to (cash_games.id), or NULL for a table outside a cluster. Lightning 2.0 P2: one player, one continuous cash identity per Cluster. This does NOT replace scope_type/scope_id; the seat still owns the stack and still closes the session.';

-- No foreign key. cash_games is small, but tables is hot and the estate has
-- already lost ~3.5 minutes of Postgres to a FK taking SHARE ROW EXCLUSIVE for
-- the length of a transaction (2026-09-08). The tick already reconciles
-- cluster membership; an orphan pointer is an audit question, not a lock.

CREATE INDEX IF NOT EXISTS cash_player_session_open_by_cluster
  ON public.cash_player_session (cluster_id)
  WHERE closed_at IS NULL AND cluster_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. BACKFILL: account for the sessions that are already open.
-- ---------------------------------------------------------------------------
-- Phase 0: "account for currently open table-scoped sessions". Every session,
-- open or closed, learns the cluster of the table it is sitting at. No money
-- moves, no session opens, no session closes, no baseline or clock is touched.

UPDATE public.cash_player_session s
   SET cluster_id = t.cluster_id
  FROM public.tables t
 WHERE t.id = s.table_id
   AND t.cluster_id IS NOT NULL
   AND s.cluster_id IS DISTINCT FROM t.cluster_id;

-- ---------------------------------------------------------------------------
-- 4. THE OPEN PATH WRITES IT.
-- ---------------------------------------------------------------------------
-- Body is the installed 20260904160500 body unchanged, except that the INSERT
-- now carries cluster_id. The function already read t.cluster_id to raise the
-- two clocks from the game's snapshot; it simply never stored it.
--
-- The three-argument positional signature is pinned by
-- server/src/engine/ChipContinuity.law.test.ts and called positionally by
-- atomic_table_buyin, so it is preserved exactly.
--
-- ON CONFLICT stays DO NOTHING: a colliding re-open keeps the existing row,
-- whose cluster_id the backfill above has already set from the same source.

CREATE OR REPLACE FUNCTION public.fn_cash_session_open(p_user_id uuid, p_table_id uuid, p_buy_in numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_id uuid; v_stay integer := 600000; v_rejoin integer := 7200000; v_snap jsonb;
BEGIN
  SELECT t.id, t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id, t.cluster_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN NULL; END IF;

  -- A game's snapshot may RAISE the two clocks (never lower: CHECK floors on
  -- the session row and the create function both refuse it).
  IF v_t.cluster_id IS NOT NULL THEN
    SELECT g.ruleset_snapshot INTO v_snap FROM public.cash_games g WHERE g.id = v_t.cluster_id;
    IF v_snap IS NOT NULL THEN
      v_stay   := GREATEST(600000,  coalesce((v_snap->>'stay_clock_min')::integer, 10) * 60000);
      v_rejoin := GREATEST(7200000, coalesce((v_snap->>'rejoin_window_min')::integer, 120) * 60000);
    END IF;
  END IF;

  IF p_buy_in IS NOT NULL THEN
    UPDATE public.cash_player_session
       SET closed_at = clock_timestamp(), closed_reason = 'stale_on_reopen'
     WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
       AND closed_at IS NULL;
  END IF;

  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, cluster_id, variant, sb, bb, baseline,
     stay_clock_ms, rejoin_window_ms, stay_remaining_ms, stay_running, stay_last_tick_at, opened_at)
  VALUES
    (p_user_id, v_t.club_id, 'table', p_table_id, p_table_id, v_t.cluster_id, v_t.game_variant,
     v_t.small_blind, v_t.big_blind, GREATEST(COALESCE(p_buy_in, 0), 0),
     v_stay, v_rejoin, v_stay, false, clock_timestamp(), clock_timestamp())
  ON CONFLICT (player_id, scope_type, scope_id) WHERE closed_at IS NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.cash_player_session
     WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
       AND closed_at IS NULL;
  END IF;
  RETURN v_id;
END;
$$;

-- Restated, not because CREATE OR REPLACE loses the ACL (it does not), but
-- because scripts/ci/check-definer-authorization.mjs models the FILE: a
-- SECURITY DEFINER writer with no visible revoke is read as reachable by anon.
REVOKE ALL ON FUNCTION public.fn_cash_session_open(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_session_open(uuid, uuid, numeric) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. THE AUTHORITATIVE READER.
-- ---------------------------------------------------------------------------
-- "The authoritative mode must always be derivable from persistent state."
-- One reader, so that later phases do not each grow their own slightly
-- different idea of what mode a Cluster is in.
--
-- open_cluster_sessions is the count of continuous cash identities bound to
-- this Cluster. It is deliberately NOT the live eligible population: that
-- predicate excludes watchers, waitlist-only users and expired disconnects,
-- it is Phase 4's, and it must be centralised there rather than approximated
-- here.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
           'game_id',               g.id,
           'cluster_mode',          g.cluster_mode,
           'cluster_epoch',         g.cluster_epoch,
           'lightning_enabled',     g.lightning_enabled,
           'must_move',             g.must_move,
           'enabled',               g.enabled,
           'handedness',            g.handedness,
           'open_cluster_sessions', (SELECT count(*)
                                       FROM public.cash_player_session s
                                      WHERE s.cluster_id = g.id
                                        AND s.closed_at IS NULL))
    FROM public.cash_games g
   WHERE g.id = p_game_id;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) TO service_role;

COMMIT;
