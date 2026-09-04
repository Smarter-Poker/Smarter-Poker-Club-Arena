# Sentry on the free tier: where it lives now, and where it does not

**2026-09-04 · binding for both repos · supersedes phases D, C and O of
`docs/SENTRY-AND-REALTIME-PROGRAMME.md`**

Dan cancelled the Team plan on 2026-09-04. The current cycle is already
hard-capped (`Pay-as-you-go limit reached: True`) — **Sentry is dropping every
event right now** and will until the Developer plan begins on 2026-09-16.
Nothing sent today lands. The work here is about what happens after that.

## 1. THE BUDGET, AND WHAT IT MEANS

The Developer plan is free for ever and provides, **for the whole organisation
across all three projects**:

|                 | per month | per day  | note                                |
| --------------- | --------- | -------- | ----------------------------------- |
| errors          | **5,000** | **~166** | shared by Hub, Arena client, engine |
| spans           | 5M        | 166K     | per-hand tracing alone is 804K/day  |
| session replays | 50        | 1.6      | one every fifteen hours             |
| cron monitors   | **1**     | —        | the estate has ~185 scheduled jobs  |
| uptime monitors | 1         | —        |                                     |
| users           | 1         | —        | Dan only                            |

Three consequences follow, and they are not negotiable:

1. **166 errors a day across everything.** The engine deals 33,500 hands an
   hour. One bug that fires per hand exhausts a _month_ in nine minutes, after
   which Sentry silently drops the real thing. Every runtime needs a hard
   daily ceiling far below its share, or the first noisy day blinds every
   other runtime for the rest of the month.
2. **Session Replay and tracing are off.** Not sampled low — off. 50 replays
   is not a feature; 5M spans is six days of hand tracing.
3. **Cron check-ins are dead as a plan.** One monitor for 185 jobs is not
   monitoring. `fn_cron_fleet_health` on Prometheus, shipped today, already
   does this for free. The programme's O1 item is withdrawn.

## 2. THE PRINCIPLE

**Sentry is an alarm bell for surprises on paths that move money or keep the
platform alive. It is not a log, not a metrics store, not a tracing tool, and
not a place where "every catch block" reports.**

Everything it used to do at volume moves to what is already free and already
running:

| It used to do                        | It now does              | What does it instead                                                                  |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------- |
| every API route's catch block        | nothing                  | `financial_alerts` (money), console + Vercel logs (rest)                              |
| engine per-hand errors               | nothing                  | Prometheus gauges + Alertmanager (`settlement`, `replication`, `money-health` groups) |
| cron failures / silence              | nothing                  | `poker_cron_*` gauges, `OpenClawJobsHaveGoneSilent`                                   |
| performance tracing                  | nothing                  | `poker_action_processing_p95_ms`, `poker_broadcast_latency_p95_ms`, SLO rules         |
| session replay                       | nothing                  | — (gone)                                                                              |
| web vitals                           | nothing                  | — (gone; was already discarded, no active span)                                       |
| breadcrumbs from MasterBus           | nothing                  | — (gone; was evicting the useful trail)                                               |
| unexpected exception on a money path | **still Sentry**         | the one job it keeps                                                                  |
| engine boot / crash / drain failure  | **still Sentry**         | the other job it keeps                                                                |
| a page crash a player actually sees  | **still Sentry**, capped | React error boundaries only                                                           |

## 3. WHERE IT LIVES — THE ALLOWLIST

A call site is critical, and may reach Sentry, only if it is on this list.
Everything else is removed or becomes a local log. **Adding to this list is a
PR that names the daily cost.**

### Engine (`server/`) — budget 60/day

| keeps Sentry                                                       | why                                       |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `GameServer` boot failure, uncaught exception, unhandled rejection | the process is about to die               |
| `drainHands()` / maintenance break failing to park a table         | a hand in flight is at risk               |
| `fn_ca_settle_hand_stacks_absolute` refused / threw                | chips did not move as the engine believes |
| ledger write failure (`chip_ledger`, `fn_credit_and_log`)          | the record and the money disagree         |
| tournament payout / bounty credit failed after retries             | a player is owed                          |
| DealRateVerifier fleet-silent verdict                              | the estate has stopped dealing            |

Everything else in the 713 call sites — seat heartbeats, RPC retries that
succeeded, horse logic, voice ICE, discovery loops — logs locally and emits a
Prometheus counter where one exists.

### World Hub server (`pages/api/`) — budget 60/day

| keeps Sentry                                                        | why                                  |
| ------------------------------------------------------------------- | ------------------------------------ |
| `cron/rakeback-period-settle`, `cron/vip-stipend`, `cron/vip-lapse` | move chips on a schedule             |
| `live/gift`, `live/gifts`                                           | move chips on demand                 |
| tournament settlement and payout routes                             | move chips                           |
| `auth/commander-sso`, `auth/*` sign-in failures                     | a locked-out player                  |
| `middleware.ts` geo-block / admin guard / JWT gate throwing         | currently fails silently at the edge |

The other 500 routes keep `reportApiError` **as a function**, but it no longer
sends unless the route is on this list: it writes to the console (Vercel
captures it) and, for anything money-shaped, to `financial_alerts`. The 541
call sites stay; the traffic stops. Ripping the calls out would be a
1,500-file diff nobody can review, and the wrapper is the right place for the
gate.

### Arena client (`src/`) — budget 40/day, **2 per session**

