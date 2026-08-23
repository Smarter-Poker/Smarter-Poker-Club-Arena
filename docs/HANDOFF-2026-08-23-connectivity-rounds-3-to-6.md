# HANDOFF — CLUB ARENA CONNECTIVITY, ROUNDS 3-6 (2026-08-22/23)

Read `AGENT-PLAYBOOK.md` first, then this. Ship via
`scripts/agent-workspace.sh` -> branch -> PR -> Autopilot. You never merge.

---

## 0. WHAT THIS SESSION WAS

The previous handoff had shipped two rounds of connectivity hardening and left
eleven open items. Dan's standing directive is unchanged: _"games randomly
break, stop running or freeze — find every reason and fix/upgrade to the max."_

The previous rounds fixed the client transport and the engine's internals. They
did not find the thing that was actually stopping the games, because the
evidence for it was in the database and nobody had looked.

**It was the recovery mechanism.**

---

## 1. THE HEADLINE, IN NUMBERS

Six hours of `engine_recovery_events` before the work:

|                         | before                     | after                   |
| ----------------------- | -------------------------- | ----------------------- |
| engine kills            | **1,603 in 6h** (~4.5/min) | **9 in 4h** (~0.04/min) |
| kills per cash table    | 22-30, every 6 hours       | 0                       |
| hands/min (fleet)       | 29 avg                     | **53-83 avg**, peak 196 |
| kills that name a cause | 0%                         | **100%**                |

`hand_history` per-table spacing told the whole story before a line was
written: normal 8-45s between hands, then **107s, 107s, 114s, 87s, 83s** —
two 90s watchdog trips plus a rebuild — repeating forever, on fully funded
tables with nothing wrong with them.

---

## 2. WHAT SHIPPED (all merged, all deployed, all verified in production)

| PR       | What                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| **#281** | The watchdog was killing every healthy cash table                                                   |
| **#296** | A database blip during engine start was a 5-second respawn loop                                     |
| **#321** | Waking a backgrounded tab tore down a healthy channel socket, + the missing EngineStateClient tests |
| **#315** | The first player to sit at an empty table had nothing to connect to, + `reconcileTeardown`          |
| **#325** | A websocket blip fired a disconnect alarm at players who never left, + the lost close reason        |
| **#331** | `pre-push` died at line one when the remote tip was not in the clone                                |

### 2.1 The root cause (#281)

The path BETWEEN hands is five Supabase round trips —
`loadSeatedPlayers`, `refreshBlinds`, `refreshRakeConfig`,
`processPendingAddOns`, `recoverBustedSeatedHorses`. Nothing bounded them and
none of them called `markProgress()`, and they sit directly under a watchdog
that kills the engine after 90s without a hand.

Database slowness is **correlated** — every table shares one database. So a
slow minute did not stall one table, it stalled the fleet, killed every engine
at once, and the rebuild storm loaded the database harder than the slowness
that started it. Round 2 had bounded `postHandTasks` for exactly this reason.
It bounded one await out of six.

The fix has three parts: the loop stamps a **phase** at every step; the
watchdog asks whether the loop is WEDGED (`msSinceLoopPhase`) rather than
whether a hand started lately; and every step carries a 20s budget whose
expiry is transient, retried, and marks progress.

### 2.2 The same bug one layer up (#296)

`loadTable` is the FIRST statement of `start()` and it is a database read. A
throw landed in the catch as `start_failed` -> `killForRestart` -> rebuild in
5s -> the same read -> the same throw. And the kill costs MORE database work
than a retry, because a rebuilt engine also re-runs
`seedHandCountFromHistory`, `checkCrashRecovery` and `resolveOrphanedAddOns`.

`dealingLoop` had always treated these errors as transient. `start()` treated
them as fatal. They could disagree because the transient list was written out
**three times**, inline, and never shared — and `refreshBlinds`' copy was
missing `supabase_timeout`, the wording the DB timeout actually emits, so the
retry it exists to perform never fired for the commonest timeout.
`ServerTableEngineBase.isTransientDbError()` is now the one definition.

---

## 3. THE KILL VOCABULARY (read `engine_recovery_events.detail`)

