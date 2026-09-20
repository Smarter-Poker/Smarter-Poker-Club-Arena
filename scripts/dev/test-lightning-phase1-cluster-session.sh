#!/usr/bin/env bash
# Lightning Phase 1: the cash session knows its cluster.
#
# Applies 20260920172736 to a throwaway PostgreSQL 17 cluster that is carrying
# the PRE-migration schema and two sessions that are ALREADY OPEN, one at a
# clustered table and one at a table outside any cluster. The migration claims
# it "cannot silently open a second economic identity" and that nothing but
# cluster_id changes on a row that is already open; this proves both against a
# real backend rather than against a reading of the file.
#
# Every comparison below is IS DISTINCT FROM, never = or <>. A NULL where a
# value was expected makes `IF NOT (x = y)` evaluate to NULL, which plpgsql
# takes as false, so an absent backfill would PASS a check written that way.
# (It did, until a negative control with the backfill deleted caught it.)
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
migration="$root/supabase/migrations/20260920172736_lightning_phase_1_the_cash_session_knows_its_cluster.sql"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase1-test.XXXXXX")
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55541 -h ''" start >/dev/null
started=1

# The seed and the two assertion groups live in the throwaway directory with
# the cluster they are written for: one psql session, so the pre-migration
# capture can be a TEMP table and the migration is applied to the same backend
# that holds it.
cat > "$fixture/seed.sql" <<'SEED'
-- One cluster, two tables (one inside it, one outside it), two chairs, and the
-- two continuous sessions the backfill has to account for. The session values
-- are deliberately NOT the defaults, so "unchanged" is a real statement.
INSERT INTO public.cash_games
  (id, club_id, name, variant, sb, bb, handedness, ruleset_snapshot, must_move)
VALUES
  ('ca000000-0000-0000-0000-000000000001', 'cb000000-0000-0000-0000-000000000001',
   'Lightning P1 fixture cluster', 'nlh', 1.00, 2.00, 9,
   '{"stay_clock_min": 15, "rejoin_window_min": 180}'::jsonb, true);

INSERT INTO public.tables
  (id, club_id, game_variant, small_blind, big_blind, tournament_id, cluster_id, role, main_index, lifecycle)
VALUES
  ('ab000000-0000-0000-0000-000000000001', 'cb000000-0000-0000-0000-000000000001',
   'nlh', 1.00, 2.00, NULL, 'ca000000-0000-0000-0000-000000000001', 'main', 1, 'live'),
  -- Outside every cluster: the case the backfill must leave alone.
  ('ab000000-0000-0000-0000-000000000002', 'cb000000-0000-0000-0000-000000000001',
   'nlh', 1.00, 2.00, NULL, NULL, NULL, NULL, 'live');

INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
VALUES
  ('ab000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001', 3, 214.75),
  ('ab000000-0000-0000-0000-000000000002', '0b000000-0000-0000-0000-000000000002', 5,  96.00);

INSERT INTO public.cash_player_session
  (id, player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline,
   stay_clock_ms, rejoin_window_ms, stay_remaining_ms, stay_running, stay_last_tick_at, opened_at)
VALUES
  -- Open, at the clustered table: the row the backfill must bind.
  ('5e550000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-000000000001',
   'cb000000-0000-0000-0000-000000000001', 'table',
   'ab000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
   'nlh', 1.00, 2.00, 137.50, 900000, 10800000, 412345, true,
   '2026-09-20T12:00:00Z', '2026-09-20T11:30:00Z'),
  -- Open, at the unclustered table: the row the backfill must NOT bind.
  ('5e550000-0000-0000-0000-000000000002', '0b000000-0000-0000-0000-000000000002',
   'cb000000-0000-0000-0000-000000000001', 'table',
   'ab000000-0000-0000-0000-000000000002', 'ab000000-0000-0000-0000-000000000002',
   'nlh', 1.00, 2.00, 60.00, 600000, 7200000, 600000, false,
   '2026-09-20T12:05:00Z', '2026-09-20T11:55:00Z');

-- The preimage. Every column of every session as it stands one statement
-- before the migration runs.
CREATE TEMP TABLE pre_migration_session AS
  SELECT * FROM public.cash_player_session;
SEED

