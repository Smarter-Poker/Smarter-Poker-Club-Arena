# CLUB ARENA — OPERATIONAL HANDOFF (OPORD FORMAT)

**From:** Claude (Cowork session `635ed867`, operator: Dan) · **As of:** 2026-09-11 ~12:35 UTC · **Classification:** internal, contains hosts/IDs, no secrets

> **Read this whole document before touching production.** Section 7 is the ordered pick-up checklist. Section 4 lists the rules; they are hard rules. Everything this document says was measured or written this session. Anything unverified is marked **UNVERIFIED**. The raw evidence is in `docs/handoffs/2026-09-11-claude/evidence/`:
>
> - 13 workflow reports
> - the stuck-event investigations
> - the verbatim session summary from the 11:42 context compaction

---

## 0. BLUF (bottom line up front)

1. **The engine is degraded right now, and its horses are the bottleneck.**
   - Build `80769f9b` has run since the 11:56 UTC restart. At 12:18 UTC: 311 dealable tables, and 311-349 horse decisions queued in the live HorseLogic lane. The oldest was 6.7-8.0 s old against an 8 s budget.
   - 11,624 decisions expired between 11:56 and 12:18. An expired decision means the horse takes its fail-safe action (check/fold).
   - Average hand time is ~35.6 s, and host CPU is 85% user.
   - **Root cause #1 is fixed and shipping:** #4295 (merged as `4895030e22`).
   - **Root cause #2, capacity, is not fixed.** See §6.1 and the horse/engine separation design in §8.
2. **Deploy in flight:** run `34598480706` (workflow_dispatch, main `4895030e22`) cuts over in the **12:55 UTC maintenance break**. It carries:
   - #4270: the deploy gate reads a degraded engine's 503 body
   - #4293: settle and doors rank a bust by hand time (engine side)
   - #4295: the horse lane is pipelined
   - **First action for the next agent:** verify it after 13:00 (§7 step 1).
3. **Also degraded:** a single hung lease heartbeat can kill every cash table. At 10:59:10 one 15 s heartbeat timeout killed 52 cash tables. The fix is designed but not written (§6.2).
4. **Money/tournament state:** all rulings applied today verified clean, and the satellite ruling closed at 12:11 (15 settled, 15 seated, 1 cancelled). Still open:
   - 59 tournaments cannot finish on their own: 57 one-seat-per-table events, plus c1f15c30 and a5aa6984. The fix and rulings are prepared, but ordering is mandatory (§6.4).
   - 79 horse-only REGISTERING events from 09-08 need a ruling.
5. **Two PRs are open and should merge:** #4292 (mystery engine follow-up; manifests regenerated, CI re-running) and #4296 (satellite feeder; its migration is already applied).
6. **Two backup branches must NOT be merged before their preconditions:**
   - `backup/claude-2026-09-11/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw`
   - `backup/claude-2026-09-11/late-status-flip-keeps-paid-ladder`
   - `backup/**` branches do not auto-open PRs.

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

| Time                | Build                                                       | What                                                            |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| 06:57               | #4225 via Dan's one-build exception (#4235, spent by #4257) | deadline clock fix                                              |
| 08:55               | `9284d7ec`                                                  | #4266 equity pool recovery, #4267 degraded-cert reads, and more |
| 10:55               | `c113fbe7`                                                  | #4274, #4276, #4275, #4277, #4279, #4281, #4285                 |
| 11:56               | `80769f9b`                                                  | Codex #4289 (restart at 11:56:00; not mine)                     |
| **12:55 (pending)** | **`4895030e22`**                                            | #4270, #4293, #4295. Run `34598480706`                          |

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

### 5.5 Files you will need (Mac)

- **Satellite ruling:** `~/tmp-claude/sat/ruling_apply.sql` (applied version), `ruling_apply.v1.sql`, `ruling_apply.run3.log`, `apply_migration.sql` / `.log`.
- **Mystery rulings:** `~/Documents/.agent-trees/club-arena/mystery-bust-phase-ruling/` (`ruling_5aa7eeba.sql`, `ruling_9536150e.sql`, `finish_functions.sql`, `rehearse_ruling.sh`, `load_data.sql`). Applied copies are under `~/tmp-claude/mystery/`.
- **Re-sequence tooling:** `~/tmp-claude/reseq2/` (`body.sql`, `commit.sql`, `dry_*.sql`, backups).
- **Breakfast Turbo (my draft):** `~/Documents/.agent-trees/club-arena/c1f15c30-ruling/ruling_c1f15c30.sql` (md5 `e688d1621e65bf09dcf3165c94bbf9d3`), `makegood_optional.sql`.
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

