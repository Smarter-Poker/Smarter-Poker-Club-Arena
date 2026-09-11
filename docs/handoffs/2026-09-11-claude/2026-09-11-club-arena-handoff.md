# CLUB ARENA — OPERATIONAL HANDOFF (OPORD FORMAT)

**From:** Claude (Cowork session `635ed867`, operator: Dan) · **As of:** 2026-09-11 ~13:25 UTC, **v4** (v1 was sent at 12:33 UTC; see `HANDOFF-CHANGES-v1-to-v4.md` for everything that changed; every decision that earlier versions left to Dan is now made, in §10) · **Classification:** internal, contains hosts/IDs, no secrets

> **Read this whole document before touching production.** Section 7 is the ordered pick-up checklist. Section 4 lists the rules; they are hard rules. Everything this document says was measured or written this session. Anything unverified is marked **UNVERIFIED**. The raw evidence is in `docs/handoffs/2026-09-11-claude/evidence/`:
>
> - 13 workflow reports
> - the stuck-event investigations
> - the verbatim session summary from the 11:42 context compaction

---

## 0. BLUF (bottom line up front)

1. **The horse-lane fix is live and verified.** Build `4895030e` has been running since the 12:55 break (deploy run `34599636898`, success).
   - **Before**, 12:45 UTC on build `80769f9b`, ~265 tables:
     - 265-269 decisions queued, the oldest 7.3-7.6 s old
     - ~258 decisions expired per minute (horses forced to check/fold)
     - lane throughput ~32 jobs/s
     - average hand 38.8 s
   - **After**, 13:04 UTC on build `4895030e`, ~277 tables:
     - queue 0-15, oldest ≤ 92 ms, **0 expired**
     - throughput ~78 jobs/s
     - average hand 20.7 s and falling
   - The post-break surge (13:02-13:03, 293 tables) briefly built a 206-deep queue (oldest 2.3 s, still 0 expired), which drained by 13:04.
   - **Capacity is still the ceiling:** the host is at ~83% user CPU and 12.7% idle. A busier hour can saturate the lane again (§6.1, §8).
2. **Deployed at 12:55:** run **`34599636898`** (workflow_dispatch, main `4895030e22`) cut over and its Verdict is green.
   - The first run, `34598480706`, failed its server-test step at 12:34:40 on a **flaky statistical test**: `src/engine/CryptoRandom.test.ts > Deck.shuffle > deals the ace of spades to a uniform position`, "expected 33 to be less than 32.91", 1 failed of 9,454.
   - The train handed on by itself.
   - It carries:
   - #4270: the deploy gate reads a degraded engine's 503 body
   - #4293: settle and doors rank a bust by hand time (engine side)
   - #4295: the horse lane is pipelined
   - **First action for the next agent:** verify it after 13:00 (§7 step 1).
3. **Also degraded:** a single hung lease heartbeat can kill every cash table. At 10:59:10 one 15 s heartbeat timeout killed 52 cash tables. The fix is designed but not written (§6.2).
4. **Money/tournament state:** all rulings applied today verified clean, and the satellite ruling closed at 12:11 (15 settled, 15 seated, 1 cancelled). Still open:
   - 59 tournaments cannot finish on their own: 57 one-seat-per-table events, plus c1f15c30 and a5aa6984. The fix and rulings are prepared, but ordering is mandatory (§6.4).
   - 79 horse-only REGISTERING events from 09-08 need a ruling.
5. **The unauthorized merge freeze is gone, and a guard against it is published.**
   - At 12:20:32 UTC the required check `Stage B Release Freeze` was added to the `main protection` ruleset through the shared Smarter-Poker account (ruleset history version 49408418). No workflow produces that check, so every merge was blocked.
   - Dan did not authorize it and ordered it removed and never allowed back. It was removed at 12:47:26 (version 49411053).
   - Once it was gone I merged **#4292** (`5a7abc7706`) and **#4296** (`6d7b08515c`). Both deploy at the **13:55 break**; verify them.
   - **Guard:** law test `tests/no-merge-gate-without-a-producer.law.test.ts` on `fix/no-merge-gate-without-a-producer` (`b3338e8cfe`, PR auto-opened). It pins:
     - every required check has a producing workflow job
     - nothing is named as a freeze
     - only the two named scripts may write a ruleset
   - **Remaining door, DECIDED (§10 D4):** agent tokens stop being able to write rulesets. Today the shared agent account token holds Administration: write, so a hand edit through the API is still possible.
   - The handoff itself is **#4299**.
6. **Three backup branches, none merged yet, each with a precondition.** `backup/**` branches do not auto-open PRs.
   - `backup/claude-2026-09-11/late-status-flip-keeps-paid-ladder` (`3aaf4ce0c4`): migration `20260911110000`. Review, apply, record, then PR. It goes first (D9, D10).
   - `backup/claude-2026-09-11/freeze-deferred-balance-redrive` (`cf64e76666`): **the chosen balance fix** (D11). PR it only after the E2 rehearsal and the 7aa16fa7 ruling.
   - `backup/claude-2026-09-11/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw` (`2b6b5c6687`): the alternative fix. Retire it unless it adds something the redrive lacks. Its wake and re-sequence scripts stay useful references.

---

## 1. SITUATION

### 1.1 Production topology (facts)

| Thing         | Where                                                                                                                            | Notes                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine        | Hetzner `engine-01`, `root@5.161.252.33`, container `club-arena-engine`                                                          | 3 vCPU, 3.8 GB RAM. Image label `sp.release.sha`. Docker healthcheck is liveness only (`running && liveness in (ok,standby)`), 20 s interval, 3 retries |
| Autoheal      | container `sp-autoheal` (`willfarrell/autoheal`)                                                                                 | restarts **only** Docker-unhealthy containers labeled `autoheal=true`. A degraded 503 `/health` does not trip it                                        |
| Monitoring    | `sp-prometheus` (reach it from the host at `172.19.0.2:9090`), `sp-alertmanager`, `sp-grafana`, `sp-node-exporter`               | rules include engine-core, engine-freeze, settlement, tournament-work-scheduler, stats-pipeline, slo-objectives                                         |
| Engine logs   | `docker logs club-arena-engine`; archived `/var/log/club-arena-engine/*.log.gz` (one per build)                                  |                                                                                                                                                         |
| Public health | `https://engine.smarter.poker/health`                                                                                            | Answers **503 with the same JSON body** when not routing-ready. Caddy has a single upstream and no active health check                                  |
| DB            | Supabase project `kuklfnapbkmacvwxktbh`, pooler `aws-0-us-west-2.pooler.supabase.com:5432`, user `postgres.kuklfnapbkmacvwxktbh` |                                                                                                                                                         |
| Repo          | `Smarter-Poker/Smarter-Poker-Club-Arena`, main checkout `~/Documents/club-arena` (it lags main, currently `ec745dbb18`)          | worktrees under `~/Documents/.agent-trees/club-arena/`                                                                                                  |

### 1.2 Engine process anatomy (why horses matter)

One Node process with three hot threads:

- **Main thread:** dealing, timers, WebSockets, cluster controller, discovery, lease renewal.
- **Live horse decision worker:** `server/src/engine/horseDecision/`. It runs HorseLogic (GTO charts, postflop solver stores, Monte Carlo equity) behind a single FIFO. It owns HorseMind and its own EquityLoadGovernor.
- **Equity worker pool:** `server/src/engine/equity/EquityWorkerPool.ts`, 1 worker = `max(1, availableParallelism()-2)`. It computes all-in runout equity for `ServerTableEngineRunout.ts`.

Horses get only their own hole cards plus public state; the worker rejects any snapshot that carries other seats' cards ("horse state contains private seat cards"). Their actions go through the same action path and clocks as humans (CLAUDE.md §10.5 "horses are players").

### 1.3 Measured degradation (12:18 UTC, build 80769f9b)

- `/health.liveHorseDecision`:
  - queue 311-349, oldest 6,688-7,978 ms
  - `expiredJobs` 11,624 (phase `active`)
  - `lastComputeMs` samples 6.6-113.7 ms
  - worker governor scale 0.35-1 (p50 70-75 ms)
