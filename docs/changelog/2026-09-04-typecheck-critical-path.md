# TypeScript Check was 5 minutes of everything except TypeScript

`tsc --noEmit` takes **3 seconds**. The job named "TypeScript Check" averaged
**5.08 minutes** and had become the critical path of every pull request: it has
no `needs:`, so it starts at once and nothing merges until it finishes.

It had accumulated 39 steps. Two of them were most of the cost.

## Dead Code Detection: 33 seconds, advisory, and the weaker of two copies

A shell loop over every source file, running a full-tree `grep -rl` **once per
file** - 1,028 files, 1,028 whole-tree greps. Quadratic, and it only ever wrote
`::warning`; it could not fail a build.

`tests/unit/orphanModuleRatchet.test.ts` already answers the same question, from
a real module graph, and **fails** when the orphan set grows. Deleting the shell
loop removes 33 seconds and leaves the stricter of the two checks in place.

## Sixteen guards, one at a time, stopping at the first failure

The 16 `scripts/ci/check-*.mjs` invariants ran as 16 sequential steps. Serial
they take 3582ms; run together, 1505ms - and 16 GitHub step boundaries go away
with them.

The bigger cost was not time. **The job stopped at the first failure.** An agent
tripping three guards was told about one, pushed a fix, waited for a queue,
was told about the second, pushed again. Three round trips to learn what a
single run already knew - a large part of why CI has felt like it "fails
constantly". Every failure is now reported together, with stderr, in one run.

No guard was weakened, dropped, reordered or made advisory. The same 16 command
lines run - `--ratchet` included - and any one of them still fails the job.

## The trap this step fell into first, and the assert that now prevents it

The first draft used `xargs -d`, a GNU extension. On the machine it was tested,
xargs rejected the flag, **no guard ran at all**, no failure file was written,
and the step printed _"All 16 invariant guards passed"_ and exited 0. It was
indistinguishable from a real pass.

That is the house failure mode - a check that looks identical whether or not it
works - and it would have silently disarmed sixteen invariants. The step now
counts the results it collected and fails if any guard did not produce one:

    only 14 of 16 invariant guards produced a result - the runner did not
    execute them all. Failing rather than reporting a pass nothing earned.

Verified before push, all four paths: 16 passing exits 0; one failure exits 1
and names it; two failures exit 1 and name **both** with their stderr; and a
guard that did not run fails on the count. The same assert also catches two
guards whose basenames collide, which would otherwise overwrite each other's
results and undercount.
