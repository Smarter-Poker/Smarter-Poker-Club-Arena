> **SUPERSEDED 2026-09-04 by [`docs/SENTRY-AND-REALTIME-PROGRAMME.md`](../../docs/SENTRY-AND-REALTIME-PROGRAMME.md).**
> That file merges this handoff with the second Sentry handoff of the same day and
> re-verifies every item against live production and `origin/main`. Five items below
> are already shipped, moot, or forbidden.
>
> **In particular: section A1 of this document — gating the `hand_history` INSERT
> triggers on `has_human` — was written, shipped, REJECTED BY DAN and REVERTED on
> 2026-09-04 (PR #2913). It violates `CLAUDE.md` §10.5, eight law tests and
> `scripts/ci/check-horses-are-players.mjs`. Do not revive it in any form.**
> The programme fixes the same write amplification without denying a horse anything.

# HANDOFF: Sentry completion + realtime WAL saturation

**Issued** 2026-09-04 · **Scope** club-arena, Smarter-Poker-World-Hub, engine host, Supabase
**Prerequisite** none. Everything below is executable by an agent with normal estate access.

---

## 0. MISSION

Two jobs, independent, both unfinished.

**A. Realtime saturation is degrading production right now.** Supabase logical
decoding is near-saturated. It fails as a spiral, not a cliff: a slot that falls
behind must read WAL from disk, which is slower, so being behind makes it fall
further behind. Fix the write amplification that causes it.

**B. Sentry is half-wired.** 54 integration points, 21 working. A repair pass has
shipped (§3). What is left is listed exhaustively in §5, §6 and §7.

Do A first. A is player-facing and compounding; B is not.

---

## 1. GROUND TRUTH (measured, do not re-derive)

Measured against production Supabase `kuklfnapbkmacvwxktbh` and engine host
`5.161.252.33` on 2026-09-04 between 02:30 and 03:10 UTC.

| Fact                                      | Value                                                               |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Replication slot lag                      | 166 MB (`supabase_realtime_replication_slot_2_134_2_a886414`)       |
| Broadcast slot lag                        | 19 kB — broadcast is provisioned and essentially unused             |
| Hands per hour                            | 33,503                                                              |
| Hands last 2h with a human in them        | **0 of 66,143**                                                     |
| Human hands ever recorded                 | 1,796 (since 2026-07-22) vs 2,505,978 horse (since 2026-08-28)      |
| `hand_state_snapshots`                    | 7,098 MB — largest table on the platform                            |
| `hand_history`                            | 6,537 MB                                                            |
| `ca_hand_player_idx`                      | 3,851 MB                                                            |
| Partitioned tables                        | **0 of 992**                                                        |
| Tables in `supabase_realtime` publication | 113 (29 Commander, 19 Hub)                                          |
| Engine `SENTRY_DSN`                       | **SET and live** — logs `[Sentry:Server] Initialized`               |
| Engine host also runs                     | Prometheus, Grafana, Alertmanager, node-exporter, autoheal          |
| Postgres exporter                         | **absent** — this is why slot lag is invisible                      |
| Sentry plan                               | Business: 50K errors, 5M spans, **50 replays**, 5 GB logs per month |

**Why Club Arena's launch caused this:** horse hands went 0 on 27 Aug → 239,989
on the 28th → 769,919 on 3 Sep. Club Arena was not running before then. This is
legitimate product traffic. **Do not propose throttling the fleet.** Dan has
explicitly rejected that framing. Treat 33,500 hands/hour as the floor.

---

## 2. RULES OF ENGAGEMENT

Binding. Violations are auto-detected.

1. **Read `AGENT-PLAYBOOK.md` and the repo `CLAUDE.md` first.**
2. **Claim your own worktree.** `git worktree add -b <branch> ~/Documents/.agent-trees/<repo>/<name> origin/main`. Takes ~40s; launch with `nohup` and return.
3. **`node` is not on the default PATH.** Prefix every command:
   `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`
4. **Worktrees have no `node_modules`.** Symlink the main clone's or the pre-push hook dies with `ERR_MODULE_NOT_FOUND`:
   `ln -s ~/Documents/<repo>/node_modules node_modules`
5. **The pre-push hook takes ~3 minutes.** `nohup git push ... & disown`, then poll the log. **Never `--no-verify`.**
6. **Push the branch and STOP.** `agent-open-pr.yml` opens the PR, `agent-autopilot.yml` merges it. **Do not sit in a loop watching CI** (CLAUDE.md 10.8 rule 3). Checking once at the end to report a blocker is fine.
7. **Never rebase `main`.** Use `git merge origin/main`.
8. **One migration = one transaction.** Every DDL statement triggers a PostgREST schema reload that takes ~28s on this database. Ten loose statements = ten reloads. See the PGRST002 policy in club-arena `CLAUDE.md`.
9. **Never probe a money path by executing it.** Wrap in a transaction you ROLL BACK. See §11.5 of club-arena `CLAUDE.md`. An agent previously destroyed 48 real chips doing this.
10. **Never unpublish a table a client still subscribes to.** Dropping `table_hole_cards` on 2026-08-31 cost every player their hole cards for four hours. Move the consumer first, prove it, unpublish after.
11. **Horses are players (CLAUDE.md 10.5).** The one sanctioned asymmetry is storage/retention, and it is Dan's decision, already made. Task A1 needs an explicit written carve-out — see A1.

---

## 3. ALREADY DONE — DO NOT REDO

Two branches pushed 2026-09-04, both passed all pre-push gates. **Verify their PR
and merge state before starting; if unmerged, do not duplicate their changes.**

**`fix/sentry-repair-pass` in club-arena** — `networkCaptureBodies: false`;
removed the `Failed to fetch`/`NetworkError` drops; narrowed bare `aborted` and
`Internal error`; deleted the `/src/` stack test; wired `PageErrorBoundary`,
`RouteErrorBoundary` and `TableErrorBoundary` to `reportError`; fixed the
hand-history swallow (query errors throw, per-row map guard, `loadFailed` state
threaded to both panels, corrected the false "At This Table" copy).
Changelog: `docs/changelog/2026-09-04-sentry-repair-pass.md`.

**`fix/sentry-repair-pass` in Smarter-Poker-World-Hub** — deleted
`scripts/sentry-resolve-all.js` and `scripts/sentry-resolve.js`; assigned
`window.Sentry` in the client config; fixed `useYouTubeErrorManager` reading
`window.__SENTRY__`; removed the unanchored `is not defined` filter; narrowed
bare `aborted`; added `release` to all three runtime configs.
Audit: `.agent/audits/2026-09-04-sentry-repair-pass.md`.

**Already verified, do not re-investigate:** engine `SENTRY_DSN` is live; the
hand-history database path is healthy (1,372 hands stored and visible under real
RLS for the test player, 295 ms on the GIN index); `has_human` is populated
correctly by the engine on every hand.

---

## 4. TASK A — REALTIME SATURATION (do first)

### A1. Gate the five ungated INSERT triggers on `hand_history`

**Verified 2026-09-04.** `hand_history` has 7 triggers. Exactly one is gated
(`trg_log_jackpot_hand_deleted`, DELETE, irrelevant to insert load). Gate these
five, all of which fire on INSERT:

| Trigger                           | Function                             |
| --------------------------------- | ------------------------------------ |
| `hand_history_club_member_stats`  | `trg_hand_history_club_member_stats` |
| `hand_history_fold_stats`         | `fn_fold_hand_winnings`              |
| `hand_history_position_stats`     | `trg_hand_history_position_stats`    |
| `trg_ca_stats_live_from_hand`     | `trg_ca_stats_live_from_hand`        |
| `trg_enqueue_hand_daily_missions` | `fn_enqueue_hand_daily_missions`     |

**CORRECTION TO EARLIER ANALYSIS:** `trg_ca_capture_hand_facts`
(`fn_ca_capture_hand_facts`) fires on **DELETE**, not INSERT. It captures
per-player facts before a hand is pruned. It is therefore **prune-path** cost,
not hot-path, and it explains the 3.35M inserts into `ca_hand_player_idx`.
**Leave it alone in this task.** It is addressed by A2 instead.

**THE GATE MUST BE WRITTEN EXACTLY THIS WAY:**

```sql
IF NEW.has_human IS FALSE THEN RETURN NEW; END IF;
```

`has_human` is `is_nullable = YES` with `column_default = NULL`. Skip only on an
explicit FALSE, so a NULL falls through and does the full work.

- `IF NOT NEW.has_human` — survivable (NULL is not TRUE, falls through) but less clear.
- `IF NEW.has_human IS DISTINCT FROM TRUE` — **FORBIDDEN.** NULL would skip the work and destroy a real player's hand history. That is the one outcome that must never happen.

In the same migration: `ALTER TABLE hand_history ALTER COLUMN has_human SET DEFAULT true;`
then backfill any NULLs to `true`, then `SET NOT NULL`. Fail-safe direction is
"treat an unknown hand as human".

Also in the same migration, scope `ca_repair_hand_player_stat_money` to
`has_human IS NOT FALSE`, or it will flag every horse hand as a violation.

**Do not gate on `is_horse` per player.** The gate is per HAND. If any seat is
human, the hand records in full including the horses in it.

**Law carve-out required.** CLAUDE.md 10.5 says horses are treated exactly like
humans. Put the reasoning in the migration header, framed exactly as Dan already
framed the retention decision: this is a **storage and derived-statistics**
policy, not player treatment. It changes nothing a horse earns, is paid, or is
subject to. It changes what the platform writes down about hands no human saw.
**If a `*.law.test.*` file contradicts this, STOP and ask Dan. Never write a
third law and never delete the other side on your own authority (CLAUDE.md 10.8).**

**Verify after apply:** re-run slot lag, WAL generated vs consumed, and the
`pg_stat_user_tables` write leaderboard. Expect a large drop in
`club_member_daily_stats`, `player_position_stats`, `player_stats`,
`daily_challenge_event_outbox` and `daily_challenge_progress_events`.

### A2. Decide `trg_ca_capture_hand_facts` on evidence, not assumption

It is the prune-path trigger. Gating it stops `ca_hand_player_stat` and
`ca_hand_player_idx` being written for horse hands. Before touching it, establish
who actually reads `ca_hand_player_stat`. Known consumers to check:
`server/src/gto/PostSessionAnalyzer.ts`, `server/src/integrity/HandEventAdapter.ts`,
and `ca_repair_hand_player_stat_money`. Report findings; do not guess.

### A3. Partition the churn tables

Zero of 992 tables are partitioned, so every retention sweep is a per-tuple
DELETE writing a WAL record. Measured delete volumes:
`ca_club_tournament_player_daily` 8.42M, `ca_club_tournament_daily` 4.65M,
`daily_challenge_event_outbox` 3.33M, `table_hole_cards` 3.27M,
`ca_hand_player_stat` 2.39M.

Range-partition by day: `hand_history`, `hand_state_snapshots`,
`ca_hand_player_idx`, `ca_hand_player_stat`, both `ca_club_tournament_*`.
Convert every retention sweep from DELETE to `DROP PARTITION`.

**`hand_state_snapshots` (7,098 MB) is the largest table on the platform and was
absent from all prior analysis. Include it.**

### A4. Prune the publication (113 tables) — CAREFULLY

Rule 10 applies with full force. Move each consumer first, prove it, unpublish
after. Start with the 29 Commander tables, which the Arena client does not
subscribe to at all.

**Note:** unpublishing reduces Realtime OUTPUT only. Logical decoding still reads
every WAL record, so this does **not** rescue a decode-bound slot. It reduces
per-subscriber RLS evaluation, which is the 500-player scaling problem, not
today's saturation. Do not expect it to move slot lag.

### A5. Migrate lobby and table channels to Broadcast

The structural fix. `postgres_changes` costs `changes × subscribers` of RLS
evaluation through one serialized slot; at 500 players the same 212 changes/sec
becomes ~530,000 evaluations/sec. Broadcast does not scale with subscriber count.
The broadcast slot is already provisioned and idle at 19 kB.

Largest task here. Do A1 and A3 first for headroom.

---

## 5. TASK B — THINGS THAT ARE BROKEN AND STILL NEED FIXING

### World Hub

| #   | What                                                                                    | Where                                                                                                                          | Why it matters                                                                                                              |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| B1  | Middleware has **zero** Sentry code and nothing wraps it (the build plugin is bypassed) | `middleware.ts`                                                                                                                | Geo-blocking, the admin guard and JWT validation fail silently on every non-API route                                       |
| B2  | Three crons build a Sentry event and never `flush()`                                    | `pages/api/cron/auth-integrity-audit.js`, `pages/api/cron/email-deliverability-check.js`, `pages/api/auth/log-client-error.js` | On a Vercel lambda the process can freeze before the transport sends. Add `await Sentry.flush(2000)`                        |
| B3  | Money-moving routes with no Sentry                                                      | `cron/rakeback-period-settle.js`, `cron/vip-stipend.js`, `cron/vip-lapse.js`, `live/gift.js`, `live/gifts.js`                  | Rakeback settlement and VIP credit move real value unmonitored                                                              |
| B4  | Only uninstrumented route under `pages/api/auth/`                                       | `pages/api/auth/commander-sso.js`                                                                                              | The other 14 are covered                                                                                                    |
| B5  | Raw SQL execution with **no try/catch at all**                                          | `pages/api/admin/exec-sql.js`, `pages/api/exec-sql.js`                                                                         | Timeouts and unauthorised attempts are invisible                                                                            |
| B6  | Signup bridge scans 7 days, archive runs at 30                                          | `cron/sentry-signup-bridge.js:89` vs `cron/archive-signup-errors.js:44`                                                        | A row unforwarded past day 7 is orphaned forever. Also its docstring says "every 5 min"; `vercel.json:670` says 15          |
| B7  | No cron check-in monitors anywhere in the estate                                        | all 32 cron routes                                                                                                             | A reconciler that **stops running** produces no signal at all. This is the single largest remaining blind spot              |
| B8  | Source maps never uploaded                                                              | `next.config.js:1100-1114`                                                                                                     | Deliberate (8 GB Vercel OOM). The `release` field shipped in §3 is the cheap half. Do not re-enable without solving the OOM |

### Club Arena

| #   | What                                                                              | Where                                                             | Why it matters                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B9  | **Source maps are shipped to players**                                            | `vite.config.ts:131` + `.github/workflows/publish-club-arena.yml` | `build.sourcemap: true`, and the only thing that deletes the maps is the Sentry plugin's `filesToDeleteAfterUpload` — which is off because the publisher never sets `SENTRY_AUTH_TOKEN`. **Your source is public and Sentry still cannot symbolicate.** Set `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` in the publisher; both problems close together |
| B10 | Release name mismatch                                                             | CI uploads `club-arena@1.0.1`, runtime tags `club-arena@<sha>`    | They have **never** matched, so even the CI upload was never usable. Align to `<sha>`                                                                                                                                                                                                                                                                          |
| B11 | `setMeasurement` called with no active span                                       | `src/core/WebVitals.ts`                                           | Every measurement is discarded. Also imports the Sentry bundle directly, downloading the chunk even when Sentry never initialises                                                                                                                                                                                                                              |
| B12 | 19 unthrottled reports                                                            | `src/services/VoiceSignalService.ts`                              | A comment claims deploy-noise suppression that was never implemented. One engine deploy can flood the 1,667/day budget. Copy the `GameServerAPI` pattern: one report per 60s + consecutive-failure count                                                                                                                                                       |
| B13 | Unthrottled breadcrumbs with full payloads                                        | `src/core/MasterBus.ts`                                           | At table speed this evicts the useful trail from the 100-item buffer. Throttle and trim the payload                                                                                                                                                                                                                                                            |
| B14 | Root `ErrorBoundary` returns early on the chunk branch **before** the Sentry call | `src/components/common/ErrorBoundary.tsx`                         | Every stale-bundle crash is invisible by design. Move the capture above the early return                                                                                                                                                                                                                                                                       |

### Engine

| #   | What                                                | Where                                                                                                                                       |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| B15 | Deploy logs `WARN SENTRY_DSN missing, non-blocking` | `.github/workflows/auto-deploy-hetzner.yml` — make it a hard gate so a future deploy cannot silently ship an engine with no error reporting |

### Both repos

| #   | What                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B16 | **Grep both repos for `reportError(` used without an import.** TypeScript resolves an unimported `reportError` to the browser's built-in `window.reportError()`, which takes one argument, compiles fine, and calls the wrong thing. This was found live during the repair pass |

---

## 6. TASK C — THINGS TO REMOVE

Seventeen inert integrations. Each reads as coverage to the next person who greps
for it. **This is not cosmetic: dead monitoring code is exactly why a previous
audit concluded the World Hub had no client Sentry when it does.** Either wire it
or delete it. Do not leave it.

### World Hub

| #   | Remove                                                                                                                | Evidence it is dead                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `utils/logger.ts`                                                                                                     | Zero importers repo-wide                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| C2  | `startTransaction` in `src/lib/sentry.js:153-161`                                                                     | `startTransaction` was removed from the SDK in v8; repo is on v10. Always returns null                                                                                                                                                                                                                                                                                                                                                                         |
| C3  | `initErrorMonitoring` + the whole `errorMonitoring.js` subsystem (its own `Sentry.init`, user context, perf wrappers) | Zero callers anywhere. Has never sent an event, client or server                                                                                                                                                                                                                                                                                                                                                                                               |
| C4  | `vendor/commander-shared/.../errorMonitoring.js` — byte-identical vendored copy                                       | Same                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| C5  | `CommanderErrorBoundary.jsx` capture path                                                                             | Depends on C3; currently only `console.warn`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C6  | `archive/cron/rls-monitor.js`                                                                                         | Not in `vercel.json`; never runs                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C7  | `archive/legacy-club-tournaments/*.js` (5 files)                                                                      | Import a `sentryWrap` path that no longer resolves from `archive/`; not routed                                                                                                                                                                                                                                                                                                                                                                                 |
| C8  | `onRouterTransitionStart` in `src/instrumentation-client.js:15-22`                                                    | Guards on `captureRouterTransitionStart`, which is `undefined` in the installed SDK. Also moot: this is a Pages Router app                                                                                                                                                                                                                                                                                                                                     |
| C9  | `pages/api/clawbot/sentry-triage.js`                                                                                  | Hardcodes org `smarter-poker` / project `smarter-poker-world-hub`; **neither exists** (real: `smarter-software-inc` / `javascript-nextjsmarter-poker-world-hubs`). Fetch 404s then silently falls back to "first org, first project". Also absent from `vercel.json`, so it never runs — which is why `sentry_error_log` has zero rows. **Fix the slugs and schedule it, or delete it. Do not leave it advertising `enabled: true` in `clawbot/status.js:26`** |
| C10 | Dead `sentryWebpackPluginOptions` and `sentryOptions` objects                                                         | `next.config.js:1057-1098` — constructed, never passed anywhere                                                                                                                                                                                                                                                                                                                                                                                                |

### Club Arena

| #   | Remove                                     | Evidence it is dead                                                                                                                                                                                                                                         |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C11 | `src/core/SupabaseIntegration.ts`          | Query spans, exception capture, RLS-violation reporting — fully written, zero production callers, only tests import it                                                                                                                                      |
| C12 | `startTransaction` shim                    | Same v8 removal as C2                                                                                                                                                                                                                                       |
| C13 | `setSentryTags`, `setSentryContext`        | Unused exports                                                                                                                                                                                                                                              |
| C14 | Server `setServerContext`, `reportWarning` | Unused exports                                                                                                                                                                                                                                              |
| C15 | Duplicate init in `ClubArenaRoot`          | `main.tsx` already calls it                                                                                                                                                                                                                                 |
| C16 | `addBreadcrumb` imported in `App.tsx`      | Imported, never called                                                                                                                                                                                                                                      |
| C17 | `services/sentry-autofix/`                 | Untouched since 2026-04-21. No workflow deploys it, bring-up is a manual SSH checklist, and its own docs tell you to point Sentry at project slugs that do not exist. **Delete it, or restore it deliberately with corrected slugs and a real deploy path** |

### Stale comments to delete while you are in these files

These assert the opposite of the surrounding code and have already caused one
wrong audit:

- `src/components/ui/PageErrorBoundary.jsx:36-39` and `:162-163` — claim the browser SDK never initialises in production. It does, via `src/instrumentation-client.js:12`.
- `pages/api/client-crash.js:7-10` — same claim.
- `src/components/ui/HubErrorBoundary.jsx:35-37` — same claim.
- `src/services/VoiceSignalService.ts` — claims deploy-noise suppression that does not exist (see B12).

---

## 7. TASK D — THINGS TO BUILD

| #   | Build                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Sentry cron check-ins**                          | `Sentry.captureCheckIn({ monitorSlug, status })` around: ledger reconcilers, rakeback settlement, VIP stipend, tournament settlement, signup bridge. Check-ins bill separately from errors. **This is the highest-value new build** — it is the only way to detect a job that stops arriving                                                                                                                                                               |
| D2  | **Postgres exporter into the existing Prometheus** | The engine host already runs Prometheus, Grafana and Alertmanager and already scrapes the engine every 15s. It is missing only `postgres_exporter`. Alert on replication-slot lag there, **not in Sentry** — you get a continuous series instead of a threshold event, and it costs nothing. Carry the maintenance-break exclusion (`unless max_over_time(poker_maintenance_break_active[6m]) == 1`) or it will page hourly about the scheduled `:55` stop |
| D3  | **Alert rules in version control**                 | None exist as code today; whatever exists lives only in the Sentry UI. Money-path errors and slot lag page immediately. Boundary crashes and cron misses go to a daily digest. Everything else stays in the inbox                                                                                                                                                                                                                                          |
| D4  | **Name the person who reads the digest**           | Not optional. If nobody will own it, recommend cancelling the $80/mo subscription and keeping the engineering fixes, which stand alone                                                                                                                                                                                                                                                                                                                     |

### Quota ceiling — every build decision must respect this

Sentry Business is **50K errors (1,667/day), 5M spans (166K/day), 50 replays/month**.

- **Do not** un-swallow all 1,522 Club Arena and 206 World Hub catch blocks. Volume alone exhausts the month in hours, after which Sentry drops **everything**, including the incident you needed.
- **Do not** add per-hand tracing. 33,503 hands/hour = ~804K/day against a 166K/day budget; the earlier proposal was ~$300/month in overage. If tracing is ever wanted, sample on `has_human`: every human hand, one in a thousand horse hands.
- **Do not** build workflow on Session Replay. 50/month is roughly one every fifteen hours. Both apps run `replaysSessionSampleRate: 0.1`, so the allowance is almost certainly exhausted and rate-limited within minutes of each billing period. **Verify actual usage in the Sentry dashboard before designing anything around replay.**
- **Do not** use Sentry as a metrics store. Grafana is already running.

---

## 8. HUMAN-ONLY — CANNOT BE DONE BY AN AGENT

**H1. Rotate the `support@smarter.poker` password.** It was committed in plaintext
at `scripts/sentry-resolve-all.js:45-46`. The file is deleted on the shipped
branch, but **git history retains the value**, so deletion is not remediation.
Also determine whether that repo has ever been public or shared.

**H2. Decide whether to keep the Sentry subscription** once §7 D4 is answered.

---

## 9. VERIFICATION — WHAT "DONE" MEANS

Claiming a fix without these is a rule violation.

**Task A:**

1. Slot lag trends down and stays under ~50 MB across a peak hour.
2. `pg_stat_user_tables` shows the expected drop in the five child tables.
3. Bounty attribution still correct end-to-end for a horse tournament knockout.
4. All nine rake invariant functions return clean on a horse-only hand.
5. Tournament recovery still ranks survivors correctly.
6. **No human hand lost.** `SELECT count(*) FROM hand_history WHERE has_human` must keep increasing when a human plays.

**Task B/C/D:**

1. `npx tsc --noEmit` clean in both repos.
2. Pre-push hook passes without `--no-verify`.
3. For each removal, prove zero importers before deleting (`grep -rn` excluding `node_modules`, `.agent-trees`, `public/`).
4. For D1, watch one real fire-cycle produce a check-in in Sentry.

---

## 10. ABORT CONDITIONS — STOP AND ASK DAN

- A `*.law.test.*` file contradicts the A1 carve-out.
- Any verification in §9 fails and you cannot explain why.
- A money path would need to be executed rather than rolled back to test it.
- Two laws or two `CLAUDE.md` copies demand opposite things.
- You are about to create a new repo, Vercel project, Supabase project, or OAuth client. **RULE 12 forbids it absolutely.** Every workload has exactly one canonical home.

---

## 11. REFERENCE

- Analysis and bottleneck verdict: the "Sentry Redline" artifact
- Full inventory, coverage map, work packages: the "Sentry Buildout" artifact
- Shipped changelog: `docs/changelog/2026-09-04-sentry-repair-pass.md` (club-arena)
- Shipped audit: `.agent/audits/2026-09-04-sentry-repair-pass.md` (World Hub)
- Realtime policy: club-arena `CLAUDE.md` §11.5, §12, §13
- Cron governance: World Hub `CLAUDE.md` §11 — **all new scheduled jobs go to Open Claw, never `vercel.json`**
