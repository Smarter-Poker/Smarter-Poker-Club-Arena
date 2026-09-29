-- A WEEKLY STATEMENT FINGERPRINTS ITS SOURCES WITHOUT A GIGABYTE STRING (2026-09-28).
--
-- fn_club_weekly_accounting_summary fingerprinted the book with
-- md5(string_agg(jsonb_build_array(..., s.contract)::text, '')) over every
-- earning source. For Deep Stack Society's week (about 599k sources, each
-- carrying its contract jsonb) the one intermediate string passed
-- PostgreSQL's 1 GB limit, and the weekly close failed at 01:23:45 UTC
-- ("out of memory: Cannot enlarge string buffer containing 1073741317 bytes"),
-- after rounds 2 and 3 had completed, rolling the whole close back.
--
-- The statement's source_fingerprint is written into the statement report
-- only; no function reads it back (checked against pg_proc). It becomes the
-- md5 of the ordered per-source md5s: the same ordered-set identity, built
-- from 32 bytes per source instead of the full row text. The report key is
-- renamed source_fingerprint_v2 so the two formats can never be compared by
-- mistake. Everything else is unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $patch$
DECLARE source text; n1 text; r1 text; n2 text; r2 text;
BEGIN
 source:=pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure);
 IF md5(source) IS DISTINCT FROM '1f2d91e88471ab5ef8cd481d3ec7f32b' THEN
  RAISE EXCEPTION 'preimage mismatch: fn_club_weekly_accounting_summary is not 20260928164258'; END IF;
 n1:=$n$md5(COALESCE(string_agg(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit,s.contract)::text,'' ORDER BY s.source_type,s.source_id),'')),$n$;
 r1:=$r$md5(COALESCE(string_agg(md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit,s.contract)::text),'' ORDER BY s.source_type,s.source_id),'')),$r$;
 n2:=$n$'source_count',source_count,'source_fingerprint',source_fingerprint,$n$;
 r2:=$r$'source_count',source_count,'source_fingerprint_v2',source_fingerprint,$r$;
 IF (length(source)-length(replace(source,n1,'')))/length(n1)<>1 OR (length(source)-length(replace(source,n2,'')))/length(n2)<>1 THEN
  RAISE EXCEPTION 'summary_fingerprint_text_changed' USING ERRCODE='55000'; END IF;
 EXECUTE replace(replace(source,n1,r1),n2,r2);
END $patch$;


DO $post$
BEGIN
 IF position('string_agg(md5(jsonb_build_array(s.source_type' in pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'postimage: per-source fingerprint not installed'; END IF;
END $post$;
COMMIT;
