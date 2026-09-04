# The build assumed it owned the machine, exactly like the tests did

`vitest.config.ts` was capped this morning because an uncapped thread pool on a
shared runner box drove it to load 41. The build had the same bug and nobody
looked, because the tests were the loud one.

Rollup defaults `maxParallelFileOps` to **20**. On a laptop that is free speed.
On an 8-core box hosting six runners it is six builds each asking for twenty
concurrent file operations. Measured 2026-09-04, after the tests were already
capped:

| box              | load (8 cores) | runners |
| ---------------- | -------------- | ------- |
| `estate-ci-eu-3` | **63.57**      | 6       |
| `estate-ci-eu-1` | **38.80**      | 6       |

## The cap costs nothing

Same machine, same tree, back to back:

|                    | wall      | vite reports |
| ------------------ | --------- | ------------ |
| uncapped (20 ops)  | 8.93s     | 7.99s        |
| **capped (4 ops)** | **8.84s** | **7.93s**    |

Identical, with a fifth of the concurrency pressure - the same result the
vitest cap produced (33.2s at 28 threads vs 37s at 2). Neither the suite nor
the build was ever parallelism-bound; both were just taking everything they
were offered.

## Why a thrashing box is not merely slow

It times out work that passes in seconds elsewhere, and a timeout is
indistinguishable from a real failure. That is how a green suite becomes a red
pull request nobody can explain, and it is most of what "CI is flaky" meant
here.

Local builds keep the default: `process.env.CI ? 4 : 20`.

## The pattern, now stated twice

Every tool that defaults its concurrency to the core count is wrong on a shared
runner. `vitest` was the first. Rollup was the second.

**Playwright was checked and is already capped** - `workers: isCI ? 4 :
undefined` in `playwright.config.ts`, with the reasoning recorded there: 149
specs at one worker is about twenty minutes of everybody's pipeline, four
brings it under three. Nothing to do. An earlier draft of this note claimed it
was uncapped; that was wrong, and left standing it would have sent the next
agent to fix something already fixed.

So the audit is complete for the three tools that matter. If a box still
thrashes after this, the cause is the RUNNER COUNT, not a tool default - the
arithmetic in `docs/ci-runner-topology.md` is the thing to revisit.
