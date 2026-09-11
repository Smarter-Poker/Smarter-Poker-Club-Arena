# tests/no-merge-gate-without-a-producer.law.test.ts

A required status check that no workflow produces is a merge freeze by another name. At 12:20:32 UTC on 2026-09-11 the `main protection` ruleset gained the unauthorized required check "Stage B Release Freeze"; nothing emits it, so every pull request (#4292, #4296, #4299) sat green and unmergeable until it was removed at 12:47:26. Dan ordered it removed and never allowed back. The law pins three things:

- Every check that `scripts/ci/apply-main-ruleset.mjs` requires, and every check the live ruleset required after the removal, is the display name of a job a workflow here runs.
- No required check, workflow or job is named as a freeze.
- Only `apply-main-ruleset.mjs` and `remove-world-hub-bypass.mjs` may write a ruleset or branch protection.

A token with Administration: write can still edit the ruleset by hand; that is a token-scope decision for the owner.
