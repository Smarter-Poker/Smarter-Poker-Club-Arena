# Diamond Phase 11 line 5: the measured operating envelope

**Line:** "Measure lobby fan-out, action latency, event-loop load, database locks and reconnect storms."
The phase exit asks for "reproducible evidence, measured operating envelope and no unresolved critical
build defects".

**Verdict: tick.** All five were measured - production passively over 81 minutes that
included the busy :35 to :53 UTC stretch and an hourly engine restart, and everything that needed load
on isolated copies of the engine's real transport and the live Diamond database doors. The envelope is
the table below. Measuring found four defects and all four are fixed in the pull request that carries
this file: a lobby join that answered every subscriber (a reconnect storm cost N(N+1)/2 messages), a
Diamond top-up that locked the wallet before the table (it deadlocked against the settlement of the hand
it followed), an engine that let a top-up race that settlement, and an engine deadlock counter that read
every engine restart as thousands of deadlocks (on its own it set off the critical deadlock alert twice
in the last day). What the envelope shows as the first
limit is not a Diamond path: it is the main realtime loop, which in production today, with no human
seated, already reads above the 40 ms line its own alert draws in 26% of its 20-second samples (61 of 238).

## How it was measured

- **Production, read only.** No load, no connection as a player, no write. The engine's public
  `/health` JSON every 20 s and `/ws-metrics` every 60 s, cache-busted, from 11:19 to
  12:40 UTC; Prometheus through the estate's own monitoring reader (the SSH path
  `scripts/ci/check-alert-rules-match.mjs` uses, instant queries over 1 h, 24 h and 7 d);
  `pg_stat_activity` and `pg_locks` every minute and `pg_stat_statements` every ten, with
  `supabase db query --linked` selects. The one production write in this work is the migration below,
  rehearsed first.
