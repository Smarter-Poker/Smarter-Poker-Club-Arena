# Problem 022 — Only One Table Dealing Hands In Entire Production

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-16 (Wave 3a variant audit, full-feature pass 2)
**Date Fixed:** UNFIXED — requires Hetzner redeploy + engine investigation
**Severity:** CRITICAL — entire fleet of tables is dead, single table handles all traffic

## Discovery

Trying to verify PLO support by creating 3 test tables (PLO4, PLO5, PLO8) with 4 horses seated at each. Waited 10+ minutes. Zero hands dealt at any PLO table. Widened the query:

```sql
SELECT table_id, COUNT(*) AS hands_last_hour
FROM hand_history
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY table_id;
-- Result: ONE row. table_id = 50c4559d-... E2E TEST TABLE. 80 hands.
```

Engine `/health` endpoint confirms:

```json
{ "activeTables": 1, "totalHandsDealt": 2015, "telemetry": { "tablesWithMetrics": 1 } }
```

Every other cash table (PLO audit tables + any existing ones with seated horses) is dead. No engine attached. No hands dealing.

## Evidence

- Engine uptime: 89,620 seconds (~25 hours) without a restart
- `activeTables: 1` in engine telemetry (tableEngines Map size)
- DB has 3 other tables with 4 horses each, 0 hands ever
- Horses correctly seated via HorseFleetManager (can see them in `table_seats.left_at IS NULL`)
- Discovery loop is 5s interval with tables.status IN ('waiting', 'running') + 2+ seat check (`discoverCashTables`, server/src/index.ts:544)

## Root cause hypotheses (un-verified, need engine logs / SSH access)

1. **Discovery loop is dead.** An unhandled exception in the while loop would kill it. The loop has a `catch (err) { reportError(err) }` block inside the while body, so errors shouldn't kill it. But if the outer promise throws before entering the loop, discovery never runs.

2. **`engine.start()` silently hangs.** The `.start()` call has `while (this.running) { await loadSeatedPlayers; if >=2 break; sleep(5000) }`. If loadSeatedPlayers throws repeatedly the engine stays in the map forever without dealing. Next iteration sees `tableEngines.has(table.id)` → skip. Engine is "attached" but dead.

3. **Engine state divergence from source.** Engine uptime is 25 hours — deployed before many of this session's fixes. Possibly an old bug that got reintroduced in a prior deploy.

## Attempted workarounds

- Set `status='running'` on new PLO tables (engine discovery accepts either 'waiting' or 'running') → no effect
- Set `current_players` to match actual seated horses → no effect after 40s wait

Neither workaround helped. The engine's in-memory state (tableEngines Map) is out of sync with DB reality and the only way to recover is a process restart.

## Fix

Single action: **restart the Hetzner container**. Either:

- `./server/deploy-hetzner.sh` (preferred — also picks up BUGs 008/009/012/013/016/017/018/019/020 queued code)
- OR `docker restart club-arena-engine` (faster if no deploy is needed, but leaves queued bug fixes un-activated)

After restart, engine will:

1. Run stale-data cleanup (reset all cash tables to status='waiting' + current_players=0) — this was failing silently
2. HorseFleetManager creates/reactivates configured tables and seats horses
3. discoverCashTables loop picks up all tables with 2+ seats and spawns engines
4. Multiple tables start dealing simultaneously

## Verification plan

Post-restart `/health` endpoint should report:

```json
{"activeTables": >= 2, "totalHandsDealt": <growing>, "telemetry":{"tablesWithMetrics": >= 2}}
```

And `hand_history.table_id` should show ≥ 2 distinct table_ids dealing hands within 5 minutes.

## Impact

Single table dealing all traffic means:

- 80 hands/hour platform-wide (vs capacity for hundreds per hour)
- 3 clubs + 1 union share one table — all agent / league / tournament activity funneled through it
- New tables (variants, higher stakes, private) cannot be exercised
- The recent BUG 019 tournament-cancel-sweep fix + BUG 018 balance_after + BUG 020 chip precision all need Hetzner redeploy anyway to land

