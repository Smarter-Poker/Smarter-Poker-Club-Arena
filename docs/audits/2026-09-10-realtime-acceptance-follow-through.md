# Realtime Acceptance Follow-Through

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

## Loaded Fleet And Maintenance

Running engine `56962e048d024cb3215a255529c7b1491873db72` contains both callback
merges `89cabee97a` and `046f9e4570`, proved by git ancestry. Actual deployment
34440761046/job 102755135235 parked the fleet at 05:55:15.6346332 UTC, started the
container at 05:56:11.56310586, verified public/container versions at 05:57:05,
proved `engine_leader` moved from c4163531 at 05:57:07.4715366, committed durable
release authority at 05:57:10.0981704, and recorded shipped attempt 350 at 05:57:14.8283839.
The current container was healthy with restart count 0 during read-only inspection.

651,500 retained current-container log lines covered 05:56:12.815535543 through
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
holder. Current 8/8 waves and 492/492 resumed tables are rollback completion at
06:53:16.303, not evidence of a successful 06:55 maintenance cycle.

## Remaining Acceptance

The next normal suite must test the repaired source. Engine release alignment,
maintenance, and Stage-B remain with the release coordinator; shared shell
geometry remains separately owned. No production mutations or fixture probes
were performed for this verification. The supported controlled browser still
timed out after 20 seconds; physical iPad/PWA and natural reconnect remain
unverified. Neither the whole programme nor Phase 16 is certified 100% complete.
