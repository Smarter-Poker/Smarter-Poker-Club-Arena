-- Cashier conservation reads only the requested club journal.
-- Version reserved by scripts/new-migration.mjs.
-- The global created_at player-wallet cover scans every club then filters.
-- A qualified one-pass report still exceeded the authenticated 8s read limit
-- on production. Key the same covering legs by club and time, retaining all
-- booked statuses and both wallet sides. No report body or financial data changes.
-- Build concurrently through apply-recorded-migration.mjs's sanctioned preamble
-- so the hot journal remains writable. All remaining DDL is one transaction.
-- @live-proof: EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_chip_ledger_club_player_legs_cover') AND indisvalid AND indisready AND indislive)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_club_player_legs_cover
  ON public.chip_ledger (club_id, created_at)
  INCLUDE (to_type, from_type, to_entity_id, from_entity_id, amount)
  WHERE club_id IS NOT NULL
    AND (to_type='player_wallet' OR from_type='player_wallet');
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $qualified_index$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid=to_regclass('public.idx_chip_ledger_club_player_legs_cover')
      AND i.indrelid='public.chip_ledger'::regclass
      AND i.indisvalid AND i.indisready AND i.indislive
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE INDEX idx_chip_ledger_club_player_legs_cover ON public.chip_ledger USING btree (club_id, created_at) INCLUDE (to_type, from_type, to_entity_id, from_entity_id, amount) WHERE ((club_id IS NOT NULL) AND ((to_type = ''player_wallet''::text) OR (from_type = ''player_wallet''::text)))'
  ) THEN
    RAISE EXCEPTION 'Cashier Club Journal Cover Missing, Invalid Or Changed'
      USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_cashier_conservation_report(uuid)')))
      IS DISTINCT FROM '68e55e37885c51afd37d532753cb5ba1' THEN
    RAISE EXCEPTION 'Cashier One-Pass Report Definition Changed' USING ERRCODE='55000';
  END IF;
END;
$qualified_index$;
COMMENT ON INDEX public.idx_chip_ledger_club_player_legs_cover IS
  'Bounds the on-demand cashier baseline comparison by club and time while covering both booked player-wallet sides.';
COMMIT;
