# 2026-09-04 - Sentry on the free tier: the Club Arena cut

**Branch:** `fix/sentry-free-tier`. **Spec:** `docs/SENTRY-FREE-TIER-POLICY.md`
(copied into the repo in this PR; it supersedes phases D, C and O of
`docs/SENTRY-AND-REALTIME-PROGRAMME.md`).

Dan cancelled the Team plan. From 2026-09-16 the whole organisation has the
Developer plan: **5,000 errors a month** (~166 a day) shared by the World Hub,
this client and the engine, 50 session replays, 5M spans, one cron monitor.
The engine deals 33,500 hands an hour; one bug firing per hand would spend a
month's allowance in nine minutes and then Sentry would silently drop the real
thing for every project. So Sentry is now an alarm bell for surprises on paths
that move money or keep the platform alive, and nothing else, and the budgets
are code.

## The budgets (section 4 of the policy)

| runtime      | daily  | per fingerprint | per session | sample | where enforced                                             |
| ------------ | ------ | --------------- | ----------- | ------ | ---------------------------------------------------------- |
| Arena client | **40** | 3               | **2**       | 0.25   | `src/core/sentryClientBudget.ts` in `beforeSend`           |
| Engine       | **60** | 3               | -           | 1.0    | `server/src/services/sentryEventBudget.ts` in `beforeSend` |

Both reset at 00:00 UTC. The client persists its daily count in
`localStorage` (`ca-sentry-budget`, keyed by the UTC date; every read and
write is wrapped, a corrupt or throwing store falls back to the in-memory
count for that page load, so a hostile browser can never break admission).
Tracing, Replay and profiling are **off**, not sampled low: the rates are
pinned to 0 AND the integrations are no longer exported from
`src/core/sentryBundle.ts`, so nothing can load them by accident.

Nothing is filtered by error class any more. The `/src/`-gated
`Cannot read properties of null` drop in the client `beforeSend` discarded
every real production null-deref once source maps stopped shipping to the
browser; it is gone, along with the `<100ms` `beforeSendTransaction` (there
are no transactions to filter). Known noise is still dropped by NAME
(AbortError, extension frames, ResizeObserver, the fetch-failed family, EPIPE,
and the one-per-minute Supabase transient rule on the engine).

## The allowlists (section 3 of the policy)

Every `reportError` call site keeps working - it still writes the console
line it always did - but only contexts on the allowlist go to Sentry. The
gate is in the wrapper because a 1,300-site (client) or 700-site (engine)
diff is a diff nobody can review, and the one place every call passes
through is the right place to decide. Each list is documented in its file's
header; every string is the literal at its call site, taken by grep, and the
engine test `every allowlisted context is a literal at a real call site`
fails if one is ever guessed.

**Client** (`src/utils/errorReporter.ts`, 26 contexts): the four boundaries
(`PageErrorBoundary.crash`, `RouteErrorBoundary.crash`,
`TableErrorBoundary.crash` are NEW calls - those three boundaries only wrote
to the console before; the root `ErrorBoundary` captures directly for its
report-dialog event id and is budgeted by the same `beforeSend`), the two
in-page boundaries on HomePage and ClubDetailPage, the global net
(`main.Unhandled_promise_rejection_caught`, the missing-env boot failure),
and 19 money contexts: buy-in, cash-out, rebuy/add-on, transfer, payout and
bonus credit paths where the client asked for a chip movement and the server
refused or never answered. Non-allowlisted contexts `console.warn` once per
context per page load saying they are kept local.

Sentry's own `onunhandledrejection` hook is turned off
(`globalHandlersIntegration({ onerror: true, onunhandledrejection: false })`)
because `main.tsx` already reports every unhandled rejection through
`reportError`; with both on, one rejection cost both of the session's two
events. `onerror` stays: an uncaught exception has no context and is
budgeted by `beforeSend` with the message head as its fingerprint.

**Engine** (`server/src/services/errorReporter.ts`, 44 contexts), by the
policy's categories:

- the process is about to die: `GameServer.Fatal_error`,
  `GameServer.Uncaught_exception`, `GameServer.Unhandled_rejection`,
  `GameServer.hand_history_queue_lost_on_fatal`, `Supabase.FATAL`
- a hand in flight is at risk: `GameServer.drain_timed_out` (NEW call in
  `drainHands()` when the budget expires with tables still mid-hand) and
  `MaintenanceBreak.park_failed` (NEW call beside the existing
  `could not park table` warning in `parkEveryEngine()`; the break's tests
  still pass, 39/39)