- `dealableTableCount` 310-311, `telemetry.avgHandDurationMs` ~35,600, main loop p50 ~20 ms.
- `top -H`, 4 s sample: 85% user, 11% idle. Threads: horse worker ~80%, a second worker ~94% (equity pool, **UNVERIFIED** which thread is which), main ~64%, four V8/GC threads ~5% each.
- Sweep agent log count: `horse_decision_worker_failed` "expired after 8000ms before worker dispatch" ~800/min around 12:11; `horse_mind_observation_failed` ~1,000.
- Before the 11:56 restart (c113fbe7, ~11:50): 185 tables, queue 126-156, oldest 2.6-3.8 s, no thread above 60%. That is the proof that the one-at-a-time dispatch left the worker idle, and it is what #4295 fixes.
- Prometheus `poker_horse_decision_worker_queue_depth`, 15 m averages: 2-7 from 02:00 to 10:50, then 98-130 after the 10:55 deploy.

### 1.4 Firing alerts (checked 11:45 UTC)

- `SpinUnfilledBacklog`: 29 Spins past their fill deadline, since 08:56.
- `StatsAllInEquityCoverageLow`: 98.4% over 7 days; 6,000 of 371,820 all-in runout seats have no equity.
- `TournamentNeverStarted` (1), `TournamentStuckCompleting` (1, c1f15c30), `TournamentSeatlessPhantoms` (1).
- Pending: `EngineCoreOutOfHeadroom` (54 ms), `EngineSheddingPrecisionForHours`.
- `MonitoringCanary` always fires by design.

### 1.5 Today's deploy timeline (UTC)

| Time                                 | Build                                                       | What                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 06:57                                | #4225 via Dan's one-build exception (#4235, spent by #4257) | deadline clock fix                                                                                               |
| 08:55                                | `9284d7ec`                                                  | #4266 equity pool recovery, #4267 degraded-cert reads, and more                                                  |
| 10:55                                | `c113fbe7`                                                  | #4274, #4276, #4275, #4277, #4279, #4281, #4285                                                                  |
| 11:56                                | `80769f9b`                                                  | Codex #4289 (restart at 11:56:00; not mine)                                                                      |
| **12:55 (deployed, verified 13:04)** | **`4895030e22`**                                            | #4270, #4293, #4295. Run `34599636898`, success (the first run, `34598480706`, failed on the CryptoRandom flake) |
| 13:55 (queued)                       | latest main                                                 | #4292 mystery engine follow-up, #4296 satellite feeder                                                           |

---

## 2. MISSION

Restore full engine health and keep it there:

- horses decide within their think time at full precision
- no mass table kills on a database blip
- every stuck tournament finishes and pays in true bust order

Do this without breaking the standing rules (§4), and verify everything end to end before calling it done.

---

## 3. EXECUTION — WHAT WAS DONE THIS SESSION (complete ledger)

### 3.1 PRs (mine unless noted), newest first

| PR                  | Merged (UTC) | Merge SHA    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #4295               | 09-11 12:20  | `4895030e22` | **perf(horses): the horse lane never waits on the main loop.** The client keeps up to 4 jobs posted (`maxInFlight`). FIFO is enforced. A posted abort/expiry sends CANCEL and keeps its slot. The integrity clock starts at the head, never at post. The barrier/priority commit is unchanged. The worker runs one job per event-loop turn (`setImmediate`). 70/70 horseDecision tests, 8 new ones proven to fail on the old code, `tsc` clean. Changelog `docs/changelog/2026-09-11-the-horse-lane-never-waits-on-the-main-loop.md` |
| #4293               | 09-11 12:18  | `ee0e25e76e` | fix: a bust is ranked by when it happened. Engine `bustOrder.ts`, `count:'exact'` reads; the migration was applied earlier (§3.2)                                                                                                                                                                                                                                                                                                                                                                                                    |
| #4270               | 09-11 12:18  | `ceb3020853` | fix: a degraded engine can still be replaced. Deploy workflow body reads with `curl -s`, and only Verify/ROLLBACK keep `-f`; law test `tests/a-degraded-engine-can-still-be-replaced.law.test.ts`                                                                                                                                                                                                                                                                                                                                    |
| #4281               | 10:20        | `c113fbe7cb` | deploy: the engine ships only with its doors. `scripts/ci/check-engine-doors-exist.mjs` blocks a build that calls a DB function missing in prod                                                                                                                                                                                                                                                                                                                                                                                      |
| #4279               | 09:23        | `1820ee927e` | db: the prize reprice door the engine calls exists. `fn_ca_reprice_unpaid_tournament_place`, applied 09:05:09, md5 `691a3f79a0a36e48f822832d98e12052`                                                                                                                                                                                                                                                                                                                                                                                |
| #4276               | 08:54        | `971f8b19e8` | tournament: an urgent wake keeps its place; ticket-based places in the elimination scheduler                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| #4274               | 08:52        | `4d1aaceed3` | perf: the decided sweep reads every playing count in one read; pass ~11 s, was 55-100 s                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #4269               | 08:38        | `d83e8b94be` | a guard without its consumer refuses nothing. Seat-exit authority close raises only if trigger `zy_tournament_live_seat_exit_requires_authority` exists and is enabled; applied 08:22:40                                                                                                                                                                                                                                                                                                                                             |
| #4267 (Codex)       | 08:24        | `9284d7ec03` | deploy reads valid restart certificates from degraded engines                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| #4266               | 08:23        | `51b6e91aff` | engine: a queue wait never retires an equity worker, and a spent pool recovers (plus Codex #4275/#4277, and #4285 test determinism)                                                                                                                                                                                                                                                                                                                                                                                                  |
| #4263               | 07:56        | `1efd952ecd` | tests: a timing budget is not a coin flip (flaky test de-flaked)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| #4262               | 07:54        | `502cf83f8f` | deploy: a rollback survives the queue, and the train hears its own fixes (engine-tree dedupe)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| #4257               | 07:23        | `4b9ffd3b8b` | deploy: the one-build exception is spent and removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #4256               | 07:22        | `91a049ecfc` | perf: the REGISTERING walk reads the fleet once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| #4255               | 07:21        | `ba6333fd26` | a hand frozen at the break is reaped (`isParkedByDesign`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| #4249               | 07:27        | `53edbd4d10` | the resume budget counts only real losses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| #4247               | 06:46        | `3ab179ac22` | the retention prune, and every root-bound call, run as the process                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| #4244               | 06:12        | `b93be238e4` | an escalated blind is a whole chip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| #4238               | 06:21        | `fcde405674` | deploy train: hands on a refused cutover; a rollback stays a rollback                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| #4235               | 05:37        | `1579ac7c14` | the frozen build can be replaced (one build, one night, Dan's approval)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #4227               | 05:16        | `d47490d19d` | the web publisher hands itself on; no cron, no watchdog                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #4225               | 04:26        | `999b57756e` | the deadline clock belongs to no tournament (horse worker crash fix)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #4218               | 00:20        | `23f00c1bef` | RUNNING re-adoption gets its own lane                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| #4216               | 09-10 23:58  | `ffd317c9b6` | every engine merge starts its own deploy run; the train hands itself on                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #4214               | 09-10 23:39  | `35c96eadd7` | a dead manager cannot recurse the elimination scheduler                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #4212               | 09-10 23:14  | `fdd789d337` | RUNNING re-adoption is budgeted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| #4190 (Codex)       | 09-10 16:51  | `c4881fea3b` | separate action and worker deadlines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| #4243 (other agent) | 08:10        | `198eecc528` | CSP report-only policy is read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Open (should merge):**

- **#4292** `fix/mystery-bust-phase-by-hand-time`, head `8004205650`. Engine `TournamentManagerBase.maybeActivateMysteryBounty` reserves unrecorded heads via `fn_mystery_bounty_unrecorded_head_cents`. The first CI run failed because the schema manifest was stale; I regenerated all three manifests (`gen-schema-manifest.mjs`) and pushed. CI is re-running, then merge.
- **#4296** `fix/satellites-never-feed-a-bounty-target`, head `ceb96f193f`:
  - engine `satelliteTargetIsDeliverable`, so the feeder skips bounty/PKO/Spin targets
  - the client pickers
  - the ruling files plus `.applied.log`
  - its migration was applied 11:38:34
  - Until it deploys, the old feeder logs `TournamentRecurring.satellite_atomic_creation_failed` every time the new DB trigger refuses it. That is noise, not a fault.

