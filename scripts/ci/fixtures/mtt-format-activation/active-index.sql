-- Exact existing production index captured 2026-09-17T19:52:54Z in foundation-metadata.
-- Missing only from the retained native fixture; this is NOT production DDL.
DO $fixture$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
    OR current_database() !~ '^r46_mtt_isolation_[0-9a-f]{32}$' THEN
  RAISE EXCEPTION 'ACTIVATION_OWNED_NATIVE_FIXTURE_REQUIRED';
 END IF;
 IF to_regclass('public.idx_tournaments_status_start_time') IS NULL THEN
  CREATE INDEX idx_tournaments_status_start_time ON public.tournaments USING btree (status,start_time);
 END IF;
 IF (SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid='public.idx_tournaments_status_start_time'::regclass)
    IS DISTINCT FROM 'CREATE INDEX idx_tournaments_status_start_time ON public.tournaments USING btree (status, start_time)' THEN
  RAISE EXCEPTION 'ACTIVATION_ACTIVE_INDEX_FIXTURE_DRIFT';
 END IF;
END $fixture$;
