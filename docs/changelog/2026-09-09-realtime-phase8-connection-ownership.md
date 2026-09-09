# Realtime phase 8: connection ownership and refusal recovery

Date: 2026-09-09. Frontend transport only; no database or engine changes.

## Reproduced failures

- A table facade replaced with close code 4901 remained registered for online,
  pageshow and visibilitychange. Each wake reopened the retired client and
  evicted its successor. Its pending EVENT could also reach the retired page.
  Restoring the old branch makes all four regression cases fail.
- The channel socket treated 4426 as an ordinary disconnect and never requested
  the newer bundle. The table socket requested it but could still reconnect
  during reload. Another client waiting for auth could also open afterward.
- Channel capacity refusals (4429) retried at the one-second starting cadence.
  Both clients counted repeated capacity refusals as failed auth handshakes.
  Five dedicated refusal regression cases failed before their fixes.

## Changes and verification

Supersession now disposes the old lifecycle through the existing identity-safe
cleanup. Both transports retire a protocol-refused connection and use the
existing shared bundle reload. The reload latch guards fresh connections,
retry scheduling and token completions. Capacity refusals retain the existing
16-second minimum plus jitter and capped backoff without asking auth.

224 focused tests passed across nine recovery, mux, subscription, session and
maintenance suites. Explicit 4401 and repeated ambiguous 1006 still check the
session and retry unknown verdicts. TypeScript and the normal push/release gates
must pass before publication. Production byte verification is recorded separately.

Physical iPad/PWA acceptance requires a reachable supported device session.
Simulated wake events and public bundle reads do not establish device acceptance.