### 3.2 Database changes applied this session (all single BEGIN/COMMIT, `lock_timeout`, outside :50-:03)

| Migration                                                               | Applied (UTC) | Key facts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260911081910_a_seat_exit_guard_without_its_consumer_refuses_nothing` | 08:22:40      | Revoked from PUBLIC/anon/authenticated/service_role. Preflight md5 `0811b7a7…`, idempotent `319441969e49923b3ee8d65f8f0b1e82`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `20260911090347_the_prize_reprice_door_the_engine_calls_exists`         | 09:05:09      | md5 `691a3f79a0a36e48f822832d98e12052`. Preflight uses `to_regprocedure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `20260911062048_a_bust_is_ranked_by_when_it_happened`                   | 11:31:54      | New md5s:<br>- `fn_settle_tournament_places` 6181734ff98555ecc04648186f6ebf24<br>- `fn_eliminate_player_legacy_candidate_20260907` 97abb184dc27e3c7a333a6160636f473<br>- `fn_claim_bounty_legacy_candidate_20260907` ea7b6236… (then patched by the mystery migration → d10ceaad9c867902c7407f20151f28b7)<br>- `fn_eliminate_tournament_player_atomic` 9447da284f1a3beb6d51dd87151c080f<br>- `fn_claim_tournament_bounty_elimination` e099757eb087ef222e2fc92030ececaf<br>- `fn_normalize_tournament_final_standings` 45b06c3f8be02940d130c427d5a32519<br>- `fn_ca_tournament_finished_but_not_completed` 6f153669e4b6b149bfccd36ad575bda8<br>Rollback file `docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql` **now refuses the claim function** because the mystery migration re-patched it. Update it before you ever use it |
| `20260911094503_a_bust_belongs_to_the_phase_its_hand_was_played_in`     | 11:32:25      | Mystery mode is decided by the bust hand against the activation receipt; the seed reserves unrecorded heads; `activated_at` is `clock_timestamp()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses`    | 11:38:34      | `fn_satellite_target_is_deliverable` + trigger `satellite_feeds_only_a_deliverable_target` on `tournaments`. Recorded in `schema_migrations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**NOT applied:** `20260911110000` (late status flip keeps the paid ladder) on `backup/claude-2026-09-11/late-status-flip-keeps-paid-ladder`, head `3aaf4ce0c4`.

### 3.3 Rulings (production money/standing writes) applied this session

| Ruling                                                                              | Applied               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mystery phase, `ruling_5aa7eeba.sql`                                                | 10:16:33              | applied; event completed with correct places                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Mystery phase, `ruling_9536150e.sql`                                                | 10:16:55              | applied; completed correctly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Re-sequences fe72385b / 798866ae / 5aa7eeba / 9536150e                              | earlier               | toggled status through `'winner'` (a toggle through `'playing'` is refused while a bounty obligation is pending); completed with correct places. Script `~/tmp-claude/reseq2/body.sql` (vars `:tid`, `:via`), dry runs `dry_*.sql`                                                                                                                                                                                                                                                                                                                                                                        |
| **Satellites into Sunday Funday High Roller PKOs** (targets `8171f9f6`, `e9541c66`) | **12:11:02-12:11:15** | **15 settled, 15 seated (8 into 8171f9f6, 7 into e9541c66), 1 cancelled (`aa7b7b59`)**:<br>- per satellite: 75.00 exact PKO entry to the winner, 20.00 to the bubble, 5.00 rake (club `2a1132b9` treasury or union `fade0000`)<br>- the first two attempts rolled back with zero writes because of the `correction_ref` format; now `migration 20260911110907_…`<br>- postflight A-D all pass; the engine's `unsupported bounty or Spin` line went quiet from 12:11:20; 15 `ca_drift_incidents` resolved<br>- log: `scripts/deploy/2026-09-11-settle-satellites-into-bounty-targets.applied.log` on #4296 |

### 3.4 Investigations completed (full reports in `evidence/`)

- deploy-rescue diagnose/audits (09-10), engine-lease-churn-fix (09-10)
- night investigations, night follow-ups, night audit (14 agents)
- knockout standings, equity pool recovery, elimination-sweep throughput
- review of the knockout migration, batched decided sweep, settle-by-true-bust-time
- stuck-events sweep, satellites, Breakfast Turbo; orphans was still running at export

Decisions taken, with the reasons:

- **Equity worker count stays at 1 on the 3-core host.** Main thread plus horse worker plus equity worker already need about 3 cores.
- **The rakeback `lapsed_week_unclosed` state is deliberate and known.**

---

## 4. RULES OF ENGAGEMENT (hard rules — breaking one is a failure)

1. **Secrets:** never print tokens or passwords. Read `~/Documents/club-arena/.env` inside the command only (`set -a; . ~/Documents/club-arena/.env; set +a`). Never set or change credentials.
2. **Production:** nothing touches production except the operator agent. Every DB write is deliberate and reviewed.
3. **Engine restarts** happen ONLY inside the announced :55 maintenance break (CLAUDE.md §13), through the deploy train.
   - There is deliberately no force input: neither a human nor automation may bypass `readyForRestart` and stop a live table engine.
   - Cancelling a deploy run that has not reached the host is fine (§5.4).
4. **Migrations:**
   - one BEGIN/COMMIT with `lock_timeout` (and `statement_timeout`)
   - never in :50-:03 UTC
   - no DDL probes; preflight is read-only
   - apply detached (nohup/setsid); record in `schema_migrations`
   - regenerate the schema manifests in the PR (`node scripts/ci/gen-schema-manifest.mjs` with SUPABASE_URL and SERVICE_ROLE_KEY from .env), or CI's "New Migrations Were Applied" fails
5. **Freeze:** no money or seat writes :55-:00. Money already paid is never clawed back. A make-good is house-funded through a future audited door; no ad-hoc back-pay migrations (the pre-push check `check-no-new-band-aids` refuses repair/back-pay/backfill paths).
6. **Git:**
   - never `--no-verify`, never rebase (merge only), never force-push
   - commit identity must be `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>` (the pre-commit hook refuses anything else)
   - end commit messages with the session attribution lines
7. **Verification:** never claim success before end-to-end verification in production (health, logs, DB postflight).
8. **Horses are players (§10.5):** same timers, rules and information as humans. Never give a horse hidden information.
9. **`correction_ref`** on `ca_drift_incidents` must match `fn_ca_resolution_needs_a_cause()`: `migration <name>`, `PR #<n>`, `chip_ledger <id>`, `correction:<key>`, `ruling: <decision>`, `verified: <evidence>`, or `no-change-needed: <why>`. Root cause must be at least 40 characters.
10. **Dan's standing directives:**
    - fix at the root, no watchdogs or crons as fixes
    - publish pushes in order
    - harden against regression
    - decide operational calls yourself and report ("STOP ASKING ME")
    - tell him when he is wrong

---

## 5. ADMINISTRATION & LOGISTICS (how to operate)

### 5.1 Reaching things

- **The Mac** (all work happens here): the `counselors__host_terminal` tool, commands under 55 s.
  - `export PATH=/opt/homebrew/bin:$PATH` first.
  - Use `perl -e 'alarm 50; exec @ARGV' <cmd>` instead of `timeout`.
  - Long jobs: `nohup perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV' bash -c '…' >/dev/null 2>&1 &`, then poll a log.
- **psql (prod):**
  `PGPASSWORD=$SUPABASE_DB_PASSWORD /opt/homebrew/bin/psql "host=aws-0-us-west-2.pooler.supabase.com port=5432 dbname=postgres user=postgres.kuklfnapbkmacvwxktbh sslmode=require" -X`
- **GitHub API:** `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/...`.
  - The check-runs API is forbidden: use `actions/runs?head_sha=`.
  - Merge with `PUT /pulls/<n>/merge {"merge_method":"squash","sha":"<head>"}`.