- settlement refused / threw: the four `DB.settle_hand_stacks_*` contexts,
  `ServerTableEnginethistableId.AtomicSettle_failed`, `HandController.CRITICAL`
- ledger write failure: `Tournament.settle_obligation_transport`, the bomb
  ledger and BBJ atomic paths, the three `logRakeCollection.*_credit_failed`,
  `Tournament.rake_settlement_failed`
- a player is owed: the prize / payout-reconcile / bubble / final-table /
  mystery-bounty / backed-payout / cancel-refund / `FeeReconciler.prize_*` /
  `RakebackSettler.tournament_payout_unreconciled` contexts
- the estate has stopped dealing: `DealRateVerifier.fleet_silent`

Everything else (seat heartbeats, RPC retries that succeeded, horse logic,
voice ICE, discovery loops) stays on stdout and on the Prometheus gauges and
alert groups that already exist.

## What is visible on /metrics

`GameServer.getPrometheusMetrics()` now emits, synchronously and with no I/O,
next to the always-on action-latency lines:

- `poker_sentry_events_dropped_total` (counter) - refused by the daily budget since boot
- `poker_sentry_events_sent_today` (gauge) - sent so far this UTC day, budget 60
- `poker_sentry_events_suppressed_total` (counter) - `reportError` calls kept local by the allowlist

The old design sent a "budget summary" EVENT every ten minutes to say what it
had dropped - up to 144 a day, more than twice the new budget. That event,
`flushBudgetSummary()`, and the `sentry_budget_summary` bypass tag are gone;
the numbers are scraped instead.

## Deleted, with zero-importer proofs

All greps run across `src/`, `server/src/`, `tests/`, `index.html`,
`vite.config.ts` after the change; the count is of remaining references.

