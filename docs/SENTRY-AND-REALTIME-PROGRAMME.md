# The Sentry And Realtime Programme

**One register.** The two agent handoffs of 2026-09-04 — "Sentry completion + realtime
WAL saturation" and "Sentry: everything still to do" — are merged here, deduplicated,
and **re-verified on 2026-09-04 against live production and `origin/main`**. This file
supersedes both. Where a handoff disagreed with the code, or with the other handoff,
the code won and the disagreement is recorded in §2.

**Read §2 before acting on anything.** Five items the handoffs ranked highly are
already shipped, moot, or forbidden by a standing law — and one of them, followed
literally, would have deleted the module that provides error reporting to five
hundred API routes.

---

## 0. STATUS — 2026-09-04, end of day

This section is the first thing to read and the first thing to update. A
programme document that describes work already done is how the next agent ends
up re-doing it, or worse, undoing it.

### Shipped

| ID     | What                                                                                                                                                                                                                                                                                                                                                                                  | Where                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| —      | **A settlement outage found and stopped.** 139,153 hands, 25-44% of every hand dealt, failed to settle for thirteen hours with no alert. Cause: an unversioned `BEFORE UPDATE` trigger on `table_seats` that cancelled no-op writes, so a correct seat write looked like a failed one. Reverted; rate went 23.5% -> 0.0% within a minute. **No chips, rake or VIP points were lost.** | `20260904110252`, `docs/changelog/2026-09-04-settlement-was-failing-a-third-of-every-hand.md` |
| **R0** | Slot lag on a gauge: `fn_replication_slot_metrics`, `ReplicationMetrics.ts`, 5 alert rules                                                                                                                                                                                                                                                                                            | `20260904103652`                                                                              |
| **R1** | `ca_hand_player_idx` unpublished - 3.9 GB, 4.5M inserts, zero subscribers ever                                                                                                                                                                                                                                                                                                        | `20260904101140`                                                                              |
| new    | **Settlement health on a gauge**, 5 alert rules. A five-minute window, never a lifetime total - the lifetime ratio read 7.7% while the live rate was 44%                                                                                                                                                                                                                              | `20260904110620`                                                                              |
| new    | The hand snapshot is written once, not twice - removes ~1.2M row versions/window                                                                                                                                                                                                                                                                                                      | `20260904104350`                                                                              |
| new    | `ca_settlements` has a retention prune. It had none, and was growing ~430 MB/day forever                                                                                                                                                                                                                                                                                              | `20260904104540`                                                                              |

### Struck from the programme

**R2 (partitioning) is declined for every table**, on evidence, not caution.
`hand_state_snapshots` carries a partial unique index Postgres cannot enforce
across partitions and that index is the invariant preventing a stale hand being
resurrected; `ca_hand_player_stat` would break the `ON CONFLICT` keeping the
stats roll idempotent; `table_hole_cards` is 20 MB behind four RLS policies and
a publication. The one table where it is safe is 156 MB, so it would be
cosmetic. Reasons in full in
`docs/changelog/2026-09-04-realtime-write-amplification.md`.

**A1 remains struck** - see section 2.1. It has now been proposed twice.

### Next

1. The **`clubs` / `agents` hot accumulators** - 900k updates between 149 rows,
   both published with live subscribers. Largest remaining reduction in
   _decoding_ work. Needs a read of the settlement and commission functions
   first; the writes are not visible as top-level statements.
2. **`settlement_idempotency_keys` has 0% HOT updates** - one partial index makes
   HOT structurally impossible across 1.2M updates.
3. **Sentry phases D, C, X and O are untouched.** D1 (does anything arrive at
   all?) and D2 (the `/src/` gate) are hours of work between them and unblock
   the rest.
4. The **164 unresolved `financial_alerts`**, including criticals unrelated to
   the settlement outage. The alerting table works; nobody is told.

---

## 1. THE SHAPE OF IT

Six phases. Only the first is player-facing and compounding; do it first.