## Deploy queue (consolidated — all activate on next `./server/deploy-hetzner.sh`)

1. BUG 008 — RakebackSettlerService + engine writes rake_records durably
2. BUG 009 — Settler extension for agent_commissions via credit_agent_commission_from_rake
3. BUG 012 — Settler extension for player_stats.hands_played + total_rake refresh
4. BUG 013 — union_transactions writes redirected to union_wallet_transactions
5. BUG 016 — Dead club_wallets probe removed; atomic clubs.chip_pool credit
6. BUG 018 layer B — Server-side wallet_transactions INSERTs now include balance_after
7. BUG 019 — Stale-tournament cancel: 12h threshold + liveness check + ended_at set
8. BUG 020 — HorseLogic toCents() wraps every raise/bet amount
9. **BUG 022** — Engine fleet recovery (THIS BUG). Restart alone fixes it; no new code.

Run:

```bash
cd ~/Documents/Smarter-Poker-Club-Arena
bash server/deploy-hetzner.sh
```

## Related

- BUGs 008–021 — all prior session bugs, most in same Hetzner queue.

## Lesson

**Telemetry's `activeTables` metric is the single most important operational signal.** If it's not `>= 2` when the DB has multiple tables with seated players, the fleet is silently down. A trivial monitor check (`activeTables >= COUNT(tables WHERE status='running' AND has seats)`) would catch this in under 5 minutes of degradation. Without it, the platform burned 25 hours at 1/Nth capacity before anyone noticed.

---

## CONFIRMED ROOT CAUSE (2026-04-17 session)

Hypothesis #1 / #2 above were wrong. The actual cause: **`cleanupStaleData()` at boot unconditionally resets `status='waiting'` and `current_players=0` for every cash table AND clears `table_seats` rows whose `table_id` is not on the protected-list.** The protected-list is populated from the `TEST_TABLE_ID` env var plus any live-tournament tables. With `TEST_TABLE_ID` unset, the new Wave 3a test tables (including `59938155-11ba-440f-9017-66019a2d697e`) had their seated horses wiped on every engine boot, leaving only the single legacy `50c4559d-...` table (which was kept alive because it happened to meet other retention criteria) as the lone active engine.

The fix that worked:

```bash
# On the Hetzner VPS, /srv/club-arena-server/.env
TEST_TABLE_ID=59938155-11ba-440f-9017-66019a2d697e
MAINTENANCE_MODE=true

# Then:
docker compose build engine && docker compose up -d engine
```

After this: `activeTables` went to 1 on the intended test table (MAINTENANCE_MODE=true suppresses the horse-fleet churn so the live E2E run is deterministic), 8+ hands dealt at 78 hands/hr, 0 broadcast violations, $30.19 rake across $773.72 in pots.

## Follow-up action item

**Make `cleanupStaleData()` idempotent and safe for tables with existing seats.** It should never clear `table_seats` rows — only reset `tables.status`/`current_players` if the engine map doesn't have a running engine for that table. The TEST_TABLE_ID protected-list is a band-aid; the real fix is to never wipe player seats on boot. Filed as BUG 026 (pending).

## Deploy path note (corrected 2026-04-17)

The LIVE path is `/opt/club-arena` with plain `docker run` — **not**
`/srv/club-arena-server`. That `/srv/...` path does not exist on the current VPS
(verified during BUG 025 redeploy: `ls -lad /srv/club-arena-server` returns
"No such file or directory"). The earlier claim above that both paths were in
play was wrong.

Canonical redeploy for any future server-side change:

```
ssh root@178.156.160.206 'cd /opt/club-arena && git fetch origin main && git reset --hard origin/main'
# then run whatever build/restart step the repo's server/deploy-hetzner.sh defines
```

Verify layout before editing env files:

```
ssh root@178.156.160.206 'docker inspect club-arena-engine --format "{{.Config.WorkingDir}} {{.HostConfig.Binds}}"'
```

`/opt/club-arena/.env` holds `TEST_TABLE_ID` and `MAINTENANCE_MODE`, both
load-bearing for the live E2E test table. Never touch them on a routine deploy.
