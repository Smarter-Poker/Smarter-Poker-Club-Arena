-- ===========================================================================
-- A SEAT WAITS FOR THE MODE CHANGE IN FLIGHT: the deterministic two-backend
-- interleavings of a seat arrival and a Cluster mode change, run by
-- scripts/dev/test-lightning-phase12-load-chaos.sh over the real chain (the
-- production bodies, then 20261015121542 applied twice).
--
-- Each case holds one backend's transaction open at the exact point the
-- race needs and lets the other run, through dblink (schema harness, from
-- the remediation-two fixture), so the interleaving is forced rather than
-- hoped for:
--
--   M1 the conversion (fn_cash_cluster_commit_lightning) has run to the end,
--      pool INSERT included, and is not committed; an arrival commits; then
--      the conversion commits.
--   M2 an arrival's seat and cash session are written and its deferred seat
--      trigger has run (SET CONSTRAINTS ALL IMMEDIATE after the arrival), and
--      it is not committed; the conversion runs; then the arrival commits.
--   M3 and M4 the same two orders for PENDING_OFF -> LIGHTNING
--      (fn_cash_cluster_abort_pending_off).
--   M5 and M6 the same two orders for the mirror, the reversion opened and
--      committed in ONE transaction (fn_cash_cluster_begin_pending_off then
--      fn_cash_cluster_commit_must_move, the Phase 13 drain's shape).
--
-- Before 20261015121542 every one of M1 to M4 left the arrival seated,
-- eligible and outside the LIGHTNING pool for good, and M5 and M6 left an open
-- pool session at the dead epoch of a MUST MOVE Cluster. After it, the
-- second backend waits for the first (it is still busy when the first is
-- released, and only then finishes) and the outcome is exact.
--
-- Every write goes through the production doors; nothing reads is_horse.
-- These Clusters are built after every load and chaos scenario has run and
-- are scenario 'MR', so no worker and no verdict ever sees them.
-- ===========================================================================

CREATE TABLE lc.mr (k text PRIMARY KEY, c uuid NOT NULL, req uuid);

CREATE FUNCTION lc.mr_connect(p_name text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF coalesce(p_name = ANY (harness.dblink_get_connections()), false) THEN
    PERFORM harness.dblink_disconnect(p_name);
  END IF;
  PERFORM harness.dblink_connect(p_name,
    'host=' || current_setting('unix_socket_directories') || ' port=' || current_setting('port')
    || ' dbname=' || current_database() || ' user=' || current_user);
  PERFORM harness.dblink_exec(p_name, 'SET lock_timeout = ''20s''');
  PERFORM harness.dblink_exec(p_name, 'SET lc.scen = ''MR''');
END $f$;
CREATE FUNCTION lc.mr_ask(p_name text, p_sql text) RETURNS text LANGUAGE sql AS $f$
  SELECT t.a FROM harness.dblink(p_name, p_sql) AS t(a text);
$f$;
-- The second backend is still waiting after this long only if it is blocked.
CREATE FUNCTION lc.mr_busy(p_name text) RETURNS integer LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_sleep(0.6);
  RETURN harness.dblink_is_busy(p_name);
END $f$;
CREATE FUNCTION lc.mr_result(p_name text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  SELECT t.a INTO v FROM harness.dblink_get_result(p_name) AS t(a text);
  PERFORM * FROM harness.dblink_get_result(p_name) AS t(a text);
  RETURN v;
END $f$;

-- A Cluster in PENDING_ON with its halt observed: one real drive pass opens
-- the conversion, the engine acknowledges the halt.
CREATE FUNCTION lc.mr_pending_on(p_key text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_c uuid; i integer;
BEGIN
  v_c := lc.build('MR', p_key, 6, 18, 1, 'nlh', '{}'::jsonb, false);
  FOR i IN 1 .. 3 LOOP
    EXIT WHEN harness.mode(v_c) = 'pending_on';
    PERFORM harness.drive(v_c);
  END LOOP;
  IF harness.mode(v_c) IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FIXTURE MR: % did not reach pending_on (%)', p_key, harness.mode(v_c);
  END IF;
  UPDATE public.tables tb SET dealing_halt_observed_at = clock_timestamp()
   WHERE tb.cluster_id = v_c AND tb.dealing_halted_at IS NOT NULL;
  INSERT INTO lc.mr (k, c, req)
  SELECT p_key, v_c, cv.conversion_request_id FROM public.cash_cluster_conversion cv
   WHERE cv.cluster_id = v_c AND cv.status = 'pending';
  RETURN v_c;
END $f$;

-- A LIGHTNING Cluster thinned to its OFF threshold and opened into
-- PENDING_OFF by the population trigger (dwell 0: two sightings).
CREATE FUNCTION lc.mr_pending_off(p_key text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_c uuid; v_req uuid := gen_random_uuid(); v_off integer; r jsonb;
BEGIN
  v_c := lc.build('MR', p_key, 6, 18, 1, 'nlh', '{"pending_off_dwell_ms": 0}'::jsonb, true);
  v_off := (public.fn_cash_cluster_lightning_thresholds(v_c) ->> 'off')::integer;
  PERFORM harness.leave(v_c, greatest(harness.live(v_c) - v_off, 0));
  r := public.fn_cash_cluster_begin_pending_off(v_c, v_req, 'lc_mode_race');
  IF harness.mode(v_c) IS DISTINCT FROM 'pending_off' THEN
    r := public.fn_cash_cluster_begin_pending_off(v_c, v_req, 'lc_mode_race');
  END IF;
  IF harness.mode(v_c) IS DISTINCT FROM 'pending_off' THEN
    RAISE EXCEPTION 'FIXTURE MR: % did not reach pending_off (% / %)', p_key, harness.mode(v_c), r;
  END IF;
  INSERT INTO lc.mr (k, c, req) VALUES (p_key, v_c, v_req);
  RETURN v_c;
END $f$;

-- A LIGHTNING Cluster whose game is switched off, so the drain shape
-- (open PENDING_OFF and revert in one transaction) is admitted at once.
CREATE FUNCTION lc.mr_lightning(p_key text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_c uuid;
BEGIN
  v_c := lc.build('MR', p_key, 6, 18, 1, 'nlh', '{}'::jsonb, true);
  UPDATE public.cash_games SET enabled = false WHERE id = v_c;
  INSERT INTO lc.mr (k, c, req) VALUES (p_key, v_c, gen_random_uuid());
  RETURN v_c;
END $f$;
CREATE FUNCTION lc.mr_revert(p_c uuid, p_req uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE a jsonb; b jsonb;
BEGIN
  a := public.fn_cash_cluster_begin_pending_off(p_c, p_req, 'lc_mode_race');
  b := public.fn_cash_cluster_commit_must_move(p_c, p_req);
  RETURN jsonb_build_object('begin', a, 'commit', b)::text;
END $f$;

-- The outcome, read from rows: eligible seated players a LIGHTNING Cluster
-- has not entered at its current epoch, and open pool sessions that are not
-- at the current epoch of a LIGHTNING Cluster (the harness's own
-- no_ghost_and_nobody_left_behind, plus the dead-epoch ghost).
CREATE FUNCTION lc.mr_left_behind(p_c uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT count(*)::integer FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
    JOIN public.cash_games cg ON cg.id = tb.cluster_id
   WHERE cg.id = p_c AND cg.cluster_mode = 'lightning' AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND public.fn_lightning_anchor_is_live_eligible(ts.id, cg.id, ts.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = cg.id
                        AND ps.player_id = ts.user_id AND ps.cluster_epoch = cg.cluster_epoch
                        AND ps.exited_at IS NULL);
$f$;
CREATE FUNCTION lc.mr_ghosts(p_c uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT count(*)::integer FROM public.lightning_pool_session ps JOIN public.cash_games cg ON cg.id = ps.cluster_id
   WHERE ps.cluster_id = p_c AND ps.exited_at IS NULL
     AND (cg.cluster_mode <> 'lightning' OR ps.cluster_epoch <> cg.cluster_epoch);
$f$;
CREATE FUNCTION lc.mr_has_session(p_c uuid, p_player uuid) RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT EXISTS (SELECT 1 FROM public.lightning_pool_session ps JOIN public.cash_games cg ON cg.id = ps.cluster_id
                  WHERE ps.cluster_id = p_c AND ps.player_id = p_player AND ps.exited_at IS NULL
                    AND ps.cluster_epoch = cg.cluster_epoch);
$f$;
CREATE FUNCTION lc.mr_verdict(p_case text, p_c uuid, p_busy integer, p_want_mode text, p_detail text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_left integer := lc.mr_left_behind(p_c); v_ghost integer := lc.mr_ghosts(p_c); v_mode text := harness.mode(p_c);
BEGIN
  IF v_left <> 0 OR v_ghost <> 0 OR v_mode IS DISTINCT FROM p_want_mode OR p_busy <> 1 THEN
    RAISE EXCEPTION 'FAIL MR %: mode % (want %), % eligible seated player(s) left out of the pool, % open pool session(s) at a dead epoch or outside LIGHTNING, second backend waited: % (want 1); %',
      p_case, v_mode, p_want_mode, v_left, v_ghost, p_busy = 1, p_detail;
  END IF;
  RAISE NOTICE 'MR % ok: mode %, nobody left behind, no ghost, the second backend waited for the first', p_case, v_mode;
END $f$;

-- ---------------------------------------------------------------------------
-- The Clusters, committed so the two other backends can see them.
-- ---------------------------------------------------------------------------
SELECT lc.mr_pending_on('M1');
SELECT lc.mr_pending_on('M2');
SELECT lc.mr_pending_off('M3');
SELECT lc.mr_pending_off('M4');
SELECT lc.mr_lightning('M5');
SELECT lc.mr_lightning('M6');
SELECT lc.mr_connect('mra');
SELECT lc.mr_connect('mrb');

-- M1 THE CONVERSION FIRST: it runs to the end (pool INSERT included) and
-- holds its transaction; an arrival commits; the conversion commits.
DO $m1$
DECLARE v_c uuid; v_req uuid; a text; b text; v_busy integer;
BEGIN
  SELECT c, req INTO v_c, v_req FROM lc.mr WHERE k = 'M1';
  PERFORM harness.dblink_exec('mra', 'BEGIN');
  a := lc.mr_ask('mra', format('SELECT public.fn_cash_cluster_commit_lightning(%L, %L)::text', v_c, v_req));
  IF (a::jsonb ->> 'converted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE MR M1: the conversion did not convert: %', a; END IF;
  PERFORM harness.dblink_send_query('mrb', format('SELECT lc.arrive(%L, false)::text', v_c));
  v_busy := lc.mr_busy('mrb');
  PERFORM harness.dblink_exec('mra', 'COMMIT');
  b := lc.mr_result('mrb');
  IF NOT lc.mr_has_session(v_c, b::uuid) THEN RAISE EXCEPTION 'FAIL MR M1: the arrival % is not in the pool', b; END IF;
  PERFORM lc.mr_verdict('M1 arrival during an uncommitted conversion', v_c, v_busy, 'lightning', a);
END $m1$;

-- M2 THE ARRIVAL FIRST: its seat trigger has run and it holds its
-- transaction; the conversion runs; the arrival commits.
DO $m2$
DECLARE v_c uuid; v_req uuid; a text; b text; v_busy integer;
BEGIN
  SELECT c, req INTO v_c, v_req FROM lc.mr WHERE k = 'M2';
  PERFORM harness.dblink_exec('mrb', 'BEGIN');
  b := lc.mr_ask('mrb', format('SELECT lc.arrive(%L, true)::text', v_c));
  PERFORM harness.dblink_exec('mrb', 'SET CONSTRAINTS ALL IMMEDIATE');
  PERFORM harness.dblink_send_query('mra', format('SELECT public.fn_cash_cluster_commit_lightning(%L, %L)::text', v_c, v_req));
  v_busy := lc.mr_busy('mra');
  PERFORM harness.dblink_exec('mrb', 'COMMIT');
  a := lc.mr_result('mra');
  IF (a::jsonb ->> 'converted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL MR M2: the conversion did not convert: %', a; END IF;
  IF NOT lc.mr_has_session(v_c, b::uuid) THEN RAISE EXCEPTION 'FAIL MR M2: the arrival % is not in the pool', b; END IF;
  PERFORM lc.mr_verdict('M2 conversion during an uncommitted arrival', v_c, v_busy, 'lightning', a);
END $m2$;

-- M3 THE ABORT FIRST: PENDING_OFF -> LIGHTNING has run and holds its
-- transaction; an arrival commits; the abort commits.
DO $m3$
DECLARE v_c uuid; v_req uuid; a text; b text; v_busy integer;
BEGIN
  SELECT c, req INTO v_c, v_req FROM lc.mr WHERE k = 'M3';
  PERFORM harness.dblink_exec('mra', 'BEGIN');
  a := lc.mr_ask('mra', format('SELECT public.fn_cash_cluster_abort_pending_off(%L, %L, %L)::text', v_c, v_req, 'lc_mode_race'));
  IF (a::jsonb ->> 'aborted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE MR M3: the abort did not abort: %', a; END IF;
  PERFORM harness.dblink_send_query('mrb', format('SELECT lc.arrive(%L, true)::text', v_c));
  v_busy := lc.mr_busy('mrb');
  PERFORM harness.dblink_exec('mra', 'COMMIT');
  b := lc.mr_result('mrb');
  IF NOT lc.mr_has_session(v_c, b::uuid) THEN RAISE EXCEPTION 'FAIL MR M3: the arrival % is not in the pool', b; END IF;
  PERFORM lc.mr_verdict('M3 arrival during an uncommitted pending_off abort', v_c, v_busy, 'lightning', a);
END $m3$;

-- M4 THE ARRIVAL FIRST, then the abort.
DO $m4$
DECLARE v_c uuid; v_req uuid; a text; b text; v_busy integer;
BEGIN
  SELECT c, req INTO v_c, v_req FROM lc.mr WHERE k = 'M4';
  PERFORM harness.dblink_exec('mrb', 'BEGIN');
  b := lc.mr_ask('mrb', format('SELECT lc.arrive(%L, false)::text', v_c));
  PERFORM harness.dblink_exec('mrb', 'SET CONSTRAINTS ALL IMMEDIATE');
  PERFORM harness.dblink_send_query('mra', format('SELECT public.fn_cash_cluster_abort_pending_off(%L, %L, %L)::text', v_c, v_req, 'lc_mode_race'));
  v_busy := lc.mr_busy('mra');
  PERFORM harness.dblink_exec('mrb', 'COMMIT');
  a := lc.mr_result('mra');
  IF (a::jsonb ->> 'aborted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL MR M4: the abort did not abort: %', a; END IF;
  IF NOT lc.mr_has_session(v_c, b::uuid) THEN RAISE EXCEPTION 'FAIL MR M4: the arrival % is not in the pool', b; END IF;
  PERFORM lc.mr_verdict('M4 pending_off abort during an uncommitted arrival', v_c, v_busy, 'lightning', a);
END $m4$;

-- M5 THE REVERSION FIRST (opened and committed in one transaction, as the
-- drain does): it has run and holds its transaction; an arrival commits; the
-- reversion commits. No pool session may survive into MUST MOVE.
DO $m5$
DECLARE v_c uuid; v_req uuid; a text; b text; v_busy integer;
BEGIN
  SELECT c, req INTO v_c, v_req FROM lc.mr WHERE k = 'M5';
  PERFORM harness.dblink_exec('mra', 'BEGIN');
  a := lc.mr_ask('mra', format('SELECT lc.mr_revert(%L, %L)', v_c, v_req));
  IF (a::jsonb -> 'commit' ->> 'reverted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE MR M5: the reversion did not revert: %', a; END IF;
  PERFORM harness.dblink_send_query('mrb', format('SELECT lc.arrive(%L, false)::text', v_c));
  v_busy := lc.mr_busy('mrb');
  PERFORM harness.dblink_exec('mra', 'COMMIT');
  b := lc.mr_result('mrb');
  PERFORM lc.mr_verdict('M5 arrival during an uncommitted reversion', v_c, v_busy, 'must_move', a);
END $m5$;

-- M6 THE ARRIVAL FIRST: its seat trigger read LIGHTNING and opened a pool
-- session it holds uncommitted; the reversion runs; the arrival commits.
DO $m6$
DECLARE v_c uuid; v_req uuid; a text; b text; v_busy integer;
BEGIN
  SELECT c, req INTO v_c, v_req FROM lc.mr WHERE k = 'M6';
  PERFORM harness.dblink_exec('mrb', 'BEGIN');
  b := lc.mr_ask('mrb', format('SELECT lc.arrive(%L, true)::text', v_c));
  PERFORM harness.dblink_exec('mrb', 'SET CONSTRAINTS ALL IMMEDIATE');
  IF NOT coalesce(lc.mr_ask('mrb', format('SELECT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = %L AND player_id = %L AND exited_at IS NULL)::text', v_c, b))::boolean, false) THEN
    RAISE EXCEPTION 'FIXTURE MR M6: the arrival''s own trigger did not enter it while the Cluster was LIGHTNING';
  END IF;
  PERFORM harness.dblink_send_query('mra', format('SELECT lc.mr_revert(%L, %L)', v_c, v_req));
  v_busy := lc.mr_busy('mra');
  PERFORM harness.dblink_exec('mrb', 'COMMIT');
  a := lc.mr_result('mra');
  IF (a::jsonb -> 'commit' ->> 'reverted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL MR M6: the reversion did not revert: %', a; END IF;
  PERFORM lc.mr_verdict('M6 reversion during an uncommitted arrival', v_c, v_busy, 'must_move', a);
END $m6$;

SELECT harness.dblink_disconnect('mra');
SELECT harness.dblink_disconnect('mrb');
