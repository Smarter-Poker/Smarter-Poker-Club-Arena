-- 20260917113717_the_finish_lane_is_exclusive_among_finishes.sql
--
-- Version 20260917082500 was reserved by scripts/new-migration.mjs; the file
-- carries the version the Supabase MCP recorded when it applied this at
-- 11:37:17 UTC on 2026-09-17, so schema_migrations and this name agree.
--
-- THE FINISH LANE IS EXCLUSIVE AMONG FINISHES AND SHARED WITH EVERYONE ELSE.
--
-- WHAT WAS WRONG (measured on production 2026-09-17, 200 ms pg_locks samples)
--
-- Every tournament finish, fn_complete_tournament_terminal, took the whole
-- platform's settlement lane exclusively: G ('ca:tournament-terminal-
-- settlement:v1') and B ('ca:hand-settlement-barrier:v1'), held to commit.
-- Every hand settlement, blind publication, horse seating and rolling
-- authority holds G shared, so all of them queued behind each finish, and a
-- burst of finishes is a burst of platform stalls. At 08:02-08:08 UTC, while
-- the restarted engine finished the decided-Spin backlog at 85 finishes a
-- minute, 1,589 hand settlements waited on G at a p50 of 1,979 ms and a p90
-- of 4,490 ms, 221 horse seatings at a p90 of 4,264 ms, and the queue reached
-- 68 backends, the PostgREST pool (71). The Postgres log counted 71
-- statement timeouts in 08:05-08:10, 52 of them fn_ca_commit_hand_settlement.
-- At the normal 20 finishes a minute the lane was held exclusively in 40% of
-- samples. Since the 2026-09-10 pg_stat_statements reset: 34,542 finishes,
-- 797 ms mean, 19.9 s max, 27,527 s of platform-wide exclusive hold;
-- fn_resolve_tournament_terminal_outcome, a read-only resolver, 3,259 calls
-- on the same lane, 217 ms mean, 15.5 s max.
--
-- WHY THE LANE WAS GLOBAL, in the finish body's own words: "It eliminates
-- cross-event cycles on shared club, union and recipient wallets without
-- weakening any event-local row proof." Deadlock avoidance between money
-- commits, not field correctness.
--
-- WHAT THIS CHANGES
--
--                             G (platform)  F (finishes)  B (hands)  T(id)
--   non-satellite finish      SHARED        EXCLUSIVE     -          EXCLUSIVE  <- was G, B EXCLUSIVE
--   satellite finish / rare   EXCLUSIVE     -             EXCLUSIVE  -          (unchanged)
--   rolling authority         SHARED        -             -          EXCLUSIVE  (unchanged)
--   hand settlement           SHARED        -             SHARED     SHARED     (unchanged)
--   terminal outcome resolver SHARED        -             -          EXCLUSIVE  <- was G, B EXCLUSIVE
--
-- Order everywhere: G, then F, then B, then T. F ('ca:tournament-finish-
-- lane:v1') is taken only by finishes, always after G and before T.
--
-- * Finishes still run one at a time (F), so finish-against-finish wallet
--   order is exactly what it was. What is new is a finish running beside the
--   hands and rolling authorities of OTHER tournaments, the class the
--   platform has run since 2026-09-10 (rolling authorities beside each other
--   and beside every hand), with the deadlock counter as its witness.
-- * The finish's own tournament is still frozen: its hands hold T(id) shared
--   and its rolling authorities T(id) exclusive, and both wait for T(id).
-- * Every proof-of-authority guard accepts T(the row's tournament) held
--   exclusively (2026-09-10), and smarter_private.f06_source_guard tries G
--   shared plus T; a finish holds both.
--
-- 1. fn_ca_lock_settlement_lane_for_finish(p_tournament_id): satellite or
--    unknown tournament -> the global lane as today; otherwise G shared, F
--    exclusive, T(id) exclusive, and a transaction-local setting
--    ca.finish_lane_tournament naming the lane held.
-- 2. fn_complete_tournament_terminal takes the finish lane. Nothing else in
--    it changes.
-- 3. fn_ca_lock_settlement_lane_global: inside a finish transaction (the
--    setting is present) it re-enters the held finish lane and returns;
--    otherwise G then B exclusive, byte for byte as before. The finish body
--    (fn_complete_tournament_terminal_pre_seat_guard), fn_settle_tournament_
--    places and fn_settle_tournament_rake call this helper again inside the
--    finish; with the outer hold now shared, those calls would be upgrades
--    (G shared -> exclusive), which deadlock (2026-09-10: no upgrades). The
--    re-entry keeps those three bodies untouched.
-- 4. fn_resolve_tournament_terminal_outcome refuses satellites itself and is
--    read-only; it takes the rolling lane, G shared and T(id) exclusive,
--    which waits for exactly an in-flight finish of the same tournament.
--
-- Stays on the global lane: satellite finishes (they write the target
-- tournament's rows; a transaction never holds two tournaments' lanes),
-- fn_resolve_satellite_settlement_outcome, cancellation, fn_spin_expire_
-- unfilled (a batch of cancellations), deal review, managed-game close, the
-- rake sweep, and every caller of the global helper outside a finish.
--
-- Proof: the precondition block refuses to run unless every replaced body is
-- byte-identical (md5) to the one reviewed, the set of functions naming G is
-- the reviewed set, the guards accept T, and no finish lane exists yet. The
-- postcondition block re-proves on the live catalog that only the two lane
-- helpers take G exclusively, that no rolling authority reaches the global
-- lane, and that the non-satellite finish reaches the global helper only
-- through the reviewed per-tournament callees. Live verification after apply
-- (pg_locks sampling of G and F, statement timeouts, guard refusals, deadlock
-- counter) is in the changelog.
-- Rollback (restores every definition this replaces, byte for byte, and drops
-- the finish lane):
--   docs/changelog/2026-09-17-the-finish-lane-is-exclusive-among-finishes.rollback.sql
-- Plan and evidence:
--   docs/terminal-settlement-lane-per-tournament-plan-2026-09-17.md
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS: the board is the board that was reviewed.
-- ---------------------------------------------------------------------------
DO $finish_pre$
DECLARE
  -- md5(prosrc) of every body this migration replaces, captured from
  -- production on 2026-09-17 08:30 UTC, plus the lane helpers it relies on.
  v_expected CONSTANT jsonb := jsonb_build_object(
    'public.fn_complete_tournament_terminal(uuid,uuid,text)',
      '96a61ea5e16560735bcb70b355aa79ab',
    'public.fn_ca_lock_settlement_lane_global()',
      '343015440ea5c84ee4ca7ae583c73d30',
    'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
      '022c1883533939caf8ebed0cb5699e8c',
    'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)',
      '3acb4c1d763181905cf5b64287f8f28f',
    'public.fn_ca_share_settlement_lane_for_table(uuid)',
      '7a4d464261d6cc5cb185ad6c8b846440',
    'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
      '0f491a45693fcf3182719647c5ed7aee');
  v_sig text;
  v_md5 text;
  v_live text;
  v_set text;
BEGIN
  FOR v_sig, v_md5 IN SELECT key, value #>> '{}' FROM jsonb_each(v_expected) LOOP
    SELECT md5(p.prosrc) INTO v_live
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF v_live IS NULL THEN
      RAISE EXCEPTION 'finish lane migration refused: % does not exist', v_sig;
    END IF;
    IF v_live <> v_md5 THEN
      RAISE EXCEPTION
        'finish lane migration refused: % changed since review (md5 %, reviewed %)',
        v_sig, v_live, v_md5;
    END IF;
  END LOOP;

  -- Every function that names G. A new one is a new authority nobody has
  -- classified: refuse and make someone look.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc LIKE '%ca:tournament-terminal-settlement:v1%';
  IF v_set IS DISTINCT FROM
     'fn_ca_lock_settlement_lane_for_tournament,fn_ca_lock_settlement_lane_global,'
     'fn_ca_share_settlement_lane_for_table,fn_resolve_committed_tournament_seat_move,'
     'fn_satellite_target_player_provenance_is_immutable,'
     'fn_tournament_live_seat_acquisition_requires_authority,'
     'fn_tournament_payouts_are_append_only' THEN
    RAISE EXCEPTION
      'finish lane migration refused: the functions naming G changed: %', v_set;
  END IF;

  -- Nothing names the finish lane yet.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.prosrc LIKE '%ca:tournament-finish-lane:v1%'
                 OR p.proname = 'fn_ca_lock_settlement_lane_for_finish') THEN
    RAISE EXCEPTION 'finish lane migration refused: a finish lane already exists';
  END IF;

  -- The three guards accept T(the row's tournament) held exclusively as
  -- proof (2026-09-10), and are wired where this migration assumes.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_tournament_live_seat_acquisition_requires_authority',
                           'fn_satellite_target_player_provenance_is_immutable',
                           'fn_tournament_payouts_are_append_only')
         AND p.prosrc LIKE '%ca:tournament-terminal-settlement:v1:%'
         AND p.prosrc LIKE '%ExclusiveLock%') <> 3 THEN
    RAISE EXCEPTION 'finish lane migration refused: a guard does not accept T as proof';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger g
       WHERE NOT g.tgisinternal AND g.tgenabled = 'O'
         AND ((g.tgrelid = 'public.table_seats'::regclass
               AND g.tgfoid = 'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure)
           OR (g.tgrelid = 'public.tournament_players'::regclass
               AND g.tgfoid = 'public.fn_satellite_target_player_provenance_is_immutable()'::regprocedure)
           OR (g.tgrelid = 'public.tournament_payouts'::regclass
               AND g.tgfoid = 'public.fn_tournament_payouts_are_append_only()'::regprocedure))) <> 3 THEN
    RAISE EXCEPTION 'finish lane migration refused: a guard trigger is missing or disabled';
  END IF;
  -- The F06 source guard tries G shared plus T, never G exclusive.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'smarter_private' AND p.proname IN ('f06_source_guard', 'f06_try_lane')
         AND p.prosrc LIKE '%pg_try_advisory_xact_lock_shared(hashtextextended(''ca:tournament-terminal-settlement:v1'',0))%'
         AND p.prosrc NOT LIKE '%pg_try_advisory_xact_lock(hashtextextended(''ca:tournament-terminal-settlement:v1'',0))%') <> 2 THEN
    RAISE EXCEPTION 'finish lane migration refused: the F06 guard''s lane proof changed';
  END IF;

  -- The columns the finish lane reads to tell a satellite from a finish.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tournaments'
         AND column_name IN ('variant', 'tournament_type', 'satellite_target_id', 'satellite_target')) <> 4 THEN
    RAISE EXCEPTION 'finish lane migration refused: tournaments lacks a satellite column';
  END IF;
