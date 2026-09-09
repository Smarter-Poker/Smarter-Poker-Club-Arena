-- 20260909171744_tournament_refund_club_foreign_keys_are_indexed.sql
-- Version reserved by scripts/new-migration.mjs after Supabase CLI creation.
-- Tournament refund foreign keys must not require full-table scans when a club is retired.
-- CI run 34381252398 named these three unindexed references to clubs.
-- Catalog review: entitlements was approximately 3,859 rows (under 2 MB),
-- tranches 48 kB and authorizations 32 kB. Keep locks and this single DDL
-- transaction bounded; no tournament, wallet, refund or policy value changes.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_tournament_refund_entitlements_refund_wallet_club_id_fk
  ON public.tournament_refund_entitlements (refund_wallet_club_id);
CREATE INDEX IF NOT EXISTS idx_tournament_refund_tranches_source_wallet_club_id_fk
  ON public.tournament_refund_tranches (source_wallet_club_id);
CREATE INDEX IF NOT EXISTS idx_tournament_refund_authorizations_source_wallet_club_id_fk
  ON public.tournament_refund_authorizations (source_wallet_club_id);

COMMIT;
