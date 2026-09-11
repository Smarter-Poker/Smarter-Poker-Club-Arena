# Problem 022 — Only One Table Dealing Hands In Entire Production

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-16 (Wave 3a variant audit, full-feature pass 2)
**Date Fixed:** Historical incident; root behavior is now pinned by `server/src/seatExitMoneyPaths.test.ts`
**Severity:** CRITICAL — entire fleet of tables is dead, single table handles all traffic

> Historical evidence only. The workstation env edit, direct SSH, hard reset,
> manual container restart, and one-table allow-list described in the original
> incident are retired. They are not recovery or deployment instructions.
> Current engine changes travel only through the Club Arena-owned exact-SHA
> `deploy-club-arena-engine` repository event and sealed Hetzner workflow.

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

## Root cause hypotheses at the time

1. **Discovery loop is dead.** An unhandled exception in the while loop would kill it. The loop has a `catch (err) { reportError(err) }` block inside the while body, so errors shouldn't kill it. But if the outer promise throws before entering the loop, discovery never runs.

2. **`engine.start()` silently hangs.** The `.start()` call has `while (this.running) { await loadSeatedPlayers; if >=2 break; sleep(5000) }`. If loadSeatedPlayers throws repeatedly the engine stays in the map forever without dealing. Next iteration sees `tableEngines.has(table.id)` → skip. Engine is "attached" but dead.

3. **Engine state divergence from source.** Engine uptime is 25 hours — deployed before many of this session's fixes. Possibly an old bug that got reintroduced in a prior deploy.

## Attempted workarounds

- Set `status='running'` on new PLO tables (engine discovery accepts either 'waiting' or 'running') → no effect
- Set `current_players` to match actual seated horses → no effect after 40s wait

Neither workaround helped. The engine's in-memory state (tableEngines Map) is out of sync with DB reality and the only way to recover is a process restart.

## Retired incident response

The original response restarted the process without removing the destructive
boot behavior. That was a band-aid. The durable contract now forbids
`cleanupStaleData()` from deleting `table_seats`; discovery reconstructs the
fleet from durable seats and the law test fails if the destructive path returns.

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

## Historical deploy queue

1. BUG 008 — RakebackSettlerService + engine writes rake_records durably
2. BUG 009 — Settler extension for agent_commissions via credit_agent_commission_from_rake
3. BUG 012 — Settler extension for player_stats.hands_played + total_rake refresh
4. BUG 013 — union_transactions writes redirected to union_wallet_transactions
5. BUG 016 — Dead club_wallets probe removed; atomic clubs.chip_pool credit
6. BUG 018 layer B — Server-side wallet_transactions INSERTs now include balance_after
7. BUG 019 — Stale-tournament cancel: 12h threshold + liveness check + ended_at set
8. BUG 020 — HorseLogic toCents() wraps every raise/bet amount
9. **BUG 022** — Engine fleet recovery (THIS BUG). This old restart-only claim
   is superseded by the durable seat-preservation fix.

## Related

- BUGs 008–021 — all prior session bugs, most in same Hetzner queue.

## Lesson

**Telemetry's `activeTables` metric is the single most important operational signal.** If it's not `>= 2` when the DB has multiple tables with seated players, the fleet is silently down. A trivial monitor check (`activeTables >= COUNT(tables WHERE status='running' AND has seats)`) would catch this in under 5 minutes of degradation. Without it, the platform burned 25 hours at 1/Nth capacity before anyone noticed.

---

## CONFIRMED ROOT CAUSE (2026-04-17 session, historical)

Hypothesis #1 / #2 above were wrong. The actual cause: **`cleanupStaleData()` at boot unconditionally resets `status='waiting'` and `current_players=0` for every cash table AND clears `table_seats` rows whose `table_id` is not on the protected-list.** The protected-list is populated from the `TEST_TABLE_ID` env var plus any live-tournament tables. With `TEST_TABLE_ID` unset, the new Wave 3a test tables (including `59938155-11ba-440f-9017-66019a2d697e`) had their seated horses wiped on every engine boot, leaving only the single legacy `50c4559d-...` table (which was kept alive because it happened to meet other retention criteria) as the lone active engine.

The temporary response used a one-table env allow-list and maintenance mode.
That workaround is retired and must not be restored.

After this: `activeTables` went to 1 on the intended test table (MAINTENANCE_MODE=true suppresses the horse-fleet churn so the live E2E run is deterministic), 8+ hands dealt at 78 hands/hr, 0 broadcast violations, $30.19 rake across $773.72 in pots.

## Follow-up action item

`cleanupStaleData()` is now pinned never to clear `table_seats`. The
`TEST_TABLE_ID` protected-list was a band-aid; the law test guards the durable
seat-preservation fix.

## Deploy path note (corrected 2026-04-17)

The LIVE path is `/opt/club-arena` with plain `docker run` — **not**
`/srv/club-arena-server`. That `/srv/...` path does not exist on the current VPS
(verified during BUG 025 redeploy: `ls -lad /srv/club-arena-server` returns
"No such file or directory"). The earlier claim above that both paths were in
play was wrong.

The canonical release path is `.github/workflows/auto-deploy-hetzner.yml`, fed
an exact full merged SHA by the reviewed Club Arena repository event. Runtime
env files are host-owned inputs to that workflow; a workstation never edits
them or issues direct SSH/container commands.
