# A wait budget equal to its ceiling, and the three pushes it cost

2026-09-06.

PR #3272 failed CI three times. The server suite was green locally, twice -
431 files, 6,192 tests, including a run with the Supabase env stripped and
`CI=true` to match the runner. Migration parity 8/8. Law registry green. No
orphan references. Both original failures fixed. And still red, with nobody
able to say which test.

## What actually failed

One test out of 6,192:

```
FAIL src/engine/RunItTwice.multiway.test.ts
  > decline -> the pot runs ONCE (full flow through the real wait)
  > a declined offer continues the runout to a single-board completion
Error: Test timed out in 10000ms.
```

Reading it took one command once the tooling could see it. The 1MB job log is
mostly the stderr of tests that PASS while deliberately exercising failure
paths - about forty lines of `[Supabase] FATAL: SUPABASE_SERVICE_ROLE_KEY is
not set!` and `hand_number_allocation_failed`, all expected. Grepping for
`Error:` finds the noise first. The real line is the only `FAIL`.

## The bug: a budget set equal to the ceiling it lives under

```ts
// RunItTwice.multiway.test.ts
const deadline = Date.now() + 10_000;
while (!complete && Date.now() < deadline) { ... }

// InsuranceRitExclusivity.test.ts
async function waitFor(ready, timeoutMs = 10_000) { ... }

// vitest.config.ts
testTimeout: 10_000,
```

**The same number.** So the wait can never reach its own `expect`. Vitest kills
the test at the exact instant the loop would have given up, the assertion that
was meant to explain the failure never runs, and CI prints a timeout that names
no cause - sending the next reader after a logic bug that is not there.

Both waits were themselves de-flake fixes, and both were _right_: each replaced
a flat `setTimeout` with a conditional wait, and each is documented in its own
file header as having fixed a real red. Each author then read the ceiling and
used it as the budget. The wait became robust; the headroom became zero.

## Ten seconds was never enough on this hardware

From the failing run itself, on boxes running 18 runners across 16 cores
(CLAUDE.md 1.1.7):

| measurement                                 | value                                        |
| ------------------------------------------- | -------------------------------------------- |
| `SeededRandom > next() stays within [0, 1)` | **3,045ms** (pure arithmetic)                |
| `HorseLogic V2 - legality fuzz`             | 68,697ms                                     |
| wall clock vs work                          | 189.87s for collect 847.74s + tests 1060.39s |
| the same suite, this Mac, idle              | **35.61s**                                   |

`InsuranceRitExclusivity`'s own header records a `sleep(400)` that took
**30,675ms** on this hardware - a 76x stretch. A 10-second budget under a
10-second ceiling on that box is not a flake. It is a scheduled failure, and
the branch history shows it arriving: six consecutive red runs, then a green
one on a commit that changed nothing near the engine.

## The fix

`server/src/testing/waitBudget.ts` holds both numbers, once:

- `TEST_TIMEOUT_MS = 30_000` - imported by `vitest.config.ts`, not restated
- `WAIT_BUDGET_MS = 20_000` - strictly less, so an exhausted wait still gets to
  run and say what was missing
- `waitFor(ready, description)` and `waitForEvent(events, type)` **throw** on
  exhaustion instead of returning quietly. The event flavour names what _did_
  arrive, which separates "never fired" from "fired late" in one CI read.

Both tests now use it, and every `waitFor` call site passes a description.

`theWaitBudgetFitsUnderTheCeiling.law.test.ts` pins the relationship: the
budget is under the ceiling by at least 5s, `vitest.config.ts` imports rather
than restates, no server test polls a hardcoded deadline at or past the
ceiling, and an exhausted wait throws naming its subject.

The law's first draft flagged seven innocent lines - `breakEndsAt: Date.now() +
30_000`, `vi.setSystemTime(Date.now() + 60_000)`, assertion bounds. Those are
fixtures; none spends wall time. Judging by magnitude alone would have taught
the next agent to delete the law, so it now requires **both halves** of the
shape: a deadline declared _and_ spun on in a loop.

Verified: full server suite green (430 files, 6,183 tests), law green, red
against a planted `Date.now() + 30_000` poll loop, red when `vitest.config.ts`
restates the literal, green again once both are reverted.

## Why nobody could read the failure

The diagnosis was blocked by the tooling, not the bug. `pr-status.mjs`
(shipped hours earlier) named the failing _job_ but printed a curl for the log,
and polling that log endpoint **exhausted the GitHub API quota**. Two fixes:

- **A 403 has two meanings and the tool conflated them.** Missing scope is
  permanent and needs a different token; rate limiting is temporary and needs a
  clock. The old message said "the token lacks a scope" either way, which would
  have sent someone to rotate a credential that was fine. It now reads
  `x-ratelimit-remaining` / `retry-after` and says which, with the reset time,
  and states plainly that this is not a permissions problem.
- **`--log` fetches the failing job's log once, caches it, and distils it** to
  the lines that name the failing test - skipping the expected-stderr noise. On
  PR #3140 it printed
  `FAIL tests/a-migration-version-is-reserved-not-guessed.law.test.ts` directly.
  A quota warning fires at 20% remaining, before the wall rather than after.

## Two MCP notes corrected in CLAUDE.md 11.0

- **The GitHub MCP works.** CLAUDE.md said it returned `Bad credentials` on
  every call as of 2026-09-01 and told agents not to debug it. Verified working
  on 2026-09-06. A note that retires a working tool costs more than the outage
  did, because every agent after it reads it as current.
- **`list_migrations` is unusable on this project** - 3,713 migrations returned
  with their full SQL, 296,122 characters. Query
  `supabase_migrations.schema_migrations` through `execute_sql` instead. A
  targeted read is not a workaround; it is the correct call.
