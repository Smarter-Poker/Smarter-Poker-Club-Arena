-- 20261012135622_the_inventory_seal_assembles_bucket_by_bucket.sql
-- Corrected before installation through a protected successor PR.
-- THE INVENTORY SEAL PUBLISHES BOUNDED COMMITTED ROWS.
-- Existing immutable checkpoint tables and headers are never rewritten.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))='c8fde7360b3696f1e11db11613e91ba6' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)'::regprocedure))='06bf76e3f1a3dccc6faa8dbace9b40ba' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure))='8ddf2b233a001cf45676aa0769090239' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean)'::regprocedure))='6a6ba426c756138747b507d6b5e9c47d' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_checkpoint_due()'::regprocedure))='9a267e0629db0051d8e3723da091447f' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_in_progress()'::regprocedure))='65f54e6ed3e52d75c70a1ee2da17a8b1' AND md5(pg_get_functiondef('public.fn_union_pnl_prove_opening_registrations(uuid,timestamptz)'::regprocedure))='aa9c5e6dad82dd08c23e4d33b8c7510c' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_build_population(timestamptz,timestamptz)'::regprocedure))='903f605586ae6417e63ed480821fb59f' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_build_transition()'::regprocedure))='715f0f61206330bce78838af0256c337' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz)'::regprocedure))='3f0335746bcca5df4b0b9b475b47f7a8' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_build_state(timestamptz,timestamptz)'::regprocedure))='32fd33062f30726b60924354db67ff6d' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_snapshot_restore(timestamptz,timestamptz)'::regprocedure))='44a1e8a1dccd9b14eb8c68bd1f2d0721' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_snapshot_save(timestamptz,timestamptz,bigint,bigint,text,text,bigint)'::regprocedure))='69836c3f54e43cfbdf062c7893f57fed')
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE TABLE public.union_pnl_inventory_seal_builds (
 boundary timestamptz PRIMARY KEY CHECK(isfinite(boundary)),
 base_boundary timestamptz REFERENCES public.union_pnl_inventory_checkpoints(boundary),
 ready boolean NOT NULL DEFAULT false,
 last_kind text,last_source text,last_row uuid,last_event bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(base_boundary IS NULL OR base_boundary<boundary),
 CHECK((last_kind IS NULL AND last_source IS NULL AND last_row IS NULL AND last_event IS NULL)
   OR (last_kind IS NOT NULL AND last_source IS NOT NULL AND last_row IS NOT NULL AND last_event IS NOT NULL))
);
CREATE TABLE public.union_pnl_inventory_seal_build_rows (
 boundary timestamptz NOT NULL REFERENCES public.union_pnl_inventory_seal_builds(boundary),
 source_name text NOT NULL,row_id uuid NOT NULL,latest_event_id bigint NOT NULL,
 first_operation text NOT NULL,after_row jsonb,
 PRIMARY KEY(boundary,source_name,row_id)
);
CREATE TABLE public.union_pnl_inventory_seal_build_issues (
 boundary timestamptz NOT NULL REFERENCES public.union_pnl_inventory_seal_builds(boundary),
 source_name text NOT NULL,row_id uuid NOT NULL,event_id bigint NOT NULL,
 PRIMARY KEY(boundary,source_name,row_id,event_id)
);
ALTER TABLE public.union_pnl_inventory_seal_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_seal_build_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_seal_build_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_pnl_inventory_seal_builds,public.union_pnl_inventory_seal_build_rows,
 public.union_pnl_inventory_seal_build_issues FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_pnl_inventory_build_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.union_pnl_inventory_seal_build_rows FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_inventory_build_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.union_pnl_inventory_seal_build_issues FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();

CREATE FUNCTION public.fn_union_pnl_inventory_build_transition() RETURNS trigger LANGUAGE plpgsql SET search_path='public' AS $f$
BEGIN
 IF TG_OP='UPDATE' AND OLD.ready=false AND NEW.ready=false
  AND NEW.last_kind IS NOT NULL
  AND (OLD.last_kind IS NULL OR (NEW.last_kind,NEW.last_source,NEW.last_row,NEW.last_event)>(OLD.last_kind,OLD.last_source,OLD.last_row,OLD.last_event))
  AND (to_jsonb(OLD)-ARRAY['last_kind','last_source','last_row','last_event'])=(to_jsonb(NEW)-ARRAY['last_kind','last_source','last_row','last_event'])
  AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=OLD.boundary) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.ready=false AND NEW.ready=true
  AND (to_jsonb(OLD)-'ready')=(to_jsonb(NEW)-'ready')
  AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=OLD.boundary) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'inventory_build_is_immutable' USING ERRCODE='55000';
END $f$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_build_transition() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inventory_build_transition BEFORE UPDATE OR DELETE ON public.union_pnl_inventory_seal_builds
 FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_inventory_build_transition();
CREATE TRIGGER inventory_build_no_truncate BEFORE TRUNCATE ON public.union_pnl_inventory_seal_builds
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();

CREATE VIEW public.union_pnl_inventory_published_rows AS
 SELECT * FROM public.union_pnl_inventory_checkpoint_rows
 UNION ALL
 SELECT r.* FROM public.union_pnl_inventory_seal_build_rows r
 JOIN public.union_pnl_inventory_checkpoints c ON c.boundary=r.boundary
 JOIN public.union_pnl_inventory_seal_builds b ON b.boundary=r.boundary AND b.ready;
CREATE VIEW public.union_pnl_inventory_published_issues AS
 SELECT * FROM public.union_pnl_inventory_checkpoint_issues
 UNION ALL
 SELECT r.* FROM public.union_pnl_inventory_seal_build_issues r
 JOIN public.union_pnl_inventory_checkpoints c ON c.boundary=r.boundary
 JOIN public.union_pnl_inventory_seal_builds b ON b.boundary=r.boundary AND b.ready;
REVOKE ALL ON public.union_pnl_inventory_published_rows,public.union_pnl_inventory_published_issues
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_union_pnl_inventory_seal_write_page(p_at timestamptz,p_base timestamptz)
 RETURNS boolean LANGUAGE plpgsql SET search_path='public','pg_temp' AS $f$
DECLARE v_build public.union_pnl_inventory_seal_builds%ROWTYPE; v_n bigint;
 v_head record;v_rows bigint;v_issues bigint;v_max bigint;v_rows_md5 text;v_issues_md5 text;
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
 -- Independently prove the durable set, including values, duplicates and issue identities.
 IF EXISTS(
  (SELECT * FROM pg_temp.union_pnl_inventory_seal EXCEPT ALL
   (SELECT 'row'::text,source_name,row_id,latest_event_id,first_operation,after_row
    FROM public.union_pnl_inventory_seal_build_rows WHERE boundary=p_at
    UNION ALL SELECT 'issue',source_name,row_id,event_id,NULL::text,NULL::jsonb
    FROM public.union_pnl_inventory_seal_build_issues WHERE boundary=p_at))
  UNION ALL
  ((SELECT 'row'::text,source_name,row_id,latest_event_id,first_operation,after_row
    FROM public.union_pnl_inventory_seal_build_rows WHERE boundary=p_at
    UNION ALL SELECT 'issue',source_name,row_id,event_id,NULL::text,NULL::jsonb
    FROM public.union_pnl_inventory_seal_build_issues WHERE boundary=p_at)
   EXCEPT ALL SELECT * FROM pg_temp.union_pnl_inventory_seal)
 ) THEN RAISE EXCEPTION 'inventory_build_disagrees_with_assembled_source' USING ERRCODE='55000'; END IF;
 -- Independently checksum the durable rows; a cache value alone cannot certify them.
 SELECT * INTO STRICT v_head FROM public.union_pnl_inventory_seal_snapshot_head WHERE boundary=p_at;
 SELECT count(*),max(latest_event_id) INTO v_rows,v_max
  FROM public.union_pnl_inventory_seal_build_rows WHERE boundary=p_at;
 SELECT count(*),md5(COALESCE(string_agg(concat_ws('|',source_name,row_id,event_id),E'\n'
   ORDER BY source_name,row_id,event_id),''))
 INTO v_issues,v_issues_md5 FROM public.union_pnl_inventory_seal_build_issues WHERE boundary=p_at;
 SELECT md5(COALESCE(string_agg(x.h,E'\n' ORDER BY x.sn,x.b),''))
 INTO v_rows_md5 FROM (
  SELECT source_name sn,left(row_id::text,2) b,
   md5(string_agg(concat_ws('|',source_name,row_id,latest_event_id,first_operation,COALESCE(after_row::text,'~')),E'\n'
    ORDER BY source_name,row_id)) h
  FROM public.union_pnl_inventory_seal_build_rows WHERE boundary=p_at GROUP BY 1,2
 ) x;
 IF (v_rows,v_issues,v_rows_md5,v_issues_md5,v_max)
  IS DISTINCT FROM (v_head.row_count,v_head.issue_count,v_head.rows_md5,v_head.issues_md5,v_head.max_event_id) THEN
  RAISE EXCEPTION 'inventory_build_checksum_disagrees_with_original_source' USING ERRCODE='55000'; END IF;

 IF NOT v_build.ready THEN UPDATE public.union_pnl_inventory_seal_builds SET ready=true WHERE boundary=p_at; END IF;
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;