cat > "$fixture/assertions.sql" <<'ASSERT'
-- BACKFILL -------------------------------------------------------------------
DO $$
DECLARE v_bound uuid; v_lone uuid; v_found integer;
BEGIN
  SELECT count(*) INTO v_found FROM public.cash_player_session
   WHERE id IN ('5e550000-0000-0000-0000-000000000001', '5e550000-0000-0000-0000-000000000002');
  IF v_found <> 2 THEN RAISE EXCEPTION 'FAIL backfill: the two pre-existing sessions are not both present (% found)', v_found; END IF;

  SELECT cluster_id INTO v_bound FROM public.cash_player_session WHERE id = '5e550000-0000-0000-0000-000000000001';
  SELECT cluster_id INTO v_lone  FROM public.cash_player_session WHERE id = '5e550000-0000-0000-0000-000000000002';
  IF v_bound IS DISTINCT FROM 'ca000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL backfill: the open session at the clustered table was not bound to its cluster (cluster_id = %)', v_bound;
  END IF;
  IF v_lone IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL backfill: the open session at the UNCLUSTERED table was invented a cluster (cluster_id = %)', v_lone;
  END IF;
END $$;
\echo '  ok  BACKFILL           open session at the clustered table bound; the unclustered one left NULL'

-- CONTINUITY -----------------------------------------------------------------
-- The one that matters. P2 is "one CONTINUOUS cash identity": if the migration
-- had reopened, re-baselined or re-clocked the row, the estate would have lost
-- the session it was in the middle of.
DO $$
DECLARE p public.cash_player_session%ROWTYPE; s public.cash_player_session%ROWTYPE; n integer;
BEGIN
  SELECT * INTO p FROM pre_migration_session WHERE id = '5e550000-0000-0000-0000-000000000001';
  SELECT * INTO s FROM public.cash_player_session WHERE id = '5e550000-0000-0000-0000-000000000001';
  IF p.id IS NULL THEN RAISE EXCEPTION 'FAIL continuity: the preimage capture is empty'; END IF;
  IF s.id IS NULL THEN RAISE EXCEPTION 'FAIL continuity: the backfilled session no longer exists'; END IF;
  IF s.id                IS DISTINCT FROM p.id                THEN RAISE EXCEPTION 'FAIL continuity: id changed'; END IF;
  IF s.baseline          IS DISTINCT FROM p.baseline          THEN RAISE EXCEPTION 'FAIL continuity: baseline % -> %', p.baseline, s.baseline; END IF;
  IF s.opened_at         IS DISTINCT FROM p.opened_at         THEN RAISE EXCEPTION 'FAIL continuity: opened_at % -> %', p.opened_at, s.opened_at; END IF;
  IF s.stay_clock_ms     IS DISTINCT FROM p.stay_clock_ms     THEN RAISE EXCEPTION 'FAIL continuity: stay_clock_ms % -> %', p.stay_clock_ms, s.stay_clock_ms; END IF;
  IF s.stay_remaining_ms IS DISTINCT FROM p.stay_remaining_ms THEN RAISE EXCEPTION 'FAIL continuity: stay_remaining_ms % -> %', p.stay_remaining_ms, s.stay_remaining_ms; END IF;
  IF s.rejoin_window_ms  IS DISTINCT FROM p.rejoin_window_ms  THEN RAISE EXCEPTION 'FAIL continuity: rejoin_window_ms % -> %', p.rejoin_window_ms, s.rejoin_window_ms; END IF;
  IF s.closed_at         IS DISTINCT FROM p.closed_at         THEN RAISE EXCEPTION 'FAIL continuity: closed_at % -> %', p.closed_at, s.closed_at; END IF;

  -- And nothing else moved either, on EITHER pre-existing row: every captured
  -- column except cluster_id, which did not exist to capture.
  SELECT count(*) INTO n
    FROM pre_migration_session p2
    JOIN public.cash_player_session s2 ON s2.id = p2.id
   WHERE ROW(p2.player_id, p2.club_id, p2.scope_type, p2.scope_id, p2.table_id, p2.variant,
             p2.sb, p2.bb, p2.baseline, p2.stay_clock_ms, p2.rejoin_window_ms,
             p2.stay_remaining_ms, p2.stay_running, p2.stay_last_tick_at, p2.opened_at,
             p2.closed_at, p2.closed_reason)
         IS DISTINCT FROM
         ROW(s2.player_id, s2.club_id, s2.scope_type, s2.scope_id, s2.table_id, s2.variant,
             s2.sb, s2.bb, s2.baseline, s2.stay_clock_ms, s2.rejoin_window_ms,
             s2.stay_remaining_ms, s2.stay_running, s2.stay_last_tick_at, s2.opened_at,
             s2.closed_at, s2.closed_reason);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL continuity: % pre-existing session row(s) changed in some column other than cluster_id', n; END IF;
  IF (SELECT count(*) FROM pre_migration_session) IS DISTINCT FROM
     (SELECT count(*) FROM pre_migration_session p3 JOIN public.cash_player_session s3 ON s3.id = p3.id) THEN
    RAISE EXCEPTION 'FAIL continuity: a pre-existing session row was dropped or re-keyed';
  END IF;
