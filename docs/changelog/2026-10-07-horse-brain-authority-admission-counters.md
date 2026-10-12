# Horse Brain: the worker's authority admission counters reach telemetry (2026-10-07)

**Found by the Phase 13 and 14 audit of October 7, 2026.** The live decision
worker admits its Phase 8, 10, 11, 12 and 13 authorities when it starts and
counted each holder's state (`phase13_authority_worker_<variant>_<state>` and
the same for the other phases). Those counts were taken before
`startServices` armed brain telemetry, so `noteFire` dropped every one of them.
Production read on 2026-10-07: `horse_brain_telemetry` held no
`phaseN_authority_worker_*` row on any day, while the worker's per-decision
counters (`phase13_seen`, `phase13_selection_none` and the rest) were present.

**The fix.** Admission is unchanged and still happens before any request is
served. The counts are now taken once, through the worker's `noteFeature`
dependency, after `startServices` resolves and before `READY` is sent, so they
land in `horse_brain_telemetry` like every other worker counter. A second
`start()` counts nothing more. The runtime withdrawal counter
(`phase8_authority_worker_withdrawn`) already fired after telemetry was armed
and is unchanged.

No selection, mode, receipt or decision changes: every selection stays `null`
and every holder reports `unselected`.

**Verification.** `server/src/engine/horseDecision/workerRuntime.test.ts`
adds two cases (every holder counted exactly once, after the services start,
through `noteFeature`; a second start adds nothing). Both fail on the previous
source (no counter reaches `noteFeature`) and pass now.

**Also.** The P14.2 worker boundary dropped a refused accepted roster through
an unused destructured binding, which `eslint` reported as a warning on every
run. It now copies the request and deletes the field; the behavior and its
three existing tests are unchanged.
