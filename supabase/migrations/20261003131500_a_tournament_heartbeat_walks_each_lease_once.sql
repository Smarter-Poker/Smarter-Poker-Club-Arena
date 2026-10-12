-- ============================================================================
-- A TOURNAMENT HEARTBEAT WALKS EACH LEASE ONCE
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-03.
--
-- WHAT HAPPENED (09:34-09:38 UTC)
--
-- 470 tournament_lease_proof_expired + 333 tournament_lease_lost watchdog
-- rebuilds (engine_recovery_events) while cron job 407 held ONE transaction
-- from 09:25:00 to 09:40:00 (a rolled-back probe of the weekly union close,
-- statement_timeout 900 s). Cash heartbeats were unaffected.
--
--   * The dedicated tournament heartbeat (role engine_lease_heartbeat) hit
--     its 8 s statement_timeout at 09:34:41, 09:35:46, 09:37:06, 09:38:26 and
--     09:38:51 (postgres log, SQLSTATE 57014). It never waited on a lock:
--     log_lock_waits (1 s) logged nothing for that role, and the function
--     SKIPs locked rows. Hedges on the shared client took 4.2-7.4 s.
--     pg_stat_statements since 2026-10-02 23:57: tournament heartbeat max
--     7,650 ms, table heartbeat max 1,038 ms.
--   * The union close does not touch engine_tournament_leases, the f06
--     tables or any row the heartbeat reads (no function on that path
--     references them). What it did was hold the xmin horizon for 15 minutes.
--
-- WHY A PINNED HORIZON HITS THIS FUNCTION AND NOT THE CASH ONE
--
-- Every tournament-manager write locks its lease row FOR KEY SHARE
-- (smarter_private.fn_smarter_data_api_pre_request, and every hand
-- submission), and the heartbeat UPDATEs that row every 5 s. An UPDATE of a
-- row with live KEY SHARE lockers stamps the superseded version with a
-- MultiXact xmax. While the horizon is pinned no version can be pruned, so
-- each lease row grows a chain of ~12 versions a minute, and every index
-- probe of the row walks the whole chain, resolving the MultiXact members of
-- every version (no hint bit caches an update MultiXact). The MultiXact SLRU
-- is small (multixact_member_buffers 32, multixact_offset_buffers 16) and
-- already thrashes (pg_stat_slru multixact_member blks_read 3.34e9 since
-- 2026-09-28, ~10k/s at 12:45), so the cost per probe climbs with the pin.
-- This function probed each claimed row THREE times: the lockable CTE, the
-- UPDATE's join back to the table, and the final LEFT JOIN that classifies
-- the answer.
--
-- Reproduced on a local PostgreSQL 16 copy of this function and table (264
-- leases, 16 clients taking FOR KEY SHARE at ~2,800 tps, one REPEATABLE READ
-- transaction holding the horizon, one fleet heartbeat a second): 48 ms ->
-- 500-870 ms within ~150 heartbeats; the same pin WITHOUT the lockers only
-- 28 -> 74 ms. The MultiXact chains are the amplifier.
--
-- THE CHANGE (this function only; same signature, arguments and answers)
--
--   * lockable also returns the ctid of the version it locked, and the
--     UPDATE reaches that exact version with a TID scan instead of probing
--     the index again. The UPDATE keeps every predicate (instance, protocol,
--     generation, f06 abort, 30 s staleness) and adds tournament_id = the
--     locked row's id, so it can only renew the row it locked. If that row
--     was changed between the statement snapshot and the lock, the TID scan
--     finds nothing and the claim reads `busy` (renews nothing) - never a
--     false `kept`.
--   * The final classification reads the row only for claims that were NOT
--     renewed (a CASE subquery, never executed for `kept`). Its rules are
--     unchanged: missing, stale, busy, taken, with the same generation.
--
-- Same local harness, old vs new on the same pinned chains: 129 ms vs 50 ms
-- in one late-pin measurement (2.6x); alternating the two every second
-- through a 190 s pin, 1.33x-1.5x on average (each call also warms the SLRU
-- for the other). The subplans report "never executed" for renewed claims.
-- This lowers the cost and the lock-hold time of every renewal; it does not
-- make an unbounded pin harmless. Every state (kept, taken, stale, other
-- instance, aborted generation, FOR SHARE busy, KEY SHARE kept, missing)
-- returned identical state and generation from both versions.
--
-- Not changed: heartbeat_table_leases_v4, any lease row, lock mode,
-- SKIP LOCKED, the 30 s window, owner, ACL or search_path. The only cure for
-- the chains themselves is not to pin the horizon during play: a back-office
-- transaction that runs ~9 minutes or more starts fencing tournaments.
--
-- @live-proof: position('A TOURNAMENT HEARTBEAT WALKS EACH LEASE ONCE' in pg_get_functiondef('public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure)) > 0 AND position('l.ctid = k.row_ctid' in pg_get_functiondef('public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure)) > 0

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $mig$
DECLARE
  v_fn constant regprocedure := 'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure;
  v_marker constant text := 'A TOURNAMENT HEARTBEAT WALKS EACH LEASE ONCE';
  v_src text; v_new text; v_anchor text; v_n int; e jsonb;
  v_edits jsonb;
