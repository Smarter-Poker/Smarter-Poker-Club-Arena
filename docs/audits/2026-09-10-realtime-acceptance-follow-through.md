# Realtime Acceptance Follow-Through

Subsequent Cashier publication and successful viewport acceptance are recorded in
`2026-09-10-realtime-phase16-cashier-acceptance.md`. That receipt supersedes the
pending Cashier statements below; the earlier runs remain historical evidence.

## Published Acceptance Repairs

PR #4140 merged as `86aab0e645b1842e83fca808cf956c9733af66ba` at
2026-09-10 07:18:36 UTC. Required CI 34448846623 passed. Publisher 34449568510,
job 102782772111, verified origin adoption at 07:25:21.9638552 UTC.
Cache-busted public and origin build-info both served that exact merge at
07:26:47.519665 UTC, built at 07:24:22 UTC. Referenced HomePage public/origin
bytes matched (SHA-256 `797da8d2cddcd14b9cb7ef9f251b26e7111c152796ebc5d5e2c7fb137b9a54d5`).
Its HomePage and mounted-test blobs still exactly matched tested head `0635c7261a`.
The three Terms/profile preflights and footer assertion now match their source
contracts. Local validation passed 27 existing tests and TypeScript; collection
found three affected certifications and 33 footer-spec cases, without live runs.

## Completed Production Run Before PR #4140

Run 34447563111/job 102777259368 tested `c50dc3abd9f6195577d7fd1ea07a442559632256`:
292 executed, 10 failed, 2 skipped, 0 flaky across 34 files. The Cashier database
contract and Trade/reconciliation case passed. Reserved-account hard deletion
and absence were verified at 07:28:15.469831 UTC. Its failures were:

- Cashier menu absent after an immediate right-click; mobile hold not reached.
- Three MTT/SPIN/SNG checks stopped at engine SHA56962e04 versus client c50dc3ab.
- One cash continuity check had no eligible occupied read-only View Table fixture.
- Three profile preflights and the stale footer assertion used source before PR #4140.
- One mobile check found Choose Arena 32px/24px and two ad dots 6px/0px, below 44px.

The Cashier spec now awaits its existing `aria-haspopup="menu"` capability;
see `2026-09-10-cashier-canary-directory-readiness.md` in `docs/changelog`.
The failed run's artifact 10141178990 exists, but browser-state attachments were
not inspectable. Its logs do not prove which directory state existed at click.

## Earlier Loaded Fleet And Maintenance

The earlier engine `56962e048d024cb3215a255529c7b1491873db72` contains both callback
merges `89cabee97a` and `046f9e4570`, proved by git ancestry. Actual deployment
34440761046/job 102755135235 parked the fleet at 05:55:15.6346332 UTC, started the
container at 05:56:11.56310586, verified public/container versions at 05:57:05,
proved `engine_leader` moved from c4163531 at 05:57:07.4715366, committed durable
release authority at 05:57:10.0981704, and recorded shipped attempt 350 at 05:57:14.8283839.
That container was healthy with restart count 0 during read-only inspection.

651,500 retained earlier-container log lines covered 05:56:12.815535543 through
07:16:51.053333668 UTC. Docker logs exited 0. Case-insensitive searches found 0
matches for the exact historical authority error, `onObligationChange`, uncaught
exception, fatal drain, shutdown deadline, and manager authority error patterns.
This establishes absence of those patterns in that interval, not every error.

| UTC Sample      | Active / Dealable | Humans | Stalled / Blocked | Gap Samples | p50 / p90 / Max Milliseconds |
| --------------- | ----------------- | ------ | ----------------- | ----------- | ---------------------------- |
| 07:11:55.680608 | 493 / 258         | 0      | 0 / 0             | 2000        | 2145 / 2198 / 5340           |
| 07:22:26.298072 | 459 / 194         | 0      | 0 / 0             | 2000        | 2147 / 2206 / 7295           |

