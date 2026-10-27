-- Cover the seven columns read by the unchanged original R2 _rw_ac lookup.
-- Preserve its existing(source_id,source_type,club_id) keys and partial predicate.
-- No function, source authority pin, query, cache, proof or money row changes.
-- Existing catalogue:25.43m rows, ~99.26% heap pages all-visible. A covering
-- read can avoid heap fetches; native proof is not production timing or size.
-- Use the maintained concurrent-preamble installer, one bounded build followed
-- by one assertion/history transaction. Inspect any INVALID/unknown outcome;
-- never automatically drop, retry or certify a same-name leftover.
-- Installation remains held until the incident's human payments are verified.
-- This R2-only access fix cannot improve split-write payer registration and
-- does not alone establish04:00 whole-week payout capacity.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND c.relowner='postgres'::regrole AND pg_get_indexdef(c.oid)='CREATE INDEX accounting_agent_commissions_source_cover ON public.agent_commissions USING btree (source_id, source_type, club_id) INCLUDE (user_id, amount, commission_rate, settled_at) WHERE (source_id IS NOT NULL)' FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.oid=to_regclass('public.accounting_agent_commissions_source_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_agent_commissions_source_cover
 ON public.agent_commissions USING btree(source_id,source_type,club_id)
 INCLUDE(user_id,amount,commission_rate,settled_at) WHERE source_id IS NOT NULL;
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $commission_cover$
DECLARE ix record;col record;j int;op oid;
 names text[]:=ARRAY['source_id','source_type','club_id','user_id','amount','commission_rate','settled_at'];
 types oid[]:=ARRAY['uuid'::regtype,'text'::regtype,'uuid'::regtype,'uuid'::regtype,'numeric'::regtype,'numeric'::regtype,'timestamptz'::regtype];
BEGIN
 SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.accounting_agent_commissions_source_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'commission_source_cover_missing';END IF;
 IF ix.indrelid IS DISTINCT FROM to_regclass('public.agent_commissions')
 OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
 OR ix.indnkeyatts<>3 OR ix.indnatts<>7 OR ix.indexprs IS NOT NULL
 OR pg_get_expr(ix.indpred,ix.indrelid) IS DISTINCT FROM '(source_id IS NOT NULL)'
 OR EXISTS(SELECT FROM pg_constraint c WHERE c.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'commission_source_cover_shape_changed';END IF;
 FOR j IN 1..7 LOOP
  SELECT a.attnum,a.atttypid,a.attcollation,a.attisdropped INTO col FROM pg_attribute a
   WHERE a.attrelid=ix.indrelid AND a.attname=names[j];
  IF col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM types[j]
   OR ix.indkey[j-1] IS DISTINCT FROM col.attnum
  THEN RAISE EXCEPTION 'commission_source_cover_column_changed:%',names[j];END IF;
  IF j<=3 THEN
   SELECT o.oid INTO op FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace
    WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype=types[j]
     AND o.opcmethod=(SELECT oid FROM pg_am WHERE amname='btree');
   IF NOT FOUND OR ix.indclass[j-1] IS DISTINCT FROM op
    OR ix.indcollation[j-1] IS DISTINCT FROM col.attcollation
    OR ix.indoption[j-1] IS DISTINCT FROM 0::smallint
   THEN RAISE EXCEPTION 'commission_source_cover_key_changed:%',names[j];END IF;
  END IF;
 END LOOP;
END $commission_cover$;
COMMIT;
