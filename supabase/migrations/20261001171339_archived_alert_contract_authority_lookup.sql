-- Reserved by scripts/reserve-migration-version.sh.
-- Oldest archived production-alert completion reads every contract version for
-- its game UUID and locks in id order. Oct 1 production has 757994 estimated
-- rows; existing secondary indexes lead with game_kind, absent from this exact
-- predicate. The lock-free same-game ordered read independently timed out at
-- 3 seconds. Preserve every game kind and the financial owner's FOR SHARE.
-- Build through the existing recorded concurrent-index installer only.
-- @live-proof: (SELECT indisvalid AND indisready AND indislive AND pg_get_indexdef(indexrelid)='CREATE INDEX managed_game_contract_versions_game_id_id_idx ON public.managed_game_contract_versions USING btree (game_id, id)' FROM pg_index WHERE indexrelid=to_regclass('public.managed_game_contract_versions_game_id_id_idx'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS managed_game_contract_versions_game_id_id_idx
ON public.managed_game_contract_versions (game_id, id);
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $assert$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_index i
  JOIN pg_class c ON c.oid=i.indexrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_class t ON t.oid=i.indrelid
  JOIN pg_namespace tn ON tn.oid=t.relnamespace
  JOIN pg_am am ON am.oid=c.relam
  JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
  JOIN pg_attribute b ON b.attrelid=t.oid AND b.attnum=i.indkey[1]
  WHERE n.nspname='public' AND c.relname='managed_game_contract_versions_game_id_id_idx'
   AND tn.nspname='public' AND t.relname='managed_game_contract_versions'
   AND c.relkind='i' AND am.amname='btree'
   AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
   AND i.indnkeyatts=2 AND i.indnatts=2
   AND a.attname='game_id' AND b.attname='id'
   AND i.indpred IS NULL AND i.indexprs IS NULL
   AND pg_get_indexdef(c.oid)='CREATE INDEX managed_game_contract_versions_game_id_id_idx ON public.managed_game_contract_versions USING btree (game_id, id)'
 ) THEN
  RAISE EXCEPTION 'Managed contract game-id ordered lookup index missing or wrong';
 END IF;
END $assert$;
COMMIT;