- **State:** #4295 removes the idle round-trip gap. At the 12:18 load (311 tables), arrival was about 54 completed/s plus about 13 expired/s, roughly 67/s. Worker CPU was ~80%. At 100% utilization the lane would be at about 68/s, **so it may still sit at capacity.**
- **After the 12:55 cutover, measure:** `oldestQueuedAgeMs`, `expiredJobs` growth, `inFlightJobs`, `avgHandDurationMs`, worker governor scale, and `top -H`.
- **If the queue stays above ~50 or anything expires, in order of speed:**
  1. **Equity pool priority.** The pool worker was at ~94% CPU. Find out what it computes for which tables (`ServerTableEngineRunout.ts`) and whether any gameplay step (insurance, run-it-twice) awaits it. If it is display/EV only, lower that thread's priority from inside the worker: on Linux, `os.setPriority(0, 10)` inside a worker affects that thread only. Then the dealer and horses win the CPU. Test it, document it, and ship it through the train.
  2. **Host upgrade:** engine-01 has 3 vCPU/3.8 GB; move to a 4-8 dedicated-vCPU box. This needs Dan's decision and cost approval, and a resize reboots the box (restart only inside a break, and a resize may not fit in 5 minutes). Recommend it; don't do it without Dan.
  3. **Horse brain separation (§8).** This is the real long-term fix.
  4. **Do NOT** raise the 8 s job timeout, or shed precision by hand. The governor already does that.

### 6.2 P0 — One hung lease heartbeat kills every cash table

- **Evidence:** 2026-09-11 10:59:10. 52 `ServerTableEngine.<id>.watchdog_kill … cash_lease_proof_expired`, then `[lease] heartbeat failed (Error: supabase_timeout)`. Same-minute `supabase_timeout` bursts hit discovery, the bust list and the board read. There was a similar burst at 09:18.
- **Mechanism:**
  - `server/src/services/tableLease.ts`: `TABLE_LEASE_PROOF_WINDOW_MS=20000`, `LEASE_STALE_SECONDS=30`.
  - `GameServer.ts`: `OWNERSHIP_LEASE_RENEWAL_CADENCE_MS = 20000/4 = 5000`.
  - `services/supabase/client.ts`: `DB_TIMEOUT_MS = SUPABASE_TIMEOUT_MS ?? 15000`.
  - A pass at t0 succeeds (proof until t0+20). The pass at t0+5 hangs until t0+20 and times out exactly as the proof expires, so every verified cash dealer self-terminates. One hung request is enough.
- **Fix to write:**
  - Give `heartbeatTables` (and `heartbeatTournaments` in `services/tournamentLease.ts`) a per-attempt deadline of about 4.5 s (`supabase.rpc(...).abortSignal(AbortSignal.timeout(4500))`). The fetch wrapper already links the caller's signal. The next serialized pass then starts immediately after a failure, so at least 3 attempts fit inside the 20 s window.
  - Keep every fail-closed rule: UNKNOWN extends nothing, and busy extends nothing.
  - Tests: a fake-clock test with one hung attempt must NOT expire the dealers, and three consecutive hung attempts still must.
  - Also consider a changelog/law test, and making the heartbeat deadline a function of the remaining proof window.
  - Optional and larger: fence-and-suspend instead of kill-for-restart. A later `kept` exact-generation proof would resume the same engine, which is safe because a takeover always writes a new generation. Discuss with Dan before building it.
- **Related noise after a storm:** "33 x GameServer.table_lease_lost … to another engine instance". Only one instance exists; these are re-admissions. Check them after the fix.

### 6.3 P1 — Merge and ship the open PRs

- #4292: wait for CI (manifests regenerated at `8004205650`), then merge. It deploys at the next break.
- #4296: merge (the migration is applied). This stops the `satellite_atomic_creation_failed` noise.
- After each deploy: `/health` version, the engine log greps, and the doors step green.

### 6.4 P1 — 59 tournaments that cannot finish (ORDER IS MANDATORY)

Evidence: `evidence/2026-09-11T1230-stuck-events-investigations.md` (sweep, 12:13 UTC).

**A. 57 one-seat-per-table events**

- 402 horses, pools of 17,572.20. Largest: 7d6f3d3b (43 players on 43 tables) and 2dbc9bb6 (35 on 35).
- **Root cause:** a one-player table never deals, so it never wakes the balancer. The only sweep is the one at adoption, and adoption happens inside the :55 freeze, where the balance stage is skipped. After the thaw nothing asks again. The balancer's earlier refusals (01:31-01:55, "Table break … incomplete - 0/1 moved") came from the seat-exit guard, which was fixed at 08:22.
- **Fix branch:** `backup/claude-2026-09-11/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw`, head `2b6b5c6687`, code commit `26e727c8cc`:
  - `freezeState.onNextMaintenanceThaw()`
  - one urgent sweep per manager per freeze, spread over 10 s; single-table formats never arm
- **Steps, in order:**
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
- Pick one after review and apply outside :50-:03.
- **Also apply the trigger fix** (`20260911110000`, backup branch `late-status-flip-keeps-paid-ladder`): review, apply, record, regenerate the manifests, open a PR. Otherwise the rewrite recurs.

**D. 79 REGISTERING events from 09-08 12:49-14:51**:

- horse-only, played, never went RUNNING; together they hold 2,164.60 in pools
- they need a ruling
- moving them straight from REGISTERING to COMPLETING trips the same paid-ladder rewrite, so apply the trigger fix first

**E. Orphans:**

- 7aa16fa7 chip drift +10,000; a5aa6984 +2,500 (river222).
- The orphans agent was still running at export; its result will be in the workflow journal if that session still exists. Otherwise re-investigate.

