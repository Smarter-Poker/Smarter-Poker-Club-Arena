# Daily Challenges Catch Up On Lifecycle Events, Not A 15-Second Timer

Phase 2 of the Daily Challenges programme, shipped in PR #5039 (squash
`b293beb4e`, merged 2026-09-21). This entry was written with the Phase 4
certification follow-up, which found that #5039 had shipped without one.

## Shipped

- **The 15-second reconciler is gone.** The page scheduled
  `setTimeout(reconcileRevision, 15_000)` for its whole lifetime: a renamed
  `setInterval` that read the per-user revision cursor every fifteen seconds
  as a repair path for a lost realtime frame. That is the recurring repair
  mechanism the owner policy and `docs/standards/EVENT-DRIVEN-EXECUTION.md`
  ban.
- **Catch-up is owned by events.** Every `SUBSCRIBED` status (the first join
  and every rejoin) performs one bounded read of
  `daily_challenge_dashboard_revisions` and loads the dashboard only when the
  cursor is newer than the rendered revision. A tab resume performs the same
  read; only a UTC date change reloads outright. One cursor read is in flight
  at a time, a burst of wakes folds into at most one follow-up, and every
  reply is fenced by mount, account and generation. The logic now lives in
  `src/components/challenges/dashboard/useDailyMissionRealtimeCatchUp.ts`
  (moved there by Phase 3).
- **A channel error no longer fetches.** A channel error, timeout or closure
  marks the page degraded and retires the catch-up generation. It used to
  issue a full dashboard RPC per error, which under a flapping socket was
  itself a poll.
- The daily-reset deadline timer is untouched.

## Measured on production

On `848fff344` with the isolated certification fixture: zero cursor reads
while the socket stays healthy for 20 seconds, exactly one cursor read after a
server-side socket drop and rejoin, one dashboard request on a cold load
(92 ms).

## Pins

- `tests/daily-challenge-realtime-contract.test.ts` pins the absence of any
  repeating timer and the shape of every lifecycle branch.
- `tests/daily-mission-subscription-recovery.test.tsx` covers no periodic
  request over ten minutes, no fetch on channel error, rejoin and resume
  catch-up, and burst coalescing.
- `tests/e2e/production-daily-missions.spec.ts` proves the missed-frame
  recovery on production. Its socket drop uses close code 4000, because a
  close code the browser refuses never drops the socket
  (`docs/changelog/2026-09-22-daily-certification-socket-close-code.md`).

## Completed later

The design named one lifecycle hole: a private channel whose Realtime sign-in
fails never exists, so nothing reconnects it. The Phase 4 certification
follow-up closed it in `useMasterBusBroadcastChannel`
(`docs/changelog/2026-09-22-daily-challenges-certification-follow-up.md`).
