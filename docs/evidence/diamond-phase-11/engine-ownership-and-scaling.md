# Diamond Phase 11: one engine owner per table, safe release and recovery, and the scaling gate

Phase 11 lines 3 and 6 of [the Diamond build programme](../../POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md):

- line 3, "Verify one engine owner per table and safe release/recovery";
- line 6, "Verify actual scaling integration before enabling additional engine workers".

Verified on 2026-09-30 against engine source at `origin/main` 52addc2502 (branch
`agent/claude-diamond-phase-11/test/one-table-one-owner`). Nothing here generated load or wrote
anything on production: production was read passively (the engine `/health` JSON, cache-busted, and
read-only selects on the three ownership tables, the deploy-attempt log and the break log). Every
contention, crash, partition and release experiment ran on an isolated PostgreSQL 17 cluster on the
work SSD with locally built engine code. **No engine code changed**, and no worker was enabled.

## Verdicts

**Line 3: tick.** A table, chip or Diamond, cash or tournament, has at most one owning engine at a
time, and a release, a crash-restart or a network partition hands it to the next engine without a
second owner and without losing or doubling a hand. Diamond custody survives a crash and takeover to
the exact Diamond. Proven by the live database rules (each lease is one row, taken over only after 30
silent seconds, and every hand is committed only under the current lease generation), by 624 engine
tests and 387 release and lease law tests of the estate (all passing), and by two new proofs: two
locally built engine processes fought over a chip-and-Diamond fleet through five real failure shapes
with zero overlap in 9,016 hands, and a new CI case takes a Diamond table through a crash, a takeover,
a late delivery, a re-delivery and a release with 600 Diamonds in custody at every step. Today's live
state has one owner for every leased table and tournament. One finding is open for whoever can read
the engine host's logs (below): at the 11:55 UTC release today the outgoing engine did not hand its
cash-table leases back, so the new engine took them by the 30-second staleness rule instead. That
path is safe (it is the crash path the proofs cover), but it is not the clean hand-back the design
intends.

**Line 6: tick, with the answer "not integrated: keep additional engine workers off".** "Additional
engine workers" in this estate means more engine processes dealing tables: a second engine instance
(standby or active) or the worker-thread shards of `server/src/scale/`. The table and tournament
leases already partition a fleet safely between two engines (proven below), but nothing routes a player
to the engine that owns their table, the channel hub is in-process, and `server/src/scale/` is a
unit-tested foundation that the live engine does not load. The precise gate is written below and is now
enforced by a law test, so enabling a worker has to be a visible change made together with it.

## What decides who owns a table