END $$;
\echo '  ok  CONTINUITY         id, baseline, opened_at, both clocks, rejoin window and closed_at unchanged'

-- NEW OPEN PATH --------------------------------------------------------------
DO $$
DECLARE v_id uuid; s public.cash_player_session%ROWTYPE;
BEGIN
  v_id := public.fn_cash_session_open('0c000000-0000-0000-0000-000000000003',
                                      'ab000000-0000-0000-0000-000000000001', 100);
  IF v_id IS NULL THEN RAISE EXCEPTION 'FAIL new open path: fn_cash_session_open returned NULL at a live clustered table'; END IF;
  SELECT * INTO s FROM public.cash_player_session WHERE id = v_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'FAIL new open path: fn_cash_session_open returned an id that is not a session'; END IF;
  IF s.cluster_id IS DISTINCT FROM 'ca000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL new open path: the new session did not learn its cluster (cluster_id = %)', s.cluster_id;
  END IF;
  IF s.scope_type IS DISTINCT FROM 'table' THEN
    RAISE EXCEPTION 'FAIL new open path: scope_type became %, which every table-scoped reader would miss', s.scope_type;
  END IF;
  IF s.scope_id  IS DISTINCT FROM 'ab000000-0000-0000-0000-000000000001'::uuid THEN RAISE EXCEPTION 'FAIL new open path: scope_id = %', s.scope_id; END IF;
  IF s.table_id  IS DISTINCT FROM 'ab000000-0000-0000-0000-000000000001'::uuid THEN RAISE EXCEPTION 'FAIL new open path: table_id = %', s.table_id; END IF;
  IF s.baseline  IS DISTINCT FROM 100::numeric THEN RAISE EXCEPTION 'FAIL new open path: baseline = %', s.baseline; END IF;
  IF s.closed_at IS NOT NULL THEN RAISE EXCEPTION 'FAIL new open path: the session was born closed'; END IF;
  -- The snapshot still raises the two clocks: 15 min / 180 min from the game.
  IF s.stay_clock_ms IS DISTINCT FROM 900000 OR s.stay_remaining_ms IS DISTINCT FROM 900000
     OR s.rejoin_window_ms IS DISTINCT FROM 10800000 THEN
    RAISE EXCEPTION 'FAIL new open path: the cluster snapshot stopped raising the clocks (% / % / %)',
      s.stay_clock_ms, s.stay_remaining_ms, s.rejoin_window_ms;
  END IF;
END $$;
\echo '  ok  NEW OPEN PATH      fn_cash_session_open writes cluster_id, keeps scope_type=table and scope_id=table_id'

-- UNCLUSTERED STILL WORKS ----------------------------------------------------
DO $$
DECLARE v_id uuid; s public.cash_player_session%ROWTYPE;
BEGIN
  v_id := public.fn_cash_session_open('0d000000-0000-0000-0000-000000000004',
                                      'ab000000-0000-0000-0000-000000000002', 100);
  IF v_id IS NULL THEN RAISE EXCEPTION 'FAIL unclustered: fn_cash_session_open returned NULL at a table outside every cluster'; END IF;
  SELECT * INTO s FROM public.cash_player_session WHERE id = v_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'FAIL unclustered: fn_cash_session_open returned an id that is not a session'; END IF;
  IF s.cluster_id IS NOT NULL THEN RAISE EXCEPTION 'FAIL unclustered: a table with no cluster produced cluster_id = %', s.cluster_id; END IF;
  IF s.scope_type IS DISTINCT FROM 'table'
     OR s.scope_id IS DISTINCT FROM 'ab000000-0000-0000-0000-000000000002'::uuid
     OR s.table_id IS DISTINCT FROM 'ab000000-0000-0000-0000-000000000002'::uuid THEN
    RAISE EXCEPTION 'FAIL unclustered: the session is not a normal table-scoped session (%, %, %)', s.scope_type, s.scope_id, s.table_id;
  END IF;
  IF s.baseline IS DISTINCT FROM 100::numeric OR s.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL unclustered: baseline % closed_at %', s.baseline, s.closed_at;
  END IF;
  -- No cluster, so no snapshot, so the floors stand.
  IF s.stay_clock_ms IS DISTINCT FROM 600000 OR s.rejoin_window_ms IS DISTINCT FROM 7200000 THEN
    RAISE EXCEPTION 'FAIL unclustered: clocks are % / %, not the floors', s.stay_clock_ms, s.rejoin_window_ms;
  END IF;
