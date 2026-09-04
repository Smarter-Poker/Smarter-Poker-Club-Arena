# The vitest worker cap was never applied

Earlier today the client suite was capped to stop it stampeding shared CI boxes.
It was written as:

    poolOptions: { threads: { maxThreads: ... } }

**Vitest 4 removed `poolOptions`.** The equivalent is a top-level `maxWorkers`.
So from the moment it landed, vitest ignored the setting, printed a `DEPRECATED`
notice on every single run, and executed the suite at full width anyway.

## The measurement it produced was therefore meaningless

The config recorded, as justification:

    uncapped (28 threads)  33.2s
    maxThreads=4           36s
    maxThreads=2           37s

and concluded that the suite is "dominated by fixed per-file environment
construction, not by parallel width". Both columns were the **same uncapped
run**. The four-second spread was noise, and the conclusion was never tested.

Re-measured against the option vitest actually reads (`tests/components`,
28-core machine, `CI=1`):

    maxWorkers=2    16s
    maxWorkers=4    10s
    maxWorkers=28   11s

Width matters up to about four, and buys nothing past it. Two workers is **60
percent slower** than four, not 10 percent. That is worth knowing before anyone
tightens this again to relieve contention: the honest trade is real, where the
old note said it was nearly free.

## What this means for the numbers reported today

The unit job fell from 12.6m to 1.38m over the session. That improvement was
real, but it cannot be credited to this cap - it came from the boxes going from
8 to 16 cores and from the thrashing being removed. The cap contributed nothing,
because it did nothing.

The formula is unchanged in intent - `max(2, cores / 4)`, so 4 workers on the
16-core boxes, which the table above puts at the sweet spot. It simply now sits
where vitest will read it. `VITEST_MAX_THREADS` still overrides.

## How this hid

A dead config option fails silently by design: the suite still runs, still
passes, and only a deprecation line in thousands of lines of CI log says
otherwise. It surfaced only because an unrelated Node 20 failure sent me back to
read that log.