| Layer                                       | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Where                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| One leader                                  | `engine_leader` is a single row (primary key `id`, `CHECK (id)`); `claim_engine_leadership` grants it only to its holder or after 30 s without a heartbeat. A fresh process boots as a **standby**, retries for 45 s, and a standby returns before discovery: it claims, cleans and deals nothing. A leader that finds itself replaced stands down and exits.                                                                                                                                                                                                                                                                                                                                                                                    | `server/src/services/leadership.ts`, `GameServer.start()`                                                        |
| One owner per cash table                    | `engine_table_leases` primary key `table_id`. `claim_table_lease_v2` locks the row, then upserts: granted only to the same instance and generation, or when the row is more than 30 s stale. `heartbeat_table_leases_v4` renews only the exact instance and generation; `release_table_leases_v2` deletes only the exact generation.                                                                                                                                                                                                                                                                                                                                                                                                             | live doors, md5s in [the manifest](../../../scripts/dev/two-engine-ownership/live-doors.manifest.json)           |
| One owner per tournament                    | the same shape on `engine_tournament_leases` (primary key `tournament_id`); a tournament's tables are dealt under its lease. Manager writes carry the lease generation in headers and the PostgREST pre-request hook refuses a stale one (`TOURNAMENT_MANAGER_FENCED`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `claim_tournament_lease_v2`, `heartbeat_tournament_leases_v4`, `smarter_private.fn_smarter_data_api_pre_request` |
| A dealer stops before anyone can take over  | every grant and renewal gives the engine a 20 s proof window measured from **before** the request; `ServerTableEngine` arms a timer and kills itself at that deadline. The database cannot hand the row to anyone until 30 s after the last heartbeat it recorded, so a dealer that cannot reach the database stops at least 10 s before a successor may start. Enforcement is unconditional (`LEASE_ENFORCED: true`).                                                                                                                                                                                                                                                                                                                           | `tableLease.ts`, `tournamentLease.ts`, `ServerTableEngineBase.armEngineLeaseExpiryTimer`                         |
| A hand commits only under the current owner | the service-role settlement doors (`fn_ca_commit_hand_settlement`, and `fn_ca_commit_hand_submission` which calls it) go through `fn_ca_commit_hand_settlement_exact_before_obligations`, which only the database owner can call directly, which refuses `hand_lease_lost` or `hand_lease_stale` unless the caller is the exact holder and generation of a fresh lease, and holds `FOR KEY SHARE` on the lease so a takeover waits for the settlement to finish. Diamond cash hands take this same door, and the engine refuses to submit one without a verified lease (`diamond_lease_required`, `server/src/domain/DiamondCashBoundary.ts`).                                                                                                   | live door md5 `c555fb7b83c889312995bc0038c1b275`                                                                 |
| Release                                     | the sealed release transaction (`server/scripts/engine-release-transaction.sh`) cuts over only inside the durable :55 break, with at least 285 s left (150 s candidate proof plus a 135 s rollback reserve), when the engine reports every table parked (`readyForRestart` and `unparkedTables == 0`, or only the bounded F06 preparation classes with `handsInFlightTotal == 0` and the database confirming no hand in the air). It refuses a second engine container on the host, stops the old one with `docker stop -t 45` (the engine drains, then releases tables, tournaments and leadership), and seals only when the new process is the one serving locally, publicly and as the database's elected leader with a heartbeat under 15 s. | release transaction, `MaintenanceBreak.ts`                                                                       |
| Restart resume                              | the boot cleanup resets cash table statuses but never touches `table_seats`; the database refuses to close an occupied cash table (`CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES`); tournament recovery owns no money and asks one database transaction for an immutable receipt; a hand delivered again after a crash gets its original receipt back instead of settling twice. F06 leases with pending custody are retained, not reaped.                                                                                                                                                                                                                                                                                                        | `GameServer.cleanupStaleData`, `tournamentRecovery.ts`, `reap_dead_engine_leases`                                |

## Evidence 1: production today (passive reads only)

Engine `/health` (cache-busted) at 11:25 UTC: instance `1-6f46b646`, release `f92ef579`, role
`leader`, holder itself, `lease.enforced: true`, `lease.conflictCount: 0`,
`tournamentLease.conflictCount: 0`, 452 active tables, 283 active tournaments, maintenance idle with
`unparkedTables: 0`. The ownership tables at the same moment:

| Scope       | Holder                                     | Rows | Fresh (heartbeat under 30 s)                                           |
| ----------- | ------------------------------------------ | ---- | ---------------------------------------------------------------------- |
| leader      | `1-6f46b646`                               | 1    | 1 (acquired 12 h 27 m earlier, at the 22:57 UTC release of `f92ef579`) |
| cash tables | `1-6f46b646`                               | 116  | 116                                                                    |
| tournaments | `1-6f46b646`                               | 282  | 282                                                                    |
| tournaments | `1-1bcee94e` (dead since 2026-09-26 01:58) | 9    | 0                                                                      |

One holder for every fresh lease; no cash-table lease on a tournament table; no table whose own lease
and whose tournament's lease name different engines (`split_scope_tables = 0`); 332 tournament tables
under the 282 fresh tournament leases, which with the 116 cash tables is 448 of the 452 the engine
reported a moment earlier. The nine
stale rows are nine COMPLETED tournaments from 2026-09-25 whose leases `reap_dead_engine_leases`
retains because F06 custody is still pending on them (the engine reports them as
`leaseCustodyRetained.tournaments: 9`); nobody deals them and anyone may take them over. The 17
Diamond cash tables hold no lease and deal nothing, as expected while `cash_games_enabled` is false.