**F. Unexplained:**

- 57a417c5 had a bust at 09:15:53 that was not recorded until the 10:56 restart.
- The satellite settlement function checks the four-table cap while the satellite is still RUNNING, so the winner's own satellite seat counts. That yields tickets where seats were possible: 38 tickets against 116 seats since 09-09. The function is Phase-3-pinned; fixing it needs a ruling on design.

### 6.5 P2 — Known defects not yet addressed (from the audits)

- Guard triggers on `tournaments` found **disabled**: `zzzz_freeze_finalized_tournament_prize_pool` plus six others. Decide re-enable or retire, with tests. **UNVERIFIED** who disabled them; see the night-audit evidence.
- `fn_settle_tournament_places_by_ruling` is broken for non-satellite events.
- Satellites and final-table deals still rank in recording order, not bust-hand order; the #4293 migration covered settle and the doors only.
- 271 rebuy legs recorded within 10 s of each other: possible double charges. **Uninvestigated.**
- 15 misallocated completed events (~1,437) plus mystery make-goods need a house-funded **audited back-pay door**. Never claw back. The door does not exist yet; design it with Dan.
- `SpinUnfilledBacklog`: 29 Spins past their fill deadline. `fn_spin_expire_unfilled` is supposed to run on the engine timer; investigate why it isn't.
- `StatsAllInEquityCoverageLow` (98.4%). Probably equity-pool expirations under load (`queueExpirations`); connects to §6.1.
- `TournamentSeatlessPhantoms` (1), `TournamentNeverStarted` (1). Identify both with the SQL in the alert descriptions (Prometheus rules).
- Task #11 ("a table frozen mid-hand inside a break is reaped and re-parked, so a broken build can still certify") shipped as #4255. Verify at the next break: `maintenance.unparkedTables` should reach 0 and `readyForRestart` true.
- Deploy pipeline edge cases, now covered by #4262: a pending rollback survives replacement, and a workflow-only fix starts a run. Re-verify with a real rollback drill when Dan allows.
- REGISTERING pass serial count sweep: batched by #4256 and #4274.

---

## 7. PICK-UP CHECKLIST (do these in order)

1. **~13:00-13:05 UTC, verify the 12:55 cutover:**
   - `bash ~/tmp-claude/verify_engine.sh` → `version 4895030e`, `status ok`
   - `curl -s https://engine.smarter.poker/health | python3 -c "import json,sys;h=json.load(sys.stdin)['liveHorseDecision'];print(h['queueDepth'],h['inFlightJobs'],h['oldestQueuedAgeMs'],h['expiredJobs'])"`
     - expect `inFlightJobs` ≤4 and `oldestQueuedAgeMs` in the tens of ms at moderate load
     - expect `expiredJobs` flat
   - the deploy run `34598480706` Verdict is green
   - if the cutover failed: read the run logs (`actions/jobs/<id>/logs`) and the ROLLBACK step. Do not force anything.
2. **Watch 15 minutes of load:** Prometheus queue depth and oldest age, `avgHandDurationMs`, and `top -H`. Decide §6.1 options 1 and 2. Tell Dan about capacity with numbers.
3. **Merge #4292** when CI is green, and **merge #4296**. They deploy at the next break; verify each.
4. **Write the lease heartbeat fix** (§6.2): PR, CI, merge, deploy, verify. Next time a supabase_timeout burst hits, the kills should not happen.
5. **Stuck tournaments** (§6.4 A, in order): 7 re-sequences, then the wake script, then a PR from the backup branch.
6. **c1f15c30:** trigger migration `20260911110000` (review and apply), then the ladder restore. Then a5aa6984 (rehearse, then apply).
7. **79 REGISTERING events:** draft a ruling and get Dan's OK on the policy (refund vs complete).
8. **P2 list** (§6.5), with an audit and a fix for each.
9. **Architecture** (§8): write it up for Dan with costs. Build only after he agrees.
10. Keep this handoff current and append to it.

---

## 8. ANNEX — HORSE BRAIN / ENGINE SEPARATION (design for Dan's decision)

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
- **Effort and cost:** about 3-5 engineering days, plus one small dedicated server. **Needs Dan's approval.**
- **Interim, no new box:** pin the horse worker and equity worker threads at a lower priority than the main thread (see §6.1), or upgrade engine-01.

---

## 9. COMMAND & SIGNAL

- **Owner:** Dan (daniel@pepnationrx.com). He wants direct numbers, root-cause fixes, no watchdogs, and no questions he has already answered. Report outcomes with evidence.
- **Other agents active on this repo:** Codex (the `agent/codex-*` branches, e.g. #4291 realtime and #4232 stage B) and the autopilot bot. Their open PRs are not yours to merge unless Dan says so. Watch for their deploys; build 80769f9b at 11:56 was Codex #4289.
- **Evidence and raw reports:** `docs/handoffs/2026-09-11-claude/evidence/*.md`.
- **This session's attribution** (put it on commits):
  - `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_01HPVofHJE7bzt6h73ZhZ8BL`
