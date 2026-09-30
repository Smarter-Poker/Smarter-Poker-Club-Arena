-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260814175455 "s12_rakeback_periods_readonly"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ca0548da804b20c934b4e494bce0c6f0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP POLICY IF EXISTS rakeback_periods_update_own ON public.rakeback_periods;

COMMENT ON TABLE public.rakeback_periods IS
  'AUDIT S12: read-only to authenticated (club-scoped SELECT via rakeback_read). The update_own policy was dropped - it let a player rewrite their own pending settlement row (widen the window, flip status, reassign club) and then trigger payment via fn_claim_rakeback, funnelling overlapping windows into a single inflated payout. All writes are server-owned (settle_club_rakeback / fn_close_settlement_period / fn_claim_rakeback, SECURITY DEFINER). Never add a client-writable policy back.';
