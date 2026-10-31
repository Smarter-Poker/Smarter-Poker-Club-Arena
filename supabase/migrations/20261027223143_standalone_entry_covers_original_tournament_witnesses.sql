-- The unchanged original Scope standalone-entry selector reads every historical
-- NULL-coordinator tournament witness before deriving its first pending week.
-- Production failed at the Scope624 FOR query after285seconds; its exact plan
-- used a105210-row heap IndexScan on(club_id,tournament_id). The union-only
-- NONNULL coordinator cover cannot serve this predicate.
-- Cover just the two existing keys and four scalar witness fields. No function,
-- source pin, earning filter, cutoff, first-week math, ACL, cache, receipt,
-- accounting budget or money changes. No duplicate payment path is added.
-- Maintained concurrent-preamble route: one bounded build,12minutes initial
-- runway before:50UTC, VALID/READY/LIVE readback and one final transaction.
-- Unknown/INVALID existing indexes are refused, never dropped/retried here.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND c.relowner='postgres'::regrole AND pg_get_indexdef(c.oid)='CREATE INDEX accounting_tournament_standalone_club_event_cover ON public.accounting_tournament_fee_sources USING btree (club_id, tournament_id) INCLUDE (id, charged_at, rake_credit, union_id) WHERE (coordinator_union_id IS NULL)' FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.oid=to_regclass('public.accounting_tournament_standalone_club_event_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_standalone_club_event_cover
 ON public.accounting_tournament_fee_sources USING btree(club_id,tournament_id)
 INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NULL;
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $standalone_club_event_cover$
DECLARE ix record;col record;j int;op oid;
 names text[]:=ARRAY['club_id','tournament_id','id','charged_at','rake_credit','union_id'];
 types oid[]:=ARRAY['uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'timestamptz'::regtype,'numeric'::regtype,'uuid'::regtype];
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'standalone_club_event_cover_platform_frozen';END IF;
 SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.accounting_tournament_standalone_club_event_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'standalone_club_event_cover_missing';END IF;
 IF ix.indrelid IS DISTINCT FROM to_regclass('public.accounting_tournament_fee_sources')
 OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
 OR ix.indnkeyatts<>2 OR ix.indnatts<>6 OR ix.indexprs IS NOT NULL
 OR pg_get_expr(ix.indpred,ix.indrelid) IS DISTINCT FROM '(coordinator_union_id IS NULL)'
 OR EXISTS(SELECT FROM pg_constraint c WHERE c.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'standalone_club_event_cover_shape_changed';END IF;
 FOR j IN 1..6 LOOP
  SELECT a.attnum,a.atttypid,a.attcollation,a.attisdropped INTO col FROM pg_attribute a
   WHERE a.attrelid=ix.indrelid AND a.attname=names[j];
  IF col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM types[j]
   OR ix.indkey[j-1] IS DISTINCT FROM col.attnum
  THEN RAISE EXCEPTION 'standalone_club_event_cover_column_changed:%',names[j];END IF;
  IF j<=2 THEN
   SELECT o.oid INTO op FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace
    WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype=types[j]
     AND o.opcmethod=(SELECT oid FROM pg_am WHERE amname='btree');
   IF NOT FOUND OR ix.indclass[j-1] IS DISTINCT FROM op
    OR ix.indcollation[j-1] IS DISTINCT FROM col.attcollation
    OR ix.indoption[j-1] IS DISTINCT FROM 0::smallint
   THEN RAISE EXCEPTION 'standalone_club_event_cover_key_changed:%',names[j];END IF;
  END IF;
 END LOOP;
END $standalone_club_event_cover$;
COMMIT;
