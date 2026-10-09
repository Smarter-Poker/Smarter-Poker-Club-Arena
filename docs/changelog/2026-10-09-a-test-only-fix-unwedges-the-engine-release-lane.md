# A Test-Only Fix Unwedges The Engine Release Lane

## What Happened

From 19:38 UTC on 2026-10-08 every Engine Release failed on one stale horse-lane test (`JointLegalForm.test.ts`, flo8 cash P13.1) in the tree of c79f08d347, the newest engine runtime commit. The fix, 3353d64d5f (#6531), changed only a test file. The release stager picks its target from runtime paths only (`*.test.ts` excluded), so every later push offered c79f08d347 again with the same broken test. Six releases failed the same way, and the tournament self-heal in 27d2776a58 (#6503) stayed merged but undeployed.

## What Is Now True

The stager still decides whether a release is owed from runtime code only, but the SHA it offers is the newest commit on main that touched anything under `server/`. That tree always contains the owed engine commit and the newest server test fixes, so a test-only fix ships with the next offer instead of being skipped forever. A test-only commit still never owes a release by itself.

## Proof

`tests/an-owed-engine-release-is-offered-until-production-holds-it.law.test.ts` drives the real detector step: a test-only fix after the owed commit is offered as the target, and a test-only commit with production current offers nothing.
