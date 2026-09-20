# tests/every-pinned-source-stays-bound.law.test.ts

Every `source-binding.json` pin is verified on the pull request that changes
the file, not on main after it merges.

A binding pins the exact bytes a financial qualification was reviewed against.
Until 2026-09-20 the only reader of those pins was the protected accounting
runner, and `changes` gates that job on `server/`, `supabase/migrations/`,
`scripts/dev/` and the accounting fixture directories. One binding file alone
pins 423 repository paths, most of them `tests/unit/*.test.ts`, which match
none of those prefixes. The pull request that broke a pin was therefore the
one pull request that never ran the check.

#4943 is the case: it retired the browser dispute escalator, changed
`tests/unit/FinancialCronService.test.ts` and
`tests/unit/discardedErrorReadRatchet.test.ts`, skipped `accounting_postgres`
in run 35478110801, merged green, and left main refusing the whole bundle.
Pull requests opened afterwards inherited a red step with nothing in their own
diff to explain it.

This law holds `scripts/ci/verify-source-bindings.py` to three promises,
proven by running it rather than by reading it: it accepts an intact pin and
refuses a drifted one; it refuses, rather than skips, a pin it cannot resolve,
including a missing file, an ambiguous root and a tree with no bindings at all;
and the workflow that runs it carries no `if`, `needs`, `paths` or
`branches-ignore`, so the check cannot be gated back into the hole it closes.
