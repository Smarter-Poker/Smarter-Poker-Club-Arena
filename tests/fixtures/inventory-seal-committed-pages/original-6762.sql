-- 20261012135622_the_inventory_seal_assembles_bucket_by_bucket.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE INVENTORY SEAL ASSEMBLES ITS WEEK BUCKET BY BUCKET. Full account:
-- docs/changelog/2026-10-12-the-inventory-seal-assembles-bucket-by-bucket.md.
-- Follows 20261012134146_the_weekly_close_never_holds_replication.
--
-- WHY. Supabase Realtime shuts replication down when one open writing
-- transaction is more than 1.5 GB of WAL behind. fn_union_pnl_inventory_seal_advance
-- computes a week's layers six hours at a time, but then wrote the WHOLE week's
-- checkpoint in one statement: 3,352,453 rows on 2026-10-12 (the table holds
-- ~1.7 GB for 5.85M rows, so ~1 GB of rows for that week alone, plus indexes
-- and WAL), and the weekly row counts are 478,197, 1,846,384 and 3,352,453.
-- Next week's assembly would be over the cutoff by itself, however fast it is.
--
-- WHAT CHANGES. Outside a verify, the week is assembled one bucket (one source,
-- the first two hex digits of row_id) at a time from exactly the rows the
-- whole-week statement read, into union_pnl_inventory_checkpoint_rows and
-- _issues, each bucket recorded in the new union_pnl_inventory_seal_buckets; a
-- call stops after 400,000 rows or 75 seconds and returns 'sealing', and the
-- next call continues. The checkpoint row is written last, in a call of its
-- own: rows hash = md5 of the bucket hashes in (source, bucket) order (the
-- formula of 20261012113248), counts and max event id from the buckets, issues
-- hash over the issues written. Every reader finds a week through its
-- checkpoint row, so a partial assembly is never read; a week whose layers are
-- restarted drops its partial assembly. A verify rebuilds the week whole and
-- writes nothing, as before.
--
-- EQUIVALENCE (read-only on production, 2026-10-12): composing the sealed week
-- 2026-10-12 from its stored rows bucket by bucket gives its stored rows_md5
-- 5ae24d37..., row_count 3,352,453, max_event_id 63,116,879, issues_md5
-- 94922459... over 245 issues; and the per-bucket statement over the week's
-- layers and the 2026-10-05 base returns exactly the rows and issues the
-- whole-week statement stored (see the changelog for the full-week check).
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))='47b1a3a80eec9fc6a593e99ebef27c27' AND to_regclass('public.union_pnl_inventory_seal_buckets') IS NOT NULL)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The assembly's own staging: one row per (week, source, bucket). Unlogged like
-- the layers it sits beside: a crash empties both, the layers' absence then
-- drops any partial assembly, and the week starts again.
CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_buckets (
  boundary timestamptz NOT NULL,
  source_name text NOT NULL,
  bucket text NOT NULL CHECK (bucket ~ '^[0-9a-f]{2}$'),
  base_boundary timestamptz NOT NULL,
  row_count bigint,
  issue_count bigint,
  rows_md5 text,
  max_event_id bigint,
  assembled_at timestamptz,
  PRIMARY KEY (boundary, source_name, bucket)
);
ALTER TABLE public.union_pnl_inventory_seal_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_pnl_inventory_seal_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.union_pnl_inventory_seal_buckets TO service_role;
COMMENT ON TABLE public.union_pnl_inventory_seal_buckets IS
  'Bucket-by-bucket inventory seal (20261012): each (week, source, first two hex digits of row_id) assembled into union_pnl_inventory_checkpoint_rows so far, with its row count, rows hash, max event id and issue count. Unlogged staging; emptied when its week is sealed.';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SEAL_BUCKET_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $mig$
DECLARE s regprocedure:='public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure; d text;
BEGIN
 -- A week mid-seal keeps whichever path started it: refuse to install while
 -- a week's layers are staged without its checkpoint.
 IF EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l
   WHERE NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=l.boundary)) THEN
  RAISE EXCEPTION 'an inventory seal is in progress; install between seals' USING ERRCODE='55000';
 END IF;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'6deca79658f44ffb149316167441b2bf' THEN RAISE EXCEPTION 'seal advance preimage %',md5(d) USING ERRCODE='55000'; END IF;
 d:=pg_temp.ca_swap_once(d,$a$ v_rows bigint; v_issues bigint; v_rows_md5 text; v_issues_md5 text; v_max bigint; v_projection jsonb; v_ms bigint; v_lr bigint; v_li bigint;
$a$,$r$ v_rows bigint; v_issues bigint; v_rows_md5 text; v_issues_md5 text; v_max bigint; v_projection jsonb; v_ms bigint; v_lr bigint; v_li bigint;
 k record; lo uuid; hi uuid; v_br bigint; v_bi bigint; v_bmd5 text; v_bmax bigint; n_tick bigint:=0; did_bucket boolean:=false; n_b bigint; n_bd bigint;
$r$,'seal declarations');
 d:=pg_temp.ca_swap_once(d,$a$ IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at)
  OR EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at AND l.base_boundary IS DISTINCT FROM v_base) THEN
  TRUNCATE public.union_pnl_inventory_seal_layers, public.union_pnl_inventory_seal_layer_rows, public.union_pnl_inventory_seal_layer_issues;
 END IF;
