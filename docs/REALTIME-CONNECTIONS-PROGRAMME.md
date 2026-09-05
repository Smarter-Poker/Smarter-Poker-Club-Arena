# Real-Time Connections Programme

Dan, 2026-09-04, after a 22-hour "Reconnecting To The Table" outage that
every monitor slept through: "TAKE EVERYTHING YOU JUST SUGGESTED, AND CREATE
A COMPREHENSIVE BUILD PLAN AND BREAK IT DOWN INTO PHASES. DO ONE PHASE AT A
TIME ... ENSURE THAT EVERYTHING WAS PUBLISHED BEFORE CLAIMING SUCCESS."

A phase is done when its code is merged, published (engine deployed and/or
Club Arena `build-info.json` showing the sha), and verified on production by
reading, not assuming. The list below is the order; each phase records its
verification when it lands.

| Phase | Name                       | Delivers                                                                                                                                                             | Status |
| ----- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1     | Measure                    | `poker_act_to_broadcast_ms{audience}` and `poker_actions_fleet_total` on the always-on `/metrics`; `ActionLatencyDegraded` / `ActionLatencyCritical` alert rules     | done   |
| 2     | See the client             | `ws_client_events` beacon (code, reason, attempt, ms) from EngineStateClient; storage + `/ws-events` endpoint; "one player reconnecting > N/h" alert                 |        |
| 3     | Do no harm                 | Auto-reload failsafe skips auth closes; idempotency key on `/action` (client + handler)                                                                              |        |
| 4     | Restart handoff + protocol | `restart_in_ms` frame at :53 and a ladder that waits it out; `v` on subscribe and `4426 upgrade_required`                                                            |        |
| 5     | Trust and limits           | Server clock offset for turn timers; periodic re-auth of live sockets (5 min, cached); per-user socket cap with `4429`; explicit Caddy WS timeouts in the clocks law |        |
| 6     | Prove it from outside      | Synthetic table probe on Open Claw (real socket to a horse-only table, wait for SNAPSHOT, close); runbook `docs/runbooks/tables-say-reconnecting.md`                 |        |
| 7     | Guardrails                 | Vercel env-var change audit (names + updatedAt, never values); CLAUDE.md rules (agents never set credentials; never hand-write what a monitor reads); alert canary   |        |

Not in the programme, because they are Dan's decisions, recorded so they are
not lost: Log Out scope (global today; local by default with an explicit
"Sign Out Everywhere" is the usual shape); Supabase JWT expiry (7 days
today; 1 hour surfaces a revoked session within the hour); a second engine
upstream (the standby was collapsed on 2026-08-23 and there is no failover).

## Phase 1 - Measure (2026-09-04)

**Why first.** Every later phase changes how a table behaves under stress,
and until this phase nothing could say whether a change made the table
faster or slower. `actToBroadcastLatency` had been recorded per table for
months and scraped never: the registry it lives in is `ENGINE_METRICS`-gated
and the gate is off in production (checked on engine-01: zero lines on
`/metrics`). The gate is right - ~270 tables x 12 buckets per scrape - so the
fix is a low-cardinality twin, not opening the gate.

**What.** `server/src/observability/engineInstruments.ts` gains
`alwaysOnRegistry` with two instruments, both labelled only by
`audience=human|horse` (human when at least one human is seated at the
table): `poker_act_to_broadcast_ms` (histogram, default 1 ms to 5 s
buckets) and `poker_actions_fleet_total`. `ServerTableEngine` observes the
twin beside the gated one; `GameServer.getPrometheusMetrics()` renders the
registry on every scrape. Two alert rules read the **human** series only - a
fleet p95 would be a horse number, and horses do not complain about lag -
guarded by the maintenance break: p95 > 500 ms for 10 m warns, > 1.5 s for
5 m is critical.

**Law.** `server/src/observability/theTableFeelIsMeasured.law.test.ts`: the
registry renders both instruments with only the audience label, GameServer
renders it on the always-on path, the engine observes the twin, and both
rules read the human series and carry the break guard.

**Found on deploy.** The first engine (77a2443f, 21:55 UTC) rendered both
instruments with zero samples while 267 tables dealt: horse actions call
`handController.performAction` directly and bypass the method that starts
the act-to-broadcast clock, so only human HTTP actions had ever been timed -
and no human was seated. Fixed in the same phase: the horse path starts the
same clock and counts on the same instrument (CLAUDE.md 10.5), which also
makes the engine's own baseline latency visible whenever no human sits.

**Verification.** Recorded below when the second engine deploy lands.