The 25 hourly breaks from 2026-09-29 10:55 to 2026-09-30 10:55 UTC (`engine_maintenance_break_log`):
23 certified ready for restart, all 25 with `thaw_ok`, 357 to 658 tables resumed each time. Sealed
releases on 2026-09-29 (`ca_engine_deploy_attempts`): `3148d2d1` 05:58, `a0cf141c` 06:08, `0b9d311c`
06:57, `9bc55c70` 08:57, `d10ad3b3` 17:57, `22515434` 19:57 and `f92ef579` 22:57 UTC; five other
attempts stood down before cutover because main had moved on.

**A release observed live.** The 11:55 UTC break today shipped `71848aae` (sealed 11:57:41). Read at
12:00 and 12:02 UTC: the new instance `1-34605107` became leader at 11:56:18 and held 63 cash tables
(first claimed 11:56:55) and 401 tournaments, all fresh, with zero lease conflicts; 53 cash-table rows
were still in the outgoing instance's name with their last heartbeat at 11:55:21.95, and no row of it
was fresh. So there was never a second owner: the outgoing engine stopped renewing at 11:55:22 and the
new one claimed its first table 94 s later. But those 53 rows also show that the outgoing engine did
not release its cash-table leases on the way out (a clean stop deletes them), so the new engine could
only take tables through the 30-second staleness rule. See Finding 1.

## Evidence 2: the estate's own tests (all run, all passing)

Engine suite, from `server/` (`npx vitest run <52 files>`): **52 files, 624 tests passed**. The
lease clients and their laws (`tableLease`, `tournamentLease`, `leadership`, `leaseEnforcementGuard`,
`LeaseBoundaries`, `LeaseCompletionRevision`, `LeaseHeartbeatKeyShare.guard`,
`LeaseReleaseDiagnosticBuffer`, `TournamentLeaseGeneration.guard`,
`TournamentManagerRequestFence.guard`, `aLeaseIsNotLostBecauseNobodyAsked.law`,
`everyLeaseClaimLandsInAnOutcome.law`, `leaseHeartbeatFleet`,
`leaseRenewalCannotQueueBehindGameTraffic`, `ProducerShutdownOwnership`, `GuaranteedRestartLead`,
`fleetFloorSurvivesRestarts`); the dealer's own fence (`EngineLeaseBoundary.guard`,
`EngineLeaseProofDeadline`, `EngineTeardownOwnership`, `TableLeaseGenerationAndHandSettlement.guard`,
`DirectEngineRecovery.guard`, `APredecessorMayStillFinishItsEnvelope.law`); boot, standby and
restart (`standbyDoesNothing`, `bootClaimRetries`, `bootOrderDiscoveryFirst`,
`CashRestartKeepsItsPlayers`, `EntryStateSurvivesRestart`, `tournamentResumeBudget`,
`GameServerBoundedLeaseRenewal`, `GameServerLeaseRenewalSupervision`, `GameServerLeaseRenewalWedge`,
`GameServerRealtimeOwnership`, `GameServerTableEngineRegistry`, `aLostLeaseDoesNotRetryAQuarantinedStop`,
`aFinishedTournamentIsNotALostLease`, `F06LeaseReaperOwnership`, `TournamentEngineRecovery.guard`,
`ResumeCurrentStatus`, `RecoveryRequiresFullSettlement`, `ClusterWakeOwnership`); the break
certificate (`theCertificateOpensBeforeTheFleetIsSwept.law`, `everyRestartBlockerDeclaresItsBound.law`,
`aStoppedBankPastItsBoundIsNamedAndStillRefuses.law`); Diamond (`DiamondAcceptedHandPipeline`,
`ClosedDiamondCashAdmission`, `aDiamondTableKeepsItsBoundaryWhileItRuns`); and, for line 6,
`scale/CrossNodeBus`, `scale/ShardManager`, `scale/ShardWorkerRuntime`, `scale/TableRouter` and
`engine/equity/EquityWorkerPool`.

