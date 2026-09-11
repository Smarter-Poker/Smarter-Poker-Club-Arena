# Every Active Workflow Keeps Its Own Verdict

## Before

`check-main-is-green.mjs` read at most 300 completed runs from one repository-wide window. A high-frequency workflow could fill that window and make a low-frequency workflow disappear entirely, allowing an old red verdict to become a false all-clear. The detector also treated any recently updated open issue containing the workflow name as an authoritative reader. The production-integrity workflow found its own issue with a fuzzy title search, so a similarly titled human issue could be edited or closed.

## After

The detector enumerates the repository's active workflows and fetches up to 300 completed `main` runs for each workflow independently. A PR-only workflow with zero completed `main` runs is explicitly not applicable. A nonempty completed-run history without a readable success or failure verdict, incomplete inventory, malformed responses, and API failures return the distinct `COULD NOT TELL` outcome and cannot print the exact all-green receipt.

Open-issue suppression now requires both the exact `main-health-reader` label and an exact per-workflow machine marker that is newer than the failure episode. The production-integrity audit owns one fixed-title issue with the immutable marker `club-arena:production-integrity-main-health:v1`. On an alarm it reads the label first and creates it only when absent; on green it never creates a label. Before edit or close it validates the exact title, owner marker, and label. Ambiguous duplicate owned issues fail closed.

## Verification

- `tests/a-skipped-run-is-not-a-green-run.test.ts` covers per-workflow discovery, disabled workflows, a low-frequency red verdict, verdict-free unknown state, and marker-plus-label suppression.
- `tests/a-watchdog-that-cannot-look.test.ts` pins the distinct unknown exit and native workflow verdict.
- `tests/a-guard-has-a-reader.law.test.ts` pins deterministic label provisioning and exact title, marker, and label ownership checks around issue mutation.
