-- The actual Auth FK check searches by player_id while reserved cleanup holds
-- the club hierarchy lock. The existing (rake_record_id,player_id) index made
-- even a read-only missing-player lookup exceed 8s on September 27.
-- Build scripts/ops/build-certification-player-index-concurrently.sql ONCE
-- through the supported finite session, preserving maintenance and DDL guards.
-- Inspect durable catalog/build ownership after an unknown outcome; never replay.
-- This recording transaction changes no cleanup, FK, financial row or authority.
-- @live-proof: select indexrelid::regclass,indisvalid,indisready,indislive from pg_index where indexrelid='public.idx_cash_rake_sources_player'::regclass;
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = public, pg_temp;
DO $verify$
BEGIN
  IF to_regclass('public.idx_cash_rake_sources_player') IS NULL THEN
    RAISE EXCEPTION 'CERTIFICATION_PLAYER_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
    JOIN pg_attribute a ON a.attrelid=tab.oid AND a.attname='player_id' AND NOT a.attisdropped
    WHERE i.indexrelid='public.idx_cash_rake_sources_player'::regclass
      AND i.indrelid='public.accounting_cash_rake_sources'::regclass
      AND ix.relkind='i' AND tab.relkind='r' AND am.amname='btree'
      AND pg_get_userbyid(ix.relowner)='postgres' AND pg_get_userbyid(tab.relowner)='postgres'
      AND a.atttypid='uuid'::regtype AND a.attnotnull
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND i.indkey[0]=a.attnum AND i.indoption::text='0'
      AND i.indcollation[0]=a.attcollation
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='uuid_ops' AND opcmethod=ix.relam)
  ) THEN
    RAISE EXCEPTION 'CERTIFICATION_PLAYER_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.accounting_cash_rake_sources'::regclass
      AND c.conname='accounting_cash_rake_sources_player_id_fkey' AND c.contype='f'
      AND c.confrelid='auth.users'::regclass AND c.convalidated
      AND NOT c.condeferrable AND NOT c.condeferred
      AND c.confdeltype='a' AND c.confupdtype='a' AND c.confmatchtype='s'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='player_id')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id')]::smallint[]
  ) THEN
    RAISE EXCEPTION 'CERTIFICATION_PLAYER_FK_CHANGED' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public.cleanup_reserved_certification_account(uuid)'))) IS DISTINCT FROM 'f29271b8f640a2d2a1f04e6f020e150c'
     OR md5(pg_get_functiondef(to_regprocedure('public.lock_club_cashier_hierarchy_mutation()'))) IS DISTINCT FROM '2bf2e0dc1876c5b1238603fc18558907' THEN
    RAISE EXCEPTION 'CERTIFICATION_CLEANUP_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