-- Private readback only; ordinary readers require the published header.
CREATE FUNCTION public.fn_union_pnl_inventory_build_state(p_base timestamptz,p_at timestamptz)
 RETURNS TABLE(o_kind text,o_source_name text,o_row_id uuid,o_event_id bigint,o_first_operation text,o_after_row jsonb)
 LANGUAGE plpgsql SET search_path='public' AS $f$
BEGIN
 IF p_base IS DISTINCT FROM p_at OR NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_builds b WHERE b.boundary=p_at AND b.ready) THEN
  RAISE EXCEPTION 'complete_inventory_build_required' USING ERRCODE='55000'; END IF;
 RETURN QUERY SELECT 'row'::text,r.source_name,r.row_id,r.latest_event_id,r.first_operation,r.after_row
  FROM public.union_pnl_inventory_seal_build_rows r WHERE r.boundary=p_at
 UNION ALL SELECT 'issue',i.source_name,i.row_id,i.event_id,NULL::text,NULL::jsonb
  FROM public.union_pnl_inventory_seal_build_issues i WHERE i.boundary=p_at;
END $f$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_build_state(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- The fully assembled original source is a crash-disposable cache, like the existing layers.
-- Logged build pages remain durable, and final publication compares them with this source.
CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_snapshot (
 boundary timestamptz NOT NULL,o_kind text NOT NULL,o_source_name text NOT NULL,o_row_id uuid NOT NULL,
 o_event_id bigint NOT NULL,o_first_operation text,o_after_row jsonb,
 PRIMARY KEY(boundary,o_kind,o_source_name,o_row_id,o_event_id)
);
CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_snapshot_head (
 boundary timestamptz PRIMARY KEY,base_boundary timestamptz,
 row_count bigint NOT NULL,issue_count bigint NOT NULL,rows_md5 text NOT NULL,
 issues_md5 text NOT NULL,max_event_id bigint
);
ALTER TABLE public.union_pnl_inventory_seal_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_seal_snapshot_head ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_pnl_inventory_seal_snapshot,public.union_pnl_inventory_seal_snapshot_head
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_union_pnl_inventory_snapshot_restore(p_at timestamptz,p_base timestamptz)
 RETURNS boolean LANGUAGE plpgsql SET search_path='public','pg_temp' AS $f$
DECLARE h public.union_pnl_inventory_seal_snapshot_head%ROWTYPE;
BEGIN
 SELECT * INTO h FROM public.union_pnl_inventory_seal_snapshot_head WHERE boundary=p_at;
 IF NOT FOUND THEN RETURN false; END IF;
 IF h.base_boundary IS DISTINCT FROM p_base THEN
  RAISE EXCEPTION 'inventory_snapshot_base_changed' USING ERRCODE='55000'; END IF;
 EXECUTE format('CREATE TEMP VIEW union_pnl_inventory_seal AS SELECT o_kind,o_source_name,o_row_id,o_event_id,o_first_operation,o_after_row FROM public.union_pnl_inventory_seal_snapshot WHERE boundary=%L::timestamptz',p_at);
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_snapshot_restore(timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_union_pnl_inventory_snapshot_save(p_at timestamptz,p_base timestamptz,p_rows bigint,p_issues bigint,p_rows_md5 text,p_issues_md5 text,p_max bigint)
 RETURNS void LANGUAGE plpgsql SET search_path='public','pg_temp' AS $f$
BEGIN
 TRUNCATE public.union_pnl_inventory_seal_snapshot_head,public.union_pnl_inventory_seal_snapshot;
 INSERT INTO public.union_pnl_inventory_seal_snapshot
  SELECT p_at,s.* FROM pg_temp.union_pnl_inventory_seal s;
 INSERT INTO public.union_pnl_inventory_seal_snapshot_head VALUES(p_at,p_base,p_rows,p_issues,p_rows_md5,p_issues_md5,p_max);
 EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal';
 IF NOT public.fn_union_pnl_inventory_snapshot_restore(p_at,p_base) THEN
  RAISE EXCEPTION 'inventory_snapshot_readback_missing' USING ERRCODE='55000'; END IF;
END $f$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_snapshot_save(timestamptz,timestamptz,bigint,bigint,text,text,bigint)
 FROM PUBLIC,anon,authenticated,service_role;


DO $patch$
DECLARE d text;s regprocedure;
BEGIN
 IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))<>'01288c36118e1e26e7673fc71f155bf6' OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))<>'929cc88e98cd027e821f871f8adbe935' THEN RAISE EXCEPTION 'bounded_close_prerequisite_not_installed' USING ERRCODE='55000'; END IF;
 s:='public.fn_union_pnl_inventory_checkpoint_seal(timestamp with time zone,boolean)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'cb561275d6e1529b522e157553f517e4' THEN RAISE EXCEPTION 'inventory preimage changed: fn_union_pnl_inventory_checkpoint_seal(timestamp with time zone,boolean)' USING ERRCODE='55000'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_checkpoint_seal(p_at timestamp with time zone, p_verify_legacy boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; v_base timestamptz;
 v_prior public.union_pnl_inventory_checkpoints%ROWTYPE; v_rows bigint; v_issues bigint; v_rows_md5 text; v_issues_md5 text;
 v_max bigint; v_projection jsonb; v_legacy jsonb; v_started timestamptz:=clock_timestamp(); v_ms bigint;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'inventory_capture_missing' USING ERRCODE='55000'; END IF;
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() OR p_at<=origin.captured_at THEN
  RAISE EXCEPTION 'closed_original_week_boundary_required' USING ERRCODE='22023'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'inventory_requires_fresh_read_committed_snapshot' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0));
 SELECT * INTO v_prior FROM public.union_pnl_inventory_checkpoints WHERE boundary=p_at;
 IF FOUND THEN
  RETURN jsonb_build_object('status','already_sealed','boundary',p_at,'base_boundary',v_prior.base_boundary,'row_count',v_prior.row_count,
   'issue_count',v_prior.issue_count,'rows_md5',v_prior.rows_md5,'result_md5',v_prior.result_md5,'legacy_verified',v_prior.legacy_verified);
 END IF;
 book:=public.fn_union_week_start(origin.captured_at);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
 SELECT c.boundary INTO v_base FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary<p_at ORDER BY c.boundary DESC LIMIT 1;
 IF true AND public.fn_union_pnl_inventory_snapshot_restore(p_at,v_base) THEN
  SELECT h.row_count,h.issue_count,h.rows_md5,h.issues_md5,h.max_event_id INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max FROM public.union_pnl_inventory_seal_snapshot_head h WHERE h.boundary=p_at;
 ELSE
 IF to_regclass('pg_temp.union_pnl_inventory_seal') IS NOT NULL THEN EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal'; END IF;
 EXECUTE 'CREATE TEMP TABLE union_pnl_inventory_seal ON COMMIT DROP AS SELECT * FROM public.fn_union_pnl_inventory_state($1,$2)' USING v_base,p_at;
 EXECUTE $q$SELECT count(*) FILTER(WHERE o_kind='row'),count(*) FILTER(WHERE o_kind='issue'),
   NULL::text,
   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id),E'\n'
    ORDER BY o_source_name,o_row_id,o_event_id) FILTER(WHERE o_kind='issue'),'')),
   max(o_event_id) FILTER(WHERE o_kind='row')
  FROM pg_temp.union_pnl_inventory_seal$q$ INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max;
 -- THE ROWS HASH IS TAKEN BUCKET BY BUCKET (2026-10-12): one string of every
 -- row passed the 1 GB limit of a value at ~3M rows (54000). Each bucket (one
 -- source, the first two hex digits of row_id) is hashed in row order, and the
 -- bucket hashes are hashed in the same order.
  EXECUTE $q$SELECT md5(COALESCE(string_agg(x.h,E'\n' ORDER BY x.sn,x.b),'')) FROM (SELECT o_source_name sn,left(o_row_id::text,2) b,
    md5(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
     ORDER BY o_source_name,o_row_id)) h
    FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row' GROUP BY 1,2) x$q$ INTO v_rows_md5;
 IF true THEN PERFORM public.fn_union_pnl_inventory_snapshot_save(p_at,v_base,v_rows,v_issues,v_rows_md5,v_issues_md5,v_max); END IF;
 END IF;
 -- THE FINAL COPY IS A BOUNDED COMMITTED PAGE (20261012).
 IF NOT public.fn_union_pnl_inventory_seal_write_page(p_at,v_base) THEN
  EXECUTE 'DROP VIEW pg_temp.union_pnl_inventory_seal';
  RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'stage','committed_build_page');
 END IF;
 EXECUTE 'DROP VIEW pg_temp.union_pnl_inventory_seal';
 -- Read the result back from the rows just written, exactly as a later reader will.
 v_projection:=public.fn_union_pnl_inventory_build_population(p_at,p_at);
 IF p_verify_legacy THEN
  v_legacy:=public.fn_union_pnl_inventory_as_of_legacy(p_at);
  IF v_legacy->'population' IS DISTINCT FROM v_projection->'population' OR v_legacy->'issues' IS DISTINCT FROM v_projection->'issues' THEN
   RAISE EXCEPTION 'inventory_checkpoint_disagrees_with_legacy_reader' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('boundary',p_at,'legacy_md5',md5(jsonb_build_object('population',v_legacy->'population','issues',v_legacy->'issues')::text),
     'checkpoint_md5',md5(v_projection::text))::text;
  END IF;
 END IF;
 v_ms:=(extract(epoch FROM clock_timestamp()-v_started)*1000)::bigint;
 INSERT INTO public.union_pnl_inventory_checkpoints(boundary,base_boundary,max_event_id,row_count,issue_count,rows_md5,issues_md5,result_md5,legacy_verified,seal_ms)
 VALUES(p_at,v_base,v_max,v_rows,v_issues,v_rows_md5,v_issues_md5,md5(v_projection::text),p_verify_legacy IS TRUE,v_ms);
 RETURN jsonb_build_object('status','sealed','boundary',p_at,'base_boundary',v_base,'max_event_id',v_max,'row_count',v_rows,'issue_count',v_issues,
  'rows_md5',v_rows_md5,'result_md5',md5(v_projection::text),'legacy_verified',p_verify_legacy IS TRUE,
  'result_issues',jsonb_array_length(v_projection->'issues'),'seal_ms',v_ms);
