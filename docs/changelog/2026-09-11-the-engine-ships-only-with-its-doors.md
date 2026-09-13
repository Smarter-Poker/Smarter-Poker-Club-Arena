# The engine ships only with its doors

2026-09-11 · deploy train (`.github/workflows/auto-deploy-hetzner.yml`,
`scripts/ci/check-engine-doors-exist.mjs`)

## Why

Twice in two days, a build went live calling a database function that
production did not have. Each time the failure was a silent loop.

| Date       | Function the engine called              | What it did                                                                                                      |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 2026-09-10 | `fn_move_tournament_player` (7 args)    | Every tournament seat move failed, the lease loop starved, and the fleet wound down each hour (`20260910051125`) |
| 2026-09-11 | `fn_ca_reprice_unpaid_tournament_place` | Any event whose prizes needed recertifying could never finish (`20260911090347`)                                 |

Both got past the phantom-reference gate for the same reason:

- The gate checks names against a schema manifest.
- A branch may add a fragment to that manifest declaring a function before
  its migration runs.
- Nothing required the migration to be applied before the code that calls
  the function went live.

## What changed

Before it hands the SHA to the durable Hetzner intake, the deploy now reads
production's `pg_proc`. That is the one witness that cannot be declared into
existence. The check covers:

- every `.rpc('<name>')` in `server/src`, excluding tests;
- every literal an `...rpcName` variable can take.

Each one must name a function in schema `public`.

- **A missing function fails the run** before the Hetzner handoff, and the
  error names the function and its callers. The release can be dispatched
  again once the migration is applied.
- **An unreadable database is a warning.** A dropped connection must never be
  the reason an urgent fix cannot ship.
- **A rollback is reported, not blocked.** It restores a build production
  already ran.
- **Deliberate exceptions** go in `scripts/ci/engine-doors.allowlist.json`,
  each with a reason. The file is empty today.

Measured against production at 09:17 UTC: all 161 functions this build calls
exist.

## Pinned by

`tests/the-engine-ships-only-with-its-doors.law.test.ts` pins:

- the extractor finds both incidents' call sites and ignores comments;
- the real script, run against a production that lacks the reprice door,
  exits 1 and names the door;
- the rollback and unreadable-database paths never block;
- the step sits before the durable Hetzner intake and has production's
  credentials.