- **Hetzner:** `ssh -i ~/.ssh/hetzner_engine_key -o BatchMode=yes root@5.161.252.33`. The host clock is US Central, so use `date -u`.
- **Prometheus:** from the host, `curl -s http://172.19.0.2:9090/api/v1/alerts` and `/api/v1/query_range`.
  - Key series: `poker_horse_decision_worker_queue_depth`, `poker_horse_decision_worker_oldest_queued_age_ms`, `poker_horse_decision_worker_last_compute_ms`, `poker_equity_governor_scale` (the horse worker), `poker_main_event_loop_governor_scale`, `poker_event_loop_delay_p50_ms`.
- **Local PG17 for rehearsals:** `/opt/homebrew/opt/postgresql@17/bin`, needs `LC_ALL=en_US.UTF-8`. The pg client locally needs `uselibpqcompat=true&sslmode=require`.
- **Helper scripts on the Mac:**
  - `~/tmp-claude/verify_engine.sh`: one-screen `/health` snapshot
  - `~/tmp-claude/prstatus.sh <pr…>`: PR plus actions summary

### 5.2 Worktrees and node_modules

- Worktrees live in `~/Documents/.agent-trees/club-arena/<name>` (~323 registered).
- New worktree: `git worktree add -b <branch> <dir> origin/main`, then symlink `node_modules`.
- **The root `node_modules` in the main checkout lacks the `@capacitor/*` packages main now needs,** so the pre-push root `tsc` fails.
  - Fix: `ln -s ~/Documents/.agent-trees/club-arena/claude-deploy-lease/node_modules node_modules`.
  - `server/node_modules` → `~/Documents/club-arena/server/node_modules`.

### 5.3 PR automation

- Any pushed branch gets a PR (`agent-open-pr.yml`), and the autopilot enables squash auto-merge.
- To publish without auto-merge, use one of:
  - push to `backup/**` (ignored by agent-open-pr)
  - a draft PR
  - a `hold`, `wip` or `do-not-merge` label
- Auto-merge needs only the required checks, so full CI can still be running. The deploy's own server-test step is the last net.

### 5.4 Deploy train (`auto-deploy-hetzner.yml`)

- **Concurrency:** 1 running plus 1 pending (newest). A cancelled run's Verdict hands on with a `workflow_dispatch` on main.
- **Steps:**
  1. checkout the exact commit
  2. resolve an immutable target
  3. dedupe if production already serves it (same engine tree)
  4. server tests
  5. image build
  6. doors check (`check-engine-doors-exist.mjs`)
  7. **wait for the break to park every table**
  8. sealed cutover
  9. Verify (liveness plus version)
  10. promote `:current`
  11. PROVE the version moved
  12. seal commit
  13. ROLLBACK on failure
  14. Verdict
- **Catch:** a run resolves its target at step 2. A merge that lands after a run has started waits for the next break, one hour later, unless you cancel the older run before it reaches the host. I did this at 12:21 so #4295 makes 12:55.
- When a run fails (e.g. a flaky server test), its Verdict hands on with a fresh `workflow_dispatch` on main. Seen at 12:34:43: `34599636898` replaced `34598480706`.

### 5.5 Files you will need (Mac)

- **Satellite ruling:** `~/tmp-claude/sat/ruling_apply.sql` (applied version), `ruling_apply.v1.sql`, `ruling_apply.run3.log`, `apply_migration.sql` / `.log`.
- **Mystery rulings:** `~/Documents/.agent-trees/club-arena/mystery-bust-phase-ruling/` (`ruling_5aa7eeba.sql`, `ruling_9536150e.sql`, `finish_functions.sql`, `rehearse_ruling.sh`, `load_data.sql`). Applied copies are under `~/tmp-claude/mystery/`.
- **Re-sequence tooling:** `~/tmp-claude/reseq2/` (`body.sql`, `commit.sql`, `dry_*.sql`, backups).
- **Breakfast Turbo (my draft):** `~/Documents/.agent-trees/club-arena/c1f15c30-ruling/ruling_c1f15c30.sql` (md5 `e688d1621e65bf09dcf3165c94bbf9d3`), `makegood_optional.sql`.
- **Freeroll rulings and the second balance fix (orphans agent):**
  - `~/Documents/.agent-trees/club-arena/freeze-deferred-balance-redrive/`, branch `fix/freeze-deferred-balance-redrive` (`cf64e76666`), pushed as `backup/claude-2026-09-11/freeze-deferred-balance-redrive`
  - rulings R1/R2/R3 and `MAKEGOOD_undelivered_rebuy_legs_readonly.sql` under `docs/changelog/2026-09-11-freeroll-rulings-7aa16fa7-a5aa6984/`
- **Stuck-event fixes and rulings (sweep agent):** `~/Documents/.agent-trees/club-arena/thaw-balance-sweep/`, also pushed to `backup/claude-2026-09-11/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw`:
  - `scripts/deploy/2026-09-11-wake-the-one-seat-tables.sql`
  - `scripts/deploy/2026-09-11-resequence-inputs.sql`
  - `scripts/deploy/2026-09-11-a5aa6984-the-stranded-rebuy-busted-first.sql`
  - `scripts/deploy/2026-09-11-c1f15c30-keeps-the-ladder-it-paid.sql`
  - `server/src/maintenance/freezeState.ts`
  - `server/src/tournament/TournamentManagerEliminations.ts`
  - `server/src/tournament/aFrozenSweepOwesTheBalancerAPass.test.ts`

---

## 6. OPEN ITEMS — prioritized, each with evidence and exact next steps

### 6.1 P0 — Horse lane capacity (engine degraded)

- **Verified 13:04 UTC on `4895030e`:** ~277 tables, queue 0-15, oldest ≤ 92 ms, 0 expired, ~78 jobs/s (was ~32/s), average hand 20.7 s (was 38.8 s).
  - The post-break surge at 293 tables peaked at queue 206 / oldest 2.3 s with 0 expired, and drained in about 2 minutes.
  - `top -H` at 13:03: horse worker ~86%, main ~76%, equity worker ~61%, host 12.7% idle.
- **Earlier state (for the record):** #4295 removes the idle round-trip gap. At the 12:18 load (311 tables), arrival was about 54 completed/s plus about 13 expired/s, roughly 67/s. Worker CPU was ~80%. At 100% utilization the lane would be at about 68/s, **so it may still sit at capacity.**
- **After the 12:55 cutover, measure:** `oldestQueuedAgeMs`, `expiredJobs` growth, `inFlightJobs`, `avgHandDurationMs`, worker governor scale, and `top -H`.
- **If the queue stays above ~50 or anything expires, in order of speed:**
  1. **Equity pool priority.** The pool worker was at ~94% CPU. Find out what it computes for which tables (`ServerTableEngineRunout.ts`) and whether any gameplay step (insurance, run-it-twice) awaits it. If it is display/EV only, lower that thread's priority from inside the worker: on Linux, `os.setPriority(0, 10)` inside a worker affects that thread only. Then the dealer and horses win the CPU. Test it, document it, and ship it through the train.
  2. **Host upgrade: DECIDED (§10 D2).** engine-01 is Hetzner `cpx21`, id 132435945, 3 shared vCPU / 4 GB, location `ash`, €37.49/mo gross. It moves to `ccx23` (4 dedicated vCPU / 16 GB, €102.99/mo), but only after a timed rehearsal proves the rescale fits inside a :55 break.
  3. **Horse brain separation (§8).** This is the real long-term fix.
  4. **Do NOT** raise the 8 s job timeout, or shed precision by hand. The governor already does that.

### 6.2 P0 — One hung lease heartbeat kills every cash table

- **Evidence:** 2026-09-11 10:59:10. 52 `ServerTableEngine.<id>.watchdog_kill … cash_lease_proof_expired`, then `[lease] heartbeat failed (Error: supabase_timeout)`. Same-minute `supabase_timeout` bursts hit discovery, the bust list and the board read. There was a similar burst at 09:18.
- **Mechanism:**
  - `server/src/services/tableLease.ts`: `TABLE_LEASE_PROOF_WINDOW_MS=20000`, `LEASE_STALE_SECONDS=30`.
  - `GameServer.ts`: `OWNERSHIP_LEASE_RENEWAL_CADENCE_MS = 20000/4 = 5000`.
  - `services/supabase/client.ts`: `DB_TIMEOUT_MS = SUPABASE_TIMEOUT_MS ?? 15000`.
  - A pass at t0 succeeds (proof until t0+20). The pass at t0+5 hangs until t0+20 and times out exactly as the proof expires, so every verified cash dealer self-terminates. One hung request is enough.
