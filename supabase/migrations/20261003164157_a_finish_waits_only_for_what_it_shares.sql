-- 20261003164157_a_finish_waits_only_for_what_it_shares
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 16:41:57 UTC.
--
-- WHAT WAS WRONG (measured on production, 2026-10-03)
--
-- Decided Spins and Sit & Gos reached their terminal receipt (receipt
-- settled_at minus the last elimination) at p50 3.2 s / p95 15.5 s between
-- 16:00 and 16:35 UTC (929 finishes), and p95 38.7 s between 15:30 and 16:00.
-- fn_complete_tournament_terminal itself is not 2-12 s of CPU. Uncontended,
-- right after the 16:35 restart, it measured 0.41-2.1 s (mean 1.04 s, 35
-- calls, pg_stat_statements). The rest of the tail is waiting, and the
-- postgres log names every wait with its call stack (parsed.context). For
-- finish RPCs, 15:30-16:35 UTC, waits over 1 s:
--
--   F(scope) exclusive, another finish of the same bank scope   226  1,094 s
--   F shared, behind an F-exclusive request                     154    569 s
--   agent-commission:<club>, behind a cash commission batch      74    135 s
--
-- 1. THE QUALIFIER ASK STALLS EVERY FINISH ON THE PLATFORM. 312 of the 315
--    requests for ca:tournament-finish-lane:v1 EXCLUSIVE in that window came
--    from fn_get_satellite_qualifier_state, through
--    fn_ca_lock_settlement_lane_for_satellite_finish. An exclusive request
--    waits for every ordinary finish holding F shared, and every new
--    ordinary finish queues behind it, so one ask costs the platform the
--    duration of the slowest finish in flight (15:47:27-15:48:37: seventeen
--    finishes of 10-19 s back to back). The ask moves no money. It reads the
--    satellite, may materialize the satellite's own entitlement rows, and
--    must not answer while that satellite's payer runs ("a lost response
--    cannot release a replacement dealer while its payer runs"). The payer
--    holds G shared, F exclusive, T(satellite) and T(target) exclusive.
--    The ask now takes G shared, F SHARED, then T(satellite) and T(target)
--    exclusive in the same uuid order: it still waits for, and excludes,
--    that payer (F exclusive and both T keys), every sweep (F exclusive),
--    every global authority (G exclusive), both tournaments' hands (T
--    shared) and rolling authorities (T exclusive) and an ordinary finish of
--    the target (T(target)). It no longer excludes ordinary finishes of
--    unrelated tournaments, which share nothing with it. Two asks into one
--    target serialize on T(target); every holder of two T keys takes them in
--    uuid order, so no new cycle exists. No proof-of-authority guard reads F:
--    they read T(id) or G held exclusively, which are unchanged. The new
--    helper, fn_ca_lock_satellite_answer_lane, never names F itself: it takes
--    G shared, F shared and the first T key through the finish helper's
--    re-entry path, so the lane doctrine's rule 2 (F is named only by the
--    three finish helpers) still holds, and the doctrine is asked below. The
--    satellite payer and every other caller keep
--    fn_ca_lock_settlement_lane_for_satellite_finish and F exclusive.
--
--    FIRST DISPATCH (17:10 UTC) WAS REFUSED AND ROLLED BACK by that doctrine
--    check: the first version added an overload of the satellite helper, and
--    rule 2 lists one name per overload. Nothing but the CONCURRENTLY-built
--    index (IF NOT EXISTS, below) remained; this file was never installed.
--
-- 2. EVERY FINISH SCANS EVERY TABLE ITS CLUB EVER HAD, THEN WRITES THE CLUB
--    ROW. Closing the tournament table fires fn_on_table_status_change ->
--    fn_refresh_club_activity_counts(club). Its live-table count
--      WHERE tb2.club_id = $club AND lower(coalesce(status,'')) NOT IN (...)
--    has no index and walks public.tables (430k rows, 86k removed per worker):
--    112 ms with 4 parallel workers in a SELECT, serial inside the UPDATE
--    (~0.41 s per finish in the plpgsql profile: fn_on_table_status_change
--    826 ms over 2 finishes). It then rewrote the clubs row even when both
--    counts were unchanged, firing the 23 UPDATE triggers on clubs and taking
--    that row's lock to commit, which is why finishes also waited "while
--    locking tuple in relation clubs" (1-4 s each). Now a partial index whose
--    predicate is exactly that filter answers the count from the club's few
--    live tables, and the row is written only when a count moved (the law of
--    fn_sync_club_table_counts, 2026-09-29). The columns end every call
--    holding exactly the recomputed values, as before.
--
-- NOT CHANGED: every money path, lock taken by a finish, receipt, escrow
-- and conservation proof, the satellite payer, F06 and seat guards, grants of
-- existing functions, schedules. The engine is unchanged.
--
-- HOW IT IS APPLIED. The index is built CONCURRENTLY in the preamble (public.tables
-- is written by every hand loop; a plain build would hold SHARE on it). The
-- transaction then refuses an INVALID leftover by name, edits both functions
-- from their exact 2026-10-03 preimages by one anchor each, verifies each
-- postimage, and asks the lane doctrine.
--
-- @live-proof: (SELECT bool_and(x) FROM (VALUES ((SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid = to_regclass('public.idx_tables_club_activity_live'))), (to_regprocedure('public.fn_ca_lock_satellite_answer_lane(uuid)') IS NOT NULL), (strpos(pg_get_functiondef('public.fn_get_satellite_qualifier_state(uuid)'::regprocedure), 'fn_ca_lock_satellite_answer_lane(p_tournament_id)') > 0), (strpos(pg_get_functiondef('public.fn_refresh_club_activity_counts(uuid)'::regprocedure), 'c.active_tables IS DISTINCT FROM coalesce(t.n, 0)') > 0)) v(x))

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tables_club_activity_live
  ON public.tables USING btree (club_id)
  WHERE (lower(COALESCE(status, ''::text)) <> ALL (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text]));

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- The index exists, is valid, and is exactly the definition measured.
-- ---------------------------------------------------------------------------
DO $idx$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.idx_tables_club_activity_live')
       AND i.indisvalid AND i.indisready AND i.indislive
       AND pg_get_indexdef(i.indexrelid) =
         'CREATE INDEX idx_tables_club_activity_live ON public.tables USING btree (club_id) WHERE (lower(COALESCE(status, ''''::text)) <> ALL (ARRAY[''closed''::text, ''completed''::text, ''cancelled''::text, ''finished''::text]))'
  ) THEN
    RAISE EXCEPTION 'idx_tables_club_activity_live is missing, invalid or not the measured definition'
      USING ERRCODE = '55000';
  END IF;
END
$idx$;

-- ---------------------------------------------------------------------------
-- The answer-only satellite lane: G shared, F shared, both T keys exclusive.
-- It does not name F itself (the lane doctrine's rule 2: only the three
-- finish helpers name F). It takes G shared, F shared and T(first) through
-- fn_ca_lock_settlement_lane_for_finish's own re-entry path, which is exactly
-- those three keys for the tournament this transaction names as its lane.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_lock_satellite_answer_lane(p_satellite_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_held text := COALESCE(current_setting('ca.finish_lane_tournament', true), '');
  v_target_id uuid;
  v_first uuid;
  v_second uuid;
BEGIN
  IF v_held <> '' THEN
    -- Re-entry inside a finish transaction: everything below is held.
    PERFORM public.fn_ca_lock_settlement_lane_for_finish(NULL);
    RETURN;
  END IF;
  IF p_satellite_id IS NOT NULL THEN
    SELECT COALESCE(t.satellite_target_id, t.satellite_target)
      INTO v_target_id
      FROM public.tournaments t
     WHERE t.id = p_satellite_id;
  END IF;
  IF p_satellite_id IS NULL OR v_target_id IS NULL OR v_target_id = p_satellite_id THEN
    -- No target to scope to: the satellite finish lane decides, as it always did.
    PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_satellite_id);
    RETURN;
  END IF;
  -- AN ANSWER WAITS ONLY FOR WHAT IT SHARES (2026-10-03). Both T keys in uuid
  -- order, the payer's order. The first comes with G shared and F shared from
  -- the finish helper's re-entry path (no bank scope is named, so no scope
  -- key): the satellite's payer and every sweep hold F exclusively and are
  -- still waited for and excluded, while ordinary finishes of other
  -- tournaments (F shared) no longer drain before an answer and queue behind
  -- it. Then the second T key exclusively. The payer, both tournaments'
  -- hands and rolling authorities, and a finish of the target are excluded
  -- exactly as before.
  IF p_satellite_id::text < v_target_id::text THEN
    v_first := p_satellite_id; v_second := v_target_id;
  ELSE
    v_first := v_target_id; v_second := p_satellite_id;
  END IF;
  PERFORM set_config('ca.finish_lane_scope', '', true);
  PERFORM set_config('ca.finish_lane_tournament', v_first::text, true);
  PERFORM public.fn_ca_lock_settlement_lane_for_finish(NULL);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_second::text, 0));
  -- Re-entry names the satellite, as the satellite finish lane does (the
  -- receipt readers re-enter through fn_ca_lock_settlement_lane_for_finish(NULL),
  -- which asks F shared and the held T key, both already held here).
  PERFORM set_config('ca.finish_lane_tournament', p_satellite_id::text, true);
END;
$function$;

-- Executable by its owner only: the qualifier ask is SECURITY DEFINER owned
-- by postgres, and no PostgREST role needs this helper.
REVOKE ALL ON FUNCTION public.fn_ca_lock_satellite_answer_lane(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The qualifier ask takes the answer-only lane; the club refresh reads its
-- live tables through the new index and writes only a changed count.
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
  -- qualifier ask
  s := 'public.fn_get_satellite_qualifier_state(uuid)'::regprocedure;
  d := pg_get_functiondef(s);
  IF md5(d) <> 'c98348c74d821296e277f94b2987bdec' THEN
    RAISE EXCEPTION 'qualifier ask preimage %', md5(d);
  END IF;
  a := E' -- The same lane serializes this answer with an unknown prior finish, so a\n'
    || E' -- lost response cannot release a replacement dealer while its payer runs.\n'
    || E' PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);\n';
  r := E' -- The same lane serializes this answer with an unknown prior finish, so a\n'
    || E' -- lost response cannot release a replacement dealer while its payer runs.\n'
    || E' -- Answer-only (2026-10-03): F shared, both T keys exclusive. The payer\n'
    || E' -- (F exclusive, both T keys) is still waited for; unrelated finishes are not.\n'
    || E' PERFORM public.fn_ca_lock_satellite_answer_lane(p_tournament_id);\n';
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'qualifier ask anchor count';
  END IF;
  d := replace(d, a, r);
  EXECUTE d;
  IF pg_get_functiondef(s) <> d THEN
    RAISE EXCEPTION 'qualifier ask postimage differs from the substituted text';
  END IF;

  -- club activity refresh
  s := 'public.fn_refresh_club_activity_counts(uuid)'::regprocedure;
  d := pg_get_functiondef(s);
  IF md5(d) <> '6d1c533f259826f0c9c3424b1b3737b7' THEN
    RAISE EXCEPTION 'club activity refresh preimage %', md5(d);
  END IF;
  a := E'     WHERE c.id = base.id\n'
    || E'       AND (p_club_id IS NULL OR base.id = p_club_id);\n';
  r := E'     WHERE c.id = base.id\n'
    || E'       AND (p_club_id IS NULL OR base.id = p_club_id)\n'
    || E'       -- A COUNT THAT HAS NOT CHANGED IS NOT A WRITE (2026-10-03): no clubs\n'
    || E'       -- row version, no clubs UPDATE triggers, no row lock to commit.\n'
    || E'       AND (c.active_players IS DISTINCT FROM coalesce(p.n, 0)\n'
    || E'         OR c.active_tables IS DISTINCT FROM coalesce(t.n, 0));\n';
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'club activity refresh anchor count';
  END IF;
  d := replace(d, a, r);
  EXECUTE d;
  IF pg_get_functiondef(s) <> d THEN
    RAISE EXCEPTION 'club activity refresh postimage differs from the substituted text';
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------------
-- The lane doctrine still holds with the overload in the catalog.
-- ---------------------------------------------------------------------------
DO $doctrine$
DECLARE v jsonb := public.fn_ca_settlement_lane_doctrine();
BEGIN
  IF (SELECT p.proacl::text FROM pg_proc p
       WHERE p.oid = 'public.fn_ca_lock_satellite_answer_lane(uuid)'::regprocedure)
     IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'answer-only lane is executable beyond its owner' USING ERRCODE = '55000';
  END IF;
  IF COALESCE((v->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'settlement lane doctrine refused: %', v->'violations' USING ERRCODE = '55000';
  END IF;
END
$doctrine$;

COMMIT;