BEGIN
  IF NOT (current_user IN ('postgres','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;
  v_src := pg_get_functiondef(v_fn);
  IF position(v_marker in v_src) > 0 THEN
    RAISE NOTICE 'heartbeat_tournament_leases_v4 already walks each lease once; skipping';
    RETURN;
  END IF;
  IF md5(v_src) <> '01fa17de7097d3c42748e6879b478411' THEN
    RAISE EXCEPTION 'heartbeat_tournament_leases_v4 changed since it was measured (md5 %) - re-read it before editing', md5(v_src);
  END IF;

  v_edits := jsonb_build_array(
    jsonb_build_object('anchor', $a$  lockable AS MATERIALIZED (
    SELECT l.tournament_id
      FROM public.engine_tournament_leases l$a$,
      'with', $w$  /* A TOURNAMENT HEARTBEAT WALKS EACH LEASE ONCE (2026-10-03). The
     UPDATE reaches the exact version locked here by its ctid instead of
     probing the index again, and the answer reads the row only for claims
     that were not renewed. Under a pinned xmin every probe walks a chain of
     MultiXact-stamped versions; 09:34-09:38 three probes per claim ran past
     the 8 s statement_timeout. */
  lockable AS MATERIALIZED (
    SELECT l.tournament_id, l.ctid AS row_ctid
      FROM public.engine_tournament_leases l$w$),
    jsonb_build_object('anchor', $a$     WHERE l.tournament_id = a.id
       AND k.tournament_id = l.tournament_id
$a$,
      'with', $w$     WHERE l.ctid = k.row_ctid
       AND l.tournament_id = k.tournament_id
       AND l.tournament_id = a.id
$w$),
    jsonb_build_object('anchor', $a$  SELECT a.id,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN 'kept'
           WHEN l.tournament_id IS NULL THEN 'missing'
           WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN 'stale'
           WHEN l.instance_id = p_instance_id
            AND l.protocol_version = 2
            AND l.lease_generation = a.requested_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation) THEN 'busy'
           ELSE 'taken'
         END,
         l.lease_generation
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id
    LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = a.id;$a$,
      'with', $w$  SELECT a.id,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN 'kept'
           ELSE COALESCE((
             SELECT CASE
                      WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN 'stale'
                      WHEN l.instance_id = p_instance_id
                       AND l.protocol_version = 2
                       AND l.lease_generation = a.requested_generation
                       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation) THEN 'busy'
                      ELSE 'taken'
                    END
               FROM public.engine_tournament_leases l
              WHERE l.tournament_id = a.id), 'missing')
         END,
         CASE
           WHEN r.tournament_id IS NOT NULL THEN r.lease_generation
           ELSE (SELECT l.lease_generation
                   FROM public.engine_tournament_leases l
                  WHERE l.tournament_id = a.id)
         END
    FROM asked a
    LEFT JOIN renewed r ON r.tournament_id = a.id;$w$));

  v_new := v_src;
  FOR e IN SELECT x FROM jsonb_array_elements(v_edits) x LOOP
    v_anchor := e->>'anchor';
    v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'heartbeat anchor appears % times, expected exactly 1: %', v_n, left(v_anchor, 60);
    END IF;
    v_new := replace(v_new, v_anchor, e->>'with');
  END LOOP;
  IF position(v_marker in v_new) = 0 OR position('l.ctid = k.row_ctid' in v_new) = 0 THEN
    RAISE EXCEPTION 'heartbeat substitution produced no marked change';
  END IF;
  EXECUTE v_new;
END
$mig$;

-- Prove the classification path on live rows without renewing anything: a
-- foreign instance renews no row (lockable never matches it), so an existing
-- lease reads `taken` with its own generation and an unknown id `missing`.
DO $prove$
DECLARE
  v_fn constant regprocedure := 'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure;
  p record;
  l record;
  v_missing constant uuid := '00000000-0000-4000-8000-0000000c7a1d';
  v_rows int;
  v_state text;
  v_gen uuid;
BEGIN
  SELECT pg_get_userbyid(proowner) AS owner, proacl::text AS acl, proconfig::text AS cfg,
         prosecdef, provolatile
    INTO p FROM pg_proc WHERE oid = v_fn;
  IF p.owner <> 'postgres'
     OR p.acl <> '{postgres=X/postgres,service_role=X/postgres,engine_lease_heartbeat=X/postgres}'
     OR p.cfg <> '{"search_path=public, pg_temp"}'
     OR NOT p.prosecdef
     OR p.provolatile <> 'v' THEN
    RAISE EXCEPTION 'heartbeat owner/acl/config changed (owner %, acl %, cfg %)', p.owner, p.acl, p.cfg;
  END IF;

  SELECT count(*) INTO v_rows FROM public.heartbeat_tournament_leases_v4('migration-proof', '[]'::jsonb, 30);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'an empty claim list must answer nothing'; END IF;

  SELECT tournament_id, lease_generation INTO l FROM public.engine_tournament_leases LIMIT 1;
  IF FOUND THEN
    SELECT h.state, h.lease_generation INTO v_state, v_gen
      FROM public.heartbeat_tournament_leases_v4(
             'migration-proof',
             jsonb_build_array(jsonb_build_object('tournament_id', l.tournament_id,
                                                  'lease_generation', gen_random_uuid())),
             30) h;
    IF v_state IS DISTINCT FROM 'taken' AND v_state IS DISTINCT FROM 'stale' THEN
      RAISE EXCEPTION 'a foreign instance must read taken or stale, got %', v_state;
    END IF;
    IF v_gen IS DISTINCT FROM l.lease_generation THEN
      RAISE EXCEPTION 'a foreign instance must be told the holder''s generation';
    END IF;
  END IF;

  SELECT h.state, h.lease_generation INTO v_state, v_gen
    FROM public.heartbeat_tournament_leases_v4(
           'migration-proof',
           jsonb_build_array(jsonb_build_object('tournament_id', v_missing,
                                                'lease_generation', gen_random_uuid())),
           30) h;
  IF v_state IS DISTINCT FROM 'missing' OR v_gen IS NOT NULL THEN
    RAISE EXCEPTION 'an unknown tournament must read missing with no generation, got % %', v_state, v_gen;
  END IF;
END
$prove$;

COMMIT;