- **Fix to write. Prefer hedged heartbeats over a short timeout.** I analysed both:
  - **Option A, a per-attempt deadline** (e.g. race the RPC against 4.5 s): three attempts fit in the 20 s window. **But it regresses a slow-but-alive database.** If every heartbeat takes ~6 s, today's code succeeds (a pass starting at t0+5 answers at t0+11 and proves until t0+25). With a 4.5 s cut, every attempt is abandoned and all dealers expire. Do not ship A alone.
  - **Option B, hedged (overlapping) heartbeats (recommended):**
    - The renewal loop starts a new heartbeat every cadence (5 s) even while an older one is still pending, bounded to 3 in flight.
    - Each answer applies its own proof, anchored at that request's start. `renewEngineLeaseProof` already keeps the greatest deadline ("concurrent renewal callers can complete out of order… keep the greatest one").
    - A hung request no longer blocks the next attempt, and a slow one still counts when it lands.
    - Work: `GameServer.runOwnershipLeaseRenewalLoop` / `renewOwnedEngineLeaseProofs` (currently single-flight), for both scopes (`heartbeatTables`, `heartbeatTournaments`).
    - Keep every fail-closed rule: UNKNOWN extends nothing, busy extends nothing, and taken/stale/missing is a loss.
    - Make sure a late 'answered' loss from an older pass cannot override a newer proof unless it is a genuine taken/stale/missing, and reason through the DB ordering carefully.
    - Overlapping `heartbeat_table_leases_v4` calls on the same rows return `busy` rather than block. Confirm in its SQL.
  - **Tests** (fake monotonic clock, `_setTableLeaseMonotonicNowForTests`): one hung attempt plus a later healthy attempt must NOT expire dealers; a uniformly 6 s-slow DB must NOT expire dealers; three genuinely failed windows still must. Add a law test and a changelog.
  - **Fence-and-suspend** (instead of kill-for-restart), **DECIDED: not now.** Ship Option B first. Build fence-and-suspend only if a kill storm still happens after Option B is live (§10 D6).
- **Related noise after a storm:** "33 x GameServer.table_lease_lost … to another engine instance". Only one instance exists; these are re-admissions. Check them after the fix.

### 6.3 P1 — Merge and ship the open PRs

- The freeze was removed at 12:47:26; see BLUF item 5.
- #4292 merged at 12:5x as `5a7abc7706`; it deploys at the 13:55 break. Verify that the mystery activation logs no `mystery_bounty_unrecorded_heads_unreadable`.
- #4296 merged as `6d7b08515c`; it deploys at 13:55. Verify that `satellite_atomic_creation_failed` stops.
- #4299 (this handoff) and the freeze-guard PR (`fix/no-merge-gate-without-a-producer`) should auto-merge. Confirm.
- After each deploy: `/health` version, the engine log greps, and the doors step green.

### 6.4 P1 — 59 tournaments that cannot finish (ORDER IS MANDATORY)

Evidence: `evidence/2026-09-11T1230-stuck-events-investigations.md` (sweep, 12:13 UTC).

**A. 57 one-seat-per-table events**

- 402 horses, pools of 17,572.20. Largest: 7d6f3d3b (43 players on 43 tables) and 2dbc9bb6 (35 on 35).
- **Root cause:** a one-player table never deals, so it never wakes the balancer. The only sweep is the one at adoption, and adoption happens inside the :55 freeze, where the balance stage is skipped. After the thaw nothing asks again. The balancer's earlier refusals (01:31-01:55, "Table break … incomplete - 0/1 moved") came from the seat-exit guard, which was fixed at 08:22.
- **Fix branch:** `backup/claude-2026-09-11/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw`, head `2b6b5c6687`, code commit `26e727c8cc`:
  - `freezeState.onNextMaintenanceThaw()`
  - one urgent sweep per manager per freeze, spread over 10 s; single-table formats never arm
- **The sweep agent's original steps. SUPERSEDED: run E2 first, then follow §10 D11's order:**
  1. Apply the **7 at-risk re-sequences** first (94 toggles; ordered lists in `scripts/deploy/2026-09-11-resequence-inputs.sql`): bee519fa 11, f922df63 12, 313a274b 9, 7aa16fa7 26, e3ef32fd 5, 8e16cdb4 11, d7997aef 20. No place money has been paid in any of them, so there is nothing to claw back. Rehearse on PG17 with `~/tmp-claude/reseq2` tooling.
  2. Run `2026-09-11-wake-the-one-seat-tables.sql`. It refuses unless still-57, outside :50-:03, and zero paid-range misorders. It emits 57 wakes via `fn_emit_tournament_manager_wake(id,'bounty_settled')`. Rehearsed: it refused with "48 standings out of order" until the toggles were applied.
  3. Open a PR from the backup branch; auto-merge and deploy.
- **Warning:** a deploy of this fix before step 1 could finish those events in the old order.

**B. a5aa6984 Early Bird Freeroll** (needs a ruling):

- river222 (`dca6c345`) busted in hand 8569325 at 09-09 06:13:09; that candidate is still pending.
- A 1.00 rebuy was charged at 06:28:26 and his stack reset to 2500, but he was never re-seated. Chip check: 320000 on the felt against 317500 issued.
- Proposal: `2026-09-11-a5aa6984-the-stranded-rebuy-busted-first.sql`:
  - resolve candidate `d0ac2895` as eliminated and set his chips to 0
  - re-sequence (a 99-toggle exact version, or a 10-toggle minimal version)
  - payouts total 99.30: MIAJordan 27.85, d.kim94 16.00, and so on
  - record river222 as owed 1.00
- **Not rehearsed.** Rehearse it on PG17 first. Zeroing his chips without the ruling would pay him second place.

**C. c1f15c30 Breakfast Turbo**, COMPLETING since 09-08:

- Every retry is refused with "place obligation outside its derived ladder" (121 in the 10:55 hour).
- All six places were already paid (180.00) against the six-place ladder. A late REGISTERING→COMPLETING flip rewrote `payout_structure` to four places.
- Two candidate scripts:
  - `thaw-balance-sweep/scripts/deploy/2026-09-11-c1f15c30-keeps-the-ladder-it-paid.sql`: restores the six-place ladder as the service role; the engine completes and pays nothing new; rehearsed end to end locally, terminal completion not rehearsed
  - my earlier `c1f15c30-ruling/ruling_c1f15c30.sql`
- **DECIDED (§10 D10):** use `ruling_c1f15c30.sql` (md5 `e688d1621e65bf09dcf3165c94bbf9d3`). Apply it after migration `20260911110000`, outside :50-:03, as the whole file, and **no re-sequence** (the completion door refuses one once settled place evidence exists).
- Then record the **121.45 make-good** on the six-place (v3) basis with `makegood_optional.sql` (five 'proposed' `ca_manual_adjustments` rows), paid later through the make-good door. It is not waived: horses are players.
- **Also apply the trigger fix** (`20260911110000`, backup branch `late-status-flip-keeps-paid-ladder`): review, apply, record, regenerate the manifests, open a PR. Otherwise the rewrite recurs.

**D. 79 REGISTERING events from 09-08 12:49-14:51**:

- horse-only, played, never went RUNNING; together they hold 2,164.60 in pools
- **DECIDED policy (§10 D9)**
- moving them straight from REGISTERING to COMPLETING trips the same paid-ladder rewrite, so apply the trigger fix first

**E. Orphans: 7aa16fa7 and a5aa6984.** The orphans agent finished at 12:40; full report in `evidence/…stuck-events-investigations.md` under "investigate:orphans".

