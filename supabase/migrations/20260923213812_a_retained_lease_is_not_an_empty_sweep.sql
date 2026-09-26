-- A RETAINED LEASE IS NOT AN EMPTY SWEEP (2026-09-23)
--
-- `reap_dead_engine_leases` has, since 20260919024039, deliberately kept a
-- stale lease whose event still holds unresolved F06 custody: "Expired
-- authority is not disposable custody." That rule is correct and is unchanged
-- here. Nothing that was deleted before is kept, nothing that was kept before
-- is deleted, and no evidence is erased.
--
-- What was wrong is that the function had NO WORD for what it kept. Its only
-- outputs were two deletion counts, so a pass that retained forty-eight dead
-- leases and a pass with nothing to do returned the same two zeroes, and
-- `GameServer.reapDeadLeases` logs only when a count is above zero. Retention
-- was folded into silence, which is exactly the outcome CLAUDE.md 10.86 rule 1
-- forbids: "I could not tell" - or here, "I deliberately kept it" - has to be
-- its own outcome with its own name.
--
-- Measured on production at 2026-09-23 20:55 UTC, before this change: 48 of
-- 423 `engine_tournament_leases` rows were past the one-hour cutoff, the
-- oldest dead for 47.6 hours with `heartbeat_at` frozen at 2026-09-21
-- 21:19:22 UTC. All 48 were retained, all 48 by an `f06_operations` row still
-- short of `acknowledged` (13 of them also by a permit still `reserved`), all
-- 48 still named the live instance `1-3846b8bb` as their holder, and all 48
-- tournaments were still RUNNING. The hourly reaper had deleted nothing for
-- two days and had said nothing at all, on either side.
--
-- This does not reclaim those leases and does not pretend to. A successor
-- engine reclaims them through `claim_tournament_lease_v2`'s stale-takeover
-- clause, which was verified available for every one of them on the same
-- reading (`f06_generation_aborted` answered false for a fresh generation on
-- all 48). What this adds is the ability for anyone to know it is happening.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The exact installed predecessor, or this migration refuses. A body that has
-- moved since it was read is a body this rewrite has not been reasoned about.
DO $pin$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.reap_dead_engine_leases(integer)')
       AND md5(pg_get_functiondef(oid)) = '7501ae6661f48127f91d85d1fb0c9c9f'
       AND proowner = 'postgres'::regrole
       AND proconfig = ARRAY['search_path=public']
       AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'LEASE_REAPER_RETENTION_COUNT_PREIMAGE_CHANGED';
  END IF;
END $pin$;

-- The return shape gains three columns, so the drop and the create are one
-- transaction. Every existing caller reads its columns by name and is
-- unaffected; `SELECT *` callers gain the new ones.
DROP FUNCTION public.reap_dead_engine_leases(integer);

CREATE FUNCTION public.reap_dead_engine_leases(p_stale_seconds integer DEFAULT 3600)
RETURNS TABLE(table_leases_deleted integer, tournament_leases_deleted integer,
              table_leases_retained integer, tournament_leases_retained integer,
              oldest_retained_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE cutoff timestamptz; candidate record; event_id uuid; n integer;
 tables_deleted integer:=0; tournaments_deleted integer:=0;
 tables_retained integer:=0; tournaments_retained integer:=0; oldest integer:=0;
BEGIN
 IF coalesce(p_stale_seconds,0)<600 THEN
  RAISE EXCEPTION 'reap_dead_engine_leases refuses a cutoff under 600s (asked for %)',p_stale_seconds;
 END IF;
 cutoff:=now()-make_interval(secs=>p_stale_seconds);
 -- Admission holds KEY SHARE on the same lease. Lock before taking the next
 -- fresh custody snapshot; SKIP LOCKED leaves an admitted writer alone rather
 -- than waiting and then deleting from a snapshot taken before its commit.
 --
 -- A row this loop cannot lock is NOT counted as retained: it is a row this
 -- call could not read, and folding it into "kept for custody" would be the
 -- same conflation this migration exists to remove.
 FOR candidate IN SELECT l.tournament_id,l.heartbeat_at FROM public.engine_tournament_leases l
  WHERE l.heartbeat_at<cutoff ORDER BY l.tournament_id FOR UPDATE OF l SKIP LOCKED LOOP
  IF NOT smarter_private.f06_lease_has_pending_custody(candidate.tournament_id,NULL) THEN
   DELETE FROM public.engine_tournament_leases WHERE tournament_id=candidate.tournament_id AND heartbeat_at<cutoff;
   GET DIAGNOSTICS n=ROW_COUNT; tournaments_deleted:=tournaments_deleted+n;
  ELSE
   tournaments_retained:=tournaments_retained+1;
   oldest:=greatest(oldest,floor(extract(epoch FROM now()-candidate.heartbeat_at))::integer);
  END IF;
 END LOOP;
 FOR candidate IN SELECT l.table_id,l.heartbeat_at FROM public.engine_table_leases l
  WHERE l.heartbeat_at<cutoff ORDER BY l.table_id FOR UPDATE OF l SKIP LOCKED LOOP
  SELECT tournament_id INTO event_id FROM public.tables WHERE id=candidate.table_id;
  -- A converted/table lease can still be the original F06 evidence. Join its
  -- event admission fence without waiting in reverse lease order. A busy event
  -- is retained for the next existing housekeeping call, never retried here.
  BEGIN
   IF event_id IS NOT NULL THEN
    PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=event_id FOR UPDATE NOWAIT;
   END IF;
   IF NOT smarter_private.f06_lease_has_pending_custody(event_id,candidate.table_id) THEN
    DELETE FROM public.engine_table_leases WHERE table_id=candidate.table_id AND heartbeat_at<cutoff;
    GET DIAGNOSTICS n=ROW_COUNT; tables_deleted:=tables_deleted+n;
   ELSE
    tables_retained:=tables_retained+1;
    oldest:=greatest(oldest,floor(extract(epoch FROM now()-candidate.heartbeat_at))::integer);
   END IF;
  EXCEPTION WHEN lock_not_available THEN NULL;
  END;
 END LOOP;
 RETURN QUERY SELECT tables_deleted,tournaments_deleted,
                     tables_retained,tournaments_retained,oldest;
END $function$;

REVOKE ALL ON FUNCTION public.reap_dead_engine_leases(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reap_dead_engine_leases(integer) TO service_role;
COMMENT ON FUNCTION public.reap_dead_engine_leases(integer) IS
 'Existing age-based housekeeping preserves unresolved F06 hands, movements and uncompleted manager custody, and now REPORTS what it preserved. Expiry revokes authority; it does not certify retirement.';
COMMIT;