END $function$
$definition$;
 s:='public.fn_union_pnl_inventory_layer_state(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'7710770d73e92b5229ba755e118558e3' THEN RAISE EXCEPTION 'inventory preimage changed: fn_union_pnl_inventory_layer_state(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_layer_state(p_week_base timestamp with time zone, p_boundary timestamp with time zone, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(o_kind text, o_source_name text, o_row_id uuid, o_event_id bigint, o_first_operation text, o_after_row jsonb)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
 SET enable_indexscan TO 'off'
 SET max_parallel_workers_per_gather TO '0'
AS $function$
BEGIN
 -- fn_union_pnl_inventory_state over the events of [p_from, p_to), its base
 -- being the snapshot at p_from: the latest staged layer (of this boundary,
 -- ending by p_from) that touched a row, else the week's base checkpoint row.
 -- Only the rows this layer touches are returned, each with its complete
 -- issue set as fn_union_pnl_inventory_state would return it.
 IF p_to IS NULL OR p_from IS NULL OR NOT isfinite(p_to) OR NOT isfinite(p_from) OR p_from>=p_to OR p_boundary IS NULL OR p_to>p_boundary
  OR (p_week_base IS NOT NULL AND p_week_base>p_from) THEN
  RAISE EXCEPTION 'invalid_inventory_layer_window' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH d AS MATERIALIZED (
  SELECT e.source_name sn,e.row_id rid,e.event_id eid,e.operation op,
   jsonb_hash_extended(e.before_row,0) b0,jsonb_hash_extended(e.before_row,1) b1,
   jsonb_hash_extended(e.after_row,0) a0,jsonb_hash_extended(e.after_row,1) a1
  FROM public.union_pnl_inventory_events e
  WHERE e.observed_at>=p_from AND e.observed_at<p_to
 ), t AS MATERIALIZED (
  SELECT d.sn,d.rid,min(d.eid) min_id,max(d.eid) max_id FROM d GROUP BY d.sn,d.rid
 ), b AS MATERIALIZED (
  SELECT DISTINCT ON (t.sn,t.rid) t.sn,t.rid,s.src,s.layer,s.eid,s.fop,s.after_row,
   jsonb_hash_extended(s.after_row,0) a0,jsonb_hash_extended(s.after_row,1) a1
  FROM t CROSS JOIN LATERAL (
   SELECT 'layer'::text src,l.layer_end layer,l.latest_event_id eid,l.first_operation fop,l.after_row
    FROM public.union_pnl_inventory_seal_layer_rows l
    WHERE l.boundary=p_boundary AND l.source_name=t.sn AND l.row_id=t.rid AND l.layer_end<=p_from
   UNION ALL
   SELECT 'base',NULL::timestamptz,r.latest_event_id,r.first_operation,r.after_row
    FROM public.union_pnl_inventory_published_rows r
    WHERE r.boundary=p_week_base AND r.source_name=t.sn AND r.row_id=t.rid) s
  ORDER BY t.sn,t.rid,s.layer DESC NULLS LAST
 ), x AS MATERIALIZED (
  -- A delta event ordered (by event_id) before the row's last earlier event:
  -- that row's whole chain is re-read below instead of continued.
  SELECT t.sn,t.rid FROM t JOIN b ON b.sn=t.sn AND b.rid=t.rid WHERE t.min_id<b.eid
 ), w AS MATERIALIZED (
  SELECT d.sn,d.rid,d.eid,d.b0,d.b1,
   row_number() OVER p k,lag(d.a0) OVER p pa0,lag(d.a1) OVER p pa1,first_value(d.op) OVER p fop
  FROM d WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=d.sn AND x.rid=d.rid)
  WINDOW p AS (PARTITION BY d.sn,d.rid ORDER BY d.eid)
 ), tl AS MATERIALIZED (
  SELECT e.event_id eid,e.after_row FROM public.union_pnl_inventory_events e
  WHERE e.event_id=ANY(ARRAY(SELECT t.max_id FROM t WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=t.sn AND x.rid=t.rid)))
 ), xh AS MATERIALIZED (
  SELECT e.sn,e.rid,e.eid,e.before_row,e.after_row,
   row_number() OVER p k,row_number() OVER (PARTITION BY e.sn,e.rid ORDER BY e.eid DESC) latest,
   lag(e.after_row) OVER p prior_after,first_value(e.op) OVER p fop
  FROM x CROSS JOIN LATERAL (
   SELECT h.source_name sn,h.row_id rid,h.event_id eid,h.operation op,h.before_row,h.after_row
   FROM public.union_pnl_inventory_events h WHERE h.source_name=x.sn AND h.row_id=x.rid AND h.observed_at<p_to) e
  WINDOW p AS (PARTITION BY e.sn,e.rid ORDER BY e.eid)
 ), pi AS MATERIALIZED (
  -- The issue set each touched row had at p_from: its latest layer's, else
  -- the base checkpoint's.
  SELECT li.source_name sn,li.row_id rid,li.event_id eid FROM b JOIN public.union_pnl_inventory_seal_layer_issues li
   ON b.src='layer' AND li.boundary=p_boundary AND li.layer_end=b.layer AND li.source_name=b.sn AND li.row_id=b.rid
  UNION ALL
  SELECT ci.source_name,ci.row_id,ci.event_id FROM t JOIN public.union_pnl_inventory_published_issues ci
   ON ci.boundary=p_week_base AND ci.source_name=t.sn AND ci.row_id=t.rid
  WHERE NOT EXISTS(SELECT 1 FROM b WHERE b.sn=t.sn AND b.rid=t.rid AND b.src='layer')
 )
 SELECT 'row'::text,t.sn,t.rid,t.max_id,COALESCE(b.fop,w.fop),tl.after_row
  FROM t JOIN w ON w.sn=t.sn AND w.rid=t.rid AND w.k=1
  JOIN tl ON tl.eid=t.max_id
  LEFT JOIN b ON b.sn=t.sn AND b.rid=t.rid
 UNION ALL
 SELECT 'row',xh.sn,xh.rid,xh.eid,xh.fop,xh.after_row FROM xh WHERE xh.latest=1
 UNION ALL
 SELECT 'issue',pi.sn,pi.rid,pi.eid,NULL::text,NULL::jsonb FROM pi WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=pi.sn AND x.rid=pi.rid)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w WHERE w.k>1 AND (w.pa0,w.pa1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w JOIN b ON b.sn=w.sn AND b.rid=w.rid
  WHERE w.k=1 AND (b.a0,b.a1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',xh.sn,xh.rid,xh.eid,NULL,NULL FROM xh WHERE xh.k>1 AND xh.prior_after IS DISTINCT FROM xh.before_row;
END $function$
$definition$;
 s:='public.fn_union_pnl_inventory_seal_advance(timestamp with time zone,boolean)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'6deca79658f44ffb149316167441b2bf' THEN RAISE EXCEPTION 'inventory preimage changed: fn_union_pnl_inventory_seal_advance(timestamp with time zone,boolean)' USING ERRCODE='55000'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_seal_advance(p_at timestamp with time zone, p_verify boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Seals a closed week's original inventory six hours at a time (see the
-- migration header); returns status 'sealing' while layers remain.
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; v_base timestamptz; v_prior public.union_pnl_inventory_checkpoints%ROWTYPE;
 g record; began timestamptz:=clock_timestamp(); t0 timestamptz; done_any boolean:=false; n_layers int; n_done int;
 v_rows bigint; v_issues bigint; v_rows_md5 text; v_issues_md5 text; v_max bigint; v_projection jsonb; v_ms bigint; v_lr bigint; v_li bigint;
BEGIN
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'inventory_capture_missing' USING ERRCODE='55000'; END IF;
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() OR p_at<=origin.captured_at THEN
  RAISE EXCEPTION 'closed_original_week_boundary_required' USING ERRCODE='22023'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'inventory_requires_fresh_read_committed_snapshot' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0));
 SELECT * INTO v_prior FROM public.union_pnl_inventory_checkpoints WHERE boundary=p_at;
 IF FOUND AND NOT p_verify THEN
  RETURN jsonb_build_object('status','already_sealed','boundary',p_at,'base_boundary',v_prior.base_boundary,'row_count',v_prior.row_count,
   'issue_count',v_prior.issue_count,'rows_md5',v_prior.rows_md5,'result_md5',v_prior.result_md5,'legacy_verified',v_prior.legacy_verified);
 END IF;
 IF p_verify AND NOT FOUND THEN RAISE EXCEPTION 'inventory_verify_needs_a_sealed_week' USING ERRCODE='22023'; END IF;
 book:=public.fn_union_week_start(origin.captured_at);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
 SELECT c.boundary INTO v_base FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary<p_at ORDER BY c.boundary DESC LIMIT 1;
 -- A week with no base seals in one go, as before.
 IF v_base IS NULL THEN
  IF p_verify THEN RAISE EXCEPTION 'inventory_verify_needs_a_base' USING ERRCODE='22023'; END IF;
  RETURN public.fn_union_pnl_inventory_checkpoint_seal(p_at,false);
 END IF;
 -- Staging holds one week at a time; layers made for another base are stale.
 IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at)
  OR EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at AND l.base_boundary IS DISTINCT FROM v_base) THEN
  TRUNCATE public.union_pnl_inventory_seal_layers, public.union_pnl_inventory_seal_layer_rows, public.union_pnl_inventory_seal_layer_issues;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _inv_layer(o_kind text,o_source_name text,o_row_id uuid,o_event_id bigint,o_first_operation text,o_after_row jsonb) ON COMMIT DROP;
 SELECT count(*) INTO n_layers FROM generate_series(v_base,p_at-interval '1 microsecond',interval '6 hours') s;
 FOR g IN SELECT s AS layer_start,LEAST(s+interval '6 hours',p_at) AS layer_end
   FROM generate_series(v_base,p_at-interval '1 microsecond',interval '6 hours') s ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at AND l.layer_end=g.layer_end);
  IF done_any AND clock_timestamp()>began+interval '90 seconds' THEN
   SELECT count(*) INTO n_done FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at;
   RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'layers',n_layers,'layers_done',n_done);
  END IF;
  t0:=clock_timestamp();
  TRUNCATE pg_temp._inv_layer;
  INSERT INTO pg_temp._inv_layer SELECT * FROM public.fn_union_pnl_inventory_layer_state(v_base,p_at,g.layer_start,g.layer_end);
  INSERT INTO public.union_pnl_inventory_seal_layer_rows(boundary,source_name,row_id,layer_end,latest_event_id,first_operation,after_row)
   SELECT p_at,o_source_name,o_row_id,g.layer_end,o_event_id,o_first_operation,o_after_row FROM pg_temp._inv_layer WHERE o_kind='row';
  GET DIAGNOSTICS v_lr=ROW_COUNT;
  INSERT INTO public.union_pnl_inventory_seal_layer_issues(boundary,source_name,row_id,layer_end,event_id)
   SELECT p_at,o_source_name,o_row_id,g.layer_end,o_event_id FROM pg_temp._inv_layer WHERE o_kind='issue';
  GET DIAGNOSTICS v_li=ROW_COUNT;
  INSERT INTO public.union_pnl_inventory_seal_layers(boundary,layer_end,layer_start,base_boundary,row_count,issue_count,layer_ms)
  VALUES(p_at,g.layer_end,g.layer_start,v_base,v_lr,v_li,(extract(epoch FROM clock_timestamp()-t0)*1000)::bigint);
  done_any:=true;
 END LOOP;
 IF done_any AND clock_timestamp()>began+interval '60 seconds' THEN
  RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'layers',n_layers,'layers_done',n_layers);
 END IF;
 -- The week: base rows no layer touched, and each touched row as of its
 -- latest layer; issues likewise.
 IF NOT p_verify AND public.fn_union_pnl_inventory_snapshot_restore(p_at,v_base) THEN
  SELECT h.row_count,h.issue_count,h.rows_md5,h.issues_md5,h.max_event_id INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max FROM public.union_pnl_inventory_seal_snapshot_head h WHERE h.boundary=p_at;
 ELSE
 IF to_regclass('pg_temp.union_pnl_inventory_seal') IS NOT NULL THEN EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal'; END IF;
 CREATE TEMP TABLE union_pnl_inventory_seal ON COMMIT DROP AS
  WITH lt AS MATERIALIZED (SELECT DISTINCT ON (l.source_name,l.row_id) l.source_name sn,l.row_id rid,l.layer_end,l.latest_event_id eid,l.first_operation fop,l.after_row
    FROM public.union_pnl_inventory_seal_layer_rows l WHERE l.boundary=p_at ORDER BY l.source_name,l.row_id,l.layer_end DESC)
  SELECT 'row'::text o_kind,lt.sn o_source_name,lt.rid o_row_id,lt.eid o_event_id,lt.fop o_first_operation,lt.after_row o_after_row FROM lt
  UNION ALL
  SELECT 'row',r.source_name,r.row_id,r.latest_event_id,r.first_operation,r.after_row FROM public.union_pnl_inventory_published_rows r
   WHERE r.boundary=v_base AND NOT EXISTS(SELECT 1 FROM lt WHERE lt.sn=r.source_name AND lt.rid=r.row_id)
  UNION ALL
  SELECT 'issue',li.source_name,li.row_id,li.event_id,NULL::text,NULL::jsonb FROM lt JOIN public.union_pnl_inventory_seal_layer_issues li
   ON li.boundary=p_at AND li.layer_end=lt.layer_end AND li.source_name=lt.sn AND li.row_id=lt.rid
  UNION ALL
  SELECT 'issue',ci.source_name,ci.row_id,ci.event_id,NULL,NULL FROM public.union_pnl_inventory_published_issues ci
   WHERE ci.boundary=v_base AND NOT EXISTS(SELECT 1 FROM lt WHERE lt.sn=ci.source_name AND lt.rid=ci.row_id);
 -- From here on, exactly fn_union_pnl_inventory_checkpoint_seal.
 EXECUTE $q$SELECT count(*) FILTER(WHERE o_kind='row'),count(*) FILTER(WHERE o_kind='issue'),
   NULL::text,
   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id),E'\n'
    ORDER BY o_source_name,o_row_id,o_event_id) FILTER(WHERE o_kind='issue'),'')),
   max(o_event_id) FILTER(WHERE o_kind='row')
  FROM pg_temp.union_pnl_inventory_seal$q$ INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max;
 -- THE ROWS HASH IS TAKEN BUCKET BY BUCKET (2026-10-12): one string of every
 -- row passed the 1 GB limit of a value at ~3M rows (54000). Each bucket (one
 -- source, the first two hex digits of row_id) is hashed in row order, and the
 -- bucket hashes are hashed in the same order.
 -- Weeks up to 2026-10-05 were sealed whole; a verify of one recomputes that hash.
 IF p_verify AND p_at<='2026-10-05 07:00:00+00'::timestamptz THEN
  EXECUTE $q$SELECT md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
    ORDER BY o_source_name,o_row_id),'')) FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row'$q$ INTO v_rows_md5;
 ELSE
  EXECUTE $q$SELECT md5(COALESCE(string_agg(x.h,E'\n' ORDER BY x.sn,x.b),'')) FROM (SELECT o_source_name sn,left(o_row_id::text,2) b,
    md5(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
     ORDER BY o_source_name,o_row_id)) h
    FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row' GROUP BY 1,2) x$q$ INTO v_rows_md5;
 END IF;
 IF NOT p_verify THEN PERFORM public.fn_union_pnl_inventory_snapshot_save(p_at,v_base,v_rows,v_issues,v_rows_md5,v_issues_md5,v_max); END IF;
 END IF;
 IF p_verify THEN
  EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal';
  RETURN jsonb_build_object('status',CASE WHEN v_rows=v_prior.row_count AND v_issues=v_prior.issue_count AND v_rows_md5=v_prior.rows_md5
     AND v_issues_md5=v_prior.issues_md5 AND v_max IS NOT DISTINCT FROM v_prior.max_event_id THEN 'verified' ELSE 'differs' END,
   'boundary',p_at,'base_boundary',v_base,'layers',n_layers,'row_count',v_rows,'issue_count',v_issues,'rows_md5',v_rows_md5,'issues_md5',v_issues_md5,'max_event_id',v_max,
   'sealed',jsonb_build_object('row_count',v_prior.row_count,'issue_count',v_prior.issue_count,'rows_md5',v_prior.rows_md5,'issues_md5',v_prior.issues_md5,'max_event_id',v_prior.max_event_id));
 END IF;
 -- THE FINAL COPY IS A BOUNDED COMMITTED PAGE (20261012).
 IF NOT public.fn_union_pnl_inventory_seal_write_page(p_at,v_base) THEN
  EXECUTE 'DROP VIEW pg_temp.union_pnl_inventory_seal';
  RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'stage','committed_build_page');
 END IF;
 EXECUTE 'DROP VIEW pg_temp.union_pnl_inventory_seal';
 v_projection:=public.fn_union_pnl_inventory_build_population(p_at,p_at);
 SELECT COALESCE(sum(l.layer_ms),0)+(extract(epoch FROM clock_timestamp()-began)*1000)::bigint INTO v_ms FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at;
 INSERT INTO public.union_pnl_inventory_checkpoints(boundary,base_boundary,max_event_id,row_count,issue_count,rows_md5,issues_md5,result_md5,legacy_verified,seal_ms)
 VALUES(p_at,v_base,v_max,v_rows,v_issues,v_rows_md5,v_issues_md5,md5(v_projection::text),false,v_ms);
 RETURN jsonb_build_object('status','sealed','boundary',p_at,'base_boundary',v_base,'max_event_id',v_max,'row_count',v_rows,'issue_count',v_issues,
  'rows_md5',v_rows_md5,'result_md5',md5(v_projection::text),'legacy_verified',false,'layers',n_layers,
  'result_issues',jsonb_array_length(v_projection->'issues'),'seal_ms',v_ms);
