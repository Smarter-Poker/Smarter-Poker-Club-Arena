# Engine rollback drill (DA10)

The rollback/restore drill proves that production can move back to an earlier sealed engine release and then forward again. Both moves go through the release transaction that every engine deploy uses. [maintenance-break-fire-drill.md](maintenance-break-fire-drill.md) sets the rules any live drill must meet. The crash drill (DA08) is not a release, so it has its own route there (`engine-drill.yml`, `engine-crash-drill.sh`). This runbook covers only rollback and roll-forward.

## The route

`.github/workflows/engine-rollback-drill.yml` runs on one repository event, `rollback-drill-club-arena-engine`, from the default branch. Nothing else starts it: there is no timer and no workstation path.

- **No mechanism of its own.** It stages the exact protected-main control scripts. `install-engine-drill.sh` then binds the drill to the run key with a root-only `$REQUEST_ROOT/<run>.drill` record, and hands that run key to the unchanged durable intake.
- **Every release control applies.** `engine-release-transaction.sh` runs the drill under the release lane and the engine mutation lock (the same lock the crash drill takes). It also uses:
  - the locked restart certificate;
  - the persisted break deadline;
  - `prove_rollback_readiness` and the 135-second rollback reserve;
  - the seal and the recovery trap.
- **Scheduled breaks only.** A drill waits for a scheduled :55 break and never requests the off-cycle window. Any newer waiting release takes the break first.
- **Strict engine doors.** Every database function the target calls must exist in production (`ROLLBACK_REQUESTED: 'false'`), a rollback included.
- **No deploy side effects.** It writes no deploy receipt and dispatches no post-deploy certification.

| Drill         | `ref_sha` must be                                                                                                                                                                                                                                      | What happens                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `rollback`    | Older than the sealed high-water release, at or above both compatibility floors in `docs/dr/diamond-release-manifest.md`, and already sealed on this host (`engine-release-seal.py attest-committed-sha`). It must not already be the desired release. | The seal's audited `rollback` mode. The high-water does not move. |
| `rollforward` | The sealed high-water release, while a rollback serves.                                                                                                                                                                                                | An ordinary deploy of the high-water.                             |

Each drill writes `/var/lib/club-arena/engine-rollback-drill-results/<run>.json` (schema `engine-drill-result-v1`), recording:

- the target;
- the release it replaced (`previousDesiredSha`);
- the serving instance;
- the break.

That file is evidence; the seal result is the authority. After the transaction, the workflow independently re-reads:

- the sealed desired release;
- the container label and image;
- local and public health leadership.

## Running DA10

1. Pick a rollback target. This is normally the sealed release that served before the current high-water; the previous engine deploy's run summary names it. The transaction refuses any target this host never sealed, so a wrong choice is refused before anything moves.
2. Dispatch the rollback. The reason names who authorised it and why:

   ```bash
   gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/dispatches \
     -f event_type=rollback-drill-club-arena-engine \
     -F 'client_payload[drill]=rollback' \
     -F 'client_payload[ref_sha]=<40-hex target>' \
     -F 'client_payload[reason]=<12-128 characters: who authorised it and why>'
   ```

3. When it ends `sealed`, check:
   - `https://engine.smarter.poker/health` serves the target with a fresh leader;
   - the break thawed (`engine_maintenance_break_log`);
   - hands are dealing again after the thaw.
4. In the next break, dispatch `drill=rollforward` with `ref_sha` set to the high-water. Check the same evidence.
5. DA10 closes only when both receipts say `sealed` and the live checks pass. Archive both workflow runs and receipts with the audit evidence.

If any step refuses, production keeps (or the recovery trap restores) its sealed desired release. Read the refusal in the workflow log. Never retry it from a workstation.