Release and lease laws, from the repository root (`npx vitest run <16 files>`): **16 files, 387 tests
passed**: `a-busy-manager-keeps-its-lease`, `a-lease-holder-does-not-starve-its-own-heartbeat`,
`the-lease-is-not-held-against-its-heartbeat`, `engine-release-seal`, `engine-release-break-recovery`,
`the-release-enters-the-break-with-time-to-finish`, `unit/engineReleaseMaintenanceCertificate`,
`unit/drainProtectsEveryHand`, `noServingReleaseBuysACustodyException`,
`a-preparation-that-can-never-resolve-is-not-a-hand`,
`a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut`,
`a-degraded-engine-can-still-be-replaced`, `the-break-clocks-agree`, `a-re-entered-release-refuses-by-name`,
`engine-recovery-healthcheck` and `unit/diamondAcceptanceCi`.

The Diamond SQL acceptance runner for accepted hands (`run-diamond-accepted-hand.py`, which CI runs on
PostgreSQL 17) already proved that a wrong lease generation and an expired lease cannot accept a
Diamond hand, and that two concurrent deliveries of one hand commit once and return a replay. Evidence
4 adds the handover to it.

## Evidence 3: two engine processes against one isolated database (new)

`scripts/dev/probe-two-engine-ownership-pg17.py` builds a fresh PostgreSQL 17.11 cluster in a
directory you name (Unix socket only, no TCP listener), loads the three ownership tables with their
live shape and the twelve live ownership doors exactly as production runs them, and checks both: every
door's `md5(pg_get_functiondef)` equals the value
[`capture-live-doors.py`](../../../scripts/dev/two-engine-ownership/capture-live-doors.py) read from
production at 11:34 UTC, and the tables' columns, constraints, indexes and F06 abort trigger equal the
live catalog. Only what the doors read but do not own is stood in for (the fleet's `tables` and
`tournaments` rows, the empty F06 abort registers, and a recorder in place of the unchanged settlement
core behind the exact-lease door); each stand-in says so in
[`isolated-schema.sql`](../../../scripts/dev/two-engine-ownership/isolated-schema.sql).

Each "engine" is a separate Node process running the **locally built engine's own** `leadership.js`,
`tableLease.js` and `tournamentLease.js` from `server/dist` (`tsc --project tsconfig.emit.json`, the
Dockerfile's build), driving a fleet the way `GameServer` does: boot as standby and retry for 45 s,
discovery and renewal every 5 s, authority ending at the proof deadline the engine code returned, on a
heartbeat loss or on a refused commit, one hand at a time per table through the exact-lease settlement
door, a park on SIGUSR1 (the break), and `GameServer.stop()`'s order on SIGTERM (stop dealing, release
tables, then tournaments, then leadership only if both releases were confirmed). Each engine reaches
the database through its own loopback PostgREST-shaped shim, so one engine's network can fail alone; a
"partitioned" shim holds every request and, on healing, delivers them all late, whether or not the
caller is still waiting. The engine refuses to start unless its database URL is that loopback shim.
The full engine cannot boot in isolation (it needs the whole Supabase schema, and there is no Docker on
this host for a local Supabase stack), so the dealer side of the rule is covered by the engine's own
tests in Evidence 2 and this probe covers the processes, the doors and their interleavings.

Fleet: 6 chip and 4 Diamond cash tables, 2 chip tournaments and 1 Diamond tournament of 2 tables each.
Run of 2026-09-30 11:47 to 11:52 UTC on the engine code of `52addc2502` (this branch changes nothing
under `server/`), Node 24.15.0; the full numbers are in
[`engine-ownership-probe-summary.json`](engine-ownership-probe-summary.json).

| Scenario               | What happened                                                                                                                | Measured                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 release cutover     | leader parks (0 hands in the air), SIGTERM, releases 10 tables, 3 tournaments and leadership; the replacement process boots  | replacement held the whole fleet 0.6 s later; every table's gap 107 to 110 ms, chip and Diamond alike                                                                                                                                                      |
| R2 crash restart       | SIGKILL mid-hand; the restarted process finds the dead instance's fresh leadership, retries, and is granted once it is stale | every table taken only after its lease was stale: gap 30.78 to 30.79 s                                                                                                                                                                                     |
| R3 partition           | a second container boots as standby while the leader deals; then the leader's database is cut off                            | the cut-off leader stopped dealing at its own proof deadline, **10.46 to 10.47 s before** the second container could take any table; the second container held the fleet 30.3 s after the cut                                                              |
| R3 late writes         | on healing, the cut-off leader's queued requests reach the database after the takeover                                       | all 50 refused: 32 hand commits `hand_lease_lost`, 10 table and 3 tournament claims refused, 2 heartbeats `taken`, 3 leadership claims refused; the old leader then saw it had lost leadership, stood down and came back as a standby that claimed nothing |
| R4 two leaders at once | leadership bypassed on both processes, both claim everything for 30 s, then one is killed                                    | the fleet split 2 and 11 with no subject held by both; the survivor adopted the dead one's tables after 25.1 s                                                                                                                                             |
| R5 busy settlement     | a Diamond table's lease goes stale while its settlement holds it; a successor claims                                         | the claim waited 5.0 s for the settlement, the settlement committed first, the successor was granted after it, and the old generation's next hand was refused `hand_lease_lost`                                                                            |

