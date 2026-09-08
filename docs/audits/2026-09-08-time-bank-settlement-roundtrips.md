# Unchanged Time Banks Must Not Add A Settlement Round Trip

## Measured Root Cause

At 11:42 UTC on 2026-09-08, engine c5b7203a reported 2,000 completion-to-deal
samples: median 3,120 ms, p90 7,195 ms, maximum 20,961 ms; 1,389 exceeded
2,500 ms. Three included rebuy pauses. The event-loop governor remained at
scale 1, p50 20.742 ms and p99 39.551 ms. The earlier 2,053 ms median was not a
stable result and does not close the overall hand-delay audit.

A subsequent 72-second difference of production settlement counters showed
sync_stacks means of 1,561-1,656 ms across cash, MTT, Spin, and heads-up. About
94-96% exceeded one second. Hand-history means were 815-858 ms. These counters
cover horse hands, not a controlled human-player timing experiment.

syncStacks awaited its atomic stack RPC, then awaited one HTTP update per player
for time banks. The existing PostgREST filter suppressed unchanged database rows
and WAL, but every unchanged player still cost a request, and that entire wave
ran after the stack RPC. This is a concrete serial wait, not a CPU hypothesis.
Tournament chip synchronization and other settlement reads remain contributors.

## Change

The existing authoritative roster read now retains the two raw persisted bank
values, including null. Settlement captures these alongside current engine bank
values before its first await. Bank persistence omits each unchanged column and
sends no request when both match. It does not maintain a cross-hand cache or
optimistically acknowledge a write. An unknown or null baseline still writes a
real zero. The original database no-op filter and active-seat predicates remain.

Consumption and replenishment still persist inside the settlement barrier after
the stack RPC succeeds. Resolved PostgREST errors are reported instead of being
silently ignored. A failed write leaves the roster baseline untouched, so the
next authoritative read still exposes the outstanding difference. The atomic
chip RPC, conservation declarations, idempotency, retries, and refusal behavior
are unchanged. No migration, live wager, or paid feature is used.

## Verification And Release Boundary

Eight behavioral tests cover request suppression, consumption to zero,
replenishment, unknown/null baselines, failed-write retry, the awaited barrier,
and preservation of raw roster nulls. The focused suites passed 71 tests.
The full engine suite passed 6,809 tests in 481 files. Server TypeScript and
`npm run build` completed successfully. Production timing improvement requires
measurement after the normal Hetzner engine release adopts this commit; these
pre-release numbers are not a claim that the overall delay is fixed.
