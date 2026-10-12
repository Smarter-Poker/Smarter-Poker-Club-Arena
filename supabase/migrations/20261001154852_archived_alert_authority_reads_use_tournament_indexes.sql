-- Reserved by scripts/reserve-migration-version.sh. Oldest production-alert
-- readiness timed out on these exact tournament absence predicates on Oct 1.
-- Original EXPLAINs and catalogs show sequential scans of approximately 5.2M
-- permits and 197k fee batches. Partial indexes preserve the full predicate
-- while excluding irrelevant NULL tournament rows. No financial rows change.
-- The maintained installer builds each index concurrently, checks VALID/READY,
-- then executes this exact-shape assertion transaction. No alternate installer.
-- @live-proof: (SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid=to_regclass('smarter_private.f06_hand_permits_tournament_id_idx'))
-- @live-proof: (SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid=to_regclass('public.accounting_tournament_fee_batches_tournament_id_idx'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS f06_hand_permits_tournament_id_idx
ON smarter_private.f06_hand_permits (tournament_id) WHERE tournament_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_fee_batches_tournament_id_idx
ON public.accounting_tournament_fee_batches (tournament_id) WHERE tournament_id IS NOT NULL;
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $assert$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('smarter_private','f06_hand_permits','f06_hand_permits_tournament_id_idx'),
 ('public','accounting_tournament_fee_batches','accounting_tournament_fee_batches_tournament_id_idx')) v(schema_name,table_name,index_name)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class t ON t.oid=i.indrelid
   JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
   JOIN pg_am am ON am.oid=c.relam
   WHERE n.nspname=r.schema_name AND c.relname=r.index_name
    AND i.indrelid=to_regclass(format('%I.%I',r.schema_name,r.table_name))
    AND i.indisvalid AND i.indisready AND am.amname='btree'
    AND i.indnkeyatts=1 AND i.indnatts=1 AND a.attname='tournament_id'
    AND pg_get_expr(i.indpred,i.indrelid)='(tournament_id IS NOT NULL)'
    AND i.indexprs IS NULL AND NOT i.indisunique)
  THEN RAISE EXCEPTION 'Tournament lookup index missing or wrong: %.%',r.schema_name,r.index_name; END IF;
 END LOOP;
END $assert$;
COMMIT;