END $function$
$definition$;
 s:='public.fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'1f3280fec2a81a57b6bc3c2cc1c308c4' THEN RAISE EXCEPTION 'inventory preimage changed: fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_state(p_base timestamp with time zone, p_at timestamp with time zone)
 RETURNS TABLE(o_kind text, o_source_name text, o_row_id uuid, o_event_id bigint, o_first_operation text, o_after_row jsonb)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
 SET enable_indexscan TO 'off'
 SET max_parallel_workers_per_gather TO '0'
AS $function$
BEGIN
 -- Plain index scans are off: measured on production 2026-09-28, a cold week
 -- range read through the boundary index one heap page at a time costs
 -- ~235us an event (7.8M events: ~30 min); the same range as a bitmap heap
 -- scan, pages in physical order, ~45us (~6 min), less in parallel.
 IF p_at IS NULL OR NOT isfinite(p_at) OR (p_base IS NOT NULL AND (NOT isfinite(p_base) OR p_base>p_at)) THEN
  RAISE EXCEPTION 'invalid_inventory_state_window' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH d AS MATERIALIZED (
  SELECT e.source_name sn,e.row_id rid,e.event_id eid,e.operation op,
   jsonb_hash_extended(e.before_row,0) b0,jsonb_hash_extended(e.before_row,1) b1,
   jsonb_hash_extended(e.after_row,0) a0,jsonb_hash_extended(e.after_row,1) a1
  FROM public.union_pnl_inventory_events e
  WHERE e.observed_at>=COALESCE(p_base,'-infinity'::timestamptz) AND e.observed_at<p_at
 ), b AS MATERIALIZED (
  SELECT r.source_name sn,r.row_id rid,r.latest_event_id eid,r.first_operation fop,r.after_row,
   jsonb_hash_extended(r.after_row,0) a0,jsonb_hash_extended(r.after_row,1) a1
  FROM public.union_pnl_inventory_published_rows r WHERE r.boundary=p_base
 ), t AS MATERIALIZED (
  SELECT d.sn,d.rid,min(d.eid) min_id,max(d.eid) max_id FROM d GROUP BY d.sn,d.rid
 ), x AS MATERIALIZED (
  -- A delta event ordered (by event_id) before the row's last pre-base event:
  -- that row's whole chain is re-read below instead of continued.
  SELECT t.sn,t.rid FROM t JOIN b ON b.sn=t.sn AND b.rid=t.rid WHERE t.min_id<b.eid
 ), w AS MATERIALIZED (
  SELECT d.sn,d.rid,d.eid,d.b0,d.b1,
   row_number() OVER p k,lag(d.a0) OVER p pa0,lag(d.a1) OVER p pa1,first_value(d.op) OVER p fop
  FROM d WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=d.sn AND x.rid=d.rid)
  WINDOW p AS (PARTITION BY d.sn,d.rid ORDER BY d.eid)
 ), tl AS MATERIALIZED (
  -- The latest row image of each continued row, fetched in one pass in
  -- physical order rather than one random heap read per row.
  SELECT e.event_id eid,e.after_row FROM public.union_pnl_inventory_events e
  WHERE e.event_id=ANY(ARRAY(SELECT t.max_id FROM t WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=t.sn AND x.rid=t.rid)))
 ), xh AS MATERIALIZED (
  -- LATERAL: always one identity-index read per interleaved row, never a join
  -- plan that scans the history.
  SELECT e.sn,e.rid,e.eid,e.before_row,e.after_row,
   row_number() OVER p k,row_number() OVER (PARTITION BY e.sn,e.rid ORDER BY e.eid DESC) latest,
   lag(e.after_row) OVER p prior_after,first_value(e.op) OVER p fop
  FROM x CROSS JOIN LATERAL (
   SELECT h.source_name sn,h.row_id rid,h.event_id eid,h.operation op,h.before_row,h.after_row
   FROM public.union_pnl_inventory_events h WHERE h.source_name=x.sn AND h.row_id=x.rid AND h.observed_at<p_at) e
  WINDOW p AS (PARTITION BY e.sn,e.rid ORDER BY e.eid)
 )
 SELECT 'row'::text,b.sn,b.rid,b.eid,b.fop,b.after_row FROM b
  WHERE NOT EXISTS(SELECT 1 FROM t WHERE t.sn=b.sn AND t.rid=b.rid)
 UNION ALL
 SELECT 'row',t.sn,t.rid,t.max_id,COALESCE(b.fop,w.fop),tl.after_row
  FROM t JOIN w ON w.sn=t.sn AND w.rid=t.rid AND w.k=1
  JOIN tl ON tl.eid=t.max_id
  LEFT JOIN b ON b.sn=t.sn AND b.rid=t.rid
 UNION ALL
 SELECT 'row',xh.sn,xh.rid,xh.eid,xh.fop,xh.after_row FROM xh WHERE xh.latest=1
 UNION ALL
 SELECT 'issue',i.source_name,i.row_id,i.event_id,NULL::text,NULL::jsonb FROM public.union_pnl_inventory_published_issues i
  WHERE i.boundary=p_base AND NOT EXISTS(SELECT 1 FROM x WHERE x.sn=i.source_name AND x.rid=i.row_id)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w WHERE w.k>1 AND (w.pa0,w.pa1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w JOIN b ON b.sn=w.sn AND b.rid=w.rid
  WHERE w.k=1 AND (b.a0,b.a1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',xh.sn,xh.rid,xh.eid,NULL,NULL FROM xh WHERE xh.k>1 AND xh.prior_after IS DISTINCT FROM xh.before_row;
END $function$
$definition$;
 s:='public.fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'2910a4e7d455ce6f05d1b6963fe54931' THEN RAISE EXCEPTION 'inventory preimage changed: fn_union_pnl_prove_opening_registrations(uuid,timestamp with time zone)' USING ERRCODE='55000'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_union_pnl_prove_opening_registrations(p_union_id uuid, p_at timestamp with time zone)
 RETURNS TABLE(registration_id uuid, tournament_id uuid, proof jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- CORE BEGIN (the production dry run executes exactly this text)
WITH args AS MATERIALIZED (SELECT p_union_id AS union_id, p_at AS boundary),
fence AS MATERIALIZED (
 SELECT a.union_id, a.boundary, (SELECT w.captured_at FROM public.union_pnl_weekly_capture w WHERE w.singleton) frames_began
 FROM args a WHERE EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints k WHERE k.boundary=a.boundary)
), tours AS MATERIALIZED (
 SELECT c.row_id tournament_id, c.after_row trow
 FROM fence f JOIN public.union_pnl_inventory_published_rows c ON c.boundary=f.boundary AND c.source_name='tournaments'
 WHERE c.after_row->>'union_id'=f.union_id::text AND c.after_row->>'status' NOT IN ('COMPLETED','CANCELLED')
  AND (SELECT e.operation FROM public.union_pnl_inventory_events e WHERE e.source_name='tournaments' AND e.row_id=c.row_id ORDER BY e.event_id LIMIT 1)='baseline'
), regs AS MATERIALIZED (
 SELECT t.tournament_id, t.trow, c.row_id registration_id, c.after_row rrow, (c.after_row->>'user_id')::uuid user_id,
  (SELECT e.operation FROM public.union_pnl_inventory_events e WHERE e.source_name='tournament_players' AND e.row_id=c.row_id ORDER BY e.event_id LIMIT 1) first_op
 FROM fence f JOIN public.union_pnl_inventory_published_rows c ON c.boundary=f.boundary AND c.source_name='tournament_players'
 JOIN tours t ON t.tournament_id::text=c.after_row->>'tournament_id'
), cand AS MATERIALIZED (
 SELECT r.*,f.union_id,f.boundary,f.frames_began,COALESCE(tt.buy_in_amount,0)+COALESCE(tt.buy_in_fee,0) price,tt.id IS NOT NULL terms_found,
  tt.rebuy_cost,tt.addon_cost,COALESCE(tt.is_rebuy,false) OR COALESCE(tt.is_reentry,false) rebuy_allowed,COALESCE(tt.add_on_available,false) addon_allowed,
  tt.free_buy,tt.buy_in_amount,tt.buy_in_fee
 FROM regs r CROSS JOIN fence f LEFT JOIN public.tournaments tt ON tt.id=r.tournament_id
 WHERE r.first_op IS DISTINCT FROM 'INSERT' OR NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts x
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=x.transaction_id
   WHERE x.tournament_id=r.tournament_id AND x.registration_id=r.registration_id AND x.asset='chips' AND b.observed_at<f.boundary)
), orphan_credits AS MATERIALIZED (
 -- a return the platform receipted before the boundary must be one of the
 -- ledger returns read below
 SELECT c.registration_id,count(*) n FROM cand c
 JOIN public.tournament_accounting_credit_receipts cr ON cr.tournament_id=c.tournament_id AND cr.user_id=c.user_id
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=cr.transaction_id AND b.observed_at<c.boundary
 WHERE NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=cr.ledger_id AND l.tournament_id=c.tournament_id
   AND l.to_type='player_wallet' AND l.to_entity_id=c.user_id AND l.created_at<c.boundary)
 GROUP BY 1
 UNION ALL
 SELECT c.registration_id,count(*) FROM cand c
 JOIN public.tournament_refund_tranches rt ON rt.tournament_id=c.tournament_id AND rt.user_id=c.user_id
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=rt.transaction_id AND b.observed_at<c.boundary
 WHERE NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=rt.credit_ledger_id AND l.tournament_id=c.tournament_id
   AND l.to_type='player_wallet' AND l.to_entity_id=c.user_id AND l.created_at<c.boundary)
 GROUP BY 1
), facts AS (
 SELECT c.*,d.*,k.*,x.*,
  COALESCE((SELECT sum(o.n) FROM orphan_credits o WHERE o.registration_id=c.registration_id),0) n_orphan_returns,
  c.rrow->>'source_satellite_id' IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.tournament_ticket_admission_authorizations a WHERE a.tournament_id=c.tournament_id AND a.user_id=c.user_id)
   OR EXISTS(SELECT 1 FROM public.tournament_qualification_entitlements q WHERE q.tournament_id=c.tournament_id AND q.user_id=c.user_id) non_chip,
  CASE WHEN c.price=0 THEN (c.rrow->>'club_id')::uuid ELSE d.d_club END owning_club
 FROM cand c
 CROSS JOIN LATERAL (
  SELECT count(l.id) d_n,count(l.id) FILTER(WHERE l.category='tournament_buyin') d_buyins,
   count(l.id) FILTER(WHERE l.status IS DISTINCT FROM 'posted' OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM c.tournament_id
    OR l.amount IS NULL OR l.amount<=0 OR l.club_id IS NULL OR l.row_hash IS NULL OR l.category NOT IN ('tournament_buyin','rebuy','addon')) d_bad,
   count(l.id) FILTER(WHERE l.created_at>=c.frames_began AND b.observed_at IS NULL) d_unreceipted,
   count(l.id) FILTER(WHERE rx.id IS NOT NULL AND rx.registration_id IS DISTINCT FROM c.registration_id) d_foreign,
   count(l.id) FILTER(WHERE (l.category='tournament_buyin' AND l.amount IS DISTINCT FROM c.price)
    OR (l.category='rebuy' AND (NOT c.rebuy_allowed OR l.amount IS DISTINCT FROM c.rebuy_cost))
    OR (l.category='addon' AND (NOT c.addon_allowed OR l.amount IS DISTINCT FROM c.addon_cost))) d_off_schedule,
   count(DISTINCT l.club_id) d_clubs,min(l.club_id::text)::uuid d_club,COALESCE(sum(l.amount),0) d_amount,
   COALESCE(jsonb_agg(jsonb_build_object('ledger_id',l.id,'chain_seq',l.chain_seq,'row_hash',l.row_hash,'category',l.category,'amount',l.amount,
    'club_id',l.club_id,'created_at',l.created_at,'receipt_id',rx.id,'receipt_observed_at',b.observed_at) ORDER BY l.created_at,l.id) FILTER(WHERE l.id IS NOT NULL),'[]') d_rows
  FROM public.chip_ledger l
  LEFT JOIN public.tournament_participant_funding_receipts rx ON rx.ledger_id=l.id
  LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=rx.transaction_id
  WHERE l.tournament_id=c.tournament_id AND l.from_type='player_wallet' AND l.from_entity_id=c.user_id AND l.created_at<c.boundary
   AND (b.observed_at IS NULL OR b.observed_at<c.boundary)
 ) d
 CROSS JOIN LATERAL (
  SELECT count(l.id) k_n,
   count(l.id) FILTER(WHERE l.status IS DISTINCT FROM 'posted' OR l.from_type IS DISTINCT FROM 'prize_liability' OR l.from_entity_id IS DISTINCT FROM c.tournament_id
    OR l.amount IS NULL OR l.amount<=0 OR l.club_id IS NULL OR l.row_hash IS NULL OR l.category NOT IN ('tournament_prize','bounty')
    OR (cr.id IS NOT NULL AND (cr.user_id IS DISTINCT FROM c.user_id OR cr.amount IS DISTINCT FROM l.amount OR cr.asset IS DISTINCT FROM 'chips'))
    OR (rt.wallet_transaction_id IS NOT NULL AND (rt.user_id IS DISTINCT FROM c.user_id OR rt.amount_paid_now IS DISTINCT FROM l.amount))) k_bad,
   count(l.id) FILTER(WHERE l.created_at>=c.frames_began AND b.observed_at IS NULL) k_unreceipted,
   count(l.id) FILTER(WHERE COALESCE(cr.credited_club_id,rt.source_wallet_club_id,l.club_id) IS DISTINCT FROM l.club_id) k_split_club,
   COALESCE(array_agg(DISTINCT l.club_id) FILTER(WHERE l.id IS NOT NULL),'{}') k_clubs,COALESCE(sum(l.amount),0) k_amount,
   COALESCE(jsonb_agg(jsonb_build_object('ledger_id',l.id,'chain_seq',l.chain_seq,'row_hash',l.row_hash,'category',l.category,'amount',l.amount,
    'club_id',l.club_id,'created_at',l.created_at,'credit_receipt_id',cr.id,'refund_tranche_id',rt.wallet_transaction_id,'receipt_observed_at',b.observed_at)
    ORDER BY l.created_at,l.id) FILTER(WHERE l.id IS NOT NULL),'[]') k_rows
  FROM public.chip_ledger l
  LEFT JOIN public.tournament_accounting_credit_receipts cr ON cr.ledger_id=l.id
  LEFT JOIN public.tournament_refund_tranches rt ON rt.credit_ledger_id=l.id
  LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=COALESCE(cr.transaction_id,rt.transaction_id)
  WHERE l.tournament_id=c.tournament_id AND l.to_type='player_wallet' AND l.to_entity_id=c.user_id AND l.created_at<c.boundary
   AND (b.observed_at IS NULL OR b.observed_at<c.boundary)
 ) k
 CROSS JOIN LATERAL (
  -- the platform's own entry receipts for this registration (framed before
  -- the boundary, or written before frames began) must agree with the ledger
  SELECT count(r.id) FILTER(WHERE r.asset IS DISTINCT FROM 'chips') x_non_chip,
   count(r.id) FILTER(WHERE r.asset='chips' AND ((r.ledger_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=r.ledger_id
     AND l.tournament_id=c.tournament_id AND l.from_type='player_wallet' AND l.from_entity_id=c.user_id AND l.created_at<c.boundary AND l.amount=r.amount))
    OR (r.ledger_id IS NULL AND (r.amount<>0 OR r.entitlement_id IS NOT NULL OR r.registration_snapshot->>'source_satellite_id' IS NOT NULL
     OR r.registration_snapshot->>'club_id' IS DISTINCT FROM c.rrow->>'club_id')))) x_disagree,
   COALESCE(jsonb_agg(r.id ORDER BY r.observed_at,r.id) FILTER(WHERE r.id IS NOT NULL),'[]') x_ids
  FROM public.tournament_participant_funding_receipts r
  LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
  WHERE r.tournament_id=c.tournament_id AND r.registration_id=c.registration_id
   AND ((b.observed_at IS NULL AND r.observed_at<c.frames_began) OR b.observed_at<c.boundary)
 ) x
), judged AS (
 SELECT f.*,CASE
  WHEN f.frames_began IS NULL OR f.frames_began>=f.boundary THEN 'capture_fence_missing'
  WHEN NOT f.terms_found THEN 'tournament_terms_missing'
  WHEN f.first_op IS NULL OR f.first_op NOT IN ('baseline','INSERT') THEN 'registration_original_population_missing'
  WHEN f.non_chip OR f.x_non_chip>0 THEN 'non_chip_instrument'
  WHEN f.d_bad>0 THEN 'entry_debit_not_posted_to_this_tournament_prize_pool'
  WHEN f.d_unreceipted>0 THEN 'post_capture_entry_debit_unreceipted'
  WHEN f.d_foreign>0 THEN 'entry_debit_receipted_for_another_registration'
  WHEN f.d_buyins<>CASE WHEN f.price=0 THEN 0 ELSE 1 END THEN 'entry_debit_count_does_not_match_schedule'
  WHEN f.d_off_schedule>0 THEN 'entry_amount_does_not_match_schedule'
  WHEN f.d_clubs>1 OR f.owning_club IS NULL OR (f.d_clubs=1 AND f.d_club IS DISTINCT FROM f.owning_club) THEN 'funding_club_ambiguous'
  WHEN f.x_disagree>0 THEN 'entry_receipt_disagrees_with_ledger'
  WHEN f.k_bad>0 THEN 'return_is_not_a_receipted_tournament_award'
  WHEN f.k_unreceipted>0 OR f.n_orphan_returns>0 THEN 'return_evidence_incomplete'
  WHEN f.k_split_club>0 OR EXISTS(SELECT 1 FROM unnest(f.k_clubs) z WHERE z IS DISTINCT FROM f.owning_club) THEN 'return_credited_to_another_club'
 END refusal
 FROM facts f
)
SELECT j.registration_id,j.tournament_id,
 jsonb_build_object('resolution_kind','opening_registration_entry_from_chip_ledger','union_id',j.union_id,'boundary',j.boundary,
  'tournament_id',j.tournament_id,'registration_id',j.registration_id,'user_id',j.user_id,
  'registration_first_operation',j.first_op,'registration_row_md5',md5(j.rrow::text),'tournament_row_md5',md5(j.trow::text),
  'instrument','chips','zero_cost_entry',j.price=0,'free_buy',j.free_buy,
  'schedule',jsonb_build_object('buy_in_amount',j.buy_in_amount,'buy_in_fee',j.buy_in_fee,'entry_price',j.price,'rebuy_cost',j.rebuy_cost,'addon_cost',j.addon_cost),
  'registration_club_id',j.rrow->'club_id','owning_club_id',j.owning_club,
  'entries',j.d_n+CASE WHEN j.price=0 THEN 1 ELSE 0 END,'entry_amount',j.d_amount,'entry_ledger',j.d_rows,'entry_receipt_ids',j.x_ids,
  'returned',j.k_amount,'returns',j.k_rows,'deferred_amount',j.d_amount-j.k_amount,'frames_began',j.frames_began)
 ||CASE WHEN j.refusal IS NULL THEN jsonb_build_object('status','proven') ELSE jsonb_build_object('status','refused','reason',j.refusal) END AS proof
