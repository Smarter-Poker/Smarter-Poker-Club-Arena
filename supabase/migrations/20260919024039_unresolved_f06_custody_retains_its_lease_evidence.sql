-- Expired authority is not disposable custody. Keep the existing housekeeping
-- callback and age boundary; never erase an unresolved original's evidence.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $pin$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.reap_dead_engine_leases(integer)')
 AND md5(pg_get_functiondef(oid))='6144b5c9ba79371234f8bee9007ed4a6'
 AND proowner='postgres'::regrole AND proconfig=ARRAY['search_path=public']
 AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
 RAISE EXCEPTION 'F06_LEASE_RETENTION_PREIMAGE_CHANGED'; END IF;
END $pin$;

CREATE FUNCTION smarter_private.f06_lease_has_pending_custody(p_tournament_id uuid,p_table_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE event_id uuid:=p_tournament_id; held boolean;
BEGIN
 IF p_table_id IS NOT NULL THEN
  SELECT tournament_id INTO event_id FROM public.tables WHERE id=p_table_id;
 END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.state='reserved'
  AND (h.tournament_id=event_id OR h.table_id=p_table_id))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations o WHERE o.state<>'acknowledged'
  AND (o.tournament_id=event_id OR o.source_table_id=p_table_id
   OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id
    AND a.destination_table_id=p_table_id))) THEN RETURN true; END IF;

 -- The independently delivered custody authority can be installed before or
 -- after this repair. A partial schema keeps every transfer; absence of the
 -- whole schema means no transfer can yet exist. Never read private card data.
 IF to_regclass('smarter_private.f06_manager_custody_transfers') IS NOT NULL THEN
  IF to_regclass('smarter_private.f06_manager_custody_completions') IS NULL THEN
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers t
    WHERE t.tournament_id=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.local_proof->''engines'') e
     WHERE e->>''table_id''=$2::text))' INTO held USING event_id,p_table_id;
  ELSE
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers t
    WHERE (t.tournament_id=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.local_proof->''engines'') e
     WHERE e->>''table_id''=$2::text)) AND NOT EXISTS
     (SELECT 1 FROM smarter_private.f06_manager_custody_completions c WHERE c.transfer_id=t.transfer_id))'
    INTO held USING event_id,p_table_id;
  END IF;
  IF held THEN RETURN true; END IF;
 END IF;
 RETURN false;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_lease_has_pending_custody(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.reap_dead_engine_leases(p_stale_seconds integer DEFAULT 3600)
RETURNS TABLE(table_leases_deleted integer,tournament_leases_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE cutoff timestamptz; candidate record; event_id uuid; n integer; tables_deleted integer:=0; tournaments_deleted integer:=0;
BEGIN
 IF coalesce(p_stale_seconds,0)<600 THEN
  RAISE EXCEPTION 'reap_dead_engine_leases refuses a cutoff under 600s (asked for %)',p_stale_seconds;
 END IF;
 cutoff:=now()-make_interval(secs=>p_stale_seconds);
 -- Admission holds KEY SHARE on the same lease. Lock before taking the next
 -- fresh custody snapshot; SKIP LOCKED leaves an admitted writer alone rather
 -- than waiting and then deleting from a snapshot taken before its commit.
 FOR candidate IN SELECT l.tournament_id FROM public.engine_tournament_leases l
  WHERE l.heartbeat_at<cutoff ORDER BY l.tournament_id FOR UPDATE OF l SKIP LOCKED LOOP
  IF NOT smarter_private.f06_lease_has_pending_custody(candidate.tournament_id,NULL) THEN
   DELETE FROM public.engine_tournament_leases WHERE tournament_id=candidate.tournament_id AND heartbeat_at<cutoff;
   GET DIAGNOSTICS n=ROW_COUNT; tournaments_deleted:=tournaments_deleted+n;
  END IF;
 END LOOP;
 FOR candidate IN SELECT l.table_id FROM public.engine_table_leases l
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
   END IF;
  EXCEPTION WHEN lock_not_available THEN NULL;
  END;
 END LOOP;
 RETURN QUERY SELECT tables_deleted,tournaments_deleted;
END $function$;
REVOKE ALL ON FUNCTION public.reap_dead_engine_leases(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reap_dead_engine_leases(integer) TO service_role;
COMMENT ON FUNCTION public.reap_dead_engine_leases(integer) IS
 'Existing age-based housekeeping preserves unresolved F06 hands, movements and uncompleted manager custody. Expiry revokes authority; it does not certify retirement.';
COMMIT;