END $$;
\echo '  ok  UNCLUSTERED        a table outside every cluster still opens a normal session with cluster_id NULL'

-- DEFAULTS -------------------------------------------------------------------
DO $$
DECLARE g public.cash_games%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = 'ca000000-0000-0000-0000-000000000001';
  IF g.id IS NULL THEN RAISE EXCEPTION 'FAIL defaults: the seeded cluster is gone'; END IF;
  IF g.cluster_mode IS DISTINCT FROM 'must_move' THEN RAISE EXCEPTION 'FAIL defaults: cluster_mode = %, not must_move', g.cluster_mode; END IF;
  IF g.lightning_enabled IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL defaults: lightning_enabled = %, so Phase 1 enabled something', g.lightning_enabled; END IF;
  IF g.cluster_epoch IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL defaults: cluster_epoch = %, not 0', g.cluster_epoch; END IF;
END $$;
\echo '  ok  DEFAULTS           the existing cluster is must_move / lightning_enabled=false / epoch 0'

-- CHECK ENFORCED -------------------------------------------------------------
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  BEGIN
    UPDATE public.cash_games SET cluster_mode = 'zoom' WHERE id = 'ca000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL check: cluster_mode accepted a mode outside the ten-state machine'; END IF;
  IF v_constraint IS DISTINCT FROM 'cash_games_cluster_mode_check' THEN
    RAISE EXCEPTION 'FAIL check: refused by %, not the named cash_games_cluster_mode_check a later migration must address', v_constraint;
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    UPDATE public.cash_games SET cluster_epoch = -1 WHERE id = 'ca000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL check: a monotonic epoch accepted -1'; END IF;
  IF v_constraint IS DISTINCT FROM 'cash_games_cluster_epoch_nonneg' THEN
    RAISE EXCEPTION 'FAIL check: refused by %, not the named cash_games_cluster_epoch_nonneg', v_constraint;
  END IF;
END $$;
\echo '  ok  CHECK ENFORCED     cluster_mode=zoom and cluster_epoch=-1 both raise their NAMED check_violation'

-- EVERY VALID MODE ACCEPTED --------------------------------------------------
DO $$
DECLARE m text; n integer := 0;
BEGIN
  FOREACH m IN ARRAY ARRAY['created','opening','must_move','pending_on','lightning',
                           'pending_off','draining','paused','frozen','dead'] LOOP
    UPDATE public.cash_games SET cluster_mode = m WHERE id = 'ca000000-0000-0000-0000-000000000001';
    IF (SELECT cluster_mode FROM public.cash_games WHERE id = 'ca000000-0000-0000-0000-000000000001')
       IS DISTINCT FROM m THEN
      RAISE EXCEPTION 'FAIL modes: % did not stick', m;
    END IF;
    n := n + 1;
  END LOOP;
  IF n <> 10 THEN RAISE EXCEPTION 'FAIL modes: only % of the ten states were accepted', n; END IF;
  -- Put the cluster back where Phase 1 leaves every cluster, for the reader.
  UPDATE public.cash_games SET cluster_mode = 'must_move' WHERE id = 'ca000000-0000-0000-0000-000000000001';
END $$;
\echo '  ok  VALID MODES        all ten states of the specification machine can be set'

-- READER ---------------------------------------------------------------------
DO $$
DECLARE j jsonb; v_open bigint;
BEGIN
  SELECT count(*) INTO v_open FROM public.cash_player_session
   WHERE cluster_id = 'ca000000-0000-0000-0000-000000000001' AND closed_at IS NULL;
  -- The backfilled session plus the one the new open path created. If this is
  -- not 2 the reader could pass on a vacuous 0 = 0.
  IF v_open IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL reader: the fixture holds % open cluster sessions, expected 2', v_open;
  END IF;

  j := public.fn_cash_cluster_lightning_state('ca000000-0000-0000-0000-000000000001');
  IF j IS NULL THEN RAISE EXCEPTION 'FAIL reader: fn_cash_cluster_lightning_state returned NULL for a live cluster'; END IF;
  IF j->>'cluster_mode' IS DISTINCT FROM 'must_move' THEN RAISE EXCEPTION 'FAIL reader: cluster_mode %', j->>'cluster_mode'; END IF;
  IF (j->>'cluster_epoch')::integer IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL reader: cluster_epoch %', j->>'cluster_epoch'; END IF;
  IF (j->>'lightning_enabled')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL reader: lightning_enabled %', j->>'lightning_enabled'; END IF;
  IF (j->>'open_cluster_sessions')::bigint IS DISTINCT FROM v_open THEN
    RAISE EXCEPTION 'FAIL reader: open_cluster_sessions = %, the cluster actually holds %', j->>'open_cluster_sessions', v_open;
  END IF;
