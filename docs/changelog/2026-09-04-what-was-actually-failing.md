# What was actually failing, measured over 24 hours

Agents have complained about CI failing all day. This is what it was, counted
rather than guessed: **46 failed CI runs, 101 failing jobs.**

| cause                                             | jobs   |
| ------------------------------------------------- | ------ |
| **a check genuinely failed**                      | **62** |
| the verdict job (reports the others, not a cause) | 38     |
| infrastructure - a runner killed mid-step         | **1**  |

**The failures were real.** Only one job in a hundred died for an
infrastructure reason, and that one was self-inflicted while rebalancing
runners. "CI is flaky" was the wrong diagnosis; the pipeline was reporting
true things.

## What the 62 were

| count  | check                                                      |
| ------ | ---------------------------------------------------------- |
| 18     | Client Unit Tests / Run Test Suite                         |
| **15** | TypeScript Check / **Supabase Invariants - New Migration** |
| 8      | Production Build / Entry Chunk Is A Reviewed List          |
| 7      | Supabase Invariants - A Club Stays Deleted                 |
| 5      | Supabase Invariants - Definer Authorization                |
| 4      | Source Windows Are Structural                              |

And inside the 18 unit failures, by spec file:

| count | spec                                   |
| ----- | -------------------------------------- |
| **6** | `migrationVersionUniqueness.test.ts`   |
| 4     | `member-count-family-complete.test.ts` |
| 2     | `noFixedSizeSourceWindows.test.ts`     |
| 2     | `discardedErrorReadRatchet.test.ts`    |
| 2     | `club-operations-page.test.tsx`        |

## One cause dominates, and it is structural

**21 of the 62 - a third of every real failure - are the same migration
version collision.** 15 in `TypeScript Check`, 6 in `Client Unit Tests`.

Agents hand-pick the 14-digit version, reach for round numbers, and two land on
the same one. Neither branch is wrong alone; the collision appears when the
second takes `main`. That is precisely the experience of "my correct work went
red for no reason".

Fixed by `scripts/new-migration.mjs`, which reserves a version against this
tree, `origin/main` and **every remote branch**. But a tool nobody runs fixes
nothing, so it is now **CLAUDE.md section 4.5**, in the file every agent reads
at session start, and the failing test's own message names it.

## What was checked and found innocent

- **`member-count-family-complete.test.ts` passes on current `main`** (12/12).
  Those four failures were branch-specific, not a broken baseline.
- **`discardedErrorReadRatchet` is well built.** It fails only on regression
  (`n > allowed`) and pins audited surfaces at zero. Unlike `orphanModuleRatchet`
  - which asserted `=== baseline` and so failed when the code IMPROVED - it does
    not punish progress. Only the orphan one needed changing.
- **Supabase Invariants - Definer Authorization** is a security gate doing its
  job: it blocked a `SECURITY DEFINER` function that writes, is browser-callable
  and never checks `auth.uid()`. Five of those are five caught vulnerabilities,
  not five bugs in CI.

## The honest summary

Two thirds of the noise was one preventable collision and a ratchet that
punished improvement. The rest was the guards working. The pipeline was not
lying to anyone - it was telling twelve agents, correctly, that they had
stepped on each other.