END;
$finish_pre$;

-- ---------------------------------------------------------------------------
-- 1. The finish lane: G SHARED, F EXCLUSIVE, T(id) EXCLUSIVE; satellite or
--    unknown tournament -> the global lane.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_held text := COALESCE(current_setting('ca.finish_lane_tournament', true), '');
  -- Unknown until the row proves it is a plain tournament: the whole lane.
  v_satellite boolean := true;
BEGIN
  -- Re-entry: this transaction already holds a finish lane. Every key below
  -- is already held by this backend, so nothing waits; a second tournament
  -- is refused, a transaction never holds two tournaments' lanes.
  IF v_held <> '' THEN
    IF p_tournament_id IS NOT NULL AND v_held <> p_tournament_id::text THEN
      RAISE EXCEPTION 'finish lane is held for tournament %, refused for %',
        v_held, p_tournament_id USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-finish-lane:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_held, 0));
    RETURN;
  END IF;

  -- Resolve the tournament before any lock. variant, tournament_type and the
  -- satellite target are fixed for the life of the row, so reading them
  -- unlocked gives the answer reading them under the lane would.
  IF p_tournament_id IS NOT NULL THEN
    SELECT (lower(COALESCE(t.variant::text, '')) = 'satellite'
            OR upper(COALESCE(t.tournament_type::text, '')) = 'SATELLITE'
            OR t.satellite_target_id IS NOT NULL
            OR t.satellite_target IS NOT NULL)
      INTO v_satellite
      FROM public.tournaments t
     WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      v_satellite := true;
    END IF;
  END IF;

  -- A satellite finish writes the target tournament's rows, and an unknown
  -- tournament cannot be scoped: the whole lane, as it always was.
  IF v_satellite THEN
    PERFORM public.fn_ca_lock_settlement_lane_global();
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, the rare global authorities (G
  -- exclusive) and nothing else. Hands and rolling authorities of other
  -- tournaments run beside this finish.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  -- F EXCLUSIVE: one finish on the platform at a time, so finish-against-
  -- finish wallet order is what it was under G exclusive.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-finish-lane:v1', 0));
  -- T(id) EXCLUSIVE: this tournament's hands (T shared) and rolling
  -- authorities (T exclusive) wait for the finish, and the proof-of-
  -- authority guards read it as this backend's authority over the rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));
  -- The rest of this transaction re-enters this lane through
  -- fn_ca_lock_settlement_lane_global; transaction-local, gone at commit.
  PERFORM set_config('ca.finish_lane_tournament', p_tournament_id::text, true);
