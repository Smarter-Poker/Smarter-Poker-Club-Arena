# Lightning Qualification Reads The Retained Access Proof

**Date:** 2026-10-22

## What Was Wrong

`scripts/ops/lightning-pilot-qualification.mjs` appended `AUTHENTICATED_OUTSIDER_BROWSER_AND_SOCKET_PROOF_REQUIRED` to every report unconditionally. The authenticated outsider browser and WebSocket proof already exists as its own audited operation (`lightning-pilot-stage.yml` stage `access`, `scripts/ops/lightning-pilot-access.mjs`), and it had passed (runs 39461266490 on 2026-10-20 and 39803082299 on 2026-10-22), but the report never read it. The blocker could never clear, whatever the evidence.

## What Changed

- `scripts/ops/lightning-pilot-access-proof.mjs` (new, read-only) verifies a retained access-stage artifact: the run must be a successful dispatched `lightning-pilot-stage.yml` run on main, at most 72 hours old at report time, for the report's designated outsider, covering every pilot Cluster, with confirmed session and pending-request cleanup. It re-checks every observed surface rather than trusting the verdict field: owner positive controls (pool status, browser render and discovery, opened sockets), and for both the nonmember and the pending state hidden discovery, refused entry, a closed browser socket with no messages, a 403 on every probed table socket, a refused join and a refused pool status, never approved or funded.
- The qualification report records `authenticatedOutsiderProof` and drops that one blocker only on a `PROVED` verdict; each target's `databaseAccess.authenticatedBrowserAndSocket` names the proving run. Absent, stale, failed, partial or mismatched evidence keeps the blocker with a specific reason code. No designated outsider or an unestablished pilot target also keeps it.
- `.github/workflows/lightning-pilot-qualification.yml` gains `actions: read` and an optional `access_proof_run_id`; by default it fetches the newest successful main access-stage run's artifact. The fetch never runs the proof and never fails the report: missing evidence simply stays a blocker.

Nothing about launch certification changes: `publicLaunch` stays `NOT_CERTIFIED` and `ALL_54_RELEASE_GATES_NOT_CERTIFIED` remains.

## Tests

`scripts/ops/lightning-pilot-access-proof.test.mjs` (8 cases) and a report-level case in `scripts/ops/lightning-pilot-qualification.test.mjs`; both run in the workflow's semantics step before collection.