END $$;
\echo '  ok  READER             fn_cash_cluster_lightning_state reports must_move / epoch 0 / disabled / 2 open sessions'

-- The preimage of the re-apply: every row of everything the migration writes.
CREATE TEMP TABLE pre_reapply_session AS SELECT * FROM public.cash_player_session;
CREATE TEMP TABLE pre_reapply_game    AS SELECT * FROM public.cash_games;
CREATE TEMP TABLE pre_reapply_counts  AS
  SELECT (SELECT count(*) FROM public.cash_player_session)                              AS sessions,
         (SELECT count(*) FROM public.cash_player_session WHERE closed_at IS NULL)      AS open_sessions,
         (SELECT count(*) FROM public.cash_player_session WHERE cluster_id IS NOT NULL) AS bound_sessions,
         (SELECT count(*) FROM public.cash_games)                                       AS games,
         (SELECT count(*) FROM public.tables)                                           AS tables_,
         (SELECT count(*) FROM public.table_seats)                                      AS seats;
ASSERT

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'
-- IDEMPOTENT RE-APPLY --------------------------------------------------------
-- Reaching this file at all means the second psql -f of the migration exited 0
-- under ON_ERROR_STOP; what is left is that it moved nothing.
DO $$
DECLARE c pre_reapply_counts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM pre_reapply_counts;
  IF c.sessions IS NULL THEN RAISE EXCEPTION 'FAIL re-apply: the pre-re-apply count capture is empty'; END IF;
  IF (SELECT count(*) FROM public.cash_player_session) IS DISTINCT FROM c.sessions THEN
    RAISE EXCEPTION 'FAIL re-apply: cash_player_session went from % rows to %', c.sessions, (SELECT count(*) FROM public.cash_player_session);
  END IF;
  IF (SELECT count(*) FROM public.cash_player_session WHERE closed_at IS NULL) IS DISTINCT FROM c.open_sessions THEN
    RAISE EXCEPTION 'FAIL re-apply: the open-session count changed (% -> %)', c.open_sessions,
      (SELECT count(*) FROM public.cash_player_session WHERE closed_at IS NULL);
  END IF;
  IF (SELECT count(*) FROM public.cash_player_session WHERE cluster_id IS NOT NULL) IS DISTINCT FROM c.bound_sessions THEN
    RAISE EXCEPTION 'FAIL re-apply: the cluster-bound count changed (% -> %)', c.bound_sessions,
      (SELECT count(*) FROM public.cash_player_session WHERE cluster_id IS NOT NULL);
  END IF;
  IF (SELECT count(*) FROM public.cash_games) IS DISTINCT FROM c.games
     OR (SELECT count(*) FROM public.tables) IS DISTINCT FROM c.tables_
     OR (SELECT count(*) FROM public.table_seats) IS DISTINCT FROM c.seats THEN
    RAISE EXCEPTION 'FAIL re-apply: a cluster, table or seat row count changed';
  END IF;

  -- Stronger than counts: not one column of one row moved.
  IF EXISTS (SELECT * FROM pre_reapply_session EXCEPT SELECT * FROM public.cash_player_session)
     OR EXISTS (SELECT * FROM public.cash_player_session EXCEPT SELECT * FROM pre_reapply_session) THEN
    RAISE EXCEPTION 'FAIL re-apply: a session row changed on the second application';
  END IF;
  IF EXISTS (SELECT * FROM pre_reapply_game EXCEPT SELECT * FROM public.cash_games)
     OR EXISTS (SELECT * FROM public.cash_games EXCEPT SELECT * FROM pre_reapply_game) THEN
    RAISE EXCEPTION 'FAIL re-apply: a cluster row changed on the second application';
  END IF;
END $$;
\echo '  ok  RE-APPLY           the migration applied a second time and moved no row'
REAPPLY

"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55541 -d postgres \
  -f "$root/scripts/dev/fixtures/lightning-phase1-cluster-session-schema.sql" \
  -f "$fixture/seed.sql" \
  -f "$migration" \
  -f "$fixture/assertions.sql" \
  -f "$migration" \
  -f "$fixture/reapply-assertions.sql"

echo 'PASS: Lightning Phase 1  -  backfill, continuity (id/baseline/opened_at/clocks/rejoin/closed_at), new open path carries cluster_id, unclustered table unaffected, defaults must_move/false/0, named cluster_mode and epoch checks enforced, all ten modes accepted, lightning-state reader exact, migration idempotent on re-apply'
