# Engine drills ride the release lane

The Diamond launch audit could not close DA08 (failover) or DA10 (rollback/restore). `docs/runbooks/maintenance-break-fire-drill.md` retired the workstation crash drill and allowed a live drill only as a reviewed default-branch repository event with the release transaction's own controls, and no such event existed. The release seal already had an audited `rollback` mode, but nothing called it: the transaction, the launcher and the deploy workflow only ever prepared `deploy`. Across 198 engine version changes in the 30 days of `engine_maintenance_break_log` none moved backwards, and no cutover has ever failed into the transaction's automatic restore. [Ruling 24](../DIAMOND-RULINGS.md) keeps one engine with no standby, so the only failover there is the supervisor restart.

## What changed

- `.github/workflows/engine-drill.yml`: a `repository_dispatch` of type `drill-club-arena-engine` with `drill` (`crash`, `rollback` or `rollforward`), an exact `ref_sha` and a 12-128 character `reason`. One drill at a time. It proves every database function the target calls exists, strictly for a rollback too (`ROLLBACK_REQUESTED: 'false'`). It writes no deploy receipt and dispatches no post-deploy certification.
- `server/scripts/install-engine-drill.sh`: runs from the exact per-run stage, verifies its own bytes and the intake's against the control commit, writes one root-only record `$REQUEST_ROOT/<run>.drill`, then execs the unchanged `install-engine-intake.sh`. Every existing record format, frozen systemd template and validator is untouched; a run key without a drill record is an ordinary release.
- `server/scripts/engine-release-transaction.sh` reads the record and runs the drill under the same certificate, lock, persisted break deadline, `prove_rollback_readiness`, seal and recovery trap as any release:
  - `crash`: the target must be the sealed desired and high-water release, live locally and publicly. Past the locked certificate, with every table parked, it arms recovery, SIGKILLs the engine's process, and proves the same sealed container and image restart on their own as a new process, serve locally and publicly, and are elected the fresh database leader, all inside the candidate-proof budget. A refusal after the kill dies under the engine lock with recovery armed, so the trap restores the sealed desired release inside the 135-second reserve. Nothing is prepared or committed; the seal records an `already-released` result.
  - `rollback`: an older target is admitted only by `drill_rollback_admission` inside `source_target_is_current`: strictly older than the sealed high-water, at or above both compatibility floors in `docs/dr/diamond-release-manifest.md`, and already sealed on this host (new read-only `engine-release-seal.py attest-committed-sha`). It prepares the seal's audited `rollback` mode, which keeps the high-water.
  - `rollforward`: an ordinary deploy of the sealed high-water while a rollback serves.
  - A drill never requests the hour's off-cycle window, never makes a waiting release stand aside, and every newer waiting release still takes the break from it.
  - Each drill writes `/var/lib/club-arena/engine-drill-results/<run>.json` with the pre- and post-crash process identity and timings. That file is evidence; the seal result remains the authority.
- `engine-release-recover.sh` retires the drill record after the request, so a replay never finds a drill's request without its record. `install-engine-supervisor.sh` packages the installer with its siblings.
- The runbook names the route and how to dispatch each drill.

## Checks

- `tests/operations/engine-drill-admission.py`: 24 cases run the real record reader, the rollback admission inside the real `source_target_is_current`, the per-mode preconditions, the crash drill against a file-backed Docker, health and leader state machine, and the real installer, against real Git histories. Three deliberate mutations (dropping the never-sealed check, killing before arming recovery, accepting the old process as restarted) each turn tests red.
- `tests/engine-release-seal.law.test.ts`: the new seal command answers from real sealed history (a forward commit and a rollback commit), refuses an unknown commit, and changes neither the seal nor its audit log.
- `tests/engine-drills-ride-the-release-lane.law.test.ts` pins the event-only triggers, strict doors, the receipts each drill may produce, where the crash sits in the cutover loop, and that recovery is armed before the kill.
- The existing release suite is unchanged and green.

## Not done here

No drill has run yet. The crash drill, then a rollback to the release that served before the current one followed by a roll-forward in the next break, run through this route after merge, and their receipts close or reopen DA08 and DA10.
