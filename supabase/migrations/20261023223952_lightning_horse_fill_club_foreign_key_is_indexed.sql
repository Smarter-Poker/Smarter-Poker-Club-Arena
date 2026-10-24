-- Version reserved by scripts/new-migration.mjs against main and remote branches.
--
-- Post-deploy run 40033127204 stopped before opening browser fixtures because
-- lightning_horse_fill.club_id has no full leading-column index. The installed
-- table has 100 rows, a horse_id primary key and a cluster_id index. Its table
-- creation belongs to PR #7846; this independent repair changes no horse,
-- game, player, wallet, privilege or business setting.
--
-- The existing club-deletion precheck is the regression protection. Follow the
-- previously qualified notice-board FK-index repair: a bounded transaction,
-- exact FK pre-image and valid non-partial index post-image. An equivalent
-- index installed meanwhile is retained without creating a duplicate.
--
-- @live-proof: (SELECT jsonb_array_length(public.fn_ca_fk_index_gaps('public.clubs')->'gaps')) = 0

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $repair$
DECLARE
  child regclass := to_regclass('public.lightning_horse_fill');
  column_number smallint;
BEGIN
  SELECT attnum INTO column_number FROM pg_attribute
  WHERE attrelid = child AND attname = 'club_id' AND NOT attisdropped;
  IF child IS NULL OR column_number IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute parent_column ON parent_column.attrelid = c.confrelid
      AND parent_column.attnum = c.confkey[1]
    WHERE c.conname = 'lightning_horse_fill_club_id_fkey' AND c.contype = 'f'
      AND c.conrelid = child AND c.confrelid = 'public.clubs'::regclass
      AND cardinality(c.conkey) = 1 AND cardinality(c.confkey) = 1
      AND c.conkey[1] = column_number AND parent_column.attname = 'id'
  ) THEN
    RAISE EXCEPTION 'LIGHTNING_FILL_CLUB_INDEX: expected club_id foreign key is missing or changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i WHERE i.indrelid = child
      AND i.indisvalid AND i.indisready AND i.indpred IS NULL
      AND i.indkey[0] = column_number
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_lightning_horse_fill_club_id_fk
      ON public.lightning_horse_fill (club_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i WHERE i.indrelid = child
      AND i.indisvalid AND i.indisready AND i.indpred IS NULL
      AND i.indkey[0] = column_number
  ) THEN
    RAISE EXCEPTION 'LIGHTNING_FILL_CLUB_INDEX: valid full club_id index was not established';
  END IF;
  IF jsonb_array_length(public.fn_ca_fk_index_gaps('public.clubs')->'gaps') <> 0 THEN
    RAISE EXCEPTION 'LIGHTNING_FILL_CLUB_INDEX: club foreign key index gaps remain';
  END IF;
END;
$repair$;
COMMIT;