$a$,$r$ IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at)
  OR EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at AND l.base_boundary IS DISTINCT FROM v_base) THEN
  TRUNCATE public.union_pnl_inventory_seal_layers, public.union_pnl_inventory_seal_layer_rows, public.union_pnl_inventory_seal_layer_issues;
  -- A week assembled bucket by bucket (20261012) restarts with its layers:
  -- this week has no checkpoint (that returned above), so any rows it has
  -- are a partial assembly.
  IF NOT p_verify THEN
   TRUNCATE public.union_pnl_inventory_seal_buckets;
   DELETE FROM public.union_pnl_inventory_checkpoint_rows WHERE boundary=p_at;
   DELETE FROM public.union_pnl_inventory_checkpoint_issues WHERE boundary=p_at;
  END IF;
 END IF;
$r$,'seal stale staging');
 d:=pg_temp.ca_swap_once(d,$a$ -- The week: base rows no layer touched, and each touched row as of its
 -- latest layer; issues likewise.
$a$,$r$ -- THE WEEK IS ASSEMBLED BUCKET BY BUCKET (20261012). Inserting every row
 -- of a week in one transaction (3,352,453 rows, ~1.7 GB of table on
 -- 2026-10-12, growing each week) is more WAL than Supabase Realtime lets one
 -- open transaction hold (1.5 GB) before it shuts replication down. Each
 -- bucket (one source, the first two hex digits of row_id) is assembled from
 -- the same rows the whole-week statement below reads, written to the
 -- checkpoint, and recorded in union_pnl_inventory_seal_buckets; a call stops
 -- after 400,000 rows or 75 seconds and the next call continues. The
 -- checkpoint row is written last, from the buckets: the rows hash is the
 -- bucket-by-bucket hash of 20261012113248 (bucket hashes in (source, bucket)
 -- order, empty buckets absent), counts and max event id are their sums and
 -- maximum, the issues hash is taken over the issues written. Readers find a
 -- week through its checkpoint row, so a partial assembly is never read.
 -- A verify still rebuilds the whole week below and writes nothing.
 IF NOT p_verify THEN
  IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_buckets b WHERE b.boundary=p_at) THEN
   INSERT INTO public.union_pnl_inventory_seal_buckets(boundary,base_boundary,source_name,bucket)
   SELECT p_at,v_base,s.sn,lpad(to_hex(i),2,'0')
    FROM (SELECT l.source_name sn FROM public.union_pnl_inventory_seal_layer_rows l WHERE l.boundary=p_at
          UNION SELECT l.source_name FROM public.union_pnl_inventory_seal_layer_issues l WHERE l.boundary=p_at
          UNION SELECT r.source_name FROM public.union_pnl_inventory_checkpoint_rows r WHERE r.boundary=v_base
          UNION SELECT r.source_name FROM public.union_pnl_inventory_checkpoint_issues r WHERE r.boundary=v_base) s
    CROSS JOIN generate_series(0,255) i;
  END IF;
  FOR k IN SELECT b.source_name,b.bucket FROM public.union_pnl_inventory_seal_buckets b
    WHERE b.boundary=p_at AND b.assembled_at IS NULL ORDER BY b.source_name,b.bucket LOOP
   IF did_bucket AND (n_tick>=400000 OR clock_timestamp()>began+interval '75 seconds') THEN
    SELECT count(*),count(*) FILTER(WHERE b.assembled_at IS NOT NULL) INTO n_b,n_bd FROM public.union_pnl_inventory_seal_buckets b WHERE b.boundary=p_at;
    RETURN jsonb_build_object('status','sealing','stage','assembling','boundary',p_at,'base_boundary',v_base,'layers',n_layers,'layers_done',n_layers,
     'buckets',n_b,'buckets_done',n_bd);
   END IF;
   lo:=(k.bucket||'000000-0000-0000-0000-000000000000')::uuid;
   hi:=CASE WHEN k.bucket='ff' THEN NULL ELSE (lpad(to_hex(('x'||k.bucket)::bit(8)::int+1),2,'0')||'000000-0000-0000-0000-000000000000')::uuid END;
   WITH lt AS MATERIALIZED (
     SELECT DISTINCT ON (l.row_id) l.row_id rid,l.layer_end,l.latest_event_id eid,l.first_operation fop,l.after_row
     FROM public.union_pnl_inventory_seal_layer_rows l
     WHERE l.boundary=p_at AND l.source_name=k.source_name AND l.row_id>=lo AND (hi IS NULL OR l.row_id<hi)
     ORDER BY l.row_id,l.layer_end DESC
   ), w AS MATERIALIZED (
     SELECT lt.rid,lt.eid,lt.fop,lt.after_row FROM lt
     UNION ALL
     SELECT r.row_id,r.latest_event_id,r.first_operation,r.after_row FROM public.union_pnl_inventory_checkpoint_rows r
      WHERE r.boundary=v_base AND r.source_name=k.source_name AND r.row_id>=lo AND (hi IS NULL OR r.row_id<hi)
       AND NOT EXISTS(SELECT 1 FROM lt WHERE lt.rid=r.row_id)
   ), wi AS MATERIALIZED (
     SELECT li.row_id,li.event_id FROM lt JOIN public.union_pnl_inventory_seal_layer_issues li
      ON li.boundary=p_at AND li.layer_end=lt.layer_end AND li.source_name=k.source_name AND li.row_id=lt.rid
     UNION ALL
     SELECT ci.row_id,ci.event_id FROM public.union_pnl_inventory_checkpoint_issues ci
      WHERE ci.boundary=v_base AND ci.source_name=k.source_name AND ci.row_id>=lo AND (hi IS NULL OR ci.row_id<hi)
       AND NOT EXISTS(SELECT 1 FROM lt WHERE lt.rid=ci.row_id)
   ), ins AS (
     INSERT INTO public.union_pnl_inventory_checkpoint_rows(boundary,source_name,row_id,latest_event_id,first_operation,after_row)
     SELECT p_at,k.source_name,w.rid,w.eid,w.fop,w.after_row FROM w RETURNING 1
   ), insi AS (
     INSERT INTO public.union_pnl_inventory_checkpoint_issues(boundary,source_name,row_id,event_id)
     SELECT p_at,k.source_name,wi.row_id,wi.event_id FROM wi RETURNING 1
   )
   SELECT (SELECT count(*) FROM ins),(SELECT count(*) FROM insi),
    (SELECT md5(string_agg(concat_ws('|',k.source_name,w.rid,w.eid,w.fop,COALESCE(w.after_row::text,'~')),E'\n' ORDER BY w.rid)) FROM w),
    (SELECT max(w.eid) FROM w)
   INTO v_br,v_bi,v_bmd5,v_bmax;
   UPDATE public.union_pnl_inventory_seal_buckets b SET row_count=v_br,issue_count=v_bi,rows_md5=v_bmd5,max_event_id=v_bmax,assembled_at=clock_timestamp()
    WHERE b.boundary=p_at AND b.source_name=k.source_name AND b.bucket=k.bucket;
   n_tick:=n_tick+v_br; did_bucket:=true;
  END LOOP;
  -- The checkpoint row gets a call of its own once the last bucket is in.
  IF did_bucket AND clock_timestamp()>began+interval '60 seconds' THEN
   SELECT count(*) INTO n_b FROM public.union_pnl_inventory_seal_buckets b WHERE b.boundary=p_at;
   RETURN jsonb_build_object('status','sealing','stage','assembling','boundary',p_at,'base_boundary',v_base,'layers',n_layers,'layers_done',n_layers,
    'buckets',n_b,'buckets_done',n_b);
  END IF;
  SELECT COALESCE(sum(b.row_count),0),COALESCE(sum(b.issue_count),0),max(b.max_event_id),
   md5(COALESCE(string_agg(b.rows_md5,E'\n' ORDER BY b.source_name,b.bucket) FILTER(WHERE b.row_count>0),''))
  INTO v_rows,v_issues,v_max,v_rows_md5 FROM public.union_pnl_inventory_seal_buckets b WHERE b.boundary=p_at;
  SELECT md5(COALESCE(string_agg(concat_ws('|',i.source_name,i.row_id,i.event_id),E'\n' ORDER BY i.source_name,i.row_id,i.event_id),''))
  INTO v_issues_md5 FROM public.union_pnl_inventory_checkpoint_issues i WHERE i.boundary=p_at;
  v_projection:=public.fn_union_pnl_inventory_population(p_at,p_at);
  SELECT COALESCE(sum(l.layer_ms),0)+(extract(epoch FROM clock_timestamp()-began)*1000)::bigint INTO v_ms FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at;
  INSERT INTO public.union_pnl_inventory_checkpoints(boundary,base_boundary,max_event_id,row_count,issue_count,rows_md5,issues_md5,result_md5,legacy_verified,seal_ms)
  VALUES(p_at,v_base,v_max,v_rows,v_issues,v_rows_md5,v_issues_md5,md5(v_projection::text),false,v_ms);
  DELETE FROM public.union_pnl_inventory_seal_buckets b WHERE b.boundary=p_at;
  RETURN jsonb_build_object('status','sealed','boundary',p_at,'base_boundary',v_base,'max_event_id',v_max,'row_count',v_rows,'issue_count',v_issues,
   'rows_md5',v_rows_md5,'result_md5',md5(v_projection::text),'legacy_verified',false,'layers',n_layers,
   'result_issues',jsonb_array_length(v_projection->'issues'),'seal_ms',v_ms);
 END IF;
 -- The week: base rows no layer touched, and each touched row as of its
 -- latest layer; issues likewise.
$r$,'seal assembles bucket by bucket');
 IF md5(d)<>'47b1a3a80eec9fc6a593e99ebef27c27' THEN RAISE EXCEPTION 'seal advance postimage %',md5(d) USING ERRCODE='55000'; END IF;
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'seal advance installed text differs' USING ERRCODE='55000'; END IF;
END
$mig$;

COMMIT;
