-- Weekly close freshness reads the sources recorded after its calculation.
-- Two original-week attempts on 2026-10-16 (16:01 and 16:06 UTC) exhausted
-- their unchanged 240s statements in fn_prepare_accounting_week's receipt
-- freshness predicate. The tournament plan could constrain only club_id using
-- accounting_tournament_fee_sources_club_event; charged_at and recorded_at
-- were heap filters (estimated cost198960). Cash has the same recorded_at
-- predicate and no index on it. These immutable source tables hold about
-- 6.66m cash and1.33m tournament rows, with 9.51GB and1.95GB heaps.
--
-- Index the actual club/recording-time lookup and carry its earning-time
-- predicate. No function, freshness rule, cutoff, receipt, budget or money row
-- changes. A late/backdated source still invalidates the old calculation.
-- Use the maintained concurrent-preamble installer exception so live writers
-- are not blocked for a regular index build. The installer admits one owning
-- operation, retains maintenance guards, and reads each index VALID before
-- sending this final catalog assertion and recording the raw migration.
--
-- @live-proof: (SELECT count(*)=2 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND i.indnkeyatts=2 AND i.indnatts=3 AND i.indexprs IS NULL AND i.indpred IS NULL AND am.amname='btree') FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE c.oid IN(to_regclass('public.accounting_cash_rake_sources_club_recorded'),to_regclass('public.accounting_tournament_fee_sources_club_recorded')))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_rake_sources_club_recorded
 ON public.accounting_cash_rake_sources (club_id,recorded_at) INCLUDE (earned_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_fee_sources_club_recorded
 ON public.accounting_tournament_fee_sources (club_id,recorded_at) INCLUDE (charged_at);

BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
DECLARE r record;ix record;cols text[];
BEGIN
 FOR r IN SELECT * FROM(VALUES
  ('accounting_cash_rake_sources_club_recorded','accounting_cash_rake_sources','earned_at'),
  ('accounting_tournament_fee_sources_club_recorded','accounting_tournament_fee_sources','charged_at')
 )v(index_name,table_name,time_column) LOOP
  SELECT i.*,c.relowner,am.amname INTO ix FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
   WHERE c.oid=to_regclass('public.'||r.index_name);
  IF NOT FOUND THEN RAISE EXCEPTION 'weekly_source_freshness_index_missing: %',r.index_name;END IF;
  SELECT array_agg(a.attname::text ORDER BY k.ord) INTO cols FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
   JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum;
  IF ix.indrelid<>to_regclass('public.'||r.table_name) OR ix.relowner<>'postgres'::regrole
   OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive OR ix.indisunique OR ix.indnkeyatts<>2 OR ix.indnatts<>3
   OR ix.amname<>'btree' OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
   OR cols IS DISTINCT FROM ARRAY['club_id','recorded_at',r.time_column]::text[]
  THEN RAISE EXCEPTION 'weekly_source_freshness_index_shape_changed: %',r.index_name;END IF;
 END LOOP;
END $guard$;
COMMIT;
