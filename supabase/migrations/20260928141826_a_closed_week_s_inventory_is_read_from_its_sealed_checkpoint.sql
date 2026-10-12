-- A CLOSED WEEK'S INVENTORY IS READ FROM ITS SEALED CHECKPOINT (2026-09-28).
--
-- Midway Union's first weekly close (book 2026-09-21 07:00 .. 09-28 07:00 UTC)
-- died on the scheduler's 2400s statement timeout inside
-- fn_union_pnl_inventory_as_of on every tick since 09:30 UTC. Its reader
-- windowed the WHOLE of union_pnl_inventory_events (11.4M rows, 11 GB, +1.1M
-- a day) on every call: an index scan in (source_name,row_id) order with a heap
-- visit per event, the full jsonb rows carried through two window sorts, and a
-- materialized CTE of all of it. The close calls it at least twice per book
-- (both boundaries, through fn_union_pnl_boundary) and several times per
-- transaction (prepare -> close_quality -> evidence_report, the cascade, the
-- invoices, qualified clubs).
--
-- A boundary's inventory is final once its books are drained: the reader
-- already takes every earlier book's exclusive advisory lock, which waits for
-- every writer whose frame (observed_at) precedes the boundary, and no later
-- frame can precede it. So it is computed once and sealed:
--   * union_pnl_inventory_checkpoints (+ _rows, + _issues): immutable, one per
--     closed week boundary: the latest state of EVERY captured row (deleted
--     rows included), its first operation, and the chain disagreements, with
--     row/issue md5s and the md5 of the reader's result;
--   * fn_union_pnl_inventory_state(base,at): the state at `at` = the base
--     checkpoint + only the events observed in [base, at). The chain check
--     compares jsonb_hash_extended pairs (seeds 0 and 1) of each event's
--     before_row with its predecessor's after_row, so the sort carries 60 bytes
--     a row instead of the rows; a row whose delta interleaves (by event_id)
--     with its pre-base history is re-read whole from its identity index;
--   * fn_union_pnl_inventory_population: the unchanged projection (active
--     population, missing-origin and chain issues, same ordering);
--   * fn_union_pnl_inventory_as_of: same validation, same locks, same result;
--     reads from the latest checkpoint at or before the boundary (none: from
--     the capture) and caches the result for the rest of the transaction;
--   * fn_union_pnl_inventory_checkpoint_seal / _due: service-role writers
--     (serialized, idempotent). p_verify_legacy additionally runs the previous
--     reader, kept byte-for-byte as fn_union_pnl_inventory_as_of_legacy, and
--     refuses a checkpoint that disagrees with it.
-- No event, boundary, holding or settlement is changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_as_of(timestamp with time zone)'::regprocedure))
     IS DISTINCT FROM '6b7204a27c7b90412646af3145096c2f' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_union_pnl_inventory_as_of is not the reviewed definition';
  END IF;
  IF to_regclass('public.union_pnl_inventory_checkpoints') IS NOT NULL
     OR to_regclass('public.union_pnl_inventory_checkpoint_rows') IS NOT NULL
     OR to_regclass('public.union_pnl_inventory_checkpoint_issues') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_inventory_as_of_legacy(timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_inventory_population(timestamp with time zone,timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_inventory_checkpoint_seal(timestamp with time zone,boolean)') IS NOT NULL
     OR to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL THEN
    RAISE EXCEPTION 'preimage mismatch: checkpoint objects already exist';
  END IF;
END $pre$;

-- The previous reader, byte-for-byte under a new name: the legacy cross-check.
DO $legacy$
DECLARE src text;
BEGIN
  src:=pg_get_functiondef('public.fn_union_pnl_inventory_as_of(timestamp with time zone)'::regprocedure);
  IF (length(src)-length(replace(src,'FUNCTION public.fn_union_pnl_inventory_as_of(','')))/length('FUNCTION public.fn_union_pnl_inventory_as_of(')<>1 THEN
    RAISE EXCEPTION 'legacy_reader_header_changed' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(src,'FUNCTION public.fn_union_pnl_inventory_as_of(','FUNCTION public.fn_union_pnl_inventory_as_of_legacy(');
END $legacy$;

CREATE TABLE public.union_pnl_inventory_checkpoints (
  boundary timestamptz PRIMARY KEY CHECK (isfinite(boundary)),
  base_boundary timestamptz REFERENCES public.union_pnl_inventory_checkpoints(boundary),
  max_event_id bigint,
  row_count bigint NOT NULL CHECK (row_count >= 0),
  issue_count bigint NOT NULL CHECK (issue_count >= 0),
  rows_md5 text NOT NULL CHECK (rows_md5 ~ '^[0-9a-f]{32}$'),
  issues_md5 text NOT NULL CHECK (issues_md5 ~ '^[0-9a-f]{32}$'),
  result_md5 text NOT NULL CHECK (result_md5 ~ '^[0-9a-f]{32}$'),
  legacy_verified boolean NOT NULL,
  seal_ms bigint NOT NULL CHECK (seal_ms >= 0),
  sealed_by text NOT NULL DEFAULT session_user,
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (base_boundary IS NULL OR base_boundary < boundary)
);
CREATE TABLE public.union_pnl_inventory_checkpoint_rows (
  boundary timestamptz NOT NULL REFERENCES public.union_pnl_inventory_checkpoints(boundary) DEFERRABLE INITIALLY DEFERRED,
  source_name text NOT NULL,
  row_id uuid NOT NULL,
  latest_event_id bigint NOT NULL,
  first_operation text NOT NULL,
  after_row jsonb,
  PRIMARY KEY (boundary, source_name, row_id)
);
CREATE TABLE public.union_pnl_inventory_checkpoint_issues (
  boundary timestamptz NOT NULL REFERENCES public.union_pnl_inventory_checkpoints(boundary) DEFERRABLE INITIALLY DEFERRED,
  source_name text NOT NULL,
  row_id uuid NOT NULL,
  event_id bigint NOT NULL,
  PRIMARY KEY (boundary, source_name, row_id, event_id)
);
ALTER TABLE public.union_pnl_inventory_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_checkpoint_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.union_pnl_inventory_checkpoint_issues ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER original_pnl_inventory_checkpoint_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.union_pnl_inventory_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_inventory_checkpoint_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.union_pnl_inventory_checkpoint_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_inventory_checkpoint_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.union_pnl_inventory_checkpoint_issues
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
REVOKE ALL ON TABLE public.union_pnl_inventory_checkpoints, public.union_pnl_inventory_checkpoint_rows,
  public.union_pnl_inventory_checkpoint_issues FROM PUBLIC, anon, authenticated, service_role;

-- State at p_at: the base checkpoint (NULL: nothing) plus the events observed
-- in [p_base, p_at). Every captured row is returned, deleted rows included, so
-- the next checkpoint can continue its chain.
CREATE FUNCTION public.fn_union_pnl_inventory_state(p_base timestamp with time zone, p_at timestamp with time zone)
 RETURNS TABLE(o_kind text, o_source_name text, o_row_id uuid, o_event_id bigint, o_first_operation text, o_after_row jsonb)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '256MB'
 SET enable_indexscan TO 'off'
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
  FROM public.union_pnl_inventory_checkpoint_rows r WHERE r.boundary=p_base
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
 SELECT 'issue',i.source_name,i.row_id,i.event_id,NULL::text,NULL::jsonb FROM public.union_pnl_inventory_checkpoint_issues i
  WHERE i.boundary=p_base AND NOT EXISTS(SELECT 1 FROM x WHERE x.sn=i.source_name AND x.rid=i.row_id)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w WHERE w.k>1 AND (w.pa0,w.pa1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',w.sn,w.rid,w.eid,NULL,NULL FROM w JOIN b ON b.sn=w.sn AND b.rid=w.rid
  WHERE w.k=1 AND (b.a0,b.a1) IS DISTINCT FROM (w.b0,w.b1)
 UNION ALL
 SELECT 'issue',xh.sn,xh.rid,xh.eid,NULL,NULL FROM xh WHERE xh.k>1 AND xh.prior_after IS DISTINCT FROM xh.before_row;
END $function$;

-- The previous reader's projection, unchanged, over that state.
CREATE FUNCTION public.fn_union_pnl_inventory_population(p_base timestamp with time zone, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE population jsonb; gaps jsonb;
BEGIN
 WITH s AS MATERIALIZED (
  SELECT * FROM public.fn_union_pnl_inventory_state(p_base,p_at)
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
   FROM active WHERE first_operation NOT IN ('baseline','INSERT')),'[]')
  ||COALESCE((SELECT jsonb_agg(jsonb_build_object('source_name',s.o_source_name,'row_id',s.o_row_id,'source_event_id',s.o_event_id,'reason','original_inventory_chain_disagrees') ORDER BY s.o_source_name,s.o_row_id,s.o_event_id)
   FROM s WHERE s.o_kind='issue'),'[]') INTO population,gaps;
 RETURN jsonb_build_object('population',population,'issues',gaps);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_as_of(p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; v_base timestamptz; v_projection jsonb; v_result jsonb;
BEGIN
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','inventory_capture_missing'); END IF;
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() THEN
  RETURN jsonb_build_object('status','blocked','reason','closed_original_week_boundary_required'); END IF;
 IF p_at<=origin.captured_at THEN RETURN jsonb_build_object('status','blocked','reason','boundary_precedes_original_inventory_capture','capture_started_at',origin.captured_at); END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RETURN jsonb_build_object('status','blocked','reason','inventory_requires_fresh_read_committed_snapshot'); END IF;
 book:=public.fn_union_week_start(origin.captured_at);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
 -- Every writer that could precede p_at has committed (the locks above), so
 -- the result is final: one transaction computes it once.
 IF to_regclass('pg_temp.union_pnl_inventory_as_of_cache') IS NOT NULL THEN
  EXECUTE 'SELECT result FROM pg_temp.union_pnl_inventory_as_of_cache WHERE boundary=$1' INTO v_result USING p_at;
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;
 END IF;
 -- VOLATILE intentionally obtains a fresh snapshot after the old-book writers
 -- have committed. A stable/snapshot reader could omit those committed events.
 SELECT c.boundary INTO v_base FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary<=p_at ORDER BY c.boundary DESC LIMIT 1;
 v_projection:=public.fn_union_pnl_inventory_population(v_base,p_at);
 v_result:=jsonb_build_object('status',CASE WHEN v_projection->'issues'='[]'::jsonb THEN 'observed' ELSE 'blocked' END,
  'inventory_version',1,'capture_started_at',origin.captured_at,'boundary',p_at,'population',v_projection->'population','issues',v_projection->'issues',
  'current_state_used',false,'financial_basis_certified',false,
  'coverage','Original active population and later captured transitions; monetary funding and obligation receipts must independently certify equity.');
 BEGIN
  IF to_regclass('pg_temp.union_pnl_inventory_as_of_cache') IS NULL THEN
   EXECUTE 'CREATE TEMP TABLE union_pnl_inventory_as_of_cache(boundary timestamptz PRIMARY KEY, result jsonb NOT NULL) ON COMMIT DROP';
  END IF;
  EXECUTE 'INSERT INTO pg_temp.union_pnl_inventory_as_of_cache(boundary,result) VALUES($1,$2) ON CONFLICT (boundary) DO NOTHING' USING p_at,v_result;
 EXCEPTION WHEN read_only_sql_transaction THEN NULL;
 END;
 RETURN v_result;
END $function$;

CREATE FUNCTION public.fn_union_pnl_inventory_checkpoint_seal(p_at timestamp with time zone, p_verify_legacy boolean DEFAULT false)
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
 IF to_regclass('pg_temp.union_pnl_inventory_seal') IS NOT NULL THEN EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal'; END IF;
 EXECUTE 'CREATE TEMP TABLE union_pnl_inventory_seal ON COMMIT DROP AS SELECT * FROM public.fn_union_pnl_inventory_state($1,$2)' USING v_base,p_at;
 EXECUTE $q$SELECT count(*) FILTER(WHERE o_kind='row'),count(*) FILTER(WHERE o_kind='issue'),
   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
    ORDER BY o_source_name,o_row_id) FILTER(WHERE o_kind='row'),'')),
   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id),E'\n'
    ORDER BY o_source_name,o_row_id,o_event_id) FILTER(WHERE o_kind='issue'),'')),
   max(o_event_id) FILTER(WHERE o_kind='row')
  FROM pg_temp.union_pnl_inventory_seal$q$ INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max;
 EXECUTE $q$INSERT INTO public.union_pnl_inventory_checkpoint_rows(boundary,source_name,row_id,latest_event_id,first_operation,after_row)
  SELECT $1,o_source_name,o_row_id,o_event_id,o_first_operation,o_after_row FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row'$q$ USING p_at;
 EXECUTE $q$INSERT INTO public.union_pnl_inventory_checkpoint_issues(boundary,source_name,row_id,event_id)
  SELECT $1,o_source_name,o_row_id,o_event_id FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='issue'$q$ USING p_at;
 EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal';
 -- Read the result back from the rows just written, exactly as a later reader will.
 v_projection:=public.fn_union_pnl_inventory_population(p_at,p_at);
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
END $function$;

