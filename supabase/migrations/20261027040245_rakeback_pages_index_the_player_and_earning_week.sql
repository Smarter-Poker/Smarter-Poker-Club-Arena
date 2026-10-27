-- Each canonical rakeback check/write page selects a few players' earned week.
-- The live 2026-10-27 plan reads cash by player then filters club/time, and scans
-- the tournament (rake_record_id,player_id) index with only its second key.
-- Add only the exact leading keys of those unchanged original predicates.
-- Cash catalog:12.997m rows/17.5GiB heap; tournament:1.877m/2.67GiB heap.
-- No allocation query, rate, historical contract, payer, source fingerprint,
-- stored part, count, source authority, wallet or financial row is rewritten.
--
-- Both builds use the maintained concurrent-preamble installer, outside its
-- one final assertion/history transaction. It gives each build one600s bound,
-- requires12minutes initial runway before:50UTC and VALID/READY readback before
-- continuing. Build duration/extra disk remain live-operation evidence, not a
-- local timing promise. A partial/unknown/INVALID build is inspected by exact
-- catalog+owning operation; never automatically dropped, retried or certified.
-- The named-index guards below refuse a same-name wrong shape or invalid row.
--
-- @live-proof: (SELECT count(*)=2 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion AND i.indexprs IS NULL AND i.indpred IS NULL AND c.relowner='postgres'::regrole AND am.amname='btree' AND pg_get_indexdef(c.oid)=CASE c.relname WHEN 'accounting_cash_rakeback_player_week' THEN 'CREATE INDEX accounting_cash_rakeback_player_week ON public.accounting_cash_rake_sources USING btree (club_id, player_id, earned_at)' ELSE 'CREATE INDEX accounting_tournament_rakeback_player ON public.accounting_tournament_fee_sources USING btree (club_id, player_id)' END) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE c.oid IN(to_regclass('public.accounting_cash_rakeback_player_week'),to_regclass('public.accounting_tournament_rakeback_player')))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_rakeback_player_week
 ON public.accounting_cash_rake_sources USING btree(club_id,player_id,earned_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_rakeback_player
 ON public.accounting_tournament_fee_sources USING btree(club_id,player_id);

BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $indexes$
DECLARE spec record;ix record;col record;j integer;op oid;
BEGIN
 FOR spec IN SELECT * FROM(VALUES
  ('accounting_cash_rakeback_player_week','accounting_cash_rake_sources',ARRAY['club_id','player_id','earned_at']::text[],ARRAY['uuid'::regtype,'uuid'::regtype,'timestamptz'::regtype]),
  ('accounting_tournament_rakeback_player','accounting_tournament_fee_sources',ARRAY['club_id','player_id']::text[],ARRAY['uuid'::regtype,'uuid'::regtype]))v(index_name,table_name,columns,types)
 LOOP
  SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
   FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
   WHERE c.oid=to_regclass('public.'||spec.index_name);
  IF NOT FOUND THEN RAISE EXCEPTION 'rakeback_player_week_index_missing:%',spec.index_name;END IF;
  IF ix.indrelid IS DISTINCT FROM to_regclass('public.'||spec.table_name)
   OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
   OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
   OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
   OR ix.indnkeyatts<>cardinality(spec.columns) OR ix.indnatts<>cardinality(spec.columns)
   OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
   OR EXISTS(SELECT FROM pg_constraint x WHERE x.conindid=ix.indexrelid)
  THEN RAISE EXCEPTION 'rakeback_player_week_index_shape_changed:%',spec.index_name;END IF;
  FOR j IN 1..cardinality(spec.columns) LOOP
   SELECT a.attnum,a.atttypid,a.attisdropped INTO col FROM pg_attribute a
    WHERE a.attrelid=ix.indrelid AND a.attname=spec.columns[j];
   SELECT o.oid INTO op FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace
    WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype=spec.types[j] AND o.opcmethod=(SELECT oid FROM pg_am WHERE amname='btree');
   IF NOT FOUND OR col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM spec.types[j]::oid
    OR ix.indkey[j-1] IS DISTINCT FROM col.attnum OR ix.indclass[j-1] IS DISTINCT FROM op
    OR ix.indcollation[j-1] IS DISTINCT FROM 0::oid OR ix.indoption[j-1] IS DISTINCT FROM 0::smallint
   THEN RAISE EXCEPTION 'rakeback_player_week_index_column_changed:%:%',spec.index_name,spec.columns[j];END IF;
  END LOOP;
 END LOOP;
END $indexes$;
COMMIT;
