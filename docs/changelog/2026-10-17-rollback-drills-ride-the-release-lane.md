# Rollback drills ride the release lane (DA10)

The Diamond launch audit could not close DA10 (rollback/restore):

- The seal already had an audited `rollback` mode, but nothing called it. The transaction, the launcher and the deploy workflow only ever prepared `deploy`.
- In the 30 days of `engine_maintenance_break_log`, 198 engine version changes occurred, and none moved backwards.
- No cutover has ever failed into the transaction's automatic restore.

`docs/runbooks/maintenance-break-fire-drill.md` allows a live drill only as a reviewed default-branch repository event with the release transaction's own controls. A rollback is a release, so this drill is built into that transaction instead of running beside it.

The crash drill for DA08 is a different build with its own route (`engine-drill.yml`, `engine-crash-drill.sh`, PR #7272). It takes the same engine mutation lock. This change shares no file with it.

## What changed

- **`.github/workflows/engine-rollback-drill.yml`**: a `repository_dispatch` of type `rollback-drill-club-arena-engine`.
  - It takes `drill` (`rollback` or `rollforward`), an exact `ref_sha` and a 12-128 character `reason`.
  - One rollback drill runs at a time.
  - It proves every database function the target calls exists, strictly for a rollback too (`ROLLBACK_REQUESTED: 'false'`).
  - It writes no deploy receipt and dispatches no post-deploy certification.
  - It accepts only a `sealed` result whose receipt names the release it replaced. It then independently re-reads the sealed desired release, the container label and image, and local and public health leadership.
- **`server/scripts/install-engine-drill.sh`**:
  - runs from the exact per-run stage;
  - verifies its own bytes and the intake's against the control commit;
  - writes one root-only record, `$REQUEST_ROOT/<run>.drill`;
  - then execs the unchanged `install-engine-intake.sh`.

  Every existing record format, frozen systemd template and validator is untouched. A run key without a drill record is an ordinary release.

- **`server/scripts/engine-release-transaction.sh`** reads the record and runs the drill under the same certificate, lock, persisted break deadline, `prove_rollback_readiness`, seal and recovery trap as any release:
  - **`rollback`**: an older target is admitted only by `drill_rollback_admission`, inside `source_target_is_current`. The target must be:
    - strictly older than the sealed high-water;
    - at or above both compatibility floors in `docs/dr/diamond-release-manifest.md`;
    - already sealed on this host, checked with the new read-only `engine-release-seal.py attest-committed-sha`.

    The drill prepares the seal's audited `rollback` mode, which keeps the high-water.

  - **`rollforward`**: an ordinary deploy of the sealed high-water while a rollback serves.
  - A drill never requests the hour's off-cycle window and never makes a waiting release stand aside. Every newer waiting release still takes the break from it.
  - Each drill writes `/var/lib/club-arena/engine-rollback-drill-results/<run>.json`. The file is evidence; the seal result remains the authority, and a receipt that cannot be written never fails a sealed release.

- **Host scripts**: `engine-release-recover.sh` retires the drill record after the request, so a replay never finds a drill's request without its record. `install-engine-supervisor.sh` packages and syntax-checks the installer with its siblings.
- **Runbook**: `docs/runbooks/engine-rollback-drill.md` gives the route, the dispatch and the DA10 checks.

## Checks

- **`tests/operations/engine-drill-admission.py`**: 21 cases run on Linux and on macOS Bash 3.2. They run the real record reader, the rollback admission inside the real `source_target_is_current`, the per-mode preconditions, the receipt writer and the real installer, against real Git histories. Each of these deliberate mutations turns tests red:
  - accepting a `crash` record;
  - dropping the never-sealed check;
  - losing the replaced release from the receipt.
- **`tests/engine-release-seal.law.test.ts`**: the new seal command answers from real sealed history (a forward commit and a rollback commit), refuses an unknown commit, and changes neither the seal nor its audit log.
- **`tests/rollback-drills-ride-the-release-lane.law.test.ts`** pins:
  - the event-only trigger;
  - strict doors;
  - the only receipt a drill may produce;
  - that the workflow never touches a process or container;
  - that no crash mode exists in the transaction;
  - where the prepare and receipt sit in the cutover loop.

## Not done here

No drill has run yet. After merge, a rollback to the release that served before the current high-water runs through this route. A roll-forward follows in the next break. Their receipts close or reopen DA10.
