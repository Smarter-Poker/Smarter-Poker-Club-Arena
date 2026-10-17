-- Original-week receipt verification reads every ledger leg of each operation.
-- The 2026-10-17 production catalog has no correlation_id index. An empty
-- prior-receipt join sorted the full 14.18m-row, 1062-byte ledger and spilled
-- over 6GiB before the unchanged 240s statement aborted. The bounded UUID-array
-- reader removed that sort, but its one ledger pass still took 35.883827s;
-- another original-week qualification exhausted its remaining statement time
-- in that same all-correlation receipt check. No failed trial paid anything.
--
-- Add only the UUID lookup the unchanged ALL-leg predicate needs. No category,
-- player, club, date, status or financial filter is added. Duplicate legs stay
-- visible and NULL correlations stay outside a lookup that cannot match NULL.
-- No function, trigger, grant, wallet, receipt, budget or source40 seal changes.
-- Non-NULL ledger inserts maintain one ordinary nonunique btree entry; no wide
-- JSON, monetary field or payload is included. Build size/time remains unknown
-- until the one actual maintained concurrent-preamble installation completes.
-- The existing installer keeps verified TLS, hourly DDL/runway guards, one
-- owning operation, a 600s build bound and VALID/READY readback before the
-- assertion/history transaction below. Never drop a failed or unknown build
-- automatically; recover its exact catalog and owning operation first.
--
-- @live-proof: (SELECT count(*)=1 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL AND pg_get_expr(i.indpred,i.indrelid)='(correlation_id IS NOT NULL)' AND pg_get_indexdef(i.indexrelid,1,true)='correlation_id' AND am.amname='btree' AND c.relowner='postgres'::regrole AND i.indrelid='public.chip_ledger'::regclass) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE c.oid=to_regclass('public.idx_chip_ledger_correlation_id'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_correlation_id
 ON public.chip_ledger USING btree (correlation_id)
 WHERE correlation_id IS NOT NULL;

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE ix record;col record;
BEGIN
 SELECT i.*,c.relowner,c.relkind,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.idx_chip_ledger_correlation_id');
 IF NOT FOUND THEN RAISE EXCEPTION 'weekly_bank_correlation_index_missing';END IF;
 SELECT a.attnum,a.atttypid,a.attisdropped INTO col FROM pg_attribute a
 WHERE a.attrelid='public.chip_ledger'::regclass AND a.attname='correlation_id';
 IF NOT FOUND OR col.attisdropped OR col.atttypid<>'uuid'::regtype
  OR ix.indrelid<>'public.chip_ledger'::regclass OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i'
  OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
  OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion
  OR ix.indnkeyatts<>1 OR ix.indnatts<>1 OR ix.amname<>'btree'
  OR ix.indexprs IS NOT NULL OR ix.indpred IS NULL
  OR pg_get_expr(ix.indpred,ix.indrelid) IS DISTINCT FROM '(correlation_id IS NOT NULL)'
  OR ix.indkey[0] IS DISTINCT FROM col.attnum
  OR ix.indcollation[0] IS DISTINCT FROM 0::oid OR ix.indoption[0] IS DISTINCT FROM 0::smallint
  OR ix.indclass[0] IS DISTINCT FROM (SELECT o.oid FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace WHERE n.nspname='pg_catalog' AND o.opcname='uuid_ops' AND o.opcintype='uuid'::regtype AND o.opcdefault AND o.opcmethod=(SELECT oid FROM pg_am WHERE amname='btree'))
  OR EXISTS(SELECT FROM pg_constraint con WHERE con.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'weekly_bank_correlation_index_shape_changed';END IF;
END $guard$;
COMMIT;