| detail                          | means                                                    |
| ------------------------------- | -------------------------------------------------------- |
| `dealing_loop_dead:<phase>`     | the loop stopped moving, in `<phase>`                    |
| `loop_ticking_no_hands:<phase>` | cycling through `<phase>`, still not dealing after 5 min |
| `start_failed:<stage>`          | `start()` threw in `<stage>`                             |

Phases: `await_post_hand_tasks`, `load_seats`, `refresh_blinds`,
`refresh_rake`, `pending_addons`, `recover_busted_horses`,
`idle_not_enough_players`, `spin_reveal_hold`, `admin_pause_lock`,
`maintenance_lock`, `dealing`, `post_hand_hold`, `start_load_table`,
`start_wait_for_players`.

**The phase is recorded WITHOUT its elapsed seconds.** A detail that is unique
per row cannot be grouped, and grouping is the entire point.

`/health` reports `loopPhase` per table (`load_seats+96s`).

---

## 4. TRAPS FOUND. DO NOT RE-LEARN THESE.

1. **`readyIds` does double duty** in `GameServer.discoverCashTables` — it is
   both the spawn list AND the zombie test (`shouldBeDealing` + 180s of no
   progress = kill). A table with one seated human makes no progress BY
   DESIGN. Widening `readyIds` would re-create #281's kill loop in a new
   place. #315 widened the spawn list and left `readyIds` filtered to
   `player_count >= 2`. **If you touch that RPC, keep the two separate.**

2. **`table_seats.horse_id` is dead** — 278 seated horses in production, zero
   with it populated. `profiles.is_horse` is the only source of truth. My
   first draft of #315 filtered on `horse_id` and would have classified every
   horse as a human.

3. **`stop()` begins `if (!this.running) return`.** So calling it from the
   reaper's `!isRunning()` branch is a no-op dressed as a safety net — worse
   than nothing, because the next reader believes it. `reconcileTeardown()`
   asks the question that can be answered instead.

4. **A superseded engine must touch nothing shared.** If a replacement engine
   has claimed the tableId, the scheduler entries are ITS entries and
   cancelling them is exactly how a table permanently loses its watchdog.
   Every teardown path is ownership-guarded. Keep it that way.

5. **Two of my own tests were wrong and passed anyway.** The disconnect-flap
   test passed with the fix reverted, because a second mechanism covered for
   it. **Mutation-check anything that pins new behaviour** — revert the fix,
   watch the test fail, restore. A test that passes against the bug it claims
   to pin is not a test.

6. **`git fetch origin main` does not fetch other branches.** Autopilot pushes
   merge commits onto your branch, so its remote tip is routinely a commit you
   have never seen. Before #331 the pre-push hook died on that with a bare
   `fatal: bad object`. Fixed, but remember the general shape: **a plain
   `git fetch origin` before pushing saves confusion.**

7. **The changelog conflicts on almost every PR.** Several agents append
   session blocks at the same spot. Both sides are pure insertions, so the
   resolution is always "keep both" — never `--ours`/`--theirs`. Session
   numbers collide freely; the title is what disambiguates.

---

## 5. STILL OPEN

1. **Mux soak (`ca_ws_mux` is still OFF).** Unchanged from the last handoff and
   the one genuinely unfinished item. Every known latent bug in
   `EngineSocketMux` is fixed and it now has tests, but enabling it needs a
   staged rollout with real play — that is a decision and an observation
   period, not a code change. **This is the top of the next session's list.**

2. **`engine_table_leases` is never pruned.** 1,961 rows, oldest 3.2 days,
   2.2 MB. `claim_table_lease` upserts on a unique `table_id` so there is no
   correctness or performance problem — it is unbounded tidiness debt. I did
   not fix it: touching lease infrastructure to reclaim 2 MB is the wrong
   trade, and new scheduled jobs must go through Open Claw. Do it when
   something else takes you into that code.

3. **`start_failed:start_load_table`, ~9 events / 4 hours.** Across 8 distinct
   tables, 1.2 events per table — **no table loops**. It is the tail of
   correlated DB stalls longer than the 5-attempt / ~8s retry budget, and the
   rebuild retries and succeeds. Self-healing. Watch it; do not chase it
   unless the rate climbs or one table starts repeating.

4. **Deferred product/UX backlog**, untouched and unchanged: 8 of 12 Law-1.16
   discrete events, X6.2 frontend polish, idempotency retrofit on 47 low-stakes
   ops routes, hand-history export/replay viewer, keyboard shortcuts,
   multi-account/bot/chip-dump detectors.