-- Every closed week boundary after the capture that has no checkpoint, oldest first.
CREATE FUNCTION public.fn_union_pnl_inventory_checkpoint_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; b timestamptz; v_sealed jsonb:='[]';
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','inventory_capture_missing'); END IF;
 b:=public.fn_union_week_start(origin.captured_at);
 LOOP
  b:=public.fn_union_week_start(b+interval '8 days');
  EXIT WHEN b>clock_timestamp();
  IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=b) THEN
   v_sealed:=v_sealed||jsonb_build_array(public.fn_union_pnl_inventory_checkpoint_seal(b,false));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','sealed',v_sealed);
END $function$;

COMMENT ON TABLE public.union_pnl_inventory_checkpoints IS
 'Sealed original inventory at a closed week boundary. Immutable. Written only by fn_union_pnl_inventory_checkpoint_seal after every earlier book is drained; read by fn_union_pnl_inventory_as_of so a close never re-reads the whole event history.';
COMMENT ON FUNCTION public.fn_union_pnl_inventory_as_of(timestamp with time zone) IS
 'Private original as-of population. No backdated balances, monetary valuation, current-membership inference or payment authorization. Reads the latest sealed checkpoint at or before the boundary plus the later events; identical to fn_union_pnl_inventory_as_of_legacy.';

REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_as_of_legacy(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_population(timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_as_of(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_checkpoint_seal(timestamp with time zone,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_checkpoint_due() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_checkpoint_seal(timestamp with time zone,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_checkpoint_due() TO service_role;

DO $post$
DECLARE f text;
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_as_of(timestamp with time zone)'::regprocedure))
     IS DISTINCT FROM '85513ff85d2b37ad04b79f89e125f1aa' THEN
    RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_inventory_as_of';
  END IF;
  IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone)'::regprocedure))
     IS DISTINCT FROM '281e345ec2f0689140ebfd4e6a6bf454' THEN
    RAISE EXCEPTION 'postimage mismatch: fn_union_pnl_inventory_state';
  END IF;
  IF md5(replace(pg_get_functiondef('public.fn_union_pnl_inventory_as_of_legacy(timestamp with time zone)'::regprocedure),
       'FUNCTION public.fn_union_pnl_inventory_as_of_legacy(','FUNCTION public.fn_union_pnl_inventory_as_of('))
     IS DISTINCT FROM '6b7204a27c7b90412646af3145096c2f' THEN
    RAISE EXCEPTION 'postimage mismatch: the legacy reader is not the previous reader';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.fn_union_pnl_inventory_as_of_legacy(timestamp with time zone)',
    'public.fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone)',
    'public.fn_union_pnl_inventory_population(timestamp with time zone,timestamp with time zone)',
    'public.fn_union_pnl_inventory_as_of(timestamp with time zone)',
    'public.fn_union_pnl_inventory_checkpoint_seal(timestamp with time zone,boolean)',
    'public.fn_union_pnl_inventory_checkpoint_due()'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'postimage: % is browser-executable',f;
    END IF;
  END LOOP;
  IF has_function_privilege('service_role','public.fn_union_pnl_inventory_as_of(timestamp with time zone)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_union_pnl_inventory_state(timestamp with time zone,timestamp with time zone)','EXECUTE') THEN
    RAISE EXCEPTION 'postimage: the private readers gained a caller';
  END IF;
  IF has_table_privilege('service_role','public.union_pnl_inventory_checkpoint_rows','INSERT')
     OR has_table_privilege('authenticated','public.union_pnl_inventory_checkpoints','SELECT')
     OR has_table_privilege('anon','public.union_pnl_inventory_checkpoints','SELECT') THEN
    RAISE EXCEPTION 'postimage: checkpoints are writable or browser-readable';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname='original_pnl_inventory_checkpoint_immutable') <> 3 THEN
    RAISE EXCEPTION 'postimage: checkpoints are not immutable';
  END IF;
END $post$;

COMMIT;