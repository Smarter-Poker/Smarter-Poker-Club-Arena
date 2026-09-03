# Problem 008 — Rakeback Settler Missing (Per-Player Rake Never Persisted)

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (live verification harness Phase D-2)
**Date Fixed:** 2026-04-15 (same session — fix-first protocol)
**Severity:** HIGH (financial accounting — players never saw accumulated rakeback)

## Discovery

Phase D-2 #1 live SQL verification (per-hand equal-share rake) found:

| Table                                        | Rows in last 7 days | Total tracked |
| -------------------------------------------- | ------------------- | ------------- |
| `rake_history` (table-level)                 | 6,869               | $30,136.94    |
| `rake_records` (per-player JSONB)            | 0 (table empty)     | —             |
| `rakeback_periods` (per-player accumulator)  | 0                   | —             |
| `rakeback_distributions` (per-player payout) | 0                   | —             |

Engine was actively recording rake at the table level (most recent insert: 30 seconds before the audit) but the per-player split was never being persisted anywhere durable.

## Root cause

Two coupled bugs:

1. **`RakebackEngine.recordHandRake` (in-memory) was correct** — it computes equal-share split and updates the in-memory `playerRecords` map.
2. **`RakebackEngine.settleRakeback` had ZERO callers** — `grep -rn "settleRakeback"` returned only the definition and the equivalent client-side legacy file. The in-memory accumulator never flushed to `rakeback_periods`.
3. **`rake_records` table was never written to by the engine** — only `rake_history` (table-level totals). So even if a settler existed externally, it had no per-hand player data to derive equal-share splits from.

Combined effect: rake was being collected (and credited to club / union wallets correctly), but per-player rakeback credits existed only in volatile engine RAM. Every engine restart wiped them.

## Fix

Two-part durability fix shipped as a single commit:

### Part A — Engine writes `rake_records` durably at end-of-hand

`server/src/engine/ServerTableEngine.ts` (Step 6 / FIX 144 block) now also INSERTs into `rake_records` with `player_contributions` serialized as JSONB:

```ts
await supabase.from('rake_records').insert({
  table_id: this.tableId,
  club_id: this.tableInfo.club_id,
  rake_amount: this.currentHandRake,
  bbj_contribution: this.currentHandBBJFee,
  pot_size: this.currentHandPotSize,
  num_players: dealtInCount,
  player_contributions: contribsObj,
  is_tournament: false,
  tournament_id: this.tableInfo.tournament_id || null,
  source: 'ServerTableEngine.handEnd',
  metadata: { handCount: this.handCount },
});
```

Wrapped in try/catch so DB failure is non-fatal to the engine — engine keeps running, settler will reprocess on next interval if needed.

### Part B — `RakebackSettlerService` daemon

New file `server/src/services/RakebackSettlerService.ts` runs every 30 minutes:

1. Reads `rake_records` since last run with `player_contributions IS NOT NULL`.
2. For each row, derives equal-share credit (`rake_amount / dealtInCount`) per dealt-in player.
3. Aggregates into per-(user, club, week) buckets.
4. Upserts `rakeback_periods` rows. Idempotent: re-runs over already-settled hands have no effect.

Wired into `server/src/index.ts` startup (Step 5b) and shutdown.

## DECISION D-001 / FIX 144 — STILL HOLDS

Equal-share method is preserved end-to-end:

- Engine: `equalShare = totalRake / playerCount` per dealt-in player
- Durable write: `player_contributions` JSONB captures per-player contribution (used only to identify dealt-in players, not to weight)
- Settler: re-derives `equalShare = rake_amount / dealtInCount` from the JSONB

Rakeback is **never weighted by pot contribution.** All three computation sites use the same equal-share formula.

## Tier table (settler)

```
Bronze:    0+ rake → 5%
Silver:    100+ rake → 10%
Gold:      500+ rake → 15%
Platinum:  2,000+ rake → 20%
Diamond:   10,000+ rake → 30%
```

Matches `RakebackEngine.DEFAULT_RAKEBACK_TIERS` exactly.

## Verification queued

Once next engine restart picks up the new build:

1. Wait 30 min for first settler tick (or run manually).
2. Re-run `scripts/verification-harness/02-equal-share-rake.sql` — should now show populated `rake_records` and `rakeback_periods` rows.
3. Open `RakebackPage.tsx` as a player — should see accumulated rakeback.
4. Validate idempotency: trigger settler twice; same `rakeback_periods` rows, no double-counting.

## Related

- DECISION D-001 — Rake equal share (FIX 144)
- Phase D signoff — `.memory/context/2026-04-15-phase-D-signoff.md` (this bug existed at signoff time but wasn't visible without live verification)
- Verification harness — `scripts/verification-harness/02-equal-share-rake.sql`

## Lesson

The signoff inventory checked code/DB/UI presence (which showed every component was wired), but the engine code path silently never connected to the persistence layer. **Live verification harnesses are essential** — code coverage isn't behavior coverage. The harness caught a real financial bug within minutes of running.
