-- ============================================================================
-- A FINISHED EVENT KEEPS NO DEAD LEASE
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-03.
--
-- WHAT HAPPENED
--
-- The 19:07 restart left lease rows on two COMPLETED events, aa27c94f and
-- e52435d6. Both finished at 19:06:34/37; their holder (1-14d6b5c1) stopped
-- heartbeating at 19:06:40/45 and never released them. At 19:52 they were
-- still there, 46 minutes stale; at 21:01, after the 21:00 database restart,
-- 9 lease rows on COMPLETED/CANCELLED events were more than 60 s stale.
--
-- Such a row grants nothing (every lease check demands a heartbeat younger
-- than 30 s), but it is a lie on the board: it names a holder for an event
-- nobody will ever deal again, and it was removed only by
-- reap_dead_engine_leases with the engine's one-hour cutoff, at boot and
-- hourly - up to two hours.
--
-- THE CHANGE (this function only; same signature, arguments and result)
--
--   * The tournament loop also takes a lease whose event is COMPLETED or
--     CANCELLED and whose heartbeat is more than 60 s old (twice the 30 s
--     takeover window, twelve renewals missed), whatever cutoff the caller
--     passed. Every engine runs the reaper at boot, so a restart clears what
--     the previous process left at once, and the hourly pass clears what a
--     stall left within the hour.
--   * Such a row is deleted only exactly as it was locked
--     (heartbeat_at = candidate.heartbeat_at; the loop holds FOR UPDATE on
--     it), and only when f06_lease_has_pending_custody says no custody is
--     pending - the F06 retention is unchanged and still counted.
--
-- Not changed: the 600 s floor for the age-based cutoff, the table-lease
-- loop, any RUNNING or REGISTERING event's lease, owner, ACL, search_path.
--
-- @live-proof: position('A FINISHED EVENT KEEPS NO DEAD LEASE' in pg_get_functiondef('public.reap_dead_engine_leases(integer)'::regprocedure)) > 0

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $mig$
DECLARE
  v_fn constant regprocedure := 'public.reap_dead_engine_leases(integer)'::regprocedure;
  v_marker constant text := 'A FINISHED EVENT KEEPS NO DEAD LEASE';
  v_src text; v_new text; v_anchor text; v_n int; e jsonb;
  v_edits jsonb;
BEGIN
  IF NOT (current_user IN ('postgres','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;
  v_src := pg_get_functiondef(v_fn);
  IF position(v_marker in v_src) > 0 THEN
    RAISE NOTICE 'reap_dead_engine_leases already reaps finished events; skipping';
    RETURN;
  END IF;
  IF md5(v_src) <> '789c71d1e878e509cc1236627a749003' THEN
    RAISE EXCEPTION 'reap_dead_engine_leases changed since it was measured (md5 %) - re-read it before editing', md5(v_src);
  END IF;

  v_edits := jsonb_build_array(
    jsonb_build_object('anchor', $a$  WHERE l.heartbeat_at<cutoff ORDER BY l.tournament_id FOR UPDATE OF l SKIP LOCKED LOOP$a$,
      'with', $w$  WHERE l.heartbeat_at<cutoff
     /* A FINISHED EVENT KEEPS NO DEAD LEASE (2026-10-03). A lease on a
        COMPLETED or CANCELLED event that has missed twelve renewals has no
        live holder; it goes at boot or on the next pass, not in an hour. */
     OR (l.heartbeat_at<now()-interval '60 seconds'
         AND EXISTS (SELECT 1 FROM public.tournaments t
                      WHERE t.id=l.tournament_id AND t.status IN ('COMPLETED','CANCELLED')))
  ORDER BY l.tournament_id FOR UPDATE OF l SKIP LOCKED LOOP$w$),
    jsonb_build_object('anchor', $a$   DELETE FROM public.engine_tournament_leases WHERE tournament_id=candidate.tournament_id AND heartbeat_at<cutoff;$a$,
      'with', $w$   DELETE FROM public.engine_tournament_leases WHERE tournament_id=candidate.tournament_id AND heartbeat_at=candidate.heartbeat_at;$w$));

  v_new := v_src;
  FOR e IN SELECT x FROM jsonb_array_elements(v_edits) x LOOP
    v_anchor := e->>'anchor';
    v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'reaper anchor appears % times, expected exactly 1: %', v_n, left(v_anchor, 60);
    END IF;
    v_new := replace(v_new, v_anchor, e->>'with');
  END LOOP;
  IF position(v_marker in v_new) = 0 THEN
    RAISE EXCEPTION 'reaper substitution produced no marked change';
  END IF;
  EXECUTE v_new;
END
$mig$;

-- The function keeps its owner, grants and configuration (CREATE OR REPLACE).
DO $prove$
DECLARE
  p record;
BEGIN
  SELECT pg_get_userbyid(proowner) AS owner, proacl::text AS acl, proconfig::text AS cfg, prosecdef
    INTO p FROM pg_proc WHERE oid = 'public.reap_dead_engine_leases(integer)'::regprocedure;
  IF p.owner <> 'postgres'
     OR p.acl <> '{postgres=X/postgres,service_role=X/postgres}'
     OR p.cfg <> '{search_path=public}'
     OR NOT p.prosecdef THEN
    RAISE EXCEPTION 'reaper owner/acl/config changed (owner %, acl %, cfg %)', p.owner, p.acl, p.cfg;
  END IF;
END
$prove$;

COMMIT;
