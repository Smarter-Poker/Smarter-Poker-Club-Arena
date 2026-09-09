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

## Release gate correction

CI run 34317955567 passed 5,290 of 5,291 tests in shard 1. The existing wallet
Retry test observed the button commit before its passive focus effect finished.
It now waits for the same focus assertion before pressing Enter. The separate
split-result/loading regression still pins the actual component fix from PR3911.
No production wallet code or focus behavior changed. All 20 tile tests passed.

## Verified publication

- PR3939 merged at 2026-09-09 06:26:07 UTC as
  27bdfaadb42e520565d48676da19b7867803bd57.
- Normal hooks and CI passed. The full local client suite passed all 17,403
  tests in 1,255 files (59.01 seconds); TypeScript passed before commit.
- Fresh public and origin build-info at 06:50:03 UTC both served
  241e3a2e651c57921b2b8945bb85692a3c92e44c, built at 06:44:27 UTC by
  publisher run 34320279438. Git ancestry proves it includes PR3939.
- The public HTML actually referenced assets/index-e86Z-F0G-v6.js.
  Its SHA-256 was e067141bfb2c327aab62f5ae9008f3723a9bcc530321196ba1e6a3a09163b7c3.
  Parsing that JavaScript confirmed disposal on table 4901, disposal and the
  shared reload on table/channel 4426, and capped backoff with an immediate
  return on table/channel 4429. Both clients carry the reload entry guards.
- The supported browser reached the live sign-in page. Secure sign-in was
  cancelled, so no authenticated table acceptance was performed. No physical
  iPad/PWA session was available. Neither is inferred from unit tests or bytes.

Verification URLs: https://smarter.poker/hub/club-arena/build-info.json and
https://ca-static.smarter.poker/build-info.json.
