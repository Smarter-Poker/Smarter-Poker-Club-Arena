-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417145259 "phase14_revert_money_ledger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8b481fe93efcbdd0427fcc4808ec3787 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 14 REVERT — platform is not a financial-transactions service
-- ══════════════════════════════════════════════════════════════════════
--
--  Phase 14 introduced a money ledger (buyins / cashouts / settlements
--  / payment handles) for home games. Product decision: the platform
--  cannot and will not be involved in any money flow. Home games are
--  strictly an advertising + communication + seating tool.
--
--  This migration drops everything Phase 14 added. All tables had zero
--  production rows at the time of drop — only test data that was
--  cleaned up inline during smoke tests. No data loss.
-- ══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS fn_home_mark_settlement_paid(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS fn_home_compute_settlements(uuid, uuid);
DROP FUNCTION IF EXISTS fn_home_game_totals(uuid);
DROP FUNCTION IF EXISTS fn_home_record_cashout(uuid, uuid, uuid, integer, integer, text);
DROP FUNCTION IF EXISTS fn_home_record_buyin(uuid, uuid, uuid, text, integer, integer, text);
DROP FUNCTION IF EXISTS fn_home_caller_is_game_staff(uuid, uuid);

DROP TABLE IF EXISTS commander_home_group_payment_links CASCADE;
DROP TABLE IF EXISTS commander_home_settlements         CASCADE;
DROP TABLE IF EXISTS commander_home_cashouts            CASCADE;
DROP TABLE IF EXISTS commander_home_buyins              CASCADE;
