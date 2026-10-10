-- Version reserved by scripts/new-migration.mjs.
-- Cover the original same-snapshot funding census without reading its wide JSON
-- custody payloads. No financial SQL, row, authorization, constraint or deadline changes.
-- The maintained applier installs this concurrent preamble separately and checks
-- its validity before running this single guarded transaction and recording the file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_funding_recovery_cover ON public.tournament_participant_funding_receipts(ledger_id) INCLUDE(asset,amount,wallet_transaction_id);
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
DECLARE ix record; cols text[];
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.tournament_participant_funding_receipts'::regclass
     AND c.relkind='r' AND c.relpersistence='p' AND c.relrowsecurity AND NOT c.relforcerowsecurity
     AND c.relacl::text='{postgres=arwdDxtm/postgres,service_role=r/postgres}' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='postgres'))
 THEN RAISE EXCEPTION 'funding_recovery_relation_preimage_changed'; END IF;
 IF (SELECT array_agg(a.atttypid::regtype::text ORDER BY u.ord)
     FROM unnest(ARRAY['ledger_id','asset','amount','wallet_transaction_id']) WITH ORDINALITY u(name,ord)
     LEFT JOIN pg_attribute a ON a.attrelid='public.tournament_participant_funding_receipts'::regclass AND a.attname=u.name AND a.attnum>0 AND NOT a.attisdropped)
     IS DISTINCT FROM ARRAY['uuid','text','numeric','uuid']::text[]
 THEN RAISE EXCEPTION 'funding_recovery_columns_changed'; END IF;
 SELECT i.*,c.relowner,c.relpersistence,c.reloptions,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.idx_tournament_funding_recovery_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'funding_recovery_cover_missing'; END IF;
 SELECT array_agg(a.attname::text ORDER BY k.ord) INTO cols
 FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
 JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum;
 IF ix.indrelid<>'public.tournament_participant_funding_receipts'::regclass
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion
 OR ix.indnkeyatts<>1 OR ix.indnatts<>4 OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
 OR ix.amname<>'btree' OR ix.relpersistence<>'p' OR ix.reloptions IS NOT NULL
 OR ix.relowner<>(SELECT oid FROM pg_roles WHERE rolname='postgres')
 OR cols IS DISTINCT FROM ARRAY['ledger_id','asset','amount','wallet_transaction_id']::text[]
 OR ix.indoption[0]<>0 OR ix.indcollation[0]<>0
 OR ix.indclass[0]<>(SELECT o.oid FROM pg_opclass o JOIN pg_am a ON a.oid=o.opcmethod
                    WHERE a.amname='btree' AND o.opcdefault AND o.opcintype='uuid'::regtype)
 THEN RAISE EXCEPTION 'funding_recovery_cover_shape_changed'; END IF;
END $guard$;
COMMIT;
