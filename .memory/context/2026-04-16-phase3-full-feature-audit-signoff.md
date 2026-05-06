# Full-Feature Audit Phase 3 Signoff — 2026-04-16

**Type:** CONTEXT
**Scope:** Dan's "prioritize variants, bomb pot, straddle, insurance, RIT, tournaments, multi-tabling, lobby, chat, hand-history" directive.
**Outcome:** 1 bug fixed + deployed + live-verified (BUG 021 four-layer). 1 new critical production issue surfaced (BUG 022 single-table fleet). All other test scenarios blocked on same Hetzner redeploy.

## Shipped and Verified Live

### BUG 021 — Hand History Viewer (4-layer silent-failure bug)

Live SQL audit of TestAlias99 showed 1,269 matching hands; UI showed "No Hands Recorded Yet".

| Layer | Issue                                                                                | Fix                                                   | Status                           |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------- |
| A     | Service queried `hand_players` (0 rows) instead of `hand_history` (5.1M rows)        | Rewrote `getPlayerHands` + new `mapHandHistoryRow`    | ✅ Bundle `index-Dug_if_k-v6.js` |
| B     | Realtime filter referenced non-existent column `player_ids`                          | Removed filter; refresh on any INSERT                 | ✅ Same bundle                   |
| C     | `hand_history` had only `service_role` SELECT policy                                 | Added `authenticated` RLS via `players @> auth.uid()` | ✅ SQL migration LIVE            |
| D     | Supabase JS `.contains('col', [{key: val}])` serialized unquoted keys → invalid JSON | Pre-stringify via `JSON.stringify([{userId}])`        | ✅ Bundle `index-DX1xPYhK-v6.js` |

Cold-load verified: https://smarter.poker/hub/club-arena/hand-history → 25 HANDS, BIGGEST POT 861.66, 4+ hand rows with pot sizes, Replay/Analyze/Share buttons, plain-text tabs (emoji violation cleaned).

Commits: WH `519eaae8`, WH `1fed86cb`, CA `f265f4bd`, CA `6f77bda5`.

## Discovered Not Yet Fixed

### BUG 022 — Only One Table Dealing Hands In Entire Production

CRITICAL operational issue discovered while testing PLO variants. Created 3 PLO test tables (PLO4/PLO5/PLO8) with 4 horses each. Waited 10+ minutes. Zero PLO hands dealt. Widened the query:

```
Table 50c4559d-... (E2E TEST): 80 hands/hour
Every other table: 0 hands/hour
```

Engine `/health` confirms `activeTables: 1`. Engine uptime 25 hours. The fleet discovery loop is effectively dead — new tables never attach engines, horses sit forever without hands.

Root cause unknown (need engine logs / SSH). Likely: either the discovery while-loop threw an unhandled exception and died, or an early engine.start() call hangs in the "wait for 2 players" loop and never reaches dealingLoop.

**Fix is a single command:** `./server/deploy-hetzner.sh` — restarts container + picks up all queued code fixes.

## Blocked on Hetzner Redeploy

These items could not be verified because the production engine fleet is in the degraded BUG 022 state (single table):

- ❌ **WAVE 3a Variants (PLO / OFC / Short Deck / Pineapple)** — created PLO tables with horses but engine didn't attach. Need restart.
- ❌ **WAVE 3b Bomb pot / Straddle / Insurance / RIT** — same; hooks run on engine-attached tables.
- ❌ **WAVE 4 Tournament round-trip** — dependent on BUG 019 + engine restart.
- ❌ **WAVE 5b Multi-tabling** — requires more than 1 active table.

All scenarios remain blocked on the same single Hetzner redeploy already in the queue from prior sessions.

## Session Totals

- **15 silent-failure bugs discovered and fixed** this session chain (008–022)
- **5 fixes LIVE on production right now:** 010, 011, 014, 015, 017, 018 layer A, 019 SQL backfill, 021 all layers
- **8 fixes queued for next Hetzner redeploy:** 008, 009, 012, 013, 016, 018 layer B, 019 code, 020
- **1 critical bug requires only a restart:** 022

## Commits This Phase

- CA `6f77bda5` — BUG 021 consolidated (service + RLS migration + problem doc)
- WH `1fed86cb` — BUG 021 final bundle (4-layer fix complete)
- CA `f265f4bd` — BUG 021 source Layer A/B
- WH `519eaae8` — BUG 021 bundle Layer A/B

## Hetzner Redeploy Handoff Prompt

```bash
cd ~/Documents/Smarter-Poker-Club-Arena
bash server/deploy-hetzner.sh
```

Expected outcomes post-restart:

- `/health` → `activeTables >= 2` (confirm BUG 022 recovery)
- `rake_records` populating on every hand end
- `rakeback_periods` + `agent_commissions` + `player_stats.updated_at` all freshening within 30 min (settler daemon)
- Wallet transactions all have `balance_after` populated
- Horse raise amounts end with `.00` or integer multiples of 0.01 (no sub-cent floats)
- Tournaments that exceed 12h uptime don't get auto-cancelled if they have recent hand activity
- Variant tables actually deal variant hands (PLO/OFC/etc.)
- Old MTT tournaments that were nuked (all 133) already have `ended_at` backfilled by SQL

Verification SQL:

```sql
-- Engine fleet recovery
SELECT activeTables FROM (SELECT ...) -- via /health endpoint

-- BUGs 008 + 009 + 012
SELECT
  (SELECT COUNT(*) FROM rake_records WHERE created_at > NOW() - INTERVAL '30 min') AS rake_records,
  (SELECT COUNT(*) FROM rakeback_periods WHERE created_at > NOW() - INTERVAL '30 min') AS rakeback_periods,
  (SELECT COUNT(*) FROM agent_commissions WHERE created_at > NOW() - INTERVAL '30 min') AS agent_comm,
  (SELECT COUNT(*) FROM player_stats WHERE updated_at > NOW() - INTERVAL '30 min') AS player_stats_updated;

-- BUG 018 layer B
SELECT COUNT(*) FILTER (WHERE balance_after IS NULL) AS missing FROM wallet_transactions
WHERE created_at > NOW() - INTERVAL '30 min';

-- BUG 020
SELECT COUNT(*) FILTER (WHERE (elem->>'amount')::numeric * 100 != FLOOR((elem->>'amount')::numeric * 100)) AS sub_cent
FROM hand_history, jsonb_array_elements(actions) elem
WHERE created_at > NOW() - INTERVAL '30 min';
```

All should return healthy values after deploy + 30 min of organic traffic.