- **Chip drift:** every hand conserved chips; all the drift happened outside hands.
  - 7aa16fa7 is +10,000: 145,000 created minus 135,000 lost. 27 rebuys were charged but never delivered. tankChamp got +115,000 from a since-deleted repair re-seat. Six players were seated with 10,000 against one 5,000 purchase each.
  - a5aa6984 is +2,500.
  - Created chips are NOT taken back (standing rule). The code paths responsible are already fixed or deleted.
- **31 undelivered rebuy charges × 1.00 = 31.00 are owed** (7aa16fa7: 27 charges to 25 players; a5aa6984: 4).
  - `fn_settle_tournament_refund_exact` cannot be used on these events: before the finish it breaks the escrow balance, and after the finish it is refused.
  - So they belong in the house-funded **make-good door**. List: `MAKEGOOD_undelivered_rebuy_legs_readonly.sql` (31 rows, none already refunded).
- **River222 (a5aa6984):** refund, not honour. The rebuy came 14m47s after his window closed at 06:13:39. The current code would refuse that purchase.
- **Rulings:** in `~/Documents/.agent-trees/club-arena/freeze-deferred-balance-redrive/docs/changelog/2026-09-11-freeroll-rulings-7aa16fa7-a5aa6984/`.
  - **R1** `R1_a5aa6984_record_river222_bust.sql`: sets his mirror chips to 0, calls `fn_eliminate_tournament_player_atomic(tid, river222, 2, 0, 0)`, then wakes the manager. **Rehearsed on PG17 through the real final settlement: COMPLETED, 99.30 paid in true order.**
  - **R2** `R2_7aa16fa7_wake_stalled_manager.sql`: one wake, applied outside :53-:00.
  - **R3** (optional): wakes all of the 57.
- **tankChamp: DECIDED (§10 D1).** He is ranked by his true bust, hand 8775892 at 09-09 22:35:09, so he finishes **36th (1.94)** and the 23 players between move up one place. His 13th place (4.37) exists only because of chips a deleted repair created. No prize money has moved in 7aa16fa7, so nothing is clawed back. Implement it inside the 7aa16fa7 ruling, before the wake. Rehearse on PG17 first.
- **The orphans agent touched production beyond plain SELECTs:**
  - two calls of the VOLATILE `fn_ca_tournament_place_amounts` (read only)
  - a full-schema `pg_dump` that held ACCESS SHARE locks on ~1,366 tables for ~4 minutes (nothing waited)

**E2. RECONCILE the two agents before acting. They disagree.**

- **The sweep agent says:** apply the 7 re-sequences (94 toggles) before any wake or deploy of the balance fix, or the events pay in the old order. Its wake script refuses while "standings out of order".
- **The orphans agent says:** the live `fn_settle_tournament_places` (from migration 20260911062048) already re-ranks everyone by bust time before paying, whenever no prize money has moved. Its PG17 rehearsal of a5aa6984 paid in true order with no re-sequence.
- **Next agent:** rehearse one of the seven (e.g. bee519fa) on PG17 through final settlement without toggles.
  - If it pays in true order, the re-sequences are unnecessary for money; drop the wake script's misorder guard, or keep it as a safety check.
  - If it doesn't, apply the toggles first.
  - Also check whether any bust inside the paid range creates a place obligation at bust time. If it does, settlement could not re-rank that place.

**E3. There are TWO competing code fixes for the same "frozen balance step" defect. Pick one or merge them.**

- **Sweep agent:** `backup/claude-2026-09-11/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw` (`26e727c8cc`). A thaw listener arms one urgent sweep.
- **Orphans agent:** `fix/freeze-deferred-balance-redrive` (`cf64e76666`, **local only, not pushed**, worktree `freeze-deferred-balance-redrive`). Adds a retry when the balance step runs out of its 5 s budget. Law test `aDeferredBalanceIsStillOwed.law.test.ts`.
- **DECIDED (§10 D11):** ship the orphans version (it covers the freeze skip and the budget exhaustion). Retire the sweep branch unless its thaw listener adds something the redrive lacks.

**F2. Satellite-seated PKOs with empty bounty pools (from the satellites report):**

- PKOs `3f19bd70` (66 entrants) and `a21c0cb6` (155 entrants) were seated entirely by satellites last week.
- Their bounty pools of 2,310.00 and 5,425.00 hold **no money** (`bounty_in` 0), and no bounties were paid. The critical alerts are still open.
- This is a separate incident with no ruling yet.
- **DECIDED (§10 D7):** PKO/bounty/Spin events get **no satellite feeders** until bounty-aware satellite settlement ships, built on top of Phase 3 (the Phase-3 activation script pins the settlement function and receipt reader by md5). The creation guard (migration 20260911110907) stays. The unfunded bounty pools of `3f19bd70` and `a21c0cb6` are paid through the make-good door (§10 D8), computed from each knockout record; nothing is clawed back.

**F. Unexplained:**

- 57a417c5 had a bust at 09:15:53 that was not recorded until the 10:56 restart.
- The satellite settlement function checks the four-table cap while the satellite is still RUNNING, so the winner's own satellite seat counts. That yields tickets where seats were possible: 38 tickets against 116 seats since 09-09. The function is Phase-3-pinned; fixing it needs a ruling on design.

### 6.5 P2 — Known defects not yet addressed (from the audits)

- Guard triggers on `tournaments` found **disabled**: `zzzz_freeze_finalized_tournament_prize_pool` plus six others. Decide re-enable or retire, with tests. **UNVERIFIED** who disabled them; see the night-audit evidence.
- `fn_settle_tournament_places_by_ruling` is broken for non-satellite events.
- Satellites and final-table deals still rank in recording order, not bust-hand order; the #4293 migration covered settle and the doors only.
- 271 rebuy legs recorded within 10 s of each other: possible double charges. **Uninvestigated.**
- 15 misallocated completed events (~1,437) plus mystery make-goods need a house-funded **audited make-good door**. Never claw back. **DECIDED: build it (§10 D8).**
- `SpinUnfilledBacklog`: 29 Spins past their fill deadline. `fn_spin_expire_unfilled` is supposed to run on the engine timer; investigate why it isn't.
- `StatsAllInEquityCoverageLow` (98.4%). Probably equity-pool expirations under load (`queueExpirations`); connects to §6.1.
- `TournamentSeatlessPhantoms` (1), `TournamentNeverStarted` (1). Identify both with the SQL in the alert descriptions (Prometheus rules).
- Task #11 ("a table frozen mid-hand inside a break is reaped and re-parked, so a broken build can still certify") shipped as #4255. Verify at the next break: `maintenance.unparkedTables` should reach 0 and `readyForRestart` true.
- Deploy pipeline edge cases, now covered by #4262: a pending rollback survives replacement, and a workflow-only fix starts a run. **DECIDED: no production rollback drill** (it would cost two real restarts). The #4238/#4262 law tests cover it; re-verify only when the train changes.
- REGISTERING pass serial count sweep: batched by #4256 and #4274.
- **Flaky deploy-blocking test:** `server/src/engine/CryptoRandom.test.ts` "deals the ace of spades to a uniform position".
  - A chi-square test over the real CSPRNG with a fixed critical value (32.91), so it fails by chance at roughly its significance level.
  - It failed deploy run `34598480706` at 12:34:40 UTC.
  - Fix: a much lower false-failure rate (e.g. a critical value for p=1e-6, or 3 trials that must all fail). Keep it a real test of the shuffle; don't seed away the CSPRNG.

---

## 7. PICK-UP CHECKLIST (do these in order)

1. **DONE 13:04: the 12:55 cutover to `4895030e` is verified (BLUF item 1).** Keep watching the lane through the next busy hour. The commands, for re-checks:
   - `bash ~/tmp-claude/verify_engine.sh` → `version 4895030e`, `status ok`
   - `curl -s https://engine.smarter.poker/health | python3 -c "import json,sys;h=json.load(sys.stdin)['liveHorseDecision'];print(h['queueDepth'],h['inFlightJobs'],h['oldestQueuedAgeMs'],h['expiredJobs'])"`
     - expect `inFlightJobs` ≤4 and `oldestQueuedAgeMs` in the tens of ms at moderate load
     - expect `expiredJobs` flat
   - the deploy run `34599636898` Verdict is green (if it failed on the CryptoRandom flake again, the train hands on; check the newest run)
   - if the cutover failed: read the run logs (`actions/jobs/<id>/logs`) and the ROLLBACK step. Do not force anything.
