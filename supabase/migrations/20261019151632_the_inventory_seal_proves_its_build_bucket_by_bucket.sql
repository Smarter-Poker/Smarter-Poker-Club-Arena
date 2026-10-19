-- 20261019151632_the_inventory_seal_proves_its_build_bucket_by_bucket.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE INVENTORY SEAL PROVES ITS BUILD BUCKET BY BUCKET.
-- Account: docs/changelog/2026-10-19-a-lock-refusal-is-not-a-day-in-the-queue.md
--
-- After 20261019102410 the week of 2026-10-12..19 wrote all 4,520,200 rows of
-- its original inventory into committed build pages by 15:00 UTC on
-- 2026-10-19. The next tick, the one that publishes, was cancelled at job
-- 272's 240 s statement timeout (15:05:00 -> 15:09:01, ready still false):
-- fn_union_pnl_inventory_seal_write_page proves the build equal to the
-- assembled cache with one EXCEPT ALL of the whole cache against the whole
-- build in both directions, and a read-only replay of exactly that query on
-- production ran past 290 s. The week's close cannot start until the seal is
-- published, so every tick would be cancelled the same way.
--
-- The proof is now taken bucket by bucket: each side is read once into
-- per-(kind, source, first two hex digits of row_id) counts and hashes, the
-- two bucket sets must be identical (a missing, extra, duplicated or changed
-- row or issue changes its bucket's count or hash), and the build's own row
-- buckets give the rows hash that must still equal the original assembly's
-- head, exactly as before (same bucketing, same row text, same order). The
-- issues hash, counts, max event, the bounded page writer, the cursor, the
-- ready transition and every refusal are unchanged. A rolled-back replay of
-- the new body on production is recorded in the changelog.
--
-- No inventory row, checkpoint, header or financial record is written by
-- this migration.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz)'::regprocedure))='3b45b74a0019ac3e65d40208a670299e')
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $admit_bucket_proof$
DECLARE refusal text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR auth.uid() IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL
 THEN RAISE EXCEPTION 'inventory_bucket_proof_operator_refused';END IF;
 refusal:=public.fn_ca_break_window_refuses_migrations(now());
 IF refusal IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false
  OR public.fn_active_maintenance_release_boundary() IS NOT NULL
 THEN RAISE EXCEPTION 'inventory_bucket_proof_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0))
 THEN RAISE EXCEPTION 'inventory_bucket_proof_writer_owns_boundary';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261019151632')
 THEN RAISE EXCEPTION 'inventory_bucket_proof_history_replay';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz)'::regprocedure))<>'3f0335746bcca5df4b0b9b475b47f7a8'
 THEN RAISE EXCEPTION 'inventory_bucket_proof_exact_preimage_required';END IF;