FROM judged j
ORDER BY j.tournament_id,j.registration_id
-- CORE END
$function$
$definition$;
END $patch$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_build_population(p_base timestamp with time zone, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE population jsonb; gaps jsonb;
BEGIN
 WITH s AS MATERIALIZED (
  SELECT * FROM public.fn_union_pnl_inventory_build_state(p_base,p_at)
 ), current_rows AS MATERIALIZED (
  SELECT s.o_source_name source_name,s.o_row_id row_id,s.o_event_id event_id,s.o_after_row after_row,s.o_first_operation first_operation
  FROM s WHERE s.o_kind='row' AND s.o_after_row IS NOT NULL
 ), active AS MATERIALIZED (
  SELECT * FROM current_rows r WHERE source_name='union_clubs'
   OR (source_name='tables' AND after_row->'tournament_id'='null'::jsonb)
   OR (source_name='table_seats' AND after_row->'left_at'='null'::jsonb)
   OR (source_name='tournaments' AND after_row->>'status' NOT IN ('COMPLETED','CANCELLED'))
   OR (source_name='tournament_players' AND EXISTS(SELECT 1 FROM current_rows t WHERE t.source_name='tournaments'
    AND t.row_id::text=r.after_row->>'tournament_id' AND t.after_row->>'status' NOT IN ('COMPLETED','CANCELLED')))
 ), grouped AS (
  SELECT source_name,jsonb_agg(jsonb_build_object('source_event_id',event_id,'row',after_row) ORDER BY row_id) rows FROM active GROUP BY source_name
 ) SELECT COALESCE((SELECT jsonb_object_agg(source_name,rows) FROM grouped),'{}'),
  COALESCE((SELECT jsonb_agg(jsonb_build_object('source_name',source_name,'row_id',row_id,'reason','active_row_original_population_missing') ORDER BY source_name,row_id)
   FROM active WHERE first_operation NOT IN ('baseline','INSERT')
    -- A seat vacated before capture began and re-opened afterwards: its first
    -- captured event is the UPDATE that opened this occupancy (see 20260928153000).
    AND NOT (source_name='table_seats' AND first_operation='UPDATE' AND EXISTS(
     SELECT 1 FROM (SELECT e.before_row FROM public.union_pnl_inventory_events e
       WHERE e.source_name='table_seats' AND e.row_id=active.row_id ORDER BY e.event_id LIMIT 1) f
     WHERE f.before_row->>'left_at' IS NOT NULL
      AND (f.before_row->>'left_at')::timestamptz<=(SELECT c.captured_at FROM public.union_pnl_inventory_capture c WHERE c.singleton)))),'[]')
  ||COALESCE((SELECT jsonb_agg(jsonb_build_object('source_name',s.o_source_name,'row_id',s.o_row_id,'source_event_id',s.o_event_id,'reason','original_inventory_chain_disagrees') ORDER BY s.o_source_name,s.o_row_id,s.o_event_id)
   FROM s WHERE s.o_kind='issue'),'[]') INTO population,gaps;
 RETURN jsonb_build_object('population',population,'issues',gaps);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_build_population(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

DO $callers$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.fn_union_pnl_inventory_checkpoint_due()'::regprocedure);
 IF md5(d)<>'0a2e8c24237184462bd97e9fbdc9a590' THEN RAISE EXCEPTION 'inventory caller preimage changed: fn_union_pnl_inventory_checkpoint_due' USING ERRCODE='55000'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_checkpoint_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; b timestamptz; v_sealed jsonb:='[]'; v_step jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','inventory_capture_missing'); END IF;
 b:=public.fn_union_week_start(origin.captured_at);
 LOOP
  b:=public.fn_union_week_start(b+interval '8 days');
  EXIT WHEN b>clock_timestamp();
  IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=b) THEN
   IF jsonb_array_length(v_sealed)>0 THEN
    RETURN jsonb_build_object('status','sealing','boundary',b,'progress',jsonb_build_object('stage','pending_boundary'),'sealed',v_sealed);
   END IF;
   -- One bounded seal operation per original close transaction.
   IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on' THEN
    v_step:=public.fn_union_pnl_inventory_seal_advance(b,false);
   ELSE
    v_step:=public.fn_union_pnl_inventory_checkpoint_seal(b,false);
   END IF;
   IF v_step->>'status'='sealing' THEN
    RETURN jsonb_build_object('status','sealing','boundary',b,'progress',v_step,'sealed',v_sealed);
   END IF;
   IF v_step->>'status' NOT IN ('sealed','already_sealed') THEN
    RAISE EXCEPTION 'inventory_seal_receipt_invalid' USING ERRCODE='55000'; END IF;
   v_sealed:=jsonb_build_array(v_step);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','sealed',v_sealed);
END $function$
$definition$;
 d:=pg_get_functiondef('public.fn_union_pnl_inventory_seal_in_progress()'::regprocedure);
 IF md5(d)<>'2a9e74c967f2ac258ff66c6efc1e095a' THEN RAISE EXCEPTION 'inventory caller preimage changed: fn_union_pnl_inventory_seal_in_progress' USING ERRCODE='55000'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_seal_in_progress()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 -- A split seal of the current week's boundary has started and not finished.
 SELECT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=public.fn_union_week_start(now()))
   AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now()))
   OR EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_builds b
    WHERE b.boundary<=public.fn_union_week_start(now())
     AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=b.boundary))