2. **Watch the lane through the next busy hours:** Prometheus queue depth and oldest age, `avgHandDurationMs`, and `top -H`. Execute §10 D2 (host rescale, rehearsal first) and D3 (equity-worker priority). Report capacity to Dan with numbers.
3. **Verify the 13:55 deploy** of #4292 and #4296 (both merged). Confirm that #4299 (handoff) and the freeze-guard PR merged. If `Stage B Release Freeze`, or any required check with no producer, reappears in the `main protection` ruleset, remove it (Dan's order) and tell Dan.
4. **Write the lease heartbeat fix** (§6.2): PR, CI, merge, deploy, verify. Next time a supabase_timeout burst hits, the kills should not happen.
5. **Stuck tournaments** (§6.4 A/E/E2/E3):
   - first reconcile the two agents on PG17 (E2)
   - then apply R1 for a5aa6984 (rehearsed)
   - then either the re-sequences plus wake, or the wakes directly
   - then one combined balance fix PR (E3)
   - tankChamp is ranked by his true bust (§10 D1); implement it in the 7aa16fa7 ruling before the wake
6. **c1f15c30:** trigger migration `20260911110000` (review and apply), then the ladder restore. Then a5aa6984 (rehearse, then apply).
7. **79 REGISTERING events:** apply the decided policy (§10 D9).
8. **P2 list** (§6.5), with an audit and a fix for each.
9. **Architecture** (§8): **DECIDED: build the horse brain** (§10 D5), phase by phase.
10. Keep this handoff current and append to it.

---

## 8. ANNEX — HORSE BRAIN / ENGINE SEPARATION (DECIDED: build it, §10 D5)

### 8.1 Is Dan right?

**Mostly yes, for the long term, but not for today's incident:**

- **Not today's root cause:** the lane idled on one-at-a-time dispatch (#4295). At 11:50 the box still had CPU headroom. At 311 tables (12:18) it is genuinely near saturation (11% idle), so capacity is now also real.
- **Separation buys:**
  1. Horse compute can scale to N cores and N lanes without touching the dealer.
  2. A horse-side crash stops restarting the whole engine. Today a worker failure is process-fatal and voids every table's hand.
  3. Stronger fairness: a brain on another machine physically cannot read the deck or other seats' cards.
- **Where he would be wrong:** a naive split (public internet, no fallback, no deadline) turns a network blip into every horse timing out. That is worse than today. The design below avoids it.

### 8.2 Target architecture

- **Service:** `horse-brain`, the same repo and the same TypeScript. A new entry point runs `HorseDecisionWorkerRuntime` lanes in worker threads on its own box. HorseLogic, HorseMind, the GTO charts, postflop/V31 stores, the governor and the deep "second look" all move unchanged. They already hydrate from and persist to Supabase inside the worker (`HorseMindPersistence`, `BrainTelemetryFlush`, the loaders).
- **Box:** a Hetzner dedicated-vCPU server in the **same location** as engine-01, on a **private network** (Hetzner Cloud Network, or WireGuard). No public port. Size: 4-8 vCPU to start. The per-job compute measured today is 2-113 ms, and one lane is about one core.
- **Transport:** one persistent authenticated stream per engine instance, carrying exactly today's messages (`protocol.ts`), plus:
  - a protocol-version handshake
  - HMAC or mTLS
  - heartbeats
  - per-lane FIFO with the same `requestId`/`fence`/`generation` checks
  - the same `maxInFlight` window
  - Private-network RTT is about 1 ms; horse think time is 250 ms-13 s by design, and queue plus RTT is absorbed into think time (`remainingThinkMs`).
- **Engine side:** implement `WorkerLike` (`postMessage`, `on('message'|'error'|'exit')`, `terminate`) over the stream and inject it through `LiveHorseDecisionWorkerClient`'s existing `workerFactory`. The table code (`ServerTableEngineTurns.ts`) does not change.
- **Hot standby (no loss of function):**
  - keep today's in-process worker hydrated and idle, and mirror `OBSERVE_COMPLETED_HAND` / `COMMIT_DECISION_EFFECTS` to it so its HorseMind stays warm
  - if the brain disconnects or misses a short per-decision deadline (e.g. min(1.5 s, remaining think time)), the job is re-issued on the local lane with the same fence
  - count fallbacks on `/health` and alert on them
- **Multi-lane (phase 2):**
  - partition decisions by `tableId` hash across lanes
  - replicate HorseMind by broadcasting observations and effect commits to every lane in the same order
  - exactly one lane persists (leader), to avoid double writes
  - measure memory per lane first; the solver stores are large (charts 240, postflop 7747 cells)
- **Security:**
  - the snapshot validator stays: no private seat cards leave the engine, and the brain validates again
  - the brain's DB role can read charts/mind and write only its own mind and telemetry tables; no deck, seed or money access
  - network ACL admits only engine-01
- **Deploys:** a separate `horse-brain` train, so engine restarts no longer restart the brain. Refuse a protocol-version mismatch at handshake, and extend the "doors" gate to the brain protocol.
- **Observability:** brain `/health` (lanes, queue, governor, persistence); engine `/health` gets `remoteLane` (connected, RTT, fallbacks); Prometheus scrape; alerts `HorseBrainUnreachable`, `HorseFallbackActive`, `HorseQueueAgeHigh`.
- **Rollout:**
  1. shadow: the engine decides locally, sends to the brain as well, and compares action distributions and latency; never acts on the brain
  2. canary: 10% of tables by hash
  3. 100%
  4. then retire the local lane to standby-only
- **Effort and cost:** about 3-5 engineering days, plus one Hetzner `ccx23` in `ash` (4 dedicated vCPU / 16 GB, €102.99/mo gross per the Hetzner API). Put it on a Hetzner Cloud private network (network zone `us-east`) with engine-01 attached. Provision it only when the phase-1 code is ready for shadow mode, not before. The Hetzner API token is in the shared `.env` as `HETZNER_API_TOKEN`; never print it. **Approved (§10 D5).**
- **Interim, no new box:** pin the horse worker and equity worker threads at a lower priority than the main thread (see §6.1), or upgrade engine-01.

---

## 9. COMMAND & SIGNAL