END;
$function$;

-- Same grants as the other lane helpers: the owner and the engine's role.
-- (Applied as FROM PUBLIC; the schema's default privileges had also granted
-- authenticated, revoked in the same minute, so the installed ACL is
-- {postgres, service_role} like the other lane helpers.)
REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The global helper re-enters a held finish lane instead of upgrading.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_global()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Inside a non-satellite finish (2026-09-17) this transaction already
  -- holds that finish's lane: G shared, F exclusive, T(id) exclusive. The
  -- finish body and the settle functions still call this helper; re-enter
  -- the lane that is held instead of requesting G exclusively, which would
  -- be an upgrade of a shared hold (2026-09-10: no upgrades, they deadlock).
  IF COALESCE(current_setting('ca.finish_lane_tournament', true), '') <> '' THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_finish(NULL);
    RETURN;
  END IF;
  -- G then B. Terminal / rare authorities: serialised against every other
  -- authority AND against every hand settlement, as on 2026-09-09.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The finish takes the finish lane. Only the lane line changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'terminal settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'terminal_finish',NULL);
  BEGIN
    v_result:=public.fn_complete_tournament_terminal_pre_seat_guard(
      p_tournament_id,p_observed_winner_id,p_settlement_mode);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$function$;

-- Unchanged grants, restated: the engine's role only (they are {postgres,
-- service_role} in production; CREATE OR REPLACE keeps them, the static
-- definer check cannot see that).
REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The read-only terminal outcome resolver takes the rolling lane.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_resolve_tournament_terminal_outcome(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_t record;
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_receipt jsonb;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal outcome requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal outcome mode %',p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite',p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_h FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_h.settlement_mode IS DISTINCT FROM v_mode
       OR (p_observed_winner_id IS NOT NULL
           AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id) THEN
      RAISE EXCEPTION 'terminal outcome parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    v_receipt := public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
    RETURN jsonb_build_object(
      'ok',true,
      'terminal_committed',true,
      'definitively_not_committed',false,
      'status','COMPLETED',
      'mode',v_mode,
      'tournament_id',p_tournament_id,
      'receipt',v_receipt);
  END IF;

  IF upper(COALESCE(v_t.status::text,'')) = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed tournament % has no atomic terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % has non-terminal-outcome status %',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,
    'terminal_committed',false,
    'definitively_not_committed',true,
    'status',upper(v_t.status::text),
    'mode',v_mode,
    'tournament_id',p_tournament_id,
    'receipt','null'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. POSTCONDITIONS on the live catalog, inside this transaction.
-- ---------------------------------------------------------------------------
DO $finish_post$
DECLARE
  v_set text;
  v_path text;
BEGIN
  -- Only the two lane helpers take G exclusively (the rolling helper only in
  -- its no-tournament branch). The finish lane takes G shared.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ 'pg_advisory_xact_lock\(\s*hashtextextended\(\s*''ca:tournament-terminal-settlement:v1''\s*,\s*0\s*\)\s*\)';
  IF v_set IS DISTINCT FROM
     'fn_ca_lock_settlement_lane_for_tournament,fn_ca_lock_settlement_lane_global' THEN
    RAISE EXCEPTION 'finish lane migration: G is taken exclusively by %', v_set;
  END IF;

  -- Only the finish lane takes F, and it takes G shared before it.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p
   WHERE p.prosrc LIKE '%ca:tournament-finish-lane:v1%';
  IF v_set IS DISTINCT FROM 'fn_ca_lock_settlement_lane_for_finish' THEN
    RAISE EXCEPTION 'finish lane migration: F is named by %', v_set;
  END IF;
  IF strpos((SELECT p.prosrc FROM pg_catalog.pg_proc p
              WHERE p.oid = 'public.fn_ca_lock_settlement_lane_for_finish(uuid)'::regprocedure),
            'pg_advisory_xact_lock_shared(') = 0 THEN
    RAISE EXCEPTION 'finish lane migration: the finish lane does not hold G shared';
  END IF;

  -- The wrapper takes the finish lane, the resolver the rolling lane, and
  -- neither names the global helper any more.
  IF strpos((SELECT p.prosrc FROM pg_catalog.pg_proc p
              WHERE p.oid = 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure),
            'fn_ca_lock_settlement_lane_for_finish(p_tournament_id)') = 0
     OR strpos((SELECT p.prosrc FROM pg_catalog.pg_proc p
              WHERE p.oid = 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure),
            'fn_ca_lock_settlement_lane_global(') > 0
     OR strpos((SELECT p.prosrc FROM pg_catalog.pg_proc p
              WHERE p.oid = 'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)'::regprocedure),
            'fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)') = 0 THEN
    RAISE EXCEPTION 'finish lane migration: a replaced body does not take its lane';
  END IF;

  -- No rolling authority reaches the global lane (that would be a G shared
  -- -> exclusive upgrade). Walk name references four calls deep from every
  -- function that takes the rolling lane, as on 2026-09-10.
  WITH RECURSIVE fns AS (
    SELECT DISTINCT ON (p.proname) p.proname::text AS proname, p.prosrc
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
     ORDER BY p.proname, p.oid),
  globals AS (
    SELECT proname FROM fns
     WHERE strpos(prosrc, 'fn_ca_lock_settlement_lane_global(') > 0
       AND proname NOT IN ('fn_ca_lock_settlement_lane_global',
                           'fn_ca_lock_settlement_lane_for_finish')),
  edges AS (
    SELECT a.proname AS caller, b.proname AS callee
      FROM fns a JOIN fns b ON b.proname <> a.proname
       AND length(b.proname) > 6
       AND strpos(a.prosrc, b.proname || '(') > 0),
  walk(node, path, depth) AS (
    SELECT f.proname, f.proname, 0 FROM fns f
     WHERE (strpos(f.prosrc, 'fn_ca_lock_settlement_lane_for_tournament(') > 0
            OR strpos(f.prosrc, 'fn_ca_lock_tournament_seat_acquisition(') > 0)
       AND f.proname NOT IN ('fn_ca_lock_settlement_lane_for_tournament',
                             'fn_ca_lock_tournament_seat_acquisition',
                             'fn_resolve_tournament_terminal_outcome')
       AND f.proname NOT IN (SELECT proname FROM globals)
    UNION ALL
    SELECT e.callee, w.path || ' > ' || e.callee, w.depth + 1
      FROM walk w JOIN edges e ON e.caller = w.node
     WHERE w.depth < 4 AND strpos(w.path, e.callee) = 0)
  SELECT path INTO v_path FROM walk
   WHERE depth > 0
     AND (node IN (SELECT proname FROM globals) OR node = 'fn_ca_lock_settlement_lane_global')
   LIMIT 1;
  IF v_path IS NOT NULL THEN
    RAISE EXCEPTION 'finish lane migration: a rolling authority reaches the global lane: %', v_path;
  END IF;

  -- The non-satellite finish reaches the global helper (now a re-entry of
  -- its own lane) only through the reviewed per-tournament callees. A new
  -- name here is a new money authority inside the finish that nobody has
  -- read for writes to another tournament's rows: refuse and make someone
  -- look.
  WITH RECURSIVE fns AS (
    SELECT DISTINCT ON (p.proname) p.proname::text AS proname, p.prosrc
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
     ORDER BY p.proname, p.oid),
  edges AS (
    SELECT a.proname AS caller, b.proname AS callee
      FROM fns a JOIN fns b ON b.proname <> a.proname
       AND length(b.proname) > 6
       AND strpos(a.prosrc, b.proname || '(') > 0),
  walk(node, path, depth) AS (
    SELECT f.proname, f.proname, 0 FROM fns f
     WHERE f.proname = 'fn_complete_tournament_terminal'
    UNION ALL
    SELECT e.callee, w.path || ' > ' || e.callee, w.depth + 1
      FROM walk w JOIN edges e ON e.caller = w.node
     WHERE w.depth < 4 AND strpos(w.path, e.callee) = 0
       AND e.callee NOT IN ('fn_ca_lock_settlement_lane_global',
                            'fn_ca_lock_settlement_lane_for_finish',
                            'fn_ca_lock_settlement_lane_for_tournament'))
  SELECT string_agg(r.node, ',' ORDER BY r.node COLLATE "C")
    INTO v_set
    FROM (SELECT DISTINCT w.node
            FROM walk w JOIN fns f ON f.proname = w.node
           WHERE strpos(f.prosrc, 'fn_ca_lock_settlement_lane_global(') > 0) r;
  IF v_set IS DISTINCT FROM
     'fn_complete_tournament_terminal_pre_seat_guard,fn_finalize_bounty_pool,'
     'fn_mystery_bounty_settle,fn_settle_tournament_final_table_deal,'
     'fn_settle_tournament_places,fn_settle_tournament_rake' THEN
    RAISE EXCEPTION 'finish lane migration: the finish reaches the global helper through %', v_set;
  END IF;
END;
$finish_post$;

COMMIT;