$function$
$definition$;
END $callers$;

-- Preserve the production operator-only ACL explicitly for source qualification.
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_checkpoint_due() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_checkpoint_due() TO service_role;

REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_seal_in_progress() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_seal_in_progress() TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_state(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_prove_opening_registrations(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

DO $post$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.fn_union_pnl_inventory_build_transition()','715f0f61206330bce78838af0256c337'),
 ('public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz)','3f0335746bcca5df4b0b9b475b47f7a8'),
 ('public.fn_union_pnl_inventory_build_state(timestamptz,timestamptz)','32fd33062f30726b60924354db67ff6d'),
 ('public.fn_union_pnl_inventory_snapshot_restore(timestamptz,timestamptz)','44a1e8a1dccd9b14eb8c68bd1f2d0721'),
 ('public.fn_union_pnl_inventory_snapshot_save(timestamptz,timestamptz,bigint,bigint,text,text,bigint)','69836c3f54e43cfbdf062c7893f57fed'),
 ('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)','06bf76e3f1a3dccc6faa8dbace9b40ba'),
 ('public.fn_union_pnl_inventory_layer_state(timestamptz,timestamptz,timestamptz,timestamptz)','8ddf2b233a001cf45676aa0769090239'),
 ('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)','c8fde7360b3696f1e11db11613e91ba6'),
 ('public.fn_union_pnl_inventory_checkpoint_due()','9a267e0629db0051d8e3723da091447f'),
 ('public.fn_union_pnl_inventory_checkpoint_seal(timestamptz,boolean)','6a6ba426c756138747b507d6b5e9c47d'),
 ('public.fn_union_pnl_inventory_build_population(timestamptz,timestamptz)','903f605586ae6417e63ed480821fb59f'),
 ('public.fn_union_pnl_inventory_seal_in_progress()','65f54e6ed3e52d75c70a1ee2da17a8b1'),
 ('public.fn_union_pnl_prove_opening_registrations(uuid,timestamptz)','aa9c5e6dad82dd08c23e4d33b8c7510c')
 ) p(signature,digest) LOOP
  IF md5(pg_get_functiondef(r.signature::regprocedure))<>r.digest THEN
   RAISE EXCEPTION 'inventory publication postimage changed: %',r.signature USING ERRCODE='55000'; END IF;
 END LOOP;
END $post$;

COMMIT;
