# Explicit V31 qualification

`gto-v31-qualification.yml` runs the existing offline evaluator from the exact
healthy serving engine revision, proved to be on protected main. It does not
deploy or restart an engine, discover work, retry, or run on a schedule.

After the source compactor has genuinely sealed the dataset, dispatch:

```sh
gh workflow run gto-v31-qualification.yml --ref main -f dataset=DATASET_UUID -f operation=evaluate
```

The configured provider identity stays in Actions. No environment file or
workstation credential is used. The unchanged evaluator produces all eight
paired-replay/league receipts and asks PostgreSQL to mark a passing candidate.
The workflow pins the actual serving source before execution and verifies it
again afterward. It retains only operation metadata, not cards or journals.

Read the actual job, metadata receipt, and durable dataset/evaluation state.
After reviewing the eight passing receipts, explicitly dispatch the same
workflow with `operation=promote`. Promotion requires the already-qualified
candidate and still executes the existing evaluator and database gates.

A timeout or interrupted receipt is unknown, not proof of no writes. Inspect
the durable partial evidence before an explicit resumed dispatch. The existing
CLI owns idempotent reuse; there is no automatic retry. A completed promotion
does not prove live Horse loading: verify the active dataset seal and actual
worker adoption separately.
