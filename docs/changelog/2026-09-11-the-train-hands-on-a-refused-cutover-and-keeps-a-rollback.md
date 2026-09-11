# 2026-09-11 — The train hands on a refused cutover, and a rollback stays a rollback

A review of the push-triggered deploy train (#4216, #4221) found five defects
in `auto-deploy-hetzner.yml`. All five are fixed here.

| #   | Severity | Defect                                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | high     | The live-by-inclusion dedupe called every audited **rollback** "already live". A rollback target is always contained in the build it rolls back from, so the run skipped the seal, the only place `MODE=rollback` exists, and went green in a minute with production still on the bad build. | The inclusion branch is skipped when `inputs.rollback` is true. The exact-version check is unchanged.                                                                                                                                                                                                                                                                                                               |
| 2   | medium   | A cutover step that **refused before touching anything** (the locked certificate re-check, the host lock, the localhost read or the ssh connect) was read as "cutover ran", so the Verdict did not hand on and the train stopped dead.                                                       | "Before the cutover" now also covers `outcome == failure` with no `attempted=true`. That output is written only after the locked check passes, so it is the step's own proof that it touched nothing.                                                                                                                                                                                                               |
| 3   | medium   | The retry bound counted failed runs **per commit**. The hand-on dispatches main, so any merge reset the count, and a failure that spans commits looped all day.                                                                                                                              | The count travels along the chain as the `retries` dispatch input. A run that ends before its cutover passes `retries+1`. A run that gets past its build passes 0. A push starts a new chain. An unreadable count stops the train.                                                                                                                                                                                  |
| 4   | medium   | A **cancel** handed on with no bound, and GitHub reports a job timeout as a cancel, so a deterministic hang looped every 130 minutes.                                                                                                                                                        | Cancels count against the same chain bound. The read-only pre-cutover steps have `timeout-minutes` (tests 30, capture 10, pre-flight 10, pull 15, build 45), so a hang fails its step. `~/hssh` sets `ServerAliveInterval=15`/`ServerAliveCountMax=4`, so a dead connection fails in about a minute. Nothing from the certificate wait onward gets a step timeout, because a cutover must never be killed half-way. |
| 5   | medium   | `hand_on()` turned a **rollback's** successor into a plain forward run of main, which silently dropped the owner's decision.                                                                                                                                                                 | A rollback hands on as the same rollback: same `ref_sha`, `rollback=true` and reason.                                                                                                                                                                                                                                                                                                                               |

## Not fixed here, still open

- **A pending rollback can be replaced.** The concurrency group keeps one
  pending run, and a newer push or hand-on replaces a pending rollback. That
  rollback then never executes its Verdict. Until this is fixed, an operator
  who needs a rollback should first disable any competing dispatch, or re-run
  the rollback after the in-flight run finishes.
- **A control-plane-only fix starts no run.** The push paths are `server/**`,
  so a fix to the workflow or to `scripts/ci/` does not start a deploy by
  itself. Adding those paths as-is would restart the engine for every
  workflow-only change, because the dedupe compares commits, not engine trees.
  The right fix is a dedupe that treats an identical engine tree as live.
- **The "main moved, control plane did not" branch** assumes a newer run is
  queued behind it, and does not check.

## Pins

`tests/unit/deployAndPublishAreHonest.test.ts` pins the Verdict guard, the
chain count, the three hand-on sites, the rollback re-dispatch, and which steps
may and may not have a timeout.
`tests/the-deploy-can-always-ship.law.test.ts` pins the rollback exemption.
