# 2026-09-04 - The engine gets its own Sentry project and an event budget

## What was wrong

The game engine's `SENTRY_DSN` on Hetzner pointed at the **World Hub** Sentry
project (`javascript-nextjsmarter-poker-world-hubs`, id 4510816835600384). On
2026-08-24 engine error loops (one defect, thousands of identical events a
minute) exhausted the organisation-wide error quota. Sentry then answered every
project in the org with HTTP 429 `error_usage_exceeded` and dropped the event -
World Hub, Club Commander, everything - until the quota renews on 2026-09-16.

The Club Commander login outage on 2026-09-03 raised no alert for exactly this
reason. A quiet Sentry was mistaken for a healthy platform.

## What changed

1. **Own project.** `club-arena-engine` (id 4512027289976832) created via the
   Sentry API, with an alert rule "Engine error loop (same issue > 200 in 15
   min)" (rule 17436247). The Hetzner `/opt/club-arena/server/.env` now
   carries its DSN (previous file kept as `.env.bak-20260904-sentry`). The
   swap takes effect at the next engine restart, which is the hourly `:55`.

   The quota is still shared org-wide, so a separate project alone does not
   protect the others. It does mean the engine's noise no longer pollutes the
   hub's issue list, and its alert rules can be tuned for an engine.

2. **Per-key rate limit: NOT available.** `PUT /projects/.../keys/<id>/` with
   `{"rateLimit":{"window":60,"count":30}}` returns 200 and `rateLimit: null`
   on this plan. Verified twice. Do not assume Sentry throttles the engine.

3. **SDK-side budget** (`server/src/services/sentryEventBudget.ts`, wired
   into `beforeSend` in `errorReporter.ts`):
   - 10 events per minute per fingerprint. A fingerprint is the
     `[context]` prefix `reportError()` writes plus the first 80 chars of the
     message with ids, hex, numbers and timestamps normalised away, so a loop
     over 200 tables is one key.
   - 60 events per minute globally, so a message-mutating defect is capped
     too.
   - Every dropped event is COUNTED. One summary event every 10 minutes (and
     on shutdown, from `flushSentry()`) reports the totals and the top 15
     fingerprints, tagged `sentry_budget_summary=true`, grouped into a single
     issue. The summary bypasses the budget: a throttled engine must be able
     to say it was throttled.
   - Worst case the engine now sends ~60/min + 1 summary/10min. The August
     loops produced millions per day.
   - Env overrides `SENTRY_BUDGET_PER_KEY`, `SENTRY_BUDGET_GLOBAL`,
     `SENTRY_BUDGET_WINDOW_MS` (documented in `server/.env.example`; set to
     the defaults on Hetzner).
   - The existing rules are untouched: EPIPE dropped, Supabase transient
     errors 1/min/message at warning level.

4. **Tests**: `server/src/services/SentryEventBudget.test.ts` (pure budget: per
   key, global, window rollover, memory bound under a message-mutating loop,
   worst-case throughput, env parsing) and
   `server/src/services/errorReporterBudget.test.ts` (wiring: the budget is in
   `beforeSend`, the summary passes when everything else is dropped,
   `flushSentry` emits it, the transient rule survives).

## What to do if the summary issue fires

The issue titled `[SentryBudget] dropped N engine event(s) ...` means the
engine was loud enough to be throttled. Open its `sentryBudget` context: `top`
lists the fingerprints and counts. That is the loop. Fix the defect; do not
raise the budget.

## Related

- Commander incident record: `smarter-poker-commander/docs/changelog/2026-09-03-commander-login-outage.md`
- Commander law 3.2 "a quiet Sentry is not health" (`smarter-poker-commander/CLAUDE.md`)
- Commander runbook `docs/runbooks/sentry-auth-alerts.md` (quota section)
