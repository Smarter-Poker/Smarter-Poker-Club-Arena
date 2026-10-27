-- The unchanged original weekly club selector probes coordinator/club/event.
-- Existing two-key indexes leave the club predicate or witness fields in heap
-- reads. Actual outage profiling found the candidate fee-field read using
-- ~1.1GB of heap and24.3s serial time; no wallet payment is certified here.
-- Cover only the exact original lookup keys and four witness fields.
-- No function/configuration/source pin, cache identity, earning contract,
-- monetary rule, journal, receipt, financial row or business budget changes.
-- Maintained concurrent-preamble route: one600s bounded build,12minutes
-- initial runway before:50UTC, VALID/READY/LIVE readback, one final transaction.
-- An unknown/INVALID existing build is inspected, never dropped/retried here.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND c.relowner='postgres'::regrole AND pg_get_indexdef(c.oid)='CREATE INDEX accounting_tournament_week_club_event_cover ON public.accounting_tournament_fee_sources USING btree (coordinator_union_id, club_id, tournament_id) INCLUDE (id, charged_at, rake_credit, union_id) WHERE (coordinator_union_id IS NOT NULL)' FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.oid=to_regclass('public.accounting_tournament_week_club_event_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_week_club_event_cover
 ON public.accounting_tournament_fee_sources USING btree(coordinator_union_id,club_id,tournament_id)
 INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NOT NULL;
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $week_club_event_cover$
DECLARE ix record;col record;j int;op oid;
 names text[]:=ARRAY['coordinator_union_id','club_id','tournament_id','id','charged_at','rake_credit','union_id'];
 types oid[]:=ARRAY['uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'timestamptz'::regtype,'numeric'::regtype,'uuid'::regtype];
BEGIN
 SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.accounting_tournament_week_club_event_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'week_club_event_cover_missing';END IF;
 IF ix.indrelid IS DISTINCT FROM to_regclass('public.accounting_tournament_fee_sources')
 OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
 OR ix.indnkeyatts<>3 OR ix.indnatts<>7 OR ix.indexprs IS NOT NULL
 OR pg_get_expr(ix.indpred,ix.indrelid) IS DISTINCT FROM '(coordinator_union_id IS NOT NULL)'
 OR EXISTS(SELECT FROM pg_constraint c WHERE c.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'week_club_event_cover_shape_changed';END IF;
 FOR j IN 1..7 LOOP
  SELECT a.attnum,a.atttypid,a.attcollation,a.attisdropped INTO col FROM pg_attribute a
   WHERE a.attrelid=ix.indrelid AND a.attname=names[j];
  IF col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM types[j]
   OR ix.indkey[j-1] IS DISTINCT FROM col.attnum
  THEN RAISE EXCEPTION 'week_club_event_cover_column_changed:%',names[j];END IF;
  IF j<=3 THEN
   SELECT o.oid INTO op FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace
    WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype=types[j]
     AND o.opcmethod=(SELECT oid FROM pg_am WHERE amname='btree');
   IF NOT FOUND OR ix.indclass[j-1] IS DISTINCT FROM op
    OR ix.indcollation[j-1] IS DISTINCT FROM col.attcollation
    OR ix.indoption[j-1] IS DISTINCT FROM 0::smallint
   THEN RAISE EXCEPTION 'week_club_event_cover_key_changed:%',names[j];END IF;
  END IF;
 END LOOP;
END $week_club_event_cover$;
COMMIT;