- **Isolation, on the Mac Studio** (Mac15,14, Apple M3 Ultra, 28 cores (20 performance, 8 efficiency),
  96 GiB, macOS 26.5.2). The machine was shared with five other agents; the load average at the start
  of every run is recorded beside it, and runs of the same code are repeated where the noise matters.
  - **Transport:** `server/scripts/measure-realtime-envelope.ts` runs the engine's real
    `EngineWebSocketServer` + `TableStateHub` (`/ws/table/:id`) and `ChannelWebSocketServer` +
    `ChannelHub` (`/ws/channel`) in one Node 22.23.3 process (production runs Node 22) bound to
    127.0.0.1, with synthetic clients in four separate processes that reconnect on the client's own
    ladder (1 s doubling to 30 s, plus up to 30% jitter). The channel server's session check goes to a
    stub GoTrue the script starts on loopback, and every outbound socket from the server process is
    refused unless it is loopback. The event loop is read the way the engine reads it
    (`EquityLoadGovernor`: a 20 ms `monitorEventLoopDelay` histogram and a 1 s timer's lateness, the
    worse of the two), so an idle loop reads about 20 ms here exactly as it does in production, and the
    estate's 40 ms and 300 ms thresholds apply unchanged.
  - **Database:** `scripts/qualification/diamond-lock-waits.py` builds its own PostgreSQL 17.11 cluster
    on the external SSD (socket only, no TCP listener, fsync and synchronous commit on), loads the
    estate's isolated accepted-hand fixture exactly as `tests/sql/run-diamond-accepted-hand.py` does,
    lays the **live** Diamond doors over it (`diamond-lock-waits-live-doors.sql`, captured read-only
    from production; the run refuses to measure unless every door's `md5(pg_get_functiondef)` equals
    production's), seats players at 64 or 96 tables through the live reserve door, and drives
    concurrent hands and top-ups with pgbench. Every wait of 10 ms or more is taken from
    `log_lock_waits` with the door and line that waited.

## The operating envelope

"Headroom" is measured against the threshold the estate already alerts on. "First to break" is the
first thing the numbers say gives way as load grows.

|                                                    | Production today (read passively)                                                                                                                                                                                                                                                                                            | Isolation (measured)                                                                                                                                                                                                                                         | Threshold the estate alerts on                                                                                                            | Headroom                                                                                                                                                                        | First to break                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lobby fan-out**                                  | Nothing to fan out: at most 2 lobby subscribers and 3 channel sockets in 77 `/ws-metrics` samples; no human seated.                                                                                                                                                                                                          | One maintenance notice to 2,000 subscribers: 24.1 ms of main-loop time, every client has it in 26.2 ms (p50; max 34.9). 1,000: 16.5 ms; 250: 1.5 ms. About 6 to 16 microseconds per subscriber.                                                              | None on fan-out itself; the main-loop rules below.                                                                                        | A broadcast is one block of the loop, a few times an hour (the break notices).                                                                                                  | Until this pull request, the join storm: 2,000 clients cost 2,001,000 frames. After it, a single broadcast blocks the loop for longer than the 40 ms line somewhere past 3,000 subscribers. |
| **Action latency** (accepted action to every seat) | Accepted to broadcast start: p50 0.50, p95 0.95, p99 0.99 ms in every format over 24 h (inside the histogram's first 1 ms bucket); 38.9 actions a second; 1,472 human actions in 7 days.                                                                                                                                     | Accepted to all 8 sockets of the table (6 seats, 2 spectators): p50 0.34, p99 1.97, max 7.1 ms at 600 tables and 600 actions a second (15 times production's rate). Diamond equals chip: four alternating 300-table runs gave p50 0.55, 0.21, 0.48, 0.54 ms. | `ActionLatencyDegraded` p95 > 3,000 ms and `ActionLatencyCritical` > 6,000 ms (human, 10 min); `SLOActionLatencyDegraded` p95 > 1,000 ms. | Three orders of magnitude on the engine's own work.                                                                                                                             | The main loop: every loop stall is added to every action at that moment (p99 up to 848 ms in the samples, 2502 ms in 24 h).                                                                 |
| **Event-loop load** (main realtime loop)           | Published p50 median 23, p90 100, max 586 ms in the samples (an idle loop reads about 20); 26% of the samples above 40 ms and 6 above 300 ms; over 24 h 559 of 1,440 minutes above 40 ms and 38 above 300 ms.                                                                                                                | The transport alone at 600 tables x 8 sockets and 600 actions a second: p50 max 21.8 ms, p99 max 25.4 ms, 19% of one core. A 2,000-client lobby storm after the fix: p50 max 22.0 ms, 0.72 s of CPU.                                                         | `EngineCoreOutOfHeadroom` p50 > 40 ms for 10 min; `EngineCoreSaturated` > 300 ms for 5 min.                                               | About 17 ms at the median; none at the p90.                                                                                                                                     | **This loop, first, and already today with no human seated.**                                                                                                                               |
| **Database locks**                                 | Lock waiters per one-minute snapshot: median 4 (8 in the busy stretch), max 34; blocked sessions waited median 1.5 to 2.4 s, max 40 s; 167 deadlocks in 74 minutes (3,577 in 24 h, worst ten minutes 123); the chip settlement door `fn_ca_commit_hand_submission` averaged 92 to 228 ms per window. Diamond doors: 0 calls. | Diamond settlement: 1.34 ms alone; p50 2.02 and p99 4.08 ms at 7,363 a second (16 sessions); no wait of 10 ms without top-ups. Top-ups beside the hands: the live door deadlocked 1,084 times in 20 s at 16 sessions and 6,499 at 48; table first, none.     | `DatabaseDeadlocksElevated` > 10 in 10 min (critical); `SettlementLaneConvoy` oldest waiter > 5 s for 10 min.                             | Chip: none (real deadlocks were above the alert's line in 834 of the day's 1,441 minutes, and the lane alert fired too). Diamond: two orders of magnitude above today's volume. | Chip: its settlement and tournament doors (outside this line). Diamond: a multi-tabling player's wallet row; the top-up inversion is fixed.                                                 |
| **Reconnect storms**                               | No human sockets, so no storm yet. The restart at 11:55 refused upgrades for about 80 s (502, then 503, then 200). Table-socket authorization since the old process started: 754, 14 over 1.2 s, slowest 3281 ms. Reconnect counters over 7 days: 0.                                                                         | 2,000 lobby clients drop and return: before the fix 15,817 ms, 2,001,000 frames, 10.7 s of CPU, 653 failed connects; after it 440 ms, 2,000 frames, 0.72 s of CPU, none. 4,800 table sockets: all back in 2.2 to 4.0 s, none failed, loop p99 41 to 57 ms.   | `PlayersReconnectingRepeatedly` (> 6 in an hour for one client, 10 min); `EngineRefusingSessions`; `TablesAreReloadingThemselves`.        | The transport brings 4,800 sockets back in seconds.                                                                                                                             | The round trips each upgrade makes: a GoTrue check per socket, and per table socket a database access check and an audit insert (slowest 3.3 s at today's trickle).                         |

## What was found, and what was done

### Fixed: a lobby join answered every subscriber

Every page holds the lobby channel (`useMaintenanceBreak` subscribes for the maintenance banner) and
every reconnect replays `JOIN_LOBBY`. `ChannelWebSocketServer` answered each join with
`channelHub.broadcastLobbyUpdate()`, which sends to every lobby subscriber, under a comment that said
it was for the joining client. N clients arriving together - every engine restart - therefore cost
N(N+1)/2 frames on the main loop, of a message (`clubOnlineCounts`, no `kind`) that no client reads.
`ChannelHub` also stringified inside its per-socket loop, the defect `TableStateHub` fixed as C16 on
2026-08-15 and never ported here. A join now answers the joiner only (`sendLobbyUpdateTo`; the 30 s
interval still refreshes everyone), and every `ChannelHub` fan-out serializes once. Measured on the
real transport, same harness, before and after:

| N lobby clients | code   | paced join: frames sent | lobby broadcast reaches all (p50 / max ms) | broadcast blocks the loop (p50 ms) | storm: frames sent | storm: main-loop CPU (ms) | storm: everyone back (ms) | storm: failed connects | storm: loop p50 max / p99 max / late max (ms) |
| --------------- | ------ | ----------------------- | ------------------------------------------ | ---------------------------------- | ------------------ | ------------------------- | ------------------------- | ---------------------- | --------------------------------------------- |
| 250             | before | 31,375                  | 2.4 / 8.5                                  | 1.8                                | 31,375             | 329                       | 315                       | 0                      | 22.1 / 22.3 / 3                               |
| 250             | after  | 250                     | 2.0 / 2.5                                  | 1.5                                | 250                | 162                       | 300                       | 0                      | 22 / 22.1 / 3                                 |
| 1000            | before | 500,500                 | 19.6 / 24.7                                | 18.2                               | 500,500            | 2,979                     | 4,342                     | 0                      | 22.1 / 107.2 / 5                              |
| 1000            | after  | 1,000                   | 18.3 / 22.2                                | 16.5                               | 1,000              | 335                       | 301                       | 0                      | 21.9 / 22.4 / 2                               |
| 2000            | before | 2,002,793               | 29.0 / 35.8                                | 27.3                               | 2,001,000          | 10,658                    | 15,817                    | 653                    | 26.6 / 248 / 6                                |
| 2000            | after  | 2,000                   | 26.2 / 34.9                                | 24.1                               | 2,000              | 717                       | 440                       | 0                      | 22 / 22.1 / 2                                 |

Pinned by `server/src/transport/aLobbyJoinAnswersOnlyTheJoiner.law.test.ts` (five of its six cases are
red on the old code). It reaches production with the next engine release; production had at most
3 channel sockets in the samples, so nothing there has had to survive the storm yet.

### Fixed: a Diamond top-up locked the wallet before the table

The hand settler (`fn_poker_diamond_settle_cash_hand`: the table `FOR UPDATE`, then every player's
wallet), the buy-in (`fn_poker_diamond_buyin`: the table, then `fn_poker_diamond_reserve`'s wallet) and
the cash-out (`fn_poker_diamond_cashout`: the table, then the wallet) all lock the table row before the
wallet row. The top-up (`fn_poker_diamond_top_up`) locked the wallet (line 21) and then the table
(line 30), under a comment saying it matched the settler. Two sessions that take the same two rows in
opposite orders deadlock, and they did, in every configuration that let a top-up meet a settlement:

| sessions | tables / players | top-up order              | hands + top-ups per s | deadlocks in 20 s | retried / failed after 5 tries | settle p99 (ms) | top-up p99 (ms) |
| -------- | ---------------- | ------------------------- | --------------------- | ----------------- | ------------------------------ | --------------- | --------------- |
| 16       | 64 / 96          | live (wallet, then table) | 4,926                 | 1,084             | 994 / 0                        | 13.9            | 21.1            |
| 16       | 64 / 96          | table, then wallet        | 7,443                 | 0                 | 0 / 0                          | 4.2             | 4.6             |
| 48       | 96 / 144         | live (wallet, then table) | 5,193                 | 6,499             | 5197 / 18                      | 40.0            | 71.6            |
| 48       | 96 / 144         | table, then wallet        | 8,005                 | 0                 | 0 / 0                          | 15.4            | 20.8            |

An earlier six-second run of the same harness, whose settle did not read the roster under the table
lock (so its settle took the table where the door does), showed the same at a lower rate: 5 deadlocks
at 16 sessions and 36 at 48 with the live door, none with the table first. Every run kept the books:
seat stacks equal custody balances, and wallets plus custody are unchanged.

Migration `20260930130000_a_diamond_top_up_takes_the_table_before_the_wallet.sql`
(md5 `0fde2c789736d446c5eb7e31baa7aaa2`) takes the table row first - one bare lock, so every refusal and
replay below it answers as it did - as an asserted substitution over the pinned live text
(`fe1cf0ce225ef0977ceef3dd8bfb4598` to `f7659bddc424e9e4b6785228ee0eec6a`, the exact text the harness
measured). Rehearsed against production in one rolled-back transaction
(`operating-envelope-top-up-rehearsal.sql`): `REHEARSAL OK: fn_poker_diamond_top_up takes the table
before the wallet (md5 f7659bddc424e9e4b6785228ee0eec6a), refuses a stranger by name
(profile_not_found), grants unchanged, both switches closed`. Applied with `apply.sh` at 12:09 UTC:
`APPLIED AND RECORDED 20260930130000`; the `@live-proof` line reads true. Both arena switches stayed
closed. Pinned by `tests/a-diamond-top-up-takes-the-table-before-the-wallet.law.test.ts`, which also
proves the harness and the migration substitute the identical text.

### Fixed: the engine let a top-up race the settlement of the hand it followed

`ServerTableEngine` clears a hand's controller when the hand ends and commits its settlement
afterwards (`postHandTasks` is not awaited; the dealing loop waits for it before the next deal). A
top-up asked for in that window went straight to the door - into the race above - and a top-up that won
it left the settler an opening stack that no longer matched the seat, which the settler refuses
(`diamond_hand_stale_seat`; the harness hit exactly this before its settle read the roster under the
table lock). Until the settlement lands, a Diamond top-up is now an intent exactly as it is mid hand,
and intents are not landed while a settlement is in flight (`ServerTableEngineSeating`, two cases in
`DiamondCashBoundary.test.ts`, both red on the old code). Reaches production with the next engine
release.

### Fixed: the engine's deadlock counter counted every restart as thousands of deadlocks

`HorseFleetMetrics` publishes `poker_db_deadlocks_total` from `pg_stat_database.deadlocks`, a
cumulative count that an engine restart does not reset, but until its first read it published `0`.
Prometheus reads a counter that goes down as a reset, so `increase()` counted the database's whole
total again when the real value came back. The raw series shows it at each of the four restarts in the
26 hours read (17:56, 19:55 and 22:56 UTC on 09-29, 11:56 today): three scrapes of 0 (45 s), then
2,543, 2,856, 3,535 and 5,287 again. Over the 24 h to 12:41 UTC that made 3,577 real deadlocks read as
17,797, the last hour's 80 as 5,387 and the worst ten minutes' 123 as 5,424, and
`DatabaseDeadlocksElevated` (critical) fired on a restart alone twice - 18:01 to 18:05 UTC on 09-29 and
12:01 to 12:05 today, while the real count in those ten minutes was 2 and 3. The counter is now absent
until the first read, as `ReplicationMetrics` already treats `poker_pg_wal_position_bytes`, so a
restart is a gap and not a spike (`server/src/services/theFleetReportsWhatItCannotFinish.law.test.ts`,
one new case, red on the old code). Reaches production with the next engine release.

### Measured and not changed

- **The main loop is the tightest resource today, and it is not a Diamond path.** In the /health samples the main loop's published p50 was above 40 ms in 61 of 238 (median 23, p90 100, max 586 ms; p99 median 57, max 848 ms) and above 300 ms in 6. Over 24 h Prometheus counts 559 of 1,440 minutes above 40 ms and 38 above 300 ms, median 28 ms, maximum 2502 ms. This is the loop that owns every socket, timer and table state; the horse decisions already run on their own worker.
  `EngineCoreOutOfHeadroom` needs ten minutes above 40 ms in a row, which is why it has not fired. Any
  human seat inherits this: action latency is the loop's latency plus about a millisecond (below).
- **Production deadlocks on the chip paths:** `pg_stat_database` counted 167 deadlocks in 74 minutes (135 an hour) during the sampling, and the raw samples of the engine's counter give 3,577 in the 24 h to 12:41 UTC (hourly median 125, max 339; worst ten minutes 123): above the 10-in-10-minutes line of `DatabaseDeadlocksElevated` in 834 of 1,441 minutes. `SettlementLaneConvoy` fired as well. The cycles are in the chip
  settlement and tournament doors (the blocked sessions sit in `fn_ca_process_hand_post_commit_obligations`,
  `fn_complete_tournament_launch_atomic` and `fn_project_hand_side_effects`); open pull requests
  already address lock order there (for example #5542). Outside this line.
- **The Diamond seat guard runs on every seat write on the platform.** `zzz_diamond_seat_keeps_custody`
  is a deferred row trigger on `table_seats`, so every chip hand pays it at commit: 4,912,113 firings since the statistics reset 44 hours earlier, 0.753 and 1.214 ms per firing on average for its two statements, 6 to 47 firings a second at 0.16 to 0.38 ms in the sampled windows.
  It is the only Diamond statement production runs at volume today; the Diamond doors themselves have
  not run (0 calls since the statistics reset).
- **A multi-tabling player's wallet row is the Diamond contention point.** Every settlement at every
  table a player sits at locks that player's wallet row (by design: "all operations for one wallet
  serialize on that profile"). In isolation it costs nothing measurable at 16 sessions and appears as
  10 to 70 ms waits at 48 (table above). At today's volumes - 17 idle Diamond tables, 13.9 chip hands a
  second on the whole platform - the isolated capacity (7,400 to 8,200 Diamond hands settled a second at 16 sessions, p99 4.1 to 4.2 ms) is two orders of magnitude
  away.
- **`SLOActionLatencyDegraded` reads a number that is zero while no human acts.** The rule watches
  `poker_action_processing_p95_ms`, fed only by human actions (`/health` `performance.totalActionsRecorded`
  was 0 in every sample). The `ActionLatency*` rules read `poker_act_to_broadcast_ms{audience="human"}`
  and are guarded by a minimum rate. Neither can say anything until humans play; that is by design and
  is recorded here so nobody reads the silence as a measurement.
- **Club presence sends the whole member list with every join and leave** (`CLUB_PRESENCE_UPDATE`
  carries `members`), so a presence storm in one club of N members is O(N) frames of O(N) bytes per
  event. Serialization is now once per event, but the bytes are the protocol's; changing it means a
  client change. Nothing on the Diamond pages subscribes to club presence today (the arena's
  "online now" is a database count), so this is recorded, not changed.

## Production, read passively

### The engine's /health

240 samples every 20 s, 11:19 to 12:40 UTC (HTTP 200 x236, 502 x2, 503 x2). Each cell is median / p90 / max over the samples in the window.

| /health field                                    | all samples (n=238) | busy :35-:53 (n=70) | after the break :05-:30 (n=104) |
| ------------------------------------------------ | ------------------- | ------------------- | ------------------------------- |
| main loop delay, published p50 (ms)              | 23 / 100 / 586      | 23 / 73 / 586       | 26 / 110 / 465                  |
| main loop delay p99 (ms)                         | 57 / 223 / 848      | 62 / 242 / 848      | 66 / 207 / 572                  |
| main loop 1 s timer lateness (ms)                | 6 / 100 / 586       | 7 / 73 / 586        | 9 / 110 / 465                   |
| horse worker loop p50 (ms)                       | 28 / 80 / 371       | 24 / 52 / 159       | 35 / 82 / 191                   |
| discovery loop stalled (ms)                      | 2920 / 4820 / 28168 | 2654 / 4650 / 5880  | 2975 / 4825 / 5431              |
| hands in flight                                  | 258 / 292 / 309     | 239 / 260 / 269     | 282 / 297 / 309                 |
| active tables                                    | 448 / 563 / 577     | 542 / 569 / 577     | 424 / 462 / 482                 |
| humans seated                                    | 0 / 0 / 0           | 0 / 0 / 0           | 0 / 0 / 0                       |
| next-hand gap p50 (ms)                           | 2315 / 2723 / 4538  | 2443 / 2883 / 4290  | 2231 / 2416 / 2564              |
| next-hand gap p90 (ms)                           | 3321 / 8249 / 10230 | 5188 / 8848 / 9821  | 2982 / 5433 / 8249              |
| gap p90: settlement post-commit obligations (ms) | 3182 / 7234 / 9004  | 4531 / 6350 / 8883  | 2352 / 7234 / 9004              |
| gap p90: await post-hand tasks (ms)              | 2443 / 4530 / 14539 | 3094 / 4967 / 5894  | 1993 / 4199 / 14539             |
| blocked settlements                              | 0 / 0 / 7           | 0 / 1 / 7           | 0 / 0 / 1                       |
| cluster pass (ms)                                | 1010 / 2002 / 6658  | 1166 / 1886 / 3478  | 992 / 2002 / 5572               |
| /health response (ms)                            | 217 / 373 / 2671    | 216 / 367 / 1680    | 244 / 391 / 2671                |

Samples with the published main-loop p50 above 40 ms (EngineCoreOutOfHeadroom): 61 of 238; above 300 ms (EngineCoreSaturated): 6.

"Busy" is the :35 to :53 stretch this line was asked to cover; it is busiest on the database side (settlement post-commit
obligations p90 4531 ms at the median against 2352 ms after the break), while the main loop is busiest
in the half hour after a break, when tournaments launch and the tables resume.

### The realtime transport (/ws-metrics)

77 samples every 60 s: table sockets max 3, channel sockets max 3, lobby subscribers max 2, soft/hard backpressure drops 0/0. Table-connection authorization since the process started: 96 completed, 0 failed, slowest 960 ms, 0 over 1,200 ms (first sample: 754 completed, 14 over 1,200 ms).

### The hourly restart, which is the reconnect storm production will have

The hourly break is when the engine is replaced, and so the moment every connected client loses its sockets at once. What /health showed through the break at 11:53 (every change of state):

- 11:19:30: HTTP 200, instance 1-6f46b646, maintenance False (idle), hands in flight 299, resume waves 8 of 8, 361 tables
- 11:53:08: HTTP 200, instance 1-6f46b646, maintenance True (last_hand), hands in flight 0
- 11:55:09: HTTP 200, instance 1-6f46b646, maintenance True (counting_down), hands in flight 0
- 11:55:30: HTTP 502, instance -, maintenance - (-), hands in flight -
- 11:56:10: HTTP 503, instance 1-34605107, maintenance False (idle), hands in flight 0
- 11:56:50: HTTP 200, instance 1-34605107, maintenance True (counting_down), hands in flight 0
- 12:02:55: HTTP 200, instance 1-34605107, maintenance False (idle), hands in flight 179, resume waves 6 of 8, 384 tables

A restart therefore refuses upgrades for roughly 40 to 80 seconds (502 while no process answers, 503 until the new one is a dealer-ready leader). During that time `EngineStateClient` climbs its ladder (1 s doubling to 30 s, plus jitter), so the returning storm arrives in waves at the ladder's steps rather than all at once, and every returning socket costs the new process a GoTrue session check and, for a table socket, a database access check (`fn_ca_engine_table_connection_access`) and an `action_audit_logs` insert. The previous break resumed 361 tables in 8 waves over 10.5 s.

### Prometheus (the engine's own gauges and the estate's alert rules)

Read at 12:40 UTC; the deadlock series and the deadlock alert's history read again, raw, at 12:45. The action-latency histogram's buckets are 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000 and 5000 ms, so a p99 under 1 ms is "inside the first bucket".

| measure                                                                                     | value                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| accept to broadcast start, p50 / p95 / p99, last 24 h, by format (horse audience)           | cash 0.50, hu_sng 0.50, mtt 0.50, spin 0.50 / cash 0.95, hu_sng 0.95, mtt 0.95, spin 0.95 / cash 0.99, hu_sng 0.99, mtt 0.99, spin 0.99 ms                   |
| worst 10-minute p95 of the same in 24 h                                                     | 0.96 ms                                                                                                                                                      |
| actions per second, last 1 h, by format                                                     | cash 11.0, hu_sng 10.2, mtt 7.6, spin 10.1 (fleet 38.9/s; hands 12.3/s)                                                                                      |
| human actions in 7 days, by format                                                          | cash 447, mtt 1025                                                                                                                                           |
| main loop published p50: median / q95 / max over 24 h                                       | 28 / 214 / 2502 ms                                                                                                                                           |
| main loop p99: q95 / max over 24 h                                                          | 403 / 2502 ms                                                                                                                                                |
| minutes in 24 h with the published p50 above 40 ms / above 300 ms                           | 559 / 38 of 1,440                                                                                                                                            |
| 1 s timer lateness: median / q95 / max over 24 h; minutes above 40 ms                       | 12 / 195 / 2502 ms; 404                                                                                                                                      |
| horse decision worker loop p99, max over 24 h                                               | 4041 ms                                                                                                                                                      |
| deadlocks: 24 h / last 1 h / worst 10 minutes, from the raw samples of the engine's counter | 3,577 / 80 / 123 (hourly median 125, max 339); `increase()` reads 17,797 / 5,387 / 5,424 because each restart counted the whole total again (the fourth fix) |
| settlement lane oldest waiter: median / q95 / max over 24 h; minutes above 5 s              | 0 / 6076 / 8913 ms; 117                                                                                                                                      |
| settlement lane waiters, max over 24 h                                                      | B 0, F 4, G 6                                                                                                                                                |
| settlements in flight, max over 24 h; oldest settlement, max                                | 242; 186389 ms                                                                                                                                               |
| engine `hand_history` settlement step in 24 h: count / slower than 1 s / mean               | 991,276 / 352,801 (36%) / 1009 ms                                                                                                                            |
| cluster pass p95: last 1 h / 24 h                                                           | 2.70 / 2.93 s                                                                                                                                                |
| discovery loop stalled, max over 24 h                                                       | 42771 ms                                                                                                                                                     |
| WebSocket reconnects by reason, 7 d                                                         | auth_failed 0, auto_reload 0, closed 0, handshake_timeout 0, other 0, reload_suppressed 0, stale 0                                                           |
| clients reconnecting badly, max 7 d; socket-cap and protocol refusals 7 d                   | 0; 0 and 0                                                                                                                                                   |
| upgrades refused for auth, 7 d                                                              | channel/invalid 222, multi/invalid 1, table/invalid 0, channel/unavailable 5, multi/unavailable 0, table/unavailable 0                                       |
| humans seated, max 24 h / 7 d; tables with humans, max 7 d                                  | 0 / 1; 1                                                                                                                                                     |
| active tables now / max 24 h; horses seated max 24 h                                        | 344 / 647; 1818                                                                                                                                              |
| engine host: CPUs, CPU busy last 1 h, worst 5-minute CPU busy in 24 h, load1 max 24 h       | 6, 51%, 67%, club-arena-turn 0.39, engine-01 9.45                                                                                                            |
| alerts that fired in the last 24 h, of the ones this line reads                             | DatabaseDeadlocksElevated, EngineProcessMemoryHigh, HostCPUSaturated, SLOEngineAvailability, SLOTableHasStalled, SettlementLaneConvoy                        |

### The database

79 snapshots, one a minute, 11:26 to 12:40 UTC.

| window           | snapshots | client backends median / max | active median / max | lock waiters median / p90 / max | blocked sessions seen: wait median / p90 / max (ms) | top waits of active backends (summed over snapshots)                                           | where blocked sessions were                                                                                                                                         |
| ---------------- | --------- | ---------------------------- | ------------------- | ------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| busy :35-:53     | 25        | 100 / 109                    | 29 / 75             | 5 / 25 / 34                     | 221: 2423 / 7813 / 40087                            | LWLock:WALWrite 269, IO:DataFileRead 148, Lock:transactionid 129, CPU:- 95, Lock:advisory 64   | `fn_ca_process_hand_post_commit_obligations` 60, `fn_complete_tournament_launch_atomic` 41, `fn_project_hand_side_effects` 39, `fn_ca_retain_hand_submission` 16    |
| rest of the hour | 44        | 99 / 106                     | 25 / 69             | 3 / 21 / 28                     | 244: 1442 / 6500 / 21706                            | LWLock:WALWrite 376, IO:DataFileRead 263, CPU:- 222, Lock:transactionid 103, Lock:advisory 102 | `fn_ca_process_hand_post_commit_obligations` 46, `fn_complete_tournament_launch_atomic` 34, `fn_project_hand_side_effects` 34, `fn_complete_tournament_terminal` 26 |
| break :53-:03    | 10        | 98 / 102                     | 3 / 31              | 0 / 0 / 0                       | 0: - / - / -                                        | IO:DataFileRead 88, CPU:- 1, IO:DataFilePrefetch 1                                             | -                                                                                                                                                                   |

`pg_stat_database` over the same 74 minutes: 167 deadlocks (135 an hour), 488,503 rollbacks, 2,015,491 commits (452 a second).

Per-window statement cost from `pg_stat_statements` deltas (9.5-minute windows; the settlement doors
of every chip hand):

| window (UTC) | `fn_ca_commit_hand_submission` calls/s, mean ms | `fn_ca_process_hand_post_commit_obligations` calls/s, mean ms | `fn_project_hand_side_effects` calls/s, mean ms | `fn_ca_retain_hand_submission` calls/s, mean ms | `fn_complete_tournament_launch_atomic` calls/s, mean ms | Diamond seat guard: firings/s, mean ms (both statements) |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| 11:26-11:35  | 13.5, 115                                       | 13.5, 120                                                     | 13.4, 161                                       | 13.5, 30                                        | 0.3, 2400                                               | 40.0, 0.28                                               |
| 11:35-11:45  | 12.0, 137                                       | 12.0, 195                                                     | 12.5, 182                                       | 12.0, 88                                        | 0.3, 3558                                               | 35.9, 0.37                                               |
| 11:45-11:54  | 9.6, 131                                        | 9.6, 70                                                       | 9.7, 127                                        | 9.5, 67                                         | 0.2, 1410                                               | 29.2, 0.31                                               |
| 11:54-12:04  | 2.1, 169                                        | 2.1, 56                                                       | 2.1, 157                                        | 2.1, 30                                         | 0.1, 3245                                               | 6.3, 0.16                                                |
| 12:04-12:13  | 13.9, 228                                       | 13.9, 98                                                      | 13.7, 157                                       | 13.9, 77                                        | 0.3, 697                                                | 41.6, 0.38                                               |
| 12:13-12:23  | 15.8, 92                                        | 15.8, 38                                                      | 16.0, 95                                        | 15.8, 23                                        | 0.4, 490                                                | 46.3, 0.22                                               |
| 12:23-12:32  | 16.8, 112                                       | 16.8, 55                                                      | 17.0, 112                                       | 16.8, 28                                        | 0.4, 1166                                               | 46.9, 0.27                                               |

### The Diamond statements a buy-in and a settlement run

Read from the live definitions (`pg_get_functiondef`), in the order they take their locks:

- **Buy-in** (`fn_poker_diamond_buyin`, md5 `2f76148f74df8766a958cdd403582e24`): advisory
  `table_cap:<player>`, advisory `table_seat:<table>`, the `tables` row `FOR UPDATE`; then
  `fn_poker_diamond_reserve` (md5 `cf2150429728d8d796711e9bdbb22f51`): the wallet (`profiles`) row
  `FOR UPDATE`, `tables` `FOR SHARE` (already held), `clubs` `FOR SHARE`, every one of the player's
  `diamond_purchase_lots` `FOR UPDATE`, one `poker_diamond_custody` insert, one lot update and one
  `poker_diamond_lot_reservations` insert per settled lot drawn, one `diamond_transactions` journal
  insert, the wallet update, one `poker_diamond_movements` insert; then the old chair's `table_seats`
  row deleted, the new seat inserted, the custody binding checked, `table_waitlist` and
  `tables.current_players` updated. At commit the deferred guards run once per seat row and once per
  custody row.
- **Settlement of a hand** (the engine's `fn_ca_commit_hand_submission` reaches
  `fn_poker_diamond_settle_cash_hand`, md5 `3aab9170062e97840afc7d15999691ad`): the `tables` row
  `FOR UPDATE`, the receipt lookup, every player's wallet row `FOR UPDATE` in id order; per player the
  `table_seats` row and the `poker_diamond_custody` row `FOR UPDATE`; per losing player the lot
  reservations and lots `FOR UPDATE` and updated; per player the custody and seat updated; one
  `poker_diamond_hand_receipts` insert; the deferred seat guard once per seat row at commit.
- **Top-up** (`fn_poker_diamond_top_up`, now md5 `f7659bddc424e9e4b6785228ee0eec6a`): advisory
  `table_seat:<table>`, the `tables` row, the wallet row, the seat, the custody, the lots, then the same
  journal, custody, seat and movement writes as a buy-in.
- **Cash-out** (`fn_poker_diamond_cashout`, md5 `86a1c1ed0233ef041695241509514c32`): advisory
  `table_cap:<player>`, the `tables` row, the wallet row, the seat, the custody, then
  `fn_poker_diamond_release` (md5 `d525cb1e20d6fb05e5b5e51497b127e7`: wallet, custody, lots) and a
  `seat_cashout_receipts` insert.

Production has run none of these doors (0 calls in `pg_stat_statements` since its reset on
2026-09-28 16:36 UTC); their cost is measured in isolation below. The one Diamond statement production
runs at volume is the seat guard, on every seat write: since the statistics reset (2026-09-28 16:36 UTC, 43.9 h before the last read) the two statements of `fn_poker_diamond_seat_keeps_custody` ran 4,912,113 times each, mean 0.753 ms and 1.214 ms (queryids -1602751914993773422 and -113917454429087212), 9,665 s of database time in all (6.1% of one core); in the sampled 9.5-minute windows they ran 6 to 47 times a second at 0.16 to 0.38 ms for the pair.

## Isolation: the realtime transport

Commands (from `server/`):

```sh
~/.nvm/versions/node/v22.23.3/bin/node node_modules/tsx/dist/cli.mjs scripts/measure-realtime-envelope.ts --out <file.json>
~/.nvm/versions/node/v22.23.3/bin/node node_modules/tsx/dist/cli.mjs scripts/measure-realtime-envelope.ts --lobby-only --out <file.json>
```

The "before" runs used `server/src/hub/ChannelHub.ts` and `server/src/transport/ChannelWebSocketServer.ts`
from `52addc2502` (origin/main when this branch started); the "after" runs use this branch.

Runs:

- prefix-retry.json: started 2026-09-30T11:57:04.436Z, node v22.23.3, darwin 25.5.0, Apple M3 Ultra x28, 96 GiB, load average [17.5, 13, 12.6] at start and [5.9, 10.2, 11.5] at end; idle loop published p50 22 ms (p99 max 22.3 ms)
- postfix.json: started 2026-09-30T12:06:35.995Z, node v22.23.3, darwin 25.5.0, Apple M3 Ultra x28, 96 GiB, load average [3.3, 6, 9.1] at start and [3.4, 4.9, 7.8] at end; idle loop published p50 22 ms (p99 max 22.4 ms)
- ab2-prefix.json: started 2026-09-30T12:24:50.328Z, node v22.23.3, darwin 25.5.0, Apple M3 Ultra x28, 96 GiB, load average [4.2, 6.7, 8.3] at start and [4.3, 5.6, 7.5] at end; idle loop published p50 22 ms (p99 max 22.5 ms)
- ab2-postfix.json: started 2026-09-30T12:27:39.515Z, node v22.23.3, darwin 25.5.0, Apple M3 Ultra x28, 96 GiB, load average [7, 6, 7.6] at start and [4.2, 5.5, 7.2] at end; idle loop published p50 22.1 ms (p99 max 23.7 ms)

**Lobby, full run (20 measured broadcasts per size):**

| N lobby clients | code   | paced join: frames sent | lobby broadcast reaches all (p50 / max ms) | broadcast blocks the loop (p50 ms) | storm: frames sent | storm: main-loop CPU (ms) | storm: everyone back (ms) | storm: failed connects | storm: loop p50 max / p99 max / late max (ms) |
| --------------- | ------ | ----------------------- | ------------------------------------------ | ---------------------------------- | ------------------ | ------------------------- | ------------------------- | ---------------------- | --------------------------------------------- |
| 250             | before | 31,375                  | 1.9 / 2.6                                  | 1.8                                | 31,375             | 315                       | 339                       | 0                      | 22 / 22.4 / 2                                 |
| 250             | after  | 250                     | 9.1 / 11.5                                 | 9.0                                | 250                | 141                       | 300                       | 0                      | 22 / 22.4 / 2                                 |
| 1000            | before | 501,328                 | 7.0 / 16.5                                 | 6.8                                | 500,500            | 3,426                     | 4,622                     | 0                      | 22.1 / 46.5 / 3                               |
| 1000            | after  | 1,933                   | 14.3 / 21.4                                | 9.0                                | 1,000              | 450                       | 300                       | 0                      | 22 / 22.2 / 4                                 |
| 2000            | before | 2,002,261               | 13.8 / 14.9                                | 13.8                               | 2,002,467          | 12,419                    | 16,501                    | 650                    | 114 / 206 / 114                               |
| 2000            | after  | 2,000                   | 25.9 / 32.8                                | 23.3                               | 2,000              | 838                       | 449                       | 0                      | 22.1 / 26.2 / 3                               |

This full run measured the broadcast right after the join phase without warming the sockets first:
before the fix every socket had just carried hundreds of frames, after it one, which is why its
broadcast columns disagree with the A/B table further up (that one sends twenty unmeasured broadcasts
to every socket first). The storm columns do not depend on it and agree between the two runs.

The lobby broadcast itself (one maintenance presentation to N subscribers, run inside one tick of the
main loop) is linear: about 6 to 16 microseconds per subscriber on this machine, so 2,000
subscribers take about 24 to 27 ms of loop time per broadcast, with run-to-run spread shown above
(the machine was shared).

**Tables, after (one action per table per second; six seats and two spectators per table):**

| tables x sockets | asset    | publishes/s | publish blocks the loop p50 / p99 (ms) | action to every seat p50 / p95 / p99 / max (ms) | DELTA frame p50 / max (bytes) | main-loop CPU share | loop p50 max / p99 max (ms) | storm: all resubscribed (ms) / failed connects / loop p99 max |
| ---------------- | -------- | ----------- | -------------------------------------- | ----------------------------------------------- | ----------------------------- | ------------------- | --------------------------- | ------------------------------------------------------------- |
| 100 x 800        | chips    | 100         | 0.55 / 1.59                            | 0.68 / 1.35 / 2.13 / 16.61                      | 890 / 2540                    | 8%                  | 22 / 25.7                   | -                                                             |
| 300 x 2,400      | chips    | 300         | 0.45 / 1.38                            | 0.55 / 1.08 / 1.70 / 4.92                       | 890 / 2540                    | 16%                 | 21.7 / 52                   | 1,157 / 0 / 22.2                                              |
| 300 x 2,400      | diamonds | 300         | 0.14 / 0.97                            | 0.21 / 0.83 / 1.49 / 4.04                       | 890 / 2540                    | 10%                 | 21.8 / 28.6                 | 736 / 0 / 22.5                                                |
| 300 x 2,400      | chips    | 300         | 0.41 / 1.11                            | 0.48 / 0.92 / 1.62 / 8.67                       | 890 / 2540                    | 15%                 | 21.4 / 37.7                 | -                                                             |
| 300 x 2,400      | diamonds | 300         | 0.45 / 1.50                            | 0.54 / 1.14 / 1.96 / 11.87                      | 890 / 2540                    | 16%                 | 21.9 / 48.4                 | -                                                             |
| 600 x 4,800      | chips    | 599         | 0.25 / 1.25                            | 0.34 / 0.86 / 1.97 / 7.08                       | 893 / 2540                    | 19%                 | 21.8 / 25.4                 | 4,043 / 0 / 40.9                                              |

**Tables, before (the table path did not change; this is the same code on another run):**

| tables x sockets | asset    | publishes/s | publish blocks the loop p50 / p99 (ms) | action to every seat p50 / p95 / p99 / max (ms) | DELTA frame p50 / max (bytes) | main-loop CPU share | loop p50 max / p99 max (ms) | storm: all resubscribed (ms) / failed connects / loop p99 max |
| ---------------- | -------- | ----------- | -------------------------------------- | ----------------------------------------------- | ----------------------------- | ------------------- | --------------------------- | ------------------------------------------------------------- |
| 100 x 800        | chips    | 100         | 0.17 / 0.70                            | 0.27 / 1.27 / 3.57 / 13.20                      | 890 / 2540                    | 3%                  | 22 / 30                     | -                                                             |
| 300 x 2,400      | chips    | 299         | 0.11 / 0.50                            | 0.19 / 0.32 / 0.66 / 7.76                       | 890 / 2540                    | 6%                  | 22 / 23.7                   | 709 / 0 / 22.1                                                |
| 300 x 2,400      | diamonds | 299         | 0.30 / 0.77                            | 0.36 / 0.70 / 1.02 / 3.13                       | 890 / 2540                    | 12%                 | 22 / 46                     | 768 / 0 / 22.6                                                |
| 600 x 4,800      | chips    | 600         | 0.22 / 0.89                            | 0.28 / 0.69 / 1.40 / 18.05                      | 893 / 2540                    | 19%                 | 22 / 72.1                   | 2,226 / 0 / 57                                                |

A Diamond table and a chip table run the same code from an accepted action to every seat: nothing in
`broadcastCurrentState`, `TableStateHub.publish` or the socket path branches on the asset (the
published state carries it as one field). The alternating chip and Diamond runs at 300 tables differ
from each other by no more than two chip runs differ from each other. The per-action difference between
the two arenas is in the settlement (the database section), which lands in the gap between hands, not
in action latency.

## Isolation: the Diamond doors under concurrency

Command:

```sh
python3 scripts/qualification/diamond-lock-waits.py --work <empty dir on a big disk> --out <file.json>
```

PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0, compiled by Apple clang version 21.0.0 (clang-2100.1.1.101), 64-bit; deadlock_timeout=10, fsync=on, listen_addresses=, log_lock_waits=on, max_connections=150, shared_buffers=65536, synchronous_commit=on (shared_buffers in 8 kB pages: 512 MB); run 2026-09-30T12:16:05Z. Each run is 20 s. `settle` is one hand at one table: the shared settlement lane, then the
live settle door; each pgbench session owns its own tables, as one engine owns a table, and reads the
roster under the table row the door takes first. `topup` is one Diamond through the live top-up door
(or the table-first text the migration installs) for a random seated player at a random table.
"Waiters per sample" is `pg_locks` not granted, sampled every 50 ms.

| run                                     | sessions | tables / players | top-up lock order | settles+top-ups per s | settle p50 / p95 / p99 / max (ms) | top-up p50 / p99 (ms) | deadlocks | waits >= 10 ms (max ms) | waiters per 50 ms sample p50 / max | invariants                                       |
| --------------------------------------- | -------- | ---------------- | ----------------- | --------------------- | --------------------------------- | --------------------- | --------- | ----------------------- | ---------------------------------- | ------------------------------------------------ |
| settle-1-client                         | 1        | 64 / 384         | live              | 721                   | 1.34 / 1.59 / 1.83 / 38.3         | -                     | 0         | 0 (-)                   | 0 / 0                              | seat = custody, wallet + custody = 3,840,000,000 |
| settle-16-clients-own-players           | 16       | 64 / 384         | live              | 7,363                 | 2.02 / 2.44 / 4.08 / 34.2         | -                     | 0         | 0 (-)                   | 0 / 2                              | seat = custody, wallet + custody = 3,840,000,000 |
| settle-16-clients-4-tables-per-player   | 16       | 64 / 96          | live              | 8,161                 | 1.84 / 2.54 / 4.17 / 130.3        | -                     | 0         | 0 (-)                   | 0 / 1                              | seat = custody, wallet + custody = 960,000,000   |
| settle-and-topup-16-clients-live-door   | 16       | 64 / 96          | live              | 4,926                 | 2.78 / 4.02 / 13.93 / 681.2       | 1.89 / 21.08          | 1,084     | 884 (675.9)             | 3 / 15                             | seat = custody, wallet + custody = 960,000,000   |
| settle-and-topup-16-clients-table-first | 16       | 64 / 96          | table-first       | 7,443                 | 2.10 / 2.98 / 4.21 / 108.5        | 1.53 / 4.57           | 0         | 10 (79.4)               | 2 / 4                              | seat = custody, wallet + custody = 960,000,000   |
| settle-and-topup-48-clients-live-door   | 48       | 96 / 144         | live              | 5,193                 | 7.31 / 20.47 / 39.98 / 180.3      | 5.70 / 71.64          | 6,499     | 8171 (105.7)            | 26 / 35                            | seat = custody, wallet + custody = 1,440,000,000 |
| settle-and-topup-48-clients-table-first | 48       | 96 / 144         | table-first       | 8,005                 | 5.56 / 10.28 / 15.43 / 92.5       | 4.81 / 20.82          | 0         | 550 (71.4)              | 21 / 26                            | seat = custody, wallet + custody = 1,440,000,000 |

Where the waits of 10 ms or more were (door and line from the lock-wait log):

- settle-and-topup-16-clients-live-door: profiles row (ShareLock on transaction) waited in fn_poker_diamond_settle_cash_hand:84 x384 (p50 10.71, max 27.43 ms); tables row (ShareLock on transaction) waited in fn_poker_diamond_top_up:30 x331 (p50 10.89, max 22.28 ms); profiles row (ShareLock on transaction) waited in fn_poker_diamond_top_up:21 x68 (p50 12.15, max 675.76 ms); advisory row (ExclusiveLock on advisory) waited in fn_poker_diamond_top_up:19 x68 (p50 11.96, max 24.68 ms); extension row (ExclusiveLock on extension) waited in fn_poker_diamond_settle_cash_hand:157 x12 (p50 670.9, max 675.92 ms)
- settle-and-topup-16-clients-table-first: profiles row (ShareLock on transaction) waited in fn_poker_diamond_settle_cash_hand:84 x5 (p50 28.18, max 79.36 ms); tables row (ShareLock on transaction) waited in fn_poker_diamond_top_up:25 x3 (p50 12.7, max 14.47 ms); profiles row (ShareLock on transaction) waited in fn_poker_diamond_top_up:27 x2 (p50 28.55, max 51.69 ms)
- settle-and-topup-48-clients-live-door: profiles row (ShareLock on transaction) waited in fn_poker_diamond_settle_cash_hand:84 x3817 (p50 11.75, max 47.56 ms); tables row (ShareLock on transaction) waited in fn_poker_diamond_top_up:30 x1966 (p50 10.98, max 45.65 ms); advisory row (ExclusiveLock on advisory) waited in fn_poker_diamond_top_up:19 x1055 (p50 17.58, max 105.66 ms); profiles row (ShareLock on transaction) waited in fn_poker_diamond_top_up:21 x618 (p50 12.72, max 46.82 ms); profiles row (AccessExclusiveLock on tuple) waited in fn_poker_diamond_settle_cash_hand:84 x470 (p50 10.81, max 32.77 ms)
- settle-and-topup-48-clients-table-first: profiles row (ShareLock on transaction) waited in fn_poker_diamond_settle_cash_hand:84 x216 (p50 15.12, max 71.42 ms); tables row (ShareLock on transaction) waited in fn_poker_diamond_top_up:25 x126 (p50 14.9, max 55.05 ms); advisory row (ExclusiveLock on advisory) waited in fn_poker_diamond_top_up:19 x99 (p50 13.59, max 53.17 ms); profiles row (ShareLock on transaction) waited in fn_poker_diamond_top_up:27 x59 (p50 15.78, max 43.95 ms); tables row (ShareLock on transaction) waited in perf_settle:8 x34 (p50 19.89, max 52.67 ms)

Relation-extension waits (`extension row ... settle_cash_hand:157`, the receipt insert growing its
table) are this machine's external SSD, not a lock-order effect. The deadlock counts are sensitive to
the width of the window between a session's table lock and its wallet lock; the harness settles take
the table a little earlier than the engine's commit path reaches the door, so the live-door counts are
an upper bound on how often production would see it - but a deadlock needs only one meeting, and the
table-first order has none by construction.

## Limits of this evidence

- Production has no human sockets today, so lobby fan-out, human action latency and reconnect storms
  exist only in isolation; production contributes its loop, its database and its restart timeline.
- The Mac is not the Hetzner box (6 vCPU, 16 GB, Linux). macOS caps the listen backlog at 128
  (`kern.ipc.somaxconn`); the before-fix storm's failed connects are partly that cap meeting a busy
  loop, which Linux's larger backlog would absorb longer - the frames and the CPU are the defect, not
  the failed connects.
- The stub GoTrue answers instantly and the table server's access check is the test seam; production
  pays a GoTrue round trip per upgrade and a database round trip plus an audit insert per table socket
  (the production numbers for that are in the /ws-metrics section).
- The table state is synthetic but has the engine's field set: 4.3 KB snapshots, 890-byte deltas at
  the median.

## Re-running

The transport and database harnesses above, with the stated Node and PostgreSQL binaries. The
production reads are the `/health` and `/ws-metrics` URLs with a `?cb=<ms>` cache-buster, the
Prometheus queries through `ENGINE_MONITORING_SSH` as `check-alert-rules-match.mjs` reaches it, and
selects on `pg_stat_activity`, `pg_locks`, `pg_stat_statements` and `pg_stat_database`; none of them
writes. Until the fourth fix is deployed, read the deadlock series raw (`poker_db_deadlocks_total[26h]`)
and drop its restart zeros before differencing; `increase()` over a restart is not a deadlock count.