| deleted                                                                                                                                                                                                                                            | proof                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/SupabaseIntegration.ts` + `tests/unit/SupabaseIntegration.test.ts`                                                                                                                                                                       | `grep -rn SupabaseIntegration src server/src tests` = 0 (its only importer was its own test)                                                                                                                                                                                                                                                                                                  |
| `src/ClubArenaRoot.tsx` (entire file)                                                                                                                                                                                                              | `grep -rn ClubArenaRoot src server/src tests index.html vite.config.ts` = 0; `index.html` boots `src/main.tsx`                                                                                                                                                                                                                                                                                |
| `src/core/WebVitals.ts` + its `initWebVitals()` call in `main.tsx` + its `entry-chunk-baseline.json` row                                                                                                                                           | `grep -rn core/WebVitals` = 0. Its only Sentry path was `setMeasurement` with no active span (already discarded server-side); the rest was a dev-only console line. `web-vitals` stays in `package.json` (a dependency change reclassifies the whole CI run; a follow-up may drop it)                                                                                                         |
| `startTransaction` shim, `setSentryTags`, `setSentryContext` in `SentryInit.ts`                                                                                                                                                                    | `grep -rn "startTransaction\|setSentryTags\|setSentryContext"` = 0 (they were test-only consumers; `tests/unit/SentryInit.test.ts` updated)                                                                                                                                                                                                                                                   |
| unused `addBreadcrumb` import in `src/App.tsx`                                                                                                                                                                                                     | only occurrence in the file; removed                                                                                                                                                                                                                                                                                                                                                          |
| `MasterBus.emit()` breadcrumb emitter (the `window.__SENTRY__` block)                                                                                                                                                                              | `grep -rn __SENTRY__ src` = 0. It evicted the useful trail on every bus event                                                                                                                                                                                                                                                                                                                 |
| server `reportWarning`, `setServerContext`, `flushBudgetSummary`                                                                                                                                                                                   | `grep -rn "reportWarning\|setServerContext\|flushBudgetSummary" server/src` = only the new test asserting they are gone; the two `vi.fn()` mocks in `insuranceLedger.test.ts` and `rakebackWatermark.test.ts` removed. The CLIENT `reportWarning` in `src/utils/errorReporter.ts` is live (`main.tsx` uses it) and stays                                                                      |
| `services/sentry-autofix/` (whole service), `scripts/sentry-autofix/`, `docs/sentry-autofix.md`, `docs/runbooks/09-sentry-autofix.md`, `.github/workflows/sentry-autofix.yml`, the `experimentalServices["sentry-autofix"]` entry in `vercel.json` | `grep -rn sentry-autofix src server/src tests` = 0. The workflow was `repository_dispatch`-only, fired by the deleted service, so it is dead with it. Remaining mentions are branch-name globs in `agent-open-pr.yml` / `report-stuck-prs.sh` (old `sentry-autofix/*` branches still on origin) and historical changelogs; `design/.../CREDENTIALS_MAP.md` no longer lists its `.env.example` |
| `replayIntegration`, `reactRouterV6BrowserTracingIntegration`, `startSpan`, `setMeasurement`, `setContext`, `setTags`, `setTag` from `sentryBundle.ts`                                                                                             | `grep -rn` = only the policy comment in the bundle and the test asserting they are unreachable                                                                                                                                                                                                                                                                                                |
| the false "deliberately quiet" comment at `VoiceSignalService.ts:534-537`                                                                                                                                                                          | the code under it reported to Sentry on every join; the comment said the opposite. The 21 `VoiceSignalService` reports are now console-only via the allowlist (no call site edited)                                                                                                                                                                                                           |
| the old per-minute `sentryEventBudget.ts`                                                                                                                                                                                                          | replaced, not tuned: `DEFAULT_BUDGET` is `{ perKeyLimit: 3, globalLimit: 60 }` per UTC day; `SENTRY_BUDGET_WINDOW_MS` is no longer read (`grep -rn SENTRY_BUDGET_WINDOW` = 0)                                                                                                                                                                                                                 |

The other three "stale comments" in the policy (`PageErrorBoundary.jsx`,
`client-crash.js`, `HubErrorBoundary.jsx`) are World Hub files and are not in
this repo.

## Kept on purpose

- The Sentry vite plugin and source-map upload (`vite.config.ts`,
  `tests/source-maps-go-to-sentry-not-to-players.law.test.ts`): the free tier
  supports it and the few client crashes that do get through must be
  readable. Untouched.
- The engine's transient-Supabase rule (one warning per message per minute):
  it is what made the 2026-08-15 freeze visible, and it runs before the budget.
- The client `reportWarning` (breadcrumbs cost nothing until an allowlisted
  error carries them).
- `SENTRY_BUDGET_PER_KEY` / `SENTRY_BUDGET_GLOBAL` env overrides, for an
  incident. Never above the policy figure without a line in the policy.
- `web-vitals` in `package.json` (see the table above).
- `agent-open-pr.yml` and `report-stuck-prs.sh` branch-name globs for
  `sentry-autofix/*`: those branches still exist on origin and the globs stop
  the watchdogs proposing them.

## Tests

- root: `tests/unit/sentryFreeTier.client.test.ts` (11 new) plus the trimmed
  `SentryInit.test.ts` (8), `bundleSurface` (4), `ErrorBoundary` (13):
  **36/36**. Against the pre-change `SentryInit.ts` / `sentryBundle.ts` /
  `errorReporter.ts` restored from `origin/main`, 7 of the 11 new tests fail
  (`expected 0.1 to be +0`, `captureException ... called 3 times`,
  `replayIntegration must not be reachable`), then pass again once restored.
- server: `SentryEventBudget.test.ts` (10) and `errorReporterBudget.test.ts`
  (11) rewritten, plus `insuranceLedger`, `rakebackWatermark`,
  `MaintenanceBreak` (39): **85/85**. Against the pre-change
  `errorReporter.ts` / `sentryEventBudget.ts`, 15 of the 21 fail
  (`expected [true, true, true, true, true] to deeply equal [true, true, true, false, false]`,
  `expected 4320 to be 180`), then pass again once restored.
- `npx tsc --noEmit`: clean in root and in `server/`.

The four verifications the policy asks for, by name: (a) a non-allowlisted
context never calls Sentry - `a non-allowlisted context is console-only and
never calls Sentry` in both files; (b) the 61st engine event in a day is
dropped and counted - `the 61st event in a day is dropped and counted, even
with distinct contexts`; (c) the fourth identical fingerprint is dropped -
`the fourth identical fingerprint is dropped and counted` (engine) and
`... across sessions` (client); (d) client replays and tracing are off -
`turns replay and tracing off and samples a quarter of errors` asserts the
`init` options and that neither integration factory was called.

## Still Dan's

Whether the Arena client keeps Sentry at all (40 a day buys visibility into
player-facing crashes; the SLO rules also see them as stalled tables), and
whether Alertmanager actually reaches a phone (`SLACK_ALERT_URL` /
`PAGERDUTY_SERVICE_KEY` on the host were never confirmed set). Neither is
changed here.
