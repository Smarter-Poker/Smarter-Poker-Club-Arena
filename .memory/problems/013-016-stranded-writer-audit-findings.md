# Problems 013 / 014 / 015 / 016 — Stranded-Writer Audit (4 Tables)

**Type:** PROBLEM (compound)
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (systematic audit after BUGs 008-012)
**Date Fixed:** 2026-04-15 (same session, fix-first)
**Severity:** HIGH (every affected write path raised 42P01 on every call; features non-functional)

## Discovery methodology

After BUGs 008-012 exposed the "stranded writer" pattern (client writers removed during Bible V8 migration, server never took over), systematically grepped `server/src` for every `.from('<table>')` call and cross-checked against `pg_tables`. Found four tables the server writes to that don't exist:

```sql
SELECT target, EXISTS(...) AS exists FROM (VALUES
  ('union_transactions'),       -- NOT FOUND (BUG 013)
  ('bbj_payouts'),              -- NOT FOUND (BUG 014)
  ('bbj_payout_recipients'),    -- NOT FOUND (BUG 014)
  ('tournament_bounties'),      -- NOT FOUND (BUG 015)
  ('club_wallets'),             -- NOT FOUND (BUG 016)
  -- (seven additional tables all confirmed present)
) q(target);
```

## BUG 013 — `union_transactions` direct server writes

**Where:** `server/src/services/supabase.ts:508` (every cash-game hand rake to a unioned club) and `server/src/index.ts:2371` (every tournament payout to a unioned club).

**Impact:** Every union rake credit path attempted `.from('union_transactions').insert({...})`. The table doesn't exist; every call raised 42P01. `supabase-js` returned `{ error }` which was never checked at the call site → silent failure. Meanwhile the chip-balance update _before_ the failed audit insert DID succeed (it was a separate statement, not wrapped in a transaction). Result: union balances drifted from audit log forever.

**Note:** This is separate from BUG 011 (same table name, but BUG 011 was inside `fn_union_send_chips_to_club` RPC; BUG 013 is direct client-lib INSERT from the server).

**Fix:** both sites now INSERT into `union_wallet_transactions` (the actual audit table) with the correct shape: `{ union_id, club_id, wallet:'main', direction:'credit', amount, balance_after, tx_type:'rake', notes }`. Both read `union_wallets.chip_balance` first to populate `balance_after` for full audit trail. Applied in `server/src/services/supabase.ts` + `server/src/index.ts` commit.

## BUG 014 — `bbj_payouts` + `bbj_payout_recipients` tables missing

**Where:** `server/src/services/supabase.ts:892` (every BBJ jackpot hit inserts master row) and `:923` (every recipient breakdown).

**Impact:** BBJ jackpot hits are rare, but when they do fire (bad beat meeting the §6.3 thresholds), the server would deduct from `bbj_pools` successfully, credit players via `ServerTableEngine` stack ops, AND then silently error on the audit rows. The payout history UI (`BBJHistoryPage.tsx`) was always empty because the table it reads didn't exist. The `bbj_winners` table was written separately and held the winner/loser display rows, but the per-recipient breakdown was lost.

**Fix:** `supabase/migrations/20260415_bugs_014_015_missing_tables.sql` creates both tables with the exact shape the server code expects (FK to `bbj_pools`, nullable `hand_id`, full monetary breakdown columns). RLS enabled + public-read policy (writes use service role which bypasses RLS).

## BUG 015 — `tournament_bounties` table missing

**Where:** `server/src/index.ts:1987`, `:2050`, `:2083` — three bounty insertion paths (PKO, Mystery Bounty, Fixed KO).

**Impact:** Every tournament knockout in PKO / Mystery / Standard Bounty formats attempted to record the bounty event. All three failed silently. `AgentDashboardPage` and `PlayerStatsPage` both read `tournament_bounties` for bounty-earnings columns; both always showed zeros. The knocker's bounty wallet credit DID succeed via `creditBountyToWallet` (written before the failed INSERT), but the bounty event was never auditable.

**Fix:** same migration creates `tournament_bounties` with `tournament_id`, `eliminated_player_id`, `collector_player_id`, `bounty_amount`, `added_to_collector_bounty` (PKO-specific), `is_mystery_revealed` (Mystery-specific), and a unique constraint `(tournament_id, eliminated_player_id, collector_player_id)` to prevent duplicate-KO rows on race conditions.

## BUG 016 — `club_wallets` dead probe (non-fatal but wasted round-trips)

**Where:** `server/src/services/supabase.ts:523` (cash-game rake) and `server/src/index.ts:2392` (tournament rake).

**Impact:** Not a silent failure — the code has a graceful fallback to `clubs.chip_pool` when `cw` is null. But every probe was a wasted DB round trip that returned 42P01. Worse, the tournament path used read-then-write pattern on clubs.chip_pool instead of the atomic `increment_club_chip_pool` RPC — a race-condition hazard.

**Fix:** removed the dead probe in both sites; both now credit `clubs.chip_pool` atomically via `increment_club_chip_pool` RPC. The tournament path is now race-safe where it wasn't before (bonus fix).

## Status after all four fixes

| Fix     | Type   | Mechanism                                                  | Applied live   |
| ------- | ------ | ---------------------------------------------------------- | -------------- |
| BUG 013 | code   | both union_transactions writes → union_wallet_transactions | pending deploy |
| BUG 014 | schema | CREATE TABLE bbj_payouts + bbj_payout_recipients           | ✅ yes         |
| BUG 015 | schema | CREATE TABLE tournament_bounties + UK + RLS                | ✅ yes         |
| BUG 016 | code   | removed dead club_wallets probe, atomic clubs.chip_pool    | pending deploy |

## Related

- BUGs 008-012 — rakeback settler + agent commission + clawback stub + player_stats freshness (same session, same audit methodology)
- BUG 011 — `fn_union_send_chips_to_club` RPC targeted `union_transactions` (RPC-level variant of BUG 013)

## Lesson (final for this session)

Nine silent-failure bugs total across the session (008-016). All share one systemic cause: the Bible V8 server-authoritative migration inventoried "code + DB + UI exists" but never ran a "RPC actually completes + data flows end-to-end" check. The stranded-writer audit (`grep -rln "<table>" server/` + `SELECT tablename FROM pg_tables`) found every instance of the pattern in under 10 minutes once the methodology was right.

**Action item for future CI:** add a migration test that parses every `.from('<table>')` call in `server/src/**` and asserts the table exists in the canonical schema. That single check would have caught BUGs 013-016 before they ever shipped.