| Phase | What it is                           | Why it is where it is                                                                                                                      |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **R** | Realtime / WAL write amplification   | Degrading production now. A slot that falls behind must read WAL from disk, which is slower, so being behind makes it fall further behind. |
| **D** | Sentry **delivery**                  | Everything downstream is worthless while stack traces are minified and events are filtered away before send.                               |
| **C** | Sentry **capture** gaps              | Instrument what is genuinely blind — not everything, see §9.                                                                               |
| **X** | **Removal** of inert monitoring code | Dead monitoring is why a previous audit concluded the Hub had no client Sentry when it did.                                                |
| **O** | **Observability** build              | Cron check-ins, a Postgres exporter, alert rules as code, a deploy-time smoke test.                                                        |
| **H** | Human-only                           | Two items. Nothing here is an agent's to do.                                                                                               |

**R0 comes before every other R item.** You cannot verify "slot lag under 50 MB
across a peak hour" without something measuring slot lag, and nothing does today.
Ship the exporter first or you will be guessing about the fix you just made.

---

## 2. CORRECTIONS TO THE TWO HANDOFFS — READ FIRST

Fifteen items. Each was verified today; each changes what the next agent should do.

### 2.1 The single most important one: A1 is struck from the programme

Handoff 1's top-priority item — gate the five ungated `hand_history` INSERT triggers
on `has_human` — **was written, shipped, rejected by Dan, and reverted, on
2026-09-04**, as PR #2913 (`fix/the-horses-stop-writing-what-nobody-reads`).

> Dan, 2026-09-04: _"daily challenges should be done by horses, and the leader boards
> 100% should have all the horses inside of it and displaying there results. they must
> be treated just like real players."_

The handoff proposed framing it as "a storage and derived-statistics policy, not player
treatment" and instructed the next agent to stop if a law test contradicted it.
**Eight law tests, a dedicated CI gate, and §10.5 of `CLAUDE.md` all contradict it**,
and §10.5 names `player_stats` explicitly in the list of things a horse earns:

- `tests/a-claim-cannot-destroy-chips.law.test.ts:141-146` — forbids the exact
  `AND NOT COALESCE(p.is_horse,false)` shape
- `tests/animations-always-play.law.test.ts:809,814`,
  `tests/commission-accrues-for-every-agent-in-the-chain.law.test.ts:142-143`,
  `tests/the-field-is-seated-before-the-clock.law.test.ts:117-118`,
  `tests/a-seat-that-waits-forever-gets-its-chips-back.law.test.ts:23,75-76`,
  `server/src/engine/TournamentChipsAreConserved.law.test.ts:239-240`
- `scripts/ci/check-horses-are-players.mjs` — whose own header records the precedent:
  a horse-only predicate left horses with a permanently empty stats sample, so every
  VPIP eviction check returned `ok: true` for them, forever. That is precisely what
  gating derived statistics on `has_human` recreates.

The revert cost roughly nine minutes of horse mission progress and had to be undone as
ledger version `20260904033143`. **Do not propose it again in any form.** The write
amplification is real; §3 fixes it without denying a horse anything.

### 2.2 The one that would have broken production

Handoff 1 item **C4 listed `vendor/commander-shared/` as a "vendored copy" to remove.**
It is not a copy. `vendor/commander-shared/src/lib/sentryWrap.js:57` is where
`reportApiError` is **defined**, reached by all ~500 instrumented API routes through a
two-line re-export at `src/lib/sentryWrap.js`, declared as a file dependency at
`package.json:65` and transpiled at `next.config.js:391`. Deleting it removes error
reporting from every route that has it. **Struck from the removal list permanently.**

### 2.3 The remaining thirteen