Across the run: 67 authority intervals over 13 tables and tournaments with **zero overlaps** between
processes; 54 handovers, each after the previous holder had stopped (smallest gap 100 ms, on clean
releases); the database let a live lease change hands 31 times and never before its holder had been
silent for 30 s (shortest 30.05 s); **9,016 hands committed (5,560 chip, 3,456 Diamond), every one by
the engine holding that table's lease generation at that instant**, no older generation ever committing
after a newer one, no hand number dealt twice, and no hand an engine saw accepted missing from the
database. `PASS` verdict lines, then `TWO-ENGINE OWNERSHIP PROBE PASSED`.

## Evidence 4: Diamond custody through a crash, a takeover and a release (new, runs in CI)

[`tests/sql/poker-diamond-accepted-hand-handover.sql`](../../../tests/sql/poker-diamond-accepted-hand-handover.sql)
now runs at the end of `run-diamond-accepted-hand.py`, the Diamond accepted-hand acceptance that CI
already runs on PostgreSQL 17 through `scripts/ci/run-diamond-sql-acceptance.py`. It loads production's
`claim_table_lease_v2` and `release_table_leases_v2` (md5 `2c6a2555d927c8dbbad47b8ac7b60552` and
`a08340dd1708cd37530e8b66e3c2a1d9`, asserted after loading) into the environment where the installed
Diamond accepted-hand door has just committed hand 1000002 for `fixture-engine`, then:

1. while the dealer heartbeats, a second engine's claim is refused;
2. the dealer crashes; after 30 silent seconds the successor is granted a new generation;
3. the crashed engine's late delivery of hand 1000003 is refused `hand_lease_lost`, and custody, seats,
   purchase lots and receipts are unchanged to the byte;
4. the successor re-delivers the committed hand 1000002 (its answer was lost in the crash): it answers
   _replay of the original receipt_, and nothing moves;
5. the successor deals hand 1000003: 600 Diamonds in custody, both seats exact (300 and 300), two hands
   committed once each;
6. a clean release deletes exactly its own generation, the table is claimable at once with no
   staleness wait, and the released generation's next hand is refused.

Result: `Diamond accepted-hand integration passed; public gameplay remains gated.` with every assertion
above printed as a `PASS` line (`python3 scripts/ci/run-diamond-sql-acceptance.py --only
run-diamond-accepted-hand.py`).

Tournament entries need no separate restart case, for three reasons that are each proven above: the
ownership doors write only the three lease tables (their md5-pinned bodies), so a handover cannot touch
an entry or a custody row; the restarted engine's boot touches no seat or entry (`CashRestartKeepsItsPlayers`
pins that tournament rows and `table_seats` are not written) and tournament recovery owns no money; and
a replaced manager's writes are refused by the pre-request fence (`TournamentManagerRequestFence.guard`)
exactly as R3's late writes were. Phase 9's funded rehearsal already proved every Diamond format
conserves and that a started event is resumed or settled, never voided.

## Evidence 5: why a release cannot produce a second owner or lose a hand

The release is the R1 shape with the certificate in front of it: the cutover is admitted only inside
the durable :55 break with at least 285 s left, when the engine reports every table parked and no hand
in flight (or only bounded F06 preparations and the database confirms no hand is in the air);
`docker stop -t 45` lets the engine drain, stop and release; a second `sp.role=engine` container on the
host refuses the release; and the seal requires the new process to be the elected leader. If the
outgoing engine is killed before it releases, the successor takes the R2 path: nothing is granted until
30 s of silence, and the outgoing dealers had stopped at least 10 s before that. Either way the database
fence refuses any write the old generation still sends (R3, R5, Evidence 4). The laws in Evidence 2 pin
every one of those gates in the script.

