# A Bare Park Request Is Not A Move In Flight

Production Alerts board (Smarter-Poker/Smarter-Poker-Club-Arena#5070):
tournament `bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f` ("DSS Thursday $5.50 NLH
Turbo") reached heads-up-then-won on 2026-09-18 05:17 UTC and sat `RUNNING`
for nine days. `financial_alerts` recorded two proven, retry-eligible
`Tournament.atomic_finish_refused` rows for it on 2026-09-26 (reasons
`other` then `timeout`); its winner (`squeeze777`, 168000 chips) was never
paid the 40.02 owed of the 63.00 pool.

## Root cause

Calling `fn_complete_tournament_terminal(...,'places')` for this tournament
failed inside `fn_settle_tournament_places`'s own winner-status flip,
refused by the `BEFORE` trigger `smarter_private.f06_source_guard()` as
`F06_SOURCE_EXCLUDED`. The guard's `bound` check treated ANY
non-acknowledged/non-withdrawn `smarter_private.f06_operations` row as a
live move that must exclude every ordinary writer to its table - but the
function's own elimination-dispatch fast path, a few lines further down,
already knows a bare `park_requested` row (no manifest, no admission, no
member, no attempt, no close/cleanup/abort evidence) is not a move in
flight; it is a planned move whose table concluded before the move could
manifest. `bound` never got the same nuance, so a table left holding one of
these skeleton rows was excluded from every ordinary write forever,
including its own tournament's terminal settlement.

This tournament's `f06_operations` row (`break_id`
`544dc515-bbbf-4337-8622-e177139bc09a`) is exactly that shape, created 25
seconds after the table's last real elimination, with zero matching rows in
`f06_movement_admissions`, `f06_members` or `f06_attempts`. It was not the
only one: 7 tables carried a bare, unbound `park_requested` operation this
way at the time this was found, the newest created minutes before the fix
was written.

## Fix

Migration `20260927201810_f06_source_guard_unbinds_bare_park_requests.sql`
gives `bound` the identical "genuinely bound" predicate the
elimination-dispatch fast path already trusts. Nothing else in the function
changes; a table with a real move in flight is excluded exactly as before.

Proved via a rolled-back production probe (CLAUDE.md 11.5) before writing
the fix, and via an executable red-before/green-after proof against a
throwaway PostgreSQL cluster
(`scripts/dev/probe-f06-source-guard-unbinds-bare-park-request-pg16.sh`,
pinned by `server/src/tournament/F06GuardUnbindsBareParkRequest.guard.test.ts`):
the exact production pre-image reproduces `F06_SOURCE_EXCLUDED`, the
migration lets the same write through, and a genuinely bound operation (a
row with a real manifest) still correctly refuses.

## What this does not do

This migration does not settle `bfcfaf17`'s payout and writes no money - it
only unblocks the existing, receipted, idempotent settlement path. Once
installed and live, the tournament's own in-process retry (or an authorized
direct call to `fn_complete_tournament_terminal`) completes it through the
normal path.

## Hardening (CLAUDE.md 10.11/10.12)

1. Cause fixed at the root: the guard's own `bound` predicate.
2. Damage: not yet settled - deferred to a follow-up run after this migration
   is live, so the settlement itself is proved against the corrected guard
   rather than assumed.
3. Regression test: see Fix, above.
4. CI: `.github/workflows/f06-guard-unbinds-bare-park-request.yml` runs both
   the live proof and the pinning test on any PR touching this path.
