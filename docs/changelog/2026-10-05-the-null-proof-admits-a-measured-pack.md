# The Null Proof Admits A Measured Pack

Date: 2026-10-05. One test case narrowed. No source file outside the test, no
migration, no client or engine behaviour.

## What was red

`main` failed `Server Engine shard 3/4` on one case out of 5,458:

```
FAIL src/engine/HorsePhase11Authority.test.ts
  > P11.3 null proof: no Phase 11 authority is selected today
  > while the selections are null, no committed Phase 11 qualification says
    qualified:true and no completion record exists
AssertionError: phase11-completion-2026-10-05-plo5.json:
  expected 'horse-phase11-completion-v1' not to be 'horse-phase11-completion-v1'
```

It took eight other required checks down with it, including the aggregators and
`Nothing is silently red on main`, which is the 10.83 detector doing its job.

## Why

That case was written while Phase 11 had measured nothing, so it pinned the
state of that moment: no qualification claiming `qualified: true`, and no
completion record at all. On 2026-10-05 Phase 11 finished measuring plo5, plo6
and plo8 and committed their completion records under `docs/evidence/phase11/`,
which is the evidence the phase exists to produce. The final assertion then
refused the result of the work it was waiting for.

This is CLAUDE.md section 8 in its ordinary form: behaviour a test pins was
deliberately replaced, and the test did not move in the same commit. Nothing is
wrong with the measurement, the records or the phase.

## What changed, and what did not

The hazard the case guards was never a completion record existing. It is a pack
being **selected** without review, because a selection is what the admission
path turns into a live authority. `PHASE11_PROTECTED_RELEASE_SELECTIONS` still
reads `{ plo5: null, plo6: null, plo8: null }`, so all three measured packs
remain in shadow, exactly as Phase 10 left PLO4 bound and measured without
promoting it.

So the case now admits a completion record and ties it to the invariant that
matters: a record may exist **only while its own variant is unpromoted**. The
`qualified: true` prohibition is unchanged, and the selections-all-null
assertion is unchanged. Nothing was deleted, skipped, loosened or given a
tolerance.

## Verified

- Unmutated: `src/engine/HorsePhase11Authority.test.ts` **95 passed (95)**.
- Mutated, to prove the narrowed case still asserts: setting plo5's selection to
  a non-null value fails this case **and** the two sibling cases that pin the
  same invariant, with `expected { plo5: {}, plo6: null, plo8: null } to deeply
equal { plo5: null, plo6: null, plo8: null }`. Reverted; `git status` clean
  apart from the test file.

Promote a pack and this case fails until somebody updates it deliberately, which
is what a null proof is for.