| #   | The handoffs said                                                                            | Verified truth (2026-09-04)                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | PR #1316 fixed the dead Hub capture sites                                                    | **#1316 does not exist on `main`.** The work landed as **#1315** (`9dd1b0bf0b`). `origin/fix/sentry-repair-pass` is **not an ancestor of main** — a stale duplicate. Re-landing it re-applies merged changes.                                                                                                                                                                              |
| 2   | Arena ships source maps to players; publisher never sets `SENTRY_AUTH_TOKEN` (H1 B9 / H2 P3) | **Fixed today by #2947 on top of #2942.** Token at `publish-club-arena.yml:473`; three independent strips (`vite.config.ts:67-71`, `publish-club-arena.yml:486-495` hard-fails if a map survives, pool sweep `:689`); locked by `tests/source-maps-go-to-sentry-not-to-players.law.test.ts`. `sourcemap: true` stays — there must be a map to upload.                                      |
| 3   | Arena release mismatch, CI vs runtime (H1 B10 / H2 P3)                                       | **Fixed by #2947.** Both read `VITE_APP_VERSION`, set from one sha at `publish-club-arena.yml:471`. Only the _fallbacks_ still diverge — cosmetic, see D5.                                                                                                                                                                                                                                 |
| 4   | Engine may be reporting to nothing (H2 P2, issue #2917); H1 said DSN "SET and live"          | Both half-right. Missing DSN still warns and continues (`errorReporter.ts:84-87`); nothing hard-fails the boot. **#2949 shipped today**: engine has its own Sentry project and a per-fingerprint/global event budget (`server/src/services/sentryEventBudget.ts`). #2917's remaining ask is a boot assertion — see C11 for why "loud, not blocking" is the right answer for a game engine. |
| 5   | `admin/exec-sql.js` and `exec-sql.js` have no try/catch (H1 B5)                              | **Moot.** Both are six-line HTTP-410 tombstones. Nothing to wrap.                                                                                                                                                                                                                                                                                                                          |
| 6   | Grep for `reportError(` used without an import (H1 B16)                                      | **Zero defects, both repos.** Arena: 2,245 call sites, the only unimported matches are prose in comments. Hub: the token does not appear at all. Item closed.                                                                                                                                                                                                                              |
| 7   | `src/lib/sentry.js` is imported by 5 live routes (H2 P4)                                     | **Eight.** The three missed: `pages/api/admin/health.js:18`, `pages/api/poker/venues.js:18`, `pages/api/public/venue/[id].js:7`.                                                                                                                                                                                                                                                           |
| 8   | `onRouterTransitionStart` is dead (H1 C8)                                                    | **It is a Next.js framework hook** (`src/instrumentation-client.js:15`), called by the router. Not removable.                                                                                                                                                                                                                                                                              |
| 9   | `services/sentry-autofix/` has no references (H1 C17)                                        | **Wired into `vercel.json:239-242`** as an experimental service with a route prefix. Removal touches `vercel.json` and two docs.                                                                                                                                                                                                                                                           |
| 10  | Duplicate `Sentry.init` in `ClubArenaRoot` (H1 C15)                                          | **Never true — and the real finding is larger.** There is exactly one `Sentry.init` client-side. But `src/ClubArenaRoot.tsx` has **zero importers repo-wide** (`index.html:90` boots `src/main.tsx`). The whole file is dead.                                                                                                                                                              |
| 11  | Arena lazy init loses early crashes (H2 P6.1)                                                | **Half true.** Unhandled _rejections_ are buffered synchronously (`main.tsx:88-93` → 50-slot queue). **`window.onerror` is genuinely uncovered** — synchronous uncaught errors before idle are lost.                                                                                                                                                                                       |
| 12  | 73% of Hub catch blocks report nothing (H2 P7)                                               | Correct as _catch-block_ coverage: 529 of 2,015 = 26.3%. **At file level it is the opposite story** — 500 of 639 route files (78%) do import `reportApiError`; only 73 files have a catch and no reporting at all. State the metric correctly or it justifies a 1,500-file sweep that §9 forbids.                                                                                          |
| 13  | `reportWarning` is dead (H1 C14)                                                             | **Dead on the server only.** The client `reportWarning` (`src/utils/errorReporter.ts:73`) has ~15 live call sites. Do not conflate them.                                                                                                                                                                                                                                                   |

### 2.4 Two findings neither handoff had

**N1 — the `/src/` gate now drops nearly every production null-deref.**
`SentryInit.ts:171-174` discards `Cannot read properties of null` unless the stack
contains `/src/`. Since #2947 strips maps from `dist`, production stacks reference
hashed `assets/*.js` and **never** contain `/src/`. A filter that was merely
questionable yesterday is, as of today's own fix, throwing away a whole error class.
This is D2 and it is the highest-value one-line change in the Sentry half.

**N2 — `ca_hand_player_idx` is published to nobody.** 3,872 MB, 4.49M inserts,
1.11M deletes, and it is a member of the `supabase_realtime` publication. A grep of
every `postgres_changes` subscription in **both** repos finds **zero subscribers**.
This is the largest safe publication prune available and neither handoff named it.

---

## 3. PHASE R — REALTIME WRITE AMPLIFICATION

Measured 2026-09-04. Slot lag has moved 166 MB → **136 MB restart / 104 MB flush**;
the second slot (broadcast, provisioned and unused) sits at 18 MB. Not a cliff, a
spiral. Handoff 1's ground-truth table is otherwise still accurate; hand rate is
legitimate traffic and throttling the fleet is not on the table.

### The measured churn, and what it means

| Table                             | Size         | ins / upd / del           | Published?                     | Subscribers |
| --------------------------------- | ------------ | ------------------------- | ------------------------------ | ----------- |
| `hand_state_snapshots`            | **7,346 MB** | 1.20M / **2.40M** / 0.29M | no                             | —           |
| `ca_settlements`                  | 1,294 MB     | 1.19M / **6.90M** / 0     | no                             | —           |
| `ca_hand_player_idx`              | **3,872 MB** | **4.49M** / 0 / 1.11M     | **yes**                        | **none**    |
| `ca_club_tournament_player_daily` | 156 MB       | 1.03M / 0.04M / **8.44M** | no                             | —           |
| `ca_hand_player_stat`             | 563 MB       | 4.31M / 0 / **4.12M**     | no                             | —           |
| `daily_challenge_event_outbox`    | 2 MB         | 4.01M / 0 / **4.01M**     | no                             | —           |
| `table_hole_cards`                | 20 MB        | 3.98M / 0.06M / **3.96M** | **yes, REPLICA IDENTITY FULL** | 1           |
| `table_seats`                     | 86 MB        | 0.08M / **4.62M** / 0.12M | yes                            | 6           |

Two mechanisms are doing the damage, and neither one cares whether a horse or a human
was in the seat — which is exactly why the fix is law-clean where A1 was not:

1. **Delete-driven pruning.** Every `DELETE` is a WAL record; on a `REPLICA IDENTITY
FULL` published table it writes the entire old row. Twenty-plus million deletes
   across five tables is the sweep pattern, not the game.
2. **In-place updates of very large rows.** 2.4M updates against a 7.3 GB table
   rewrites the row (and its TOAST) each time. 6.9 million updates against 1.19
   million `ca_settlements` rows is ~5.8 writes per settlement.

### The items

| ID     | Item                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0** | **Postgres exporter into the existing Prometheus, with a slot-lag alert.**          | The host already runs Prometheus, Grafana, Alertmanager and node-exporter and scrapes the engine. The exporter is simply absent, which is why slot lag is invisible. Alert rule must carry `unless max_over_time(poker_maintenance_break_active[6m]) == 1` or it pages hourly about the scheduled `:55` stop. **This gates verification of every item below it.**                                                                                                                                                                                                |
| **R1** | **Unpublish `ca_hand_player_idx`.**                                                 | Zero subscribers proven by grep across both repos (§2.4 N2). Cheap, reversible, immediately measurable against R0. Put the grep evidence in the migration header.                                                                                                                                                                                                                                                                                                                                                                                                |
| **R2** | Range-partition the delete-churn tables by day; convert sweeps to `DROP PARTITION`. | `ca_club_tournament_player_daily`, `ca_hand_player_stat`, `daily_challenge_event_outbox`, `ca_hand_player_idx`, and — absent from all prior analysis — `hand_state_snapshots`. A dropped partition writes almost no WAL where twenty million deletes wrote a great deal. Zero of 992 tables are partitioned today.                                                                                                                                                                                                                                               |
| **R3** | `hand_state_snapshots`: stop updating a 7.3 GB table in place.                      | Measure row width and update cadence first (`ServerTableEngineBase.ts`, `ServerTableEngineSettlement.ts`, `TournamentManager.ts`, `DisconnectEngine.ts`, `services/supabase/snapshots.ts`). Append-only + partition prune, or snapshot only at state-transition boundaries.                                                                                                                                                                                                                                                                                      |
| **R4** | `ca_settlements`: explain 5.8 updates per row, then collapse them.                  | Almost certainly a status machine rewriting one row repeatedly. Read before changing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **R5** | Publication sweep, small batches, rule 10 in full force.                            | 113 tables. Unpublish **only** members with zero `postgres_changes` subscribers in **both** repos, batch by batch, evidence in each migration header. Start with the 29 Commander tables. **Correction to Handoff 1:** it claimed unpublishing "will not move slot lag" because decoding still reads every record. `pgoutput` checks publication membership before reassembling and emitting the tuple, so the saving is real, just smaller than the write-side fixes. Remember what dropping `table_hole_cards` cost: four hours of players with no hole cards. |
| **R6** | `table_hole_cards` — investigate before touching.                                   | `REPLICA IDENTITY FULL`, published, one subscriber, 3.96M inserts and 3.96M deletes. Find out what that subscriber needs from DELETE payloads before considering a replica-identity change. If it needs nothing, `default(pk)` removes a whole-row WAL write per delete.                                                                                                                                                                                                                                                                                         |
| **R7** | Migrate lobby and table channels to Broadcast.                                      | The structural fix: `postgres_changes` costs `changes × subscribers`, so 212 changes/sec at 500 players is ~530,000 evaluations/sec, while Broadcast does not scale with subscriber count. 148 `postgres_changes` sites against 17 broadcast sites today. Do R1–R4 first for headroom.                                                                                                                                                                                                                                                                           |
| ~~A1~~ | ~~Gate the five `hand_history` INSERT triggers on `has_human`~~                     | **STRUCK. See §2.1. Do not revive.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**One migration, one transaction** (each DDL fires a ~28 s PostgREST schema reload).
Partitioning 992-relation-database tables is Tier 3: template from
`supabase/migrations/.template.sql`, assertions that abort on their own violated
assumptions, and a pasted ROLLBACK section.

---

## 4. PHASE D — SENTRY DELIVERY

| ID     | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Was           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **D1** | **Verify in the Sentry dashboard that events actually arrive** — from all five runtimes (Hub client / server / edge, Arena client, engine). Is `NEXT_PUBLIC_SENTRY_DSN` even set in Vercel? It appears in no committed file. Also: alert rules, 30-day volume per project, the recorded **413** from ingest (`.agent/audits/2026-08-12-*:106`), whether Hub and Arena are separate projects, and PII (`sendDefaultPii`, `IdentityDNA.ts:206`).                                                     | H2 P5         |
| **D2** | **Remove the `/src/` gate on `Cannot read properties of null`** (`SentryInit.ts:171-174`). As of #2947 it drops essentially every production null-deref.                                                                                                                                                                                                                                                                                                                                           | New (§2.4 N1) |
| **D3** | Hub source maps. `withSentryConfig` is imported at `next.config.js:77` and never called; `sentryWebpackPluginOptions` (`:1070`) and `sentryOptions` (`:1087`) are dead variables; the export is `withPWA(nextConfig)`. The OOM justification (`:1113-1117`) is about **auto-instrumentation across 950+ pages**, not about uploading. **So upload the maps out of band** — a `sentry-cli sourcemaps upload` step after the build — and leave the plugin off. Measure a real build before deciding. | H1 B8 / H2 P3 |
| **D4** | Arena `beforeSendTransaction` drops every span under 100 ms (`SentryInit.ts:190`), and a 16-entry `ignoreErrors` duplicates most of the `beforeSend` string list. Rationalise both; filter by identifier, never by error class.                                                                                                                                                                                                                                                                    | H2 P6.3-4     |
| **D5** | Arena release _fallbacks_ still diverge (`'unknown'` vs `npm_package_version`). Cosmetic; fold into any nearby PR.                                                                                                                                                                                                                                                                                                                                                                                 | New           |
| **D6** | Hub `release` in all three inits — **already done by #1315**. Verify only, do not redo.                                                                                                                                                                                                                                                                                                                                                                                                            | H2 P8         |

---

## 5. PHASE C — CAPTURE GAPS

Ordered by blast radius. **Do not bulk-instrument** — §9.

| ID      | Item                                                                                                                                                                                                                                                                                                                                                                                          | Evidence            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **C1**  | `middleware.ts` — 319 lines, **zero** `try`/`catch`, zero Sentry. Geo-block (`:90`), admin guard (`:142`), JWT gate (`:150`, `:272`) all throw unhandled at the edge. Bonus: `createMiddlewareClient` imported at `:4` and never used — dead weight in the edge bundle.                                                                                                                       | H1 B1               |
| **C2**  | Five money routes plus `auth/commander-sso.js` have no `reportApiError` at all: `cron/rakeback-period-settle.js`, `cron/vip-stipend.js`, `cron/vip-lapse.js` (an hourly cron), `live/gift.js` (721 lines, 4 catches), `live/gifts.js`.                                                                                                                                                        | H1 B3, B4           |
| **C3**  | 22 of 32 `pages/api/cron/` handlers never import `reportApiError`; three more capture but never `flush()` (`auth-integrity-audit.js:94,97`, `email-deliverability-check.js:243,247`, `auth/log-client-error.js:143,161`). Only `sentry-signup-bridge.js:141` flushes. In a serverless function, no flush means no event.                                                                      | H1 B2, B7 / H2 P7   |
| **C4**  | Migrate the **eight** importers of `src/lib/sentry.js` to `reportApiError` — they believe they have reporting and have none (returns null on client `:25` and edge `:26`, calls the v8-removed `startTransaction` at `:153-157`). Then delete the file and add an import guard.                                                                                                               | H2 P4               |
| **C5**  | Arena: install a synchronous `window.onerror` listener that buffers into the existing 50-slot queue. Rejections are already covered; synchronous uncaught errors before idle are not.                                                                                                                                                                                                         | H2 P6.1 (corrected) |
| **C6**  | Arena root `ErrorBoundary.tsx:81` returns before the capture at `:84-99` for `ChunkLoadError`. The hard reload is correct; the silence is not — **at minimum count them**, because these spike on exactly the bad deploy you need to see.                                                                                                                                                     | H1 B14 / H2 P6.2    |
| **C7**  | `src/core/WebVitals.ts:25-29` calls `setMeasurement` from a dynamic-import `.then()` with no active span. Every measurement is discarded.                                                                                                                                                                                                                                                     | H1 B11              |
| **C8**  | `VoiceSignalService.ts:534-537` — a comment claiming deliberate quiet sits one line above `reportError`, and `src/utils/errorReporter.ts:23-67` has no throttle at all; 21 more report sites in that one file. **Port the engine's `sentryEventBudget.ts` (#2949, per-fingerprint 10/min + global 60/min) to the client** rather than inventing a second mechanism. Delete the false comment. | H1 B12              |
| **C9**  | `MasterBus.ts:1568-1589` — a breadcrumb per `emit`, no rate limit; the 500 ms identical-payload dedup at `:1515-1535` only catches byte-identical repeats, and `DEDUP_BYPASS` types skip even that. Useful trail gets evicted.                                                                                                                                                                | H1 B13              |
| **C10** | Signup bridge scans 7 days (`sentry-signup-bridge.js:89`) but archive runs at 30 (`archive-signup-errors.js:44`) — rows aged 7–30 days are unreachable and still live. Schedule disagrees too: docstring `:21` says 5 minutes, `vercel.json` says `*/15`.                                                                                                                                     | H1 B6               |
| **C11** | Engine DSN boot (#2917). **Recommendation: loud, not blocking.** A poker engine that refuses to boot because a telemetry endpoint is unset trades a monitoring gap for an outage. Make the absence a first-class alert through R0's Prometheus path and a startup log the deploy gate reads — not a hard `exit(1)`. Say so on the issue and close it.                                         | H1 B15 / H2 P2      |

---

## 6. PHASE X — REMOVAL

Every removal needs a zero-importer proof in the PR body. Most are proven below.

**Removable — World Hub**

| ID  | Target                                                                  | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | `utils/logger.ts`                                                       | The string `utils/logger` appears in no file anywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| X2  | `archive/cron/rls-monitor.js`                                           | 0 external importers (self-references only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| X3  | `archive/legacy-club-tournaments/*.js` (5 files)                        | 0 importers; two comment mentions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| X4  | `initErrorMonitoring` **only**                                          | The function is never called. **The module stays** — `CommanderErrorBoundary.jsx:25` needs its `captureException`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| X5  | `clawbot/sentry-triage.js` — **decide, don't drift**                    | Hardcodes org `smarter-poker` / project `smarter-poker-world-hub` (`:37-38`); the real slugs are `smarter-software-inc` / `javascript-nextjsmarter-poker-world-hubs` (`next.config.js:1076-1077`). Not scheduled anywhere, despite its docstring. This is why `sentry_error_log` has zero rows. Either fix the slugs and schedule it **through Open Claw** (§11.2 — never `vercel.json`, never a GitHub `schedule:`, never the Claude scheduler), or delete it and its five call sites. Either way `pages/api/clawbot/status.js:26` must stop advertising `enabled: true` — it is the only one of 19 tasks set true. |
| X6  | Dead `sentryWebpackPluginOptions` / `sentryOptions` in `next.config.js` | Resolve together with D3: use them or delete them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Removable — Club Arena**

| ID  | Target                                                                                           | Proof                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| X7  | `src/core/SupabaseIntegration.ts`                                                                | Only importer is its own test.                                                                             |
| X8  | `startTransaction` shim (`SentryInit.ts:337-343`)                                                | 0 call sites. (Correction: it wraps `startSpan`, so it is _not_ the removed v8 API — it is merely unused.) |
| X9  | `setSentryTags` / `setSentryContext` (`:280`, `:289`)                                            | Test-only consumers.                                                                                       |
| X10 | Server `setServerContext` / `reportWarning` (`server/src/services/errorReporter.ts:247`, `:212`) | Only `vi.fn()` mocks. **The client `reportWarning` is live — do not touch it.**                            |
| X11 | **`src/ClubArenaRoot.tsx` entire**                                                               | Zero importers repo-wide; `index.html:90` boots `src/main.tsx`.                                            |
| X12 | Unused `addBreadcrumb` import, `src/App.tsx:26`                                                  | Only occurrence in the file.                                                                               |
| X13 | `services/sentry-autofix/`                                                                       | No code imports it, but `vercel.json:239-242` declares it. Removal touches `vercel.json` plus two docs.    |

**X14 — stale comments that assert the opposite of the code.** These caused at least one
wrong audit; delete them in whichever PR touches the file: `PageErrorBoundary.jsx:36-39`
and `:162-163`, `pages/api/client-crash.js:7-10`, `HubErrorBoundary.jsx:35-37`, and the
false suppression claim at `VoiceSignalService.ts:534-537`.

**NOT removable — struck from the handoffs' lists**

- `vendor/commander-shared/` — defines `reportApiError` for ~500 routes (§2.2)
- `CommanderErrorBoundary` — rendered live from `CommanderLayout.jsx:19,935,1224`
- `onRouterTransitionStart` — a Next.js framework hook

---

## 7. PHASE O — WHAT TO BUILD

| ID     | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Why it is worth the tokens |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| **O1** | **Sentry cron check-ins.** `Sentry.captureCheckIn({monitorSlug, status})`. Wrap `fire_cron` in `scripts/openclaw-cron-dispatcher.py` — one place, ~58 jobs — and add `withMonitor` to the shared route wrapper for the 22 uninstrumented handlers, deriving schedule and grace from the cron expression already there. Start with `sp_prune_hand_history_10m`, `sp_prune_hand_state_snapshots_2m`, the horse social/story jobs, `auth-integrity-audit`. **Sentry can tell you a job that ran threw; it can never tell you a job stopped.** Two incidents this week were exactly that — the workers hop 401'd for a full day, and a doubled engine hand rate ran 53 hours until a billing email surfaced it. **Trap:** `deploy-openclaw.sh` was silently broken for months (it referenced an SSH key that never existed). Confirm it succeeds; do not assume. |
| **O2** | **Postgres exporter** — this is R0. Listed twice on purpose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **O3** | **Alert rules in version control.** None exist as code today. Money paths and slot lag page immediately; boundary crashes and cron misses go to a daily digest. Every fleet-level rule carries the maintenance-break guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **O4** | **A deploy-time synthetic smoke test.** All Sentry configs are `enabled: NODE_ENV === 'production'`, so the wiring is never exercised before it ships — which is exactly how three dead capture sites survived a green test suite. Throw a tagged error at deploy time and assert via the Sentry API that it arrived. **This is the check that catches the whole class**, including the next one nobody has found.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **O5** | **Name the digest owner.** If nobody will own it, the honest recommendation is to cancel the $80/mo and keep the engineering fixes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Scheduling constraints, all three binding:** Open Claw for application logic
(World Hub §11.2); no new GitHub `schedule:` trigger outside the §11.4 allowlist;
**never** the Claude scheduler (World Hub §10.9 — those tasks belong to one account,
report `enabled: true` forever, and stop firing silently; one read healthy for two and
a half months while dead).

---

## 8. PHASE H — HUMAN-ONLY

**H1. Rotate the `support@smarter.poker` password.** It was committed in plaintext at
`scripts/sentry-resolve-all.js:45-46`. The file is deleted on `main` (#1315) but **git
history retains the value**. Also determine whether that repo was ever public.

**H2. Decide whether to keep the Sentry subscription**, once O5 is answered.

---

## 9. THE QUOTA CEILING — EVERY ITEM RESPECTS THIS

50,000 errors/month (1,667/day), 5M spans (166K/day), **50 replays/month**.

- **Do not** un-swallow all 1,522 Arena and 2,015 Hub catch blocks. That exhausts the
  month in hours, after which Sentry drops _everything_. This is why §5 is a list of
  eleven named gaps and not a sweep. It is also why §2.3 item 12 matters: the "27%"
  figure describes catch blocks, not routes, and 78% of route files already report.
- **Do not** add per-hand tracing — 804K/day against a 166K/day budget, roughly $300/mo
  in overage. If it is ever wanted, sample on `has_human` **for tracing volume only**;
  that is a sampling decision about telemetry, not a denial of anything to a player,
  and it is the one place `has_human` remains legitimate here.
- **Do not** build on Session Replay. 50/month is one per fifteen hours, and both apps
  run `replaysSessionSampleRate: 0.1`, so it is almost certainly already rate-limited.
  Verify in the dashboard before designing anything around it.
- **Do not** use Sentry as a metrics store. Grafana is already running (R0/O2).

---

## 10. WHAT "DONE" MEANS

**Phase R.** (1) Slot lag under ~50 MB across a full peak hour, **read from R0's
exporter**, not inferred. (2) The expected drop in each table's WAL contribution,
stated per item. (3) Bounty attribution correct end to end for a horse tournament
knockout. (4) All nine rake invariants clean on a horse-only hand. (5) Tournament
recovery still ranks survivors. (6) **No hand lost for anyone** — every counter that
was rising keeps rising, for horses and humans alike.

**Phases D/C/X/O.** (1) **Evidence from the Sentry dashboard, never from source** —
"the code calls `captureException`" was true throughout the entire period it was
broken. (2) Both directions on every guard: it must fail against the broken version
and pass after; state both in the PR. (3) `npx tsc --noEmit` clean in both repos and
the pre-push hook passing **without `--no-verify`**. (4) A zero-importer proof pasted
into the PR before each removal. (5) One real fire-cycle observed producing a check-in.

---

## 11. ABORT — STOP AND ASK DAN

- A law test contradicts something here (**A1 already did — §2.1**)
- Any §10 verification fails and you cannot explain why
- A money path would have to be **executed** rather than probed and rolled back
  (§11.5 — an agent destroyed 48 real chips learning this)
- Two laws, or two `CLAUDE.md` copies, demand opposite things — never write a third law
- You are about to create a repo, Vercel project, Supabase project or OAuth client
  (**RULE 12 forbids it absolutely**)

---

## 12. WHERE TO START

Three PRs, in this order, each independently shippable:

1. **R0** — Postgres exporter + slot-lag alert with the break guard. Nothing else in
   Phase R is verifiable until this exists.
2. **R1** — unpublish `ca_hand_player_idx`. One transaction, grep evidence in the
   header, immediately measurable against R0.
3. **D2 + C7 + X12** — one small Arena PR: delete the `/src/` gate, give `setMeasurement`
   a span, drop the unused import. Small, safe, and D2 restores a whole error class.

Then R2 (partitioning, Tier 3, its own PR per table) and O1 (cron check-ins).

Push the branch and stop. Autopilot opens and merges. Do not sit watching CI
(`CLAUDE.md` §10.8 rule 3).

---

## 13. SOURCES

Both handoffs of 2026-09-04 · `docs/changelog/2026-09-04-sentry-repair-pass.md` ·
`.agent/audits/2026-09-04-sentry-repair-pass.md` · PRs #1315, #2913, #2942, #2947,
#2949 · issues #1317, #1318, #2917 · club-arena `CLAUDE.md` §10.5, §10.8, §11.5, §13 ·
World Hub `CLAUDE.md` §10.9, §11 · `scripts/ci/check-horses-are-players.mjs` ·
live production measurements, 2026-09-04.