- **Owner:** Dan (daniel@pepnationrx.com). He wants direct numbers, root-cause fixes, no watchdogs, and no questions he has already answered. Report outcomes with evidence.
- **Other agents active on this repo:** Codex (the `agent/codex-*` branches, e.g. #4291 realtime and #4232 stage B) and the autopilot bot. Their open PRs are not yours to merge unless Dan says so. Watch for their deploys; build 80769f9b at 11:56 was Codex #4289.
- **Evidence and raw reports:** `docs/handoffs/2026-09-11-claude/evidence/*.md`.
- **This session's attribution** (put it on commits):
  - `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_01HPVofHJE7bzt6h73ZhZ8BL`

---

## 10. DECISIONS — made 2026-09-11 ~13:20 UTC and binding for the next agent

Dan (13:15 UTC): "NONE OF THESE ARE FOR ME TO DECIDE THEY ARE ALL ON YOU." Every item earlier versions left to Dan is decided below. Execute these. Do not send them back to him as questions. Report outcomes with numbers.

**D1. tankChamp (7aa16fa7): ranked by his true bust.**

- His real bust is hand 8775892 at 09-09 22:35:09. A since-deleted repair then re-seated him at 22:40:01 with 115,000 chips that never existed, and he busted again later.
- A re-seat by a bug is not a rebuy, so the "latest eliminated candidate" rule does not apply to it.
- Result: **36th (1.94)** instead of 13th (4.37); the 23 players between move up one place.
- No prize money has moved in 7aa16fa7 (no payouts, no obligations), so nothing is clawed back. The created chips he lost were won by other players, and they keep them (the no-clawback rule).
- **How:**
  1. Before the 7aa16fa7 wake (R2), in one transaction and after a PG17 rehearsal through final settlement, make his elimination record carry hand 8775892's commit time. Use the same witness/commit-time source `fn_settle_tournament_places` uses (`hand_atomic_commits` / knockout candidates).
  2. Verify the rehearsal's final standings match the orphans report's true order, with tankChamp at 36.
  3. Then wake.

**D2. Engine host: rescale `club-arena-engine` from `cpx21` (3 shared vCPU / 4 GB, €37.49/mo) to `ccx23` (4 dedicated vCPU / 16 GB, €102.99/mo), gated on a rehearsal.**

- **Why:** after #4295 the lane keeps up at ~277 tables, but the host runs at ~83-87% CPU with 12.7% idle. Main thread, horse worker and equity worker each want a full core. Dedicated cores also remove noisy-neighbour steal.
- **Rehearsal first (no production impact):**
  1. Create a throwaway `cpx21` in `ash` from the same image family.
  2. Put a dummy container on it with `restart: always`.
  3. Time power-off → `change_type` to `ccx23` with `upgrade_disk: false` (keeps it reversible) → power-on → container up.
  4. Delete the throwaway.
- **Production:**
  - Only if the rehearsal is ≤ 3 minutes end to end.
  - Only in a quiet :55 break with **no deploy**, after `/health.maintenance.readyForRestart` is `true`.
  - `docker stop -t 45 club-arena-engine` (a graceful drain inside the break), then power off, `change_type`, power on.
  - Verify `/health` 200, version unchanged, tables resume at :00.
- **If the rehearsal exceeds 3 minutes:** do not rescale in place; the horse brain (D5) carries the capacity instead.
- Use `HETZNER_API_TOKEN` from `.env` and never print it. Nothing here bypasses `readyForRestart`.

**D3. Equity worker priority: lower it if nothing in gameplay waits on it.**

1. Read `ServerTableEngineRunout.ts` and every caller of `getEquityPool()`.
2. If no hand-flow step (insurance offer, run-it-twice, showdown timing) awaits the pool's result, have the equity worker lower its own thread priority at start (`os.setPriority(0, 10)` inside the worker thread affects only that thread on Linux).
3. Ship it through the train with a test, and watch `StatsAllInEquityCoverageLow`.
4. If a gameplay step does await it, leave the priority alone and record why in the changelog.

**D4. Merge freezes and ruleset writes by agents: closed.**

- The unauthorized `Stage B Release Freeze` is gone. The law test (`fix/no-merge-gate-without-a-producer`, PR #4301) pins that every required check has a producer, that nothing is named as a freeze, and that only two scripts may write rulesets.
- **Decided:** agent tokens become read-only on repository administration.
  - Agents are barred by standing rule from creating or changing credentials, so the one physical step (regenerating the shared token with Administration: Read only, then swapping it in `.env`) has to be done from the GitHub account's settings page.
  - Until then, the next agent re-reads the `main protection` ruleset at the start of every session and after every merge.
  - It removes any required check that no workflow produces, and records the ruleset history version and actor.

**D5. Horse brain: BUILD IT** (design §8).

1. **Phase 1:** a remote lane on its own box.
   - Provision a `ccx23` in `ash` with a private network (zone `us-east`) and attach engine-01. Do this when the code reaches shadow mode.
   - Shadow first: the engine decides locally and the brain's decisions are only compared.
   - Then canary 10% of tables by hash, then 100%.
   - The in-process worker stays as the hot standby.
2. **Phase 2:** multi-lane with replicated HorseMind.
3. **Invariants:**
   - no other seat's cards ever leave the engine
   - same timers and rules as humans
   - fallback to the local lane on any brain miss
   - the brain has no deck, seed or money access

**D6. Lease kill storms: ship Option B (hedged heartbeats) first** (§6.2). Fence-and-suspend is not built unless a storm still happens after B is live.

**D7. Satellites into bounty/PKO/Spin targets stay refused** until bounty-aware satellite settlement ships, built on top of Phase 3. The creation guard stays.

**D8. Build the audited make-good door (house-funded; never claw back).**

- **Mechanism:**
  - owed items are `ca_manual_adjustments` rows in status 'proposed' (as `makegood_optional.sql` writes them), each with evidence and amount
  - one SECURITY DEFINER door pays one item from a house make-good source; it is idempotent per item, refuses negative amounts and anything already paid, and writes the ledger and an audit record
  - the executing role is the server only (revoke PUBLIC/anon/authenticated)
  - the pre-push check `check-no-new-band-aids` refuses migrations that declare repair/back-pay/backfill paths, so name and justify the door as the audited payment authority in that check's terms, never as a backfill
- **Items to load, then pay:**
  - 31.00 in undelivered rebuy charges (`MAKEGOOD_undelivered_rebuy_legs_readonly.sql`, 31 rows)
  - 121.45 for c1f15c30 (D10)
  - the 15 misallocated completed events (~1,437; list in the knockout/settle evidence)
  - the mystery make-goods
  - the unfunded bounty pools of `3f19bd70` and `a21c0cb6` (compute each knockout's bounty from its record)
- Horses are paid like any player.

**D9. The 79 REGISTERING events from 09-08 (horse-only, played, never RUNNING; 2,164.60 in pools).**

1. Apply migration `20260911110000` first, so a status flip cannot rewrite a paid ladder.
2. Then, per event, in batches of 10 or fewer, outside :50-:03, each batch rehearsed on PG17:
   - **no place money moved and play produced a winner:** complete through the normal terminal door; `fn_settle_tournament_places` ranks by true bust time
   - **place money already moved:** the paid record stands (no re-sequence, as with c1f15c30); restore the contract the places were paid against if it was rewritten; complete; put any true-order difference on the make-good door
   - **no valid finish** (no winner or no bust record): refund every entry exactly with `fn_settle_tournament_refund_exact` before terminal completion
3. Record one audit row per event.

**D10. c1f15c30 Breakfast Turbo:**

1. Apply migration `20260911110000` (branch `backup/claude-2026-09-11/late-status-flip-keeps-paid-ladder`, `3aaf4ce0c4`).
2. Then apply `ruling_c1f15c30.sql` (md5 `e688d1621e65bf09dcf3165c94bbf9d3`) as the whole file. It restores the paid six-place v3 ladder, completes through `fn_complete_tournament_terminal`, pays no new prize money, and settles the 20.00 fee.
3. No re-sequence.
4. Record the 121.45 make-good with `makegood_optional.sql`. Not waived.

**D11. The stuck-tournament balance fix:** ship the orphans agent's `fix/freeze-deferred-balance-redrive` (`cf64e76666`, pushed as `backup/claude-2026-09-11/freeze-deferred-balance-redrive`).

- It covers both the freeze-skipped balance step and the budget-exhausted one.
- Retire the sweep agent's `a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw` unless its thaw listener adds something the redrive lacks; read both and write down which.
- Order: the E2 rehearsal, then R1 (a5aa6984), then the 7aa16fa7 ruling with D1, then the wakes (or the fix's first thaw), then the PR.
- Add the `docs/laws.d` entry its law test needs.

**D12. Other open defects, all decided "fix":**

- **The seven disabled guard triggers on `tournaments`** (including `zzzz_freeze_finalized_tournament_prize_pool`): re-enable all of them in one migration after a PG17 rehearsal of start, late-reg close, completion, ruling and refund. A trigger that blocks a legitimate flow gets its logic fixed in the same migration; none stays disabled.
- **`fn_settle_tournament_places_by_ruling`:** it fails for non-satellite events (fee order, its own frozen batch, no terminal receipt, leaves the ladder). **Retire it for non-satellite use** and standardize rulings on the c1f15c30 pattern: restore the contract, complete through the normal door, write an audit record.
- **Satellites and final-table deals:** extend bust-time ranking to them with the same witness ordering as `fn_settle_tournament_places`.
- **The 271 rebuy legs within 10 s:** investigate. Any double charge goes on the make-good door. The code path is already fixed (a rebuy is tied to a specific bust and seated in the same transaction).
- **The flaky `CryptoRandom.test.ts` shuffle test:** move its critical value to p≈1e-6 (or require 3 failing trials), keeping the real CSPRNG.

**Operator handover:** from ~13:20 UTC this Cowork session takes **no further production actions**. The other agent Dan started is the sole operator. Two operators on one production is how conflicting writes happen.
