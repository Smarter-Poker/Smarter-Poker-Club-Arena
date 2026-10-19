# 2026-10-19 - Law tests scan each migration once; dead print exporters removed

An audit found four things. Each was checked again on `origin/main` (29f3e1822)
before it was changed.

## A. Law tests that ran close to vitest's 5 s ceiling

CLAUDE.md 10.86 rule 4: a test whose normal runtime is most of its budget
fails as "Test timed out" on a slow runner, and the timeout never says which
assertion it was about to make.

| case                                                                                              | before   | after                                |
| ------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ |
| postgrest-is-never-reloaded-on-a-timer: no migration since the root fix sets it under two minutes | 3,661 ms | 597-684 ms                           |
| postgrest-is-never-reloaded-on-a-timer: nothing from 20260922141524 puts a reload on a timer      | 4,229 ms | 53-59 ms                             |
| every-chip-store-balances: NEGATIVE PROOF (journalled column with no tally)                       | 2,685 ms | 26-33 ms                             |
| every-chip-store-balances: every chip-balance column is counted (first scan)                      | 1,519 ms | 731-808 ms                           |
| every-chip-store-balances: NEGATIVE PROOF (suspense rule)                                         | 1,499 ms | under 100 ms                         |
| a-runbook-link-leads-somewhere: drift check states what it did not fetch                          | 2,182 ms | 1,623-1,671 ms, explicit 20 s budget |
| the three files together, wall                                                                    | 22.5 s   | 5.8 s                                |

Measured on the shared 2-core box. "Before" was taken at load 0.5 and "after"
at load 1.5, so the after column is, if anything, pessimistic.

**The cause was repeated work, not slow checks.** The postgrest law re-read
each migration and blanked its comments and literals character by character,
twice per file over 3,183 files (52 MB) in one case and five times per file
over 1,076 files in the other. The chip-store law stripped comments from all
~5,700 files (77 MB) again for every derivation, and three of its cases
re-read the whole directory from disk on top of the copy it already held.

**The fix:**

- postgrest: each file is read once. One pass now produces both blanked copies
  (the comment-and-literal copy and the comment-only copy), and the result is
  cached for the rest of the file. The new pass gives byte-identical output to
  the old `blankSql` in both modes. That was checked on all 5,685 migration
  files (66.9M characters) and 200,000 fuzzed strings, with 0 mismatches. A
  planted one-character bug in the same harness produced 34,874 mismatches, so
  the check can fail.
- chip-store: each file is read once and stripped once. Each derivation
  (journal triggers, tallied columns, counted stores, latest function bodies)
  is memoised per file and folded in migration order, exactly as before. The
  old and new functions were compared on the full migration set, the planted
  negative-proof sets, the narrowed set and a partial set: 35 comparisons, 0
  mismatches.
- runbook: the time is the drift script's own work matching alert metrics to
  their producers, 1.7 s with nothing else running, so nothing in the test
  repeats it. That one case gets an explicit `timeout: 20_000`, with the
  measurement written beside it.

No assertion was removed, weakened or narrowed. Every case still scans the
same files with the same detectors.

## B. Dead print exporters in src/lib/export.ts

`exportSettlementPDF` and `exportHandHistoryPDF` had no caller in `src/` or
`server/`. They returned the HTML as a "placeholder" blob rather than a PDF,
and they rendered through a hidden `<iframe>` built with
`document.createElement`, outside the one sanctioned frame
(`src/components/table/HubFrame.tsx`, CLAUDE.md 1.3). Both are deleted, along
with their private `htmlToPdfBlob` and `arenaPrintText` helpers.
`exportToCSV`, `buildCSV`, `escapeCSVCell` and `downloadBlob` are unchanged.

`tests/arena-dollar-signs.law.test.tsx` loses only the one case that called
the deleted functions ("renders printable hand and settlement previews").
With no print preview left, that case has nothing to check. Every other
display surface the dollar-sign law covers is still checked by its remaining
cases.

## C. Stale "NOT yet wired" headers

- `server/src/observability/Metrics.ts` and `Tracing.ts` are wired:
  `observability/engineInstruments.ts` builds the engine's registries and its
  tracer from them. The headers now say what is wired (actions, act-to-broadcast
  latency, hands and hand duration, RPC errors, WS reconnects, hand span) and
  what still is not (`poker_rpc_total`, `EventLoopLagMonitor`, action and RPC
  spans).
- `server/src/scale/index.ts` was **left unchanged**. Its "NOT yet wired" is
  accurate: nothing outside `server/src/scale/` imports it, and
  `tests/additional-engine-workers-wait-for-the-scaling-gate.law.test.ts`
  requires that to stay true until the scaling gate is met.

## D. check-horses-are-players register

The gate reported `server/src/services/supabase/handFacts.ts` as an unused
register entry. The exclusion it excused has been gone since 2026-09-05, when
fact rows went platform-wide for horses. The entry is removed, and the gate now
reports 8 registered exclusions, all justified.