## Line 6: what "additional engine workers" means here, and whether the integration works

The programme's own boundary inventory names it: "Capacity: `server/src/services/tableLease.ts`;
`server/src/scale/`: verify actual live integration before claiming horizontal scaling", and "Reuse one
engine artifact. Worker placement may later be separated for capacity and failure isolation". So an
additional engine worker is **another process or thread that deals tables**. There are two candidates,
and two other kinds of worker that are not this:

| Candidate                                | What it is                                                                                                                                                      | State today                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second engine instance                 | another `club-arena-engine` process against the same database                                                                                                   | Supported only as a **standby** (`leadership.ts`): it claims, cleans and deals nothing until the leader's lease is stale, then restarts into a full leader. The standby was collapsed on 2026-08-23 ([Real-Time Connections Programme](../../REALTIME-CONNECTIONS-PROGRAMME.md): "there is no failover", recorded as Dan's decision). Active/active is explicitly unsupported (`leadership.ts`, "WHY NOT ACTIVE/ACTIVE"). |
| Worker-thread shards                     | `server/src/scale/`: `TableRouter` (rendezvous hashing), `ShardManager` (epochs, drain and handoff), `ShardWorkerRuntime`, `scaleWorkerHarness`, `CrossNodeBus` | A standalone foundation. Its own README says it is "not yet wired into the live GameServer / ServerTableEngine". Nothing outside `server/src/scale/` imports it. Its unit tests pass in isolation (4 files, part of Evidence 2).                                                                                                                                                                                          |
| The equity worker pool (not a dealer)    | `worker_threads` for live all-in equity and insurance pricing                                                                                                   | Live: 2 workers (`availableParallelism() - 2`, `EQUITY_WORKER_COUNT` overrides), phase `ready` in production. Fail-closed CPU offload inside the one engine; it owns no table.                                                                                                                                                                                                                                            |
| The horse decision worker (not a dealer) | one FIFO worker holding horse RNG and memory                                                                                                                    | One owner by design ("LIVE HORSE COMPUTE HAS ONE OWNER"); a standby never starts one.                                                                                                                                                                                                                                                                                                                                     |

What was verified in isolation:

- **Lease partitioning works.** Two engine processes that both act as leader split a fleet with no
  table ever held by both and no foreign hand committed (R4), and a standby takes over only when the
  leader's lease is stale or released (R1, R2, R3). So a second engine cannot double-deal a table.
- **Nothing routes a player to the owning engine.** `server/Caddyfile` sends `engine.smarter.poker` to
  one upstream, `localhost:8080`. An engine that does not own a table answers `POST /action` with
  `404 Table engine not found` (`server/src/handlers/action.ts`) and closes `/ws/table/:id` with 4404
  (`EngineWebSocketServer`, `CLOSE_TABLE_NOT_FOUND`) once its own claim is refused `owned_elsewhere`.
  That is the 2026-08-23 production state in which a second container held 14 of 44 tables no player
  could reach.
- **Lobby fan-out is per process.** `server/src/hub/ChannelHub.ts` is "in-memory pub/sub for the
  /ws/channel endpoint"; `CrossNodeBus` has only an in-memory transport. A lobby, presence or
  tournament event published on one engine reaches only sockets connected to that engine.
- **Nothing balances the split.** Every leader claims everything it discovers, so two active engines
  split the fleet by race (2 and 11 in R4), not by `TableRouter`.
- **The release handles one container.** The sealed release refuses any second `sp.role=engine`
  container, reads one `/health` for its certificate and proves one elected leader.

## The gate before any additional engine worker

None of these may be skipped. Items 1 to 5 are engineering with no decision in them; item 6 is Dan's:

1. **Owner-aware routing** for `/action`, the other table HTTP routes and `/ws/table/:id`: a gateway, or
   Caddy routing by table, that sends each request to the process holding that table's lease (or the
   worker `TableRouter` assigns it), including during a handover.