| keeps Sentry                                                                          | why                  |
| ------------------------------------------------------------------------------------- | -------------------- |
| `TableErrorBoundary`, `PageErrorBoundary`, `RouteErrorBoundary`, root `ErrorBoundary` | a player saw a crash |
| uncaught exception / unhandled rejection (one each per session)                       | same                 |
| a money action the client believes succeeded and the server refused                   | chips                |

Removed entirely: `WebVitals` (`setMeasurement` with no span — was already
discarded), `MasterBus` breadcrumbs (evicted the useful trail), the 21
`VoiceSignalService` reports, `SupabaseIntegration`, tracing, Replay.

**Clients are the quota risk.** A bad deploy puts the same error in ten
thousand browsers at once. So the client carries a per-session cap of two
events and `sampleRate: 0.25` on top of the boundary allowlist — a wave of
identical crashes costs at most a few dozen events, and the deploy is caught
by the SLO rules and `publish-watchdog` anyway.

### World Hub client and edge — **removed**

The Hub is a content site. A client crash there is not money, the edge config
sampled traces at 5% and captured nothing that mattered, and both are pure
quota exposure. `sentry.client.config.js` and `sentry.edge.config.js` go, and
`GlobalErrorCatcher` / `useYouTubeErrorManager` stop reporting. `middleware.ts`
is the exception and is instrumented from the _server_ config's scope.

## 4. THE BUDGETS ARE CODE, NOT INTENT

Every runtime that keeps Sentry gets the same mechanism:

- `tracesSampleRate: 0`, `replaysSessionSampleRate: 0`,
  `replaysOnErrorSampleRate: 0`, `profilesSampleRate: 0`; the Replay and
  BrowserTracing integrations are not loaded at all.
- A **daily token bucket** in `beforeSend`, per runtime, sized from section 3.
  When it is empty, `beforeSend` returns `null` and increments a local counter
  (`poker_sentry_events_dropped_total` on the engine) so the drop is visible.
- A **per-fingerprint cap of 3 a day**: the fourth identical error is dropped.
  Sentry groups them anyway; sending a thousand copies buys nothing.
- **Nothing is filtered by error class.** The morning's audit found blanket
  `ReferenceError` and `/src/`-gated null-deref drops throwing away the bugs
  with the noise. Filter known identifiers by name, never by type.

The engine's existing `sentryEventBudget.ts` (10/min per fingerprint, 60/min
global — up to 86,400 a day) is replaced, not tuned: the shape was right and
the numbers were built for a plan that no longer exists.

## 5. WHAT IS DELETED, WITH PROOF

Every item below is removed with a zero-importer grep pasted in the PR. Most
were identified this morning; the free tier makes them mandatory.

**World Hub:** `sentry.client.config.js`, `sentry.edge.config.js`,
`src/lib/sentry.js` (8 importers migrated to `reportApiError`),
`utils/logger.ts`, `initErrorMonitoring` and the `errorMonitoring.js`
subsystem, `archive/cron/rls-monitor.js`, `archive/legacy-club-tournaments/*`,
`clawbot/sentry-triage.js` and its five call sites (it hardcoded slugs that
do not exist), the dead `sentryWebpackPluginOptions` / `sentryOptions` in
`next.config.js`, `withSentryConfig` import, `pages/api/client-crash.js`'s
stale comments. **Not** `vendor/commander-shared/` — it defines
`reportApiError`.

**Arena:** `SupabaseIntegration.ts`, `src/ClubArenaRoot.tsx` (zero importers,
entire file), the `startTransaction` shim, `setSentryTags` / `setSentryContext`,
server `setServerContext` / `reportWarning` (server only), the unused
`addBreadcrumb` import in `App.tsx`, `WebVitals.ts`'s Sentry path,
`MasterBus`'s breadcrumb emitter, `services/sentry-autofix/` and its
`vercel.json` entry, `sentryEventBudget.ts` (replaced), the four stale
comments that assert the opposite of the code.

**Both:** every `Replay` / `BrowserTracing` / `reactRouterV6BrowserTracing`
integration, every `tracesSampleRate` above 0, `SENTRY_TRACES_SAMPLE_RATE`
env references, cron check-in code (none was ever written — O1 is withdrawn
before it starts).

## 6. WHAT STAYS FREE AND ALREADY WORKS

None of this is new; it was built today and it is the reason the cut is safe:

- `replication`, `settlement`, `money-health`, `cron-health`,
  `postgres-health`, `slo-objectives` alert groups — 30 rules on Prometheus
- `fn_settlement_health`, `fn_financial_alert_health`,
  `fn_undeclared_money_triggers`, `fn_cron_fleet_health`,
  `fn_replication_slot_metrics`
- `financial_alerts` with a `resolution` column and an auto-resolver
- source-map upload to Sentry (free tier supports it) — kept, because the
  handful of client crashes that do get through must be readable

## 7. WHAT DAN STILL DECIDES

- **Alertmanager's receiver.** The 30 rules route to Alertmanager; whether
  Alertmanager reaches a phone depends on `SLACK_ALERT_URL` /
  `PAGERDUTY_SERVICE_KEY` in the host `.env`, which the engine-01 README
  says were never set. With Sentry gone as the thing that emails, this is the
  only path left, and it is not confirmed live.
- Whether the Arena client keeps Sentry at all. Forty events a day buys
  visibility into player-facing crashes; zero buys nothing. The policy keeps
  it; the case for removing it entirely is that boundary crashes also show up
  in the SLO rules as stalled tables.