Each sample uses the configured ten-minute window and deliberate 2000ms rest.
These are two health observations, not proof of continuously zero stalls.

The prior thaw completed at 06:00:02.566639028 UTC in one call with zero errors.
The next 06:53 announcement failed on `canceling statement due to lock timeout`:
clearing the break row failed at 06:53:11.049220024, followed by announcement
failure at 06:53:11.050082791. The captured logs do not identify the RPC or lock
holder. Those 8/8 waves and 492/492 resumed tables are rollback completion at
06:53:16.303, not evidence of a successful 06:55 maintenance cycle.

## Live Acceptance And Replacement Engine

On September 10, run 34449578074/job 102783712375 tested exact LIVE/specs/harness
`86aab0e645b1842e83fca808cf956c9733af66ba`. Both customization specs and the
corrected footer passed; Daily Missions passed Terms/profile and failed later.
Run 34451803919/job 102790759550 repeated those preflight successes. It executed
292 cases, with 7 failures, 2 skips and 0 flaky results; reserved-account deletion
and absence were verified at 08:21:33.347319 UTC.

PR #4144 merged as `28a10843d51cabca469659d7d5f783726763edfc`; CI 34451036857
passed, publisher 34451499334/job 102788775766 verified origin at 07:48:05.546133
UTC, and fresh public/origin reads served that exact merge at 07:48:57.262955.
The later run served LIVE `146128eb5c89edb1880473905524556b956b613f` while
specs/harness stayed at `1c29d5d9ddb850387eda8cca2da55c20db28d760` after a drift
warning. Canary, tile and HomePage CSS blobs were identical across both refs.
Cashier readiness, right-click, Escape and mobile-hold opening passed. Its mobile
left boundary failed at -112px on a 320px viewport; Trade/reconciliation passed.
The scoped portal repair is documented in
`docs/changelog/2026-09-10-cashier-menu-escapes-page-transforms.md`.
The existing production boundary assertions remain unchanged.

Engine deployment 34449341468/job 102781237201 adopted `86aab0e645b1842e83fca808cf956c9733af66ba`,
which contains both callback fixes. All-parked certification was 07:55:00.877428
UTC; startup was 07:55:58.991693916; public/container version verification was
07:56:52-53; database version proof was 07:56:55.2213623; durable release seal
committed at 07:56:56.7991648; attempt 354 recorded shipped=true at 07:57:02.3443527.
Thaw completed in one call with zero errors at 08:00:02.461866566. All 415 tables
resumed in 8/8 waves by 08:00:13.189, closing the prior failed-cycle qualification.

At 08:12:05.319106 UTC, the new process had 386 active/93 dealable tables, zero
humans, stalled tables and blocked settlements, and idle maintenance. Its 2,000
retained gap samples in the configured 600,000ms window had p50 2,003ms, p90
2,164ms and max 2,849ms, including the unchanged deliberate 2,000ms rest.
Startup identity remained unchanged with zero restarts. A successful read-only
scan of 70,260 new-container log lines, 07:55:59.851119522 to 08:12:06.473099916,
found zero matches for the six authority/fatal patterns above. These bounded
automated-fleet observations do not certify human/device latency or continuously
zero stalls.

## Remaining Acceptance

The portal repair still requires normal publication and the unchanged live
Cashier viewport certificate. The live-table suite's exact client/engine SHA
gate is intentional, and coordinator PR #3908 changes the same prerequisite
while preserving it. Cross-SHA failures mean continuity observation did not run.
Engine release alignment and Stage-B remain with that coordinator. Daily
Missions' later freeze-purchase assertion, shared mobile geometry, and the missing
cash fixture remain distinct from repaired preflights and directory readiness.

The supported controlled browser still timed out after 20 seconds. Physical
iPad/PWA and natural reconnect remain unverified. The Supabase follow-through
still requires detailed PostgreSQL logs and per-service egress access. Neither
the whole programme nor Phase 16 is certified 100% complete.