END $admit_bucket_proof$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_seal_write_page(p_at timestamp with time zone, p_base timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_build public.union_pnl_inventory_seal_builds%ROWTYPE; v_n bigint;
 v_head record;v_rows bigint;v_issues bigint;v_max bigint;v_rows_md5 text;v_issues_md5 text;v_diff bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0));
 IF EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints WHERE boundary=p_at) THEN
  RAISE EXCEPTION 'inventory_build_boundary_already_published' USING ERRCODE='55000'; END IF;
 INSERT INTO public.union_pnl_inventory_seal_builds(boundary,base_boundary)
 VALUES(p_at,p_base) ON CONFLICT(boundary) DO NOTHING;
 SELECT * INTO STRICT v_build FROM public.union_pnl_inventory_seal_builds WHERE boundary=p_at;
 IF v_build.base_boundary IS DISTINCT FROM p_base THEN
  RAISE EXCEPTION 'inventory_build_base_changed' USING ERRCODE='55000'; END IF;
 -- Both cardinality and encoded volume are bounded before any logged row is written.
 -- No last-step copy: these private logged rows become the checkpoint's storage.
 DROP TABLE IF EXISTS pg_temp._inv_write_page;
 CREATE TEMP TABLE _inv_write_page ON COMMIT DROP AS
 WITH candidates AS MATERIALIZED (
  SELECT s.*,512+4*GREATEST(COALESCE(pg_column_size(s.o_after_row),0),COALESCE(octet_length(s.o_after_row::text),0))::bigint
   +octet_length(s.o_source_name)+COALESCE(octet_length(s.o_first_operation),0) cost
  FROM pg_temp.union_pnl_inventory_seal s
  WHERE (v_build.last_kind IS NULL OR (s.o_kind,s.o_source_name,s.o_row_id,s.o_event_id)>(v_build.last_kind,v_build.last_source,v_build.last_row,v_build.last_event))
  AND ((s.o_kind='row' AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_build_rows b
    WHERE b.boundary=p_at AND b.source_name=s.o_source_name AND b.row_id=s.o_row_id))
   OR (s.o_kind='issue' AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_build_issues b
    WHERE b.boundary=p_at AND b.source_name=s.o_source_name AND b.row_id=s.o_row_id AND b.event_id=s.o_event_id)))
  ORDER BY s.o_kind,s.o_source_name,s.o_row_id,s.o_event_id LIMIT 32768
 ), budgeted AS (
  SELECT c.*,sum(cost) OVER(ORDER BY o_kind,o_source_name,o_row_id,o_event_id ROWS UNBOUNDED PRECEDING) used
  FROM candidates c
 ) SELECT * FROM budgeted WHERE used<=33554432;
 SELECT count(*) INTO v_n FROM pg_temp._inv_write_page;
 IF v_n>0 THEN
  IF v_build.ready THEN RAISE EXCEPTION 'inventory_ready_build_has_missing_rows' USING ERRCODE='55000'; END IF;
  INSERT INTO public.union_pnl_inventory_seal_build_rows
   SELECT p_at,o_source_name,o_row_id,o_event_id,o_first_operation,o_after_row FROM pg_temp._inv_write_page WHERE o_kind='row';
  INSERT INTO public.union_pnl_inventory_seal_build_issues
   SELECT p_at,o_source_name,o_row_id,o_event_id FROM pg_temp._inv_write_page WHERE o_kind='issue';
  UPDATE public.union_pnl_inventory_seal_builds b SET last_kind=p.o_kind,last_source=p.o_source_name,last_row=p.o_row_id,last_event=p.o_event_id
   FROM (SELECT * FROM pg_temp._inv_write_page ORDER BY o_kind DESC,o_source_name DESC,o_row_id DESC,o_event_id DESC LIMIT 1) p
   WHERE b.boundary=p_at;
  -- Publication always uses a separate tick after the final write page committed.
  RETURN false;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_temp.union_pnl_inventory_seal s
  WHERE (v_build.last_kind IS NULL OR (s.o_kind,s.o_source_name,s.o_row_id,s.o_event_id)>(v_build.last_kind,v_build.last_source,v_build.last_row,v_build.last_event))
   AND (
  (s.o_kind='row' AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_build_rows b
    WHERE b.boundary=p_at AND b.source_name=s.o_source_name AND b.row_id=s.o_row_id))
   OR (s.o_kind='issue' AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_build_issues b
    WHERE b.boundary=p_at AND b.source_name=s.o_source_name AND b.row_id=s.o_row_id AND b.event_id=s.o_event_id)))) THEN
  RAISE EXCEPTION 'inventory_build_row_exceeds_bounded_page' USING ERRCODE='54000'; END IF;
 -- Independently prove the durable set, BUCKET BY BUCKET (20261019151632).
 -- The 4.52M-row week of 2026-10-19 could not publish: one EXCEPT ALL of the
 -- whole cache against the whole build, both ways, ran past 290 s on
 -- production, past job 272's 240 s tick, so the publishing tick was
 -- cancelled every time. Each side is now read ONCE into per-bucket counts
 -- and hashes (one source, the first two hex digits of row_id, the same
 -- buckets the rows hash already uses), and the two bucket sets must be
 -- identical: a missing, extra, duplicated or changed row or issue changes its
 -- bucket's count or hash. The build's own buckets then give the rows hash that
 -- must equal the original assembly's, as before.
 DROP TABLE IF EXISTS pg_temp._inv_build_buckets;
 CREATE TEMP TABLE _inv_build_buckets ON COMMIT DROP AS
  SELECT 'row'::text k,source_name sn,left(row_id::text,2) b,count(*) n,max(latest_event_id) mx,
   md5(string_agg(concat_ws('|',source_name,row_id,latest_event_id,first_operation,COALESCE(after_row::text,'~')),E'\n'
    ORDER BY source_name,row_id,latest_event_id)) h
  FROM public.union_pnl_inventory_seal_build_rows WHERE boundary=p_at GROUP BY 2,3
  UNION ALL
  SELECT 'issue',source_name,left(row_id::text,2),count(*),NULL::bigint,
   md5(string_agg(concat_ws('|',source_name,row_id,event_id),E'\n' ORDER BY source_name,row_id,event_id))
  FROM public.union_pnl_inventory_seal_build_issues WHERE boundary=p_at GROUP BY 2,3;
 DROP TABLE IF EXISTS pg_temp._inv_cache_buckets;
 CREATE TEMP TABLE _inv_cache_buckets ON COMMIT DROP AS
  SELECT s.o_kind k,s.o_source_name sn,left(s.o_row_id::text,2) b,count(*) n,
   md5(string_agg(CASE WHEN s.o_kind='row'
     THEN concat_ws('|',s.o_source_name,s.o_row_id,s.o_event_id,s.o_first_operation,COALESCE(s.o_after_row::text,'~'))
     ELSE concat_ws('|',s.o_source_name,s.o_row_id,s.o_event_id) END,E'\n'
    ORDER BY s.o_source_name,s.o_row_id,s.o_event_id)) h
  FROM pg_temp.union_pnl_inventory_seal s GROUP BY 1,2,3;
 SELECT count(*) INTO v_diff FROM pg_temp._inv_build_buckets x FULL JOIN pg_temp._inv_cache_buckets c
  ON c.k=x.k AND c.sn=x.sn AND c.b=x.b
  WHERE x.k IS NULL OR c.k IS NULL OR x.n IS DISTINCT FROM c.n OR x.h IS DISTINCT FROM c.h
   OR c.k NOT IN ('row','issue');
 IF v_diff>0 THEN RAISE EXCEPTION 'inventory_build_disagrees_with_assembled_source' USING ERRCODE='55000'; END IF;
 -- Independently checksum the durable rows; a cache value alone cannot certify them.
 SELECT * INTO STRICT v_head FROM public.union_pnl_inventory_seal_snapshot_head WHERE boundary=p_at;
 SELECT COALESCE(sum(n),0),max(mx),md5(COALESCE(string_agg(h,E'\n' ORDER BY sn,b),''))
  INTO v_rows,v_max,v_rows_md5 FROM pg_temp._inv_build_buckets WHERE k='row';
 SELECT count(*),md5(COALESCE(string_agg(concat_ws('|',source_name,row_id,event_id),E'\n'
   ORDER BY source_name,row_id,event_id),''))
 INTO v_issues,v_issues_md5 FROM public.union_pnl_inventory_seal_build_issues WHERE boundary=p_at;
 IF (v_rows,v_issues,v_rows_md5,v_issues_md5,v_max)
  IS DISTINCT FROM (v_head.row_count,v_head.issue_count,v_head.rows_md5,v_head.issues_md5,v_head.max_event_id) THEN
  RAISE EXCEPTION 'inventory_build_checksum_disagrees_with_original_source' USING ERRCODE='55000'; END IF;

 IF NOT v_build.ready THEN UPDATE public.union_pnl_inventory_seal_builds SET ready=true WHERE boundary=p_at; END IF;
 RETURN true;
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated, service_role;

DO $verify_bucket_proof$
BEGIN
 IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz)'::regprocedure))<>'3b45b74a0019ac3e65d40208a670299e'
  OR (SELECT proacl::text FROM pg_proc WHERE oid='public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz)'::regprocedure)<>'{postgres=X/postgres}'
 THEN RAISE EXCEPTION 'inventory_bucket_proof_exact_postimage_required';END IF;
END $verify_bucket_proof$;
COMMIT;