2. **Cross-instance channel fan-out**: a real `CrossNodeBus` transport and `ChannelHub` as its consumer,
   so a lobby, presence, tournament or financial event reaches every connected client wherever it
   connected.
3. **An assignment policy** wired into discovery (`TableRouter` weights, or an ownership store), so a
   worker claims only its share and a tournament's tables stay with the tournament's manager, plus a
   decision on where each leader-only job runs (cluster controller, tournament scheduling, horse fleet,
   boot cleanup, reaper), each of which must stay idempotent while a partitioned leader still believes
   it leads (it keeps its role until it can read the database, by design; see R3).
4. **Release, health and alerts for more than one process**: the sealed release must drain and certify
   every worker, `/health` and the alert rules must read the whole fleet, and a worker's shutdown must
   be proven to hand its leases back (see Finding 1).
5. For `server/src/scale/` specifically: a real `TableHost` adapter, the `TableStateHub` bridge to
   the thread that holds the sockets, lease claims made inside each worker, and drain and handoff tied
   to the release transaction (its README's "event log" resume does not exist; the engine resumes from
   database state and receipts).
6. Dan's decisions, below.

This gate is enforced by
[`tests/additional-engine-workers-wait-for-the-scaling-gate.law.test.ts`](../../../tests/additional-engine-workers-wait-for-the-scaling-gate.law.test.ts):
nothing outside `server/src/scale/` may import it, Caddy must have exactly one engine upstream, and the
sealed release must keep refusing a second engine container. Meeting the gate means changing that law
in the same pull request.

## Findings

**Finding 1 (open, for whoever can read the engine host's logs): the outgoing engine did not hand its
leases back at the 11:55 UTC release today.** Evidence 1 shows 53 cash-table lease rows still in the
name of `1-6f46b646` (`f92ef579`) with their last heartbeat at 11:55:21.95, after `71848aae` had taken
over. A clean `GameServer.stop()` deletes every lease it holds before it releases leadership, so it
either did not reach that step (a process owner that did not certify its shutdown makes it keep the
leases on purpose, `GameServer.shutdown_ownership_not_released`) or was stopped by Docker's 45-second
kill. Nothing unsafe happened: the database refused every takeover until the rows were 30 s silent,
every table was parked for the break, and the successor claimed its first table at 11:56:55, three
minutes before play resumed. But the release is designed to hand over cleanly, and a worker fleet (gate item 4) would need it to. The outgoing container's log, which `engine-up.sh` keeps on the host named by stop
time and image, says which it was. The 53 dead rows are removed by the hourly reaper once they are an
hour old; no one needs to touch them.

**No defect was found in the ownership machinery itself**, so no fix was shipped. The one new code in
this change is test code: the probe, the Diamond handover case and the gate law.

## Questions for Dan

1. **A standby again?** The leader/standby machinery works in isolation (R2 and R3: the standby takes
   over only after the leader's lease is stale, and a cut-off leader stops dealing 10 s before that).
   Running a warm standby would cut a crash's outage from "container restart plus 30 s" to about 30 s.
   It was collapsed on 2026-08-23 by your decision. Keep it collapsed?
2. **Horizontal scaling, if ever needed**: one box with worker threads or several boxes, and Redis or
   NATS for the bus (the choices `server/src/scale/README.md` lists as yours). Nothing needs this
   today: production runs 450 to 650 tables on one engine with the equity pool at 2 workers.

## Re-run

```
# the two-engine probe (about 5 minutes; needs PostgreSQL 17 and the built engine)
(cd server && npx tsc --project tsconfig.emit.json)
python3 scripts/dev/probe-two-engine-ownership-pg17.py --work-dir <an empty directory>

# the Diamond handover case, inside the accepted-hand acceptance
python3 scripts/ci/run-diamond-sql-acceptance.py --only run-diamond-accepted-hand.py

# re-capture the live doors (read-only, from a clone linked to production)
python3 scripts/dev/two-engine-ownership/capture-live-doors.py --linked-dir <linked clone>

# the estate's tests named in Evidence 2, and the gate law
(cd server && npx vitest run <the 52 files>)
npx vitest run <the 16 files> tests/additional-engine-workers-wait-for-the-scaling-gate.law.test.ts
```
