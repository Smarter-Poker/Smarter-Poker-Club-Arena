-- RAKE-AUDIT 2026-07-24: Re-arm the Bad Beat Jackpot fee drop.
-- (Applied to the live PokerIQ-Production database on 2026-07-24 via MCP.)
--
-- FIX-A2 (2026-07-19) gated the BBJ fee on tables.bbj_percent > 0, but the
-- column defaulted to 0.00 on all 50,155 table rows, was never set by any
-- code path, and was not even selected by the engine's loadTable() query.
-- Net effect: ZERO BBJ collected platform-wide since 2026-07-19 16:29 UTC
-- (verified against hand_history.bbj_amount and bbj_contributions).
--
-- bbj_percent semantics after this migration: >0 = BBJ active (default 100),
-- explicit 0 = per-table opt-out. Tournament tables ignore the flag entirely
-- (server code guard, RAKE-AUDIT 2026-07-24) since tournaments never collect
-- the BBJ fee. This backfill is inert until the fixed engine deploys, because
-- the pre-fix engine build never reads the column.

ALTER TABLE tables ALTER COLUMN bbj_percent SET DEFAULT 100;

UPDATE tables SET bbj_percent = 100 WHERE coalesce(bbj_percent, 0) = 0;
