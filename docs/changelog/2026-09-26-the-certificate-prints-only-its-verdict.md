# The restart certificate prints only its verdict

2026-09-26

## What was wrong

`maintenance_certificate()` in `server/scripts/engine-release-transaction.sh`
is read by every caller as

    BREAK_REMAINING_MS="$(maintenance_certificate ...)"

and the figure is then used in shell arithmetic. When the engine's certificate
is shut only by bounded reasons, the function asks the database whether a hand
is in the air through `engine-release-inflight-hands.py`. That helper announces
its answer on stdout, and the admission line that followed it was also written
to stdout. Both landed in the captured figure.

The branch had never admitted a cutover before #5266 (merged 02:25Z) taught it
the stopped-bank class. The first time it did, release run 36211686180 at
02:34:11Z (predecessor 778075b4, 13 `f06_preparation_stuck` and 186
`stopped_bank_custody_unconfirmed`, database answer "no hand in the air")
captured

    [engine-release-inflight-hands] no hand in the air: zero incomplete hand snapshots written in the last 120s
    [engine-release-transaction] the database confirms no hand is in the air; ...
    294308

as `BREAK_REMAINING_MS`. `$(( ... / 1000 ))` refused it as a syntax error and
the transaction exited before prepare. Nothing was mutated, but a cutover
every gate had admitted was thrown away, and the fleet stayed on the wedged
release for another break.

The law test added in #5266 asserted that stdout _contained_ the admission
message, so it pinned the defect instead of catching it: its stand-in helper
printed nothing.

## What changed

- The helper's output and the admission line go to stderr. stdout carries the
  remaining-milliseconds figure only. The journal records both lines exactly
  as before.
- `tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts`:
  the stand-in helper now announces its answer on stdout like the real one;
  every admitted certificate must print exactly one integer line; a new case
  feeds the captured figure through the same `$(( BREAK_REMAINING_MS / 1000 ))`
  the transaction runs; the source pins `>&2` on both lines.

## What is not changed

Every refusal, the bounded allow-list, the predecessor allow-list, the database
proof and every timing budget are exactly as they were.

## Tested

21 root test files that read the transaction or the certificate: 697 tests
(one load-sensitive 5 s timeout in `engine-release-break-recovery` passes
alone, 5/5); `tests/operations/engine-release-*.py`; `bash -n`.
