# Problem 012 — player_stats Table Frozen 22 Days (Engine Never Writes It)

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (H-2 live verification)
**Date Fixed:** 2026-04-15 (same session, fix-first)
**Severity:** MEDIUM-HIGH (every analytics UI shows 22-day-old data; total_rake always $0)

## Discovery

Phase H signoff listed `player_stats` as the backing store for `PlayerStatsDashboard`, `AdvancedStatsSummary`, `AchievementTriggerService`, `LeaderboardService`, and admin analytics. H-2 live verification found:

| Check                                    | Live value                        |
| ---------------------------------------- | --------------------------------- |
| `player_stats` rows total                | 128                               |
| Rows with `updated_at > NOW() - 7 days`  | 0                                 |
| Rows with `updated_at > NOW() - 30 days` | 128 (all at same timestamp)       |
| Rows with `total_rake > 0`               | **0**                             |
| Max `updated_at`                         | 2026-03-24 20:18:03 (22 days ago) |
| Top user `hands_played`                  | 5,571                             |
| Top user `total_rake`                    | $0.00                             |

Every top-10 player had **identical** `updated_at` (2026-03-24 20:18:03.522016) — signature of a one-time bulk backfill. Since then: zero updates. But `hand_history` shows 22,566 hands in the last 7 days — the data is flowing, just not into player_stats.

Grep audit:

```
$ grep -rln "player_stats" server/
(zero matches)

$ grep -rln "player_stats" src/
src/components/profile/PlayerProfileCard.tsx
src/components/stats/AdvancedStatsSummary.tsx
src/lib/storage.ts
src/pages/AdminDashboardPage.tsx
src/pages/PlayerStatsPage.tsx
src/services/LeaderboardService.ts
src/services/AchievementTriggerService.ts
```

**7 client-side readers, 0 server-side writers.** After the Bible V8 server-authoritative migration, the client code that previously wrote to player_stats was removed but no server-side equivalent was ever written.

## Fix

Extended `RakebackSettlerService.runSettlement()` (2b section) to also upsert `player_stats` from the same `rake_records` data pass:

- Aggregate per (user_id, club_id) → `{ hands: count, rake: Σ equalShare }`
- For each bucket: if a player_stats row exists, UPDATE `hands_played += hands`, `total_rake += rake`, `updated_at = NOW()`. Otherwise INSERT a new row with zeros for VPIP/PFR/winnings/losses/tournaments (those need dedicated hand-event analysis that's out of scope for this settler).
- Idempotent in the sense that the settler resumes from `lastSettledAt` so no double-counting across ticks.

Settler now does FOUR things per 30-min tick, all from the same rake_records read:

1. Player rakeback periods (BUG 008)
2. Agent commissions (BUG 009)
3. Player stats freshness — hands_played + total_rake (BUG 012)
4. Itself the source truth is immutable rake_records (engine writes in BUG 008 fix)

## What's still out of scope

This fix only refreshes `hands_played` and `total_rake`. VPIP, PFR, total_winnings, total_losses still need:

- A dedicated hand-event analyzer that reads hand_history.winners / actions
- OR a server-side trigger that derives them from per-hand events

Those are phase H-3 work — deferred, not a silent-failure bug. Settler now makes `player_stats.updated_at` current + tracks hands + tracks rake, which unblocks the 7 client readers from showing completely stale data.

## Related

- BUG 008 — rakeback settler missing (same root cause: client-only code after V8 migration)
- BUG 009 — agent commission never credited (same pattern)
- DECISION D-001 — rake equal share (FIX 144)

## Lesson (fifth silent-failure bug in one session)

The pattern keeps repeating: Bible V8 server-authoritative migration moved the engine but left every side-effect write (rakeback, agent commission, player_stats) stranded in orphaned client services. `grep -rln "player_stats" server/` as a one-line smoke test would have caught this.

**Recommended future practice:** for every DB table that a UI reads, run `grep -rln "<table>" server/` — if zero hits but the UI displays the data as "fresh", that's a red flag for a stranded-writer bug.
