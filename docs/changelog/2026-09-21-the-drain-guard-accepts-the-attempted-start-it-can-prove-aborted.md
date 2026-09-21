# The drain guard accepts the attempted start it can prove aborted

2026-09-21. The second blocker named in #5013 ("The helper that was never
packaged"), still shut at the time of writing there, is opened here - on the
guard side only, and only against rows.

## The refusal

`server/scripts/legacy-engine-checkpoint-guard.mjs` runs inside the live
`8825af51` engine through the inspector. Its synchronous sweep `physical()`
refused the retained Noon original every release:

```
{"ok":false,"reason":"mixed_original_work_not_drained","failedCheck":"engineCollection.size",
 "failedTable":"2c621856-e728-4e8b-bf08-4c56746a8649",
 "failedField":"terminalBoundaryPendingGenerations","observed":"1","expected":"0"}
```

#5011 had already admitted exactly one reserved terminal-boundary generation
on an interrupted original, provisionally, as "the interruption this checkpoint
exists to hand over". Its admission read

```js
const interrupted =
  permit !== null && ['unknown', 'reserved', 'terminated'].includes(capture.phase);
const allowed = name === 'terminalBoundaryPendingGenerations' && interrupted ? 1 : 0;
```

and the live permit on `2c621856` is in phase `attempted`. So `allowed` was 0,
and the one integer the fence left behind was refused as undrained work.

## Why `attempted` is the only phase the real shape can present

Read from the 8825 lineage, not from the current tree: `F06HandPermit.start()`
moves the permit to `attempted` BEFORE `startExactController` reaches
`beginTerminalBoundaryPersistence()`, which is what adds the generation to
`terminalBoundaryPendingGenerations` immediately before `HandController.start`.
`fenceTerminalEngine()` then sets `handController = null`, `running = false`
and `terminal = true` synchronously and never touches the pending set (#5013
lists the three resolvers, all downstream of `HAND_COMPLETE`, none reachable
after the fence).

So a live engine that was fenced with one reserved generation and no
controller can present exactly one permit phase: `attempted`. The three-phase
set #5011 admitted was unreachable for the interruption it was written for. No
engine-side path can drain the set on a fenced engine, and #5013 explained why
the engine half must not be shipped alone; this does not ship it at all.

## What the rows already say

Both interrupted permits have their disposition written, by permit id, in
`smarter_private.f06_hand_permits`:

| permit                                 | table      | tournament           | hand     | state               | evidence_id                            |
| -------------------------------------- | ---------- | -------------------- | -------- | ------------------- | -------------------------------------- |
| `098c0945-54f9-4c48-a600-3b8845da267b` | `2c621856` | `5a387a75` Noon      | 12942021 | `aborted_unsettled` | `7d0f56e9-10ce-4c2f-b337-101b75924257` |
| `14cddb92-cf9d-46fd-80f7-6379695c0032` | `9f30d335` | `615783bf` Afternoon | 12943630 | `aborted_unsettled` | `16268739-c7c3-4d38-8a8f-e8f08ac0591b` |

Those evidence ids are the two `historical_loss_normal_session_v1` receipts the
guard already carries by value in `historicalBankLoss`. The guard's
`sealAndRetireOriginals` already performs the row-backed proof for every
interrupted original before anything irreversible: `permit.state ===
'aborted_unsettled'`, `evidence.hand.receipt_id === permit.evidence_id`,
`receipt.outcome === 'aborted_unsettled'`, `receipt.expected.kind ===
'retained_mtt_interruption_v1'`, the receipt's physical `manager_id`,
`engine_id` and `container_id` equal to this run's, then exactly one such
original per manager - and all of it before the custody commit and before the
retirement CAS. The proof was there; the sweep never let the real shape reach
it.

## The fix

One predicate, `interruptedOriginal`, defined once at guard scope and read in
both places:

- `permit !== null`, and either the #5011 phases `unknown`, `reserved`,
  `terminated`, or phase `attempted` in the exact shape 8825 leaves behind: one
  pending generation, `terminalBoundaryPersistenceFailed === false`,
  `handController === null`, `settlementInFlight.size === 0`. A start that was
  attempted, reserved its generation, and produced neither a controller nor a
  settlement before the fence.
- `physical()` asks it about the one generation it is about to allow. The
  count is what its own `size <= allowed` check proves next, so a second
  reserved generation on an attempted start now refuses as `expected 1`, and an
  attempted start that reserved nothing passes the sweep (`0 <= 1`) but is not
  an interrupted original downstream - unchanged from before. Every other
  predicate in the sweep, its order and its reported `expected` are untouched;
  a failed boundary or a live controller still refuse earlier, by name.
- `sealAndRetireOriginals` reads the same predicate on the same captured engine
  at its live pending count, which `checkAll()` has just re-proved against the
  capture. That engine is the manager's one interrupted original whose
  row-backed disposition is required, exactly as above, before commit.

The acceptance in `physical()` remains purely provisional: nothing is retired,
no custody is committed, and no CAS runs unless the rows prove the same permit
`aborted_unsettled` against a committed `retained_mtt_interruption_v1` receipt
naming this engine, manager and container.

Not involved: no engine source, no custody RPC, no SQL, no binding. The guard
is not a pinned source; `scripts/ci/verify-source-bindings.py` was run and
reports every pin unchanged.

## Proof

`tests/legacyEngineCheckpointGuard.test.ts`, on the shared 8825 mixed fixture
whose custody RPC answers with the row-backed disposition above:

- attempted + exactly one pending generation + no controller, settlement or
  persistence failure: accepted in `physical()`, counted as the manager's
  interrupted original, proved against the receipt, retired; the engine's
  pending set is still 1 afterwards (admitted, never discarded). This case
  previously pinned the refusal; it fails on the pre-fix guard.
- attempted + two pending generations: refused, `engineCollection.size`,
  `expected: '1'`, no RPC. Fails on the pre-fix guard (which reported `0`).
- attempted + `terminalBoundaryPersistenceFailed`: refused earlier, by name.
- attempted + a live `handController`: refused earlier, by name.
- attempted + zero pending generations: passes the sweep, then refused before
  commit as `mixed_original_disposition_set_changed` after exactly one
  observation RPC - as before.
- The `reserved` happy path, the two-generation refusal on `reserved`, and
  every other refusal on an interrupted original are unchanged.

Run, all green: `npx vitest run tests/legacyEngineCheckpointGuard.test.ts
tests/legacyEngineCheckpointAdmission.test.ts
tests/legacyCheckpointLockIdentity.test.ts tests/engine-release-seal.law.test.ts
tests/a-degraded-engine-can-still-be-replaced.law.test.ts` (5 files), from
`server/`: `npx vitest run src/engine/EngineLifecycleDiagnostics.test.ts` (53)
and the native qualification `npx vitest run --config
qualification/vitest.config.ts` against the archived 8825 build (31), `node
--check server/scripts/legacy-engine-checkpoint-guard.mjs`, and
`python3 scripts/ci/verify-source-bindings.py` (758 pins, 15 files).

Per CLAUDE.md 10.86: the phase is read from the lineage's own ordering, the
disposition is read from rows, and the sweep asserts nothing it has not read.
The next break still refuses at the legacy checkpoint unless the rows prove it.
