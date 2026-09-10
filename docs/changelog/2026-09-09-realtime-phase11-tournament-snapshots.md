# Phase 11: Tournament Lobby Snapshot Recovery

Scope: The existing TournamentDetails page, shared by the routed tournament
lobby and embedded tournament tabs. No engine, accounting, schema, scheduler,
credential, or notification-delivery changes.

## Reproduced Failures

The actual mounted page failed 11 targeted cases before the repair: no read on
SUBSCRIBED, ten reads for a pending refresh plus a burst, an old tournament
response overwriting a new scope, failed player reads clearing confirmed rows,
initial failure rendering an empty field, zero chips replaced by starting chips,
unrelated tournament invalidations issuing reads, failed scope transitions
retaining the previous event, retired channel callbacks changing the new event,
and an older snapshot overwriting a live entry update. The SUBSCRIBED case ran
for both routed and embedded mounts.

## Repair And Invocation

- Tournament/account effects create and retire the snapshot owner. Every read
  verifies that owner before applying any result. Registration UI completions
  use the same boundary; mutation authorities and request identities are unchanged.
- Mount, channel SUBSCRIBED, matching TOURNAMENT_UPDATED, visibility/focus, the
  existing watchdog, and Try Again all invoke loadTournament. A pending read
  retains one follow-up invalidation instead of starting overlapping requests.
- Existing tournament, player, and table callbacks apply their patches immediately.
  Patches arriving during a read are replayed on its result, without starting
  a full-field query for every live update.
- The service's explicit throwOnError read option separates failed reads from
  verified missing rows. Confirmed entries/tables survive refresh errors;
  initial failure and retry have an explicit UI state. Zero chips stay zero.
- Navigation waits for the current scope's complete snapshot. The existing
  pre-seat timing and fallback polling cadence remain unchanged.

## Verification

- Before repair: 11 targeted mounted-page failures.
- Final focused pass: 193 tests across tournamentSnapshotRecovery (14),
  TournamentService (85), tourneyUxSweep20260825 (74), and
  the-field-is-seated-before-the-clock (20).
- The final mounted tests use the real useMasterBusSubscription hook, including
  its payload contract. They also verify account retirement, retry recovery,
  purchased-seat navigation after a delayed table read, and no extra read for
  an in-flight live entry patch.
- TypeScript: npx tsc --noEmit passed. The worktree's dependencies were restored
  from the existing lockfile with npm ci; no dependency versions changed.
- Production build: npm run build passed; Vite completed in 15.52 seconds.
- Controlled Chrome opened a running tournament read-only; this is a baseline
  rendered-page check, before publication of this repair.
- CI, main adoption, public/origin assets and the corrected controlled-Chrome
  page were verified. Exact evidence: `../audits/2026-09-09-realtime-phase11-release.md`.

Physical iPad/PWA acceptance remains open. A Chrome page or a server metric is
not physical-device acceptance. No live seats, registrations, balances, or push
notifications are modified as test probes.

## Ordering Review

PR4043 merged as c79e2687f8446d47488dd8c17990cc6abf263f5d. A final
ordering regression then reproduced a narrower issue: an entry patch arriving
while the tournament header query was pending could overwrite a newer entry
query result (600 instead of 700 in the isolated case). The entry and table
patch buffers now open immediately before their own queries. They preserve
updates received during that query without replaying earlier updates over a
newer database answer. The added case failed before this correction.

The correction uses a fresh branch from main because PR4043 had already merged.
Publication verification must include this correction as well as PR4043.

## Corrective Release Verification

PR4046 merged as 65f1f4eed01300459545332eb7d4a90bddffba2a. All 15 mounted
recovery cases and TypeScript passed after the query-boundary correction. CI
34414946450 passed on its normal failed-job retry after an isolated PostgreSQL
shared-memory error. Publisher 34415964089 adopted this exact merge; both
public and origin stamps and the referenced tournament bundle were verified
at 23:19:43 UTC. Controlled Chrome loaded that bundle and matched the read-only
field and table counts, with no displayed error alert. Physical-device
acceptance remains open. See the release audit for exact timestamps and hashes.