### Closed, do not re-litigate

- **`pending_deadlines` "dead writes"** — not dead. B10 (2026-08-20) already
  made the reasoned call in `checkCrashRecovery()`: every persisted deadline
  belongs to the hand being abandoned, so reinstating them would fire turn
  timers for a hand that no longer exists. Kept for forensics and PR-E.
- **"14 live engines on closed tournament tables"** — I suspected this and
  **disproved it**. A 20-second heartbeat window shows zero closed tables
  actively leased. The 15-minute window I used first was catching leases that
  had already stopped renewing. Teardown works.

---

## 5b. THE NEXT THREAD: RESTART GAPS, NOT STALL GAPS

The kill-loop gaps are gone. What is left in `hand_history` is a **different
shape**, and it was masked by the bigger problem until now.

Last two hours: 5 runs of 2+ zero-hand minutes, longest **8 minutes** — but
only **5 engine kills** in that whole window. So it is not the watchdog. Every
one of those gaps lines up with an engine **container restart**:

| gap                     | what `engine_table_leases` says                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 23:13-23:14             | deploy (#315 merged 23:13:10, Hetzner deploy 23:13:13)                                                                   |
| 23:25-23:26             | deploy                                                                                                                   |
| **23:31-23:38 (8 min)** | instance `1-9373f1dd` last heartbeat 23:16; next instance did not claim until 23:52                                      |
| 23:55-23:56             | instance cutover                                                                                                         |
| **00:39-00:43 (5 min)** | `1-6911a2f8` last heartbeat 00:37:17; `1-22d45d8e` first claim 00:43:53 — **6.5 minutes with no engine instance at all** |

Several agents ship `server/**` changes continuously, and `auto-deploy-hetzner`
fires on every one. Each restart costs roughly two minutes of dealing, and the
cutover sometimes takes six.

**This is the next thing worth fixing, and it is a deploy-pipeline problem, not
a connectivity one.** Worth looking at: whether the new container claims leases
before the old one releases them (`LEASE_STALE_SECONDS` is 30s, so a hard-killed
container costs at least that), whether deploys can be batched or debounced, and
why one cutover took 36 minutes (23:16 -> 23:52).

Diagnose it with:

```sql
SELECT instance_id, engine_version, COUNT(*) tables,
       MIN(acquired_at) first_claim, MAX(heartbeat_at) last_hb
FROM engine_table_leases
WHERE acquired_at > NOW() - INTERVAL '3 hours'
GROUP BY 1,2 ORDER BY 4;
```

Holes between one instance's `last_hb` and the next one's `first_claim` are the
gaps. Do not mistake them for the stall this session fixed — the tell is that
`engine_recovery_events` stays quiet through them.

---

## 6. HOW TO VERIFY ANYTHING HERE

```sql
-- The health of the fleet, in one query.
SELECT detail, COUNT(*) FROM engine_recovery_events
WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY 1 ORDER BY 2 DESC;

-- Are engines live where they should be, and nowhere else?
SELECT t.status, t.tournament_id IS NOT NULL AS is_tourney, COUNT(*)
FROM engine_table_leases l JOIN tables t ON t.id = l.table_id
WHERE l.heartbeat_at > NOW() - INTERVAL '20 seconds'   -- 20s, NOT 15 minutes
GROUP BY 1,2;

-- Throughput and gaps.
WITH mins AS (SELECT generate_series(date_trunc('minute', NOW() - INTERVAL '1 hour'),
                                     date_trunc('minute', NOW()), '1 minute') AS m),
     h AS (SELECT date_trunc('minute', created_at) m, COUNT(*) c FROM hand_history
           WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY 1)
SELECT COUNT(*) FILTER (WHERE COALESCE(c,0)=0) zero_min, ROUND(AVG(COALESCE(c,0))) avg_hands
FROM mins LEFT JOIN h USING (m);
```

Engine deploys: push to main touching `server/**` auto-deploys Hetzner.
**Verify via Supabase, never the health endpoint** — it is CDN-cached.

Reading CI: `gh pr checks` 403s because the local PAT has no Checks: Read.
`gh pr view <n> --json state,mergeStateStatus` and `gh run list --branch <b>`
both work. See `AGENT-PLAYBOOK.md` section 12.
