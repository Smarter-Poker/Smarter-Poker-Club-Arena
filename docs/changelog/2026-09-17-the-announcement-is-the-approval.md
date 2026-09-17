# The announcement is the approval (2026-09-17)

Dan, 2026-09-17: "REMOVE THIS GLOBALLY: human-only `revert-approved`. I don't
approve anything, when you are cleared to push and publish you do it
automatically. Then fix any and all things that are blocking you from pushing
and publishing yourself."

## What was the gate

Since 2026-09-01 the Silent Revert Guard refused any pull request that
restored a file to an older state unless a human applied the
`revert-approved` label. Announcing the revert in the commit message did
nothing, the workflow filed an issue asking for the label, and CLAUDE.md
10.8.2 said intentional reverts need a human. It was the only human-only gate
in the estate: no repository ruleset requires a review, no GitHub environment
requires a reviewer, and every publisher runs on the protected merge.

## What it is now

- `scripts/ci/detect-silent-revert.mjs`: a commit whose message says
  "revert" or `[allow-revert]` is an intended revert and is not a finding.
  `REVERT_ANNOUNCED=true` (the pull request title or body says so) clears the
  whole pull request, exactly as the label (`REVERT_APPROVED=true`) still
  does. Only a SILENT restore of an older state fails, with instructions to
  merge `origin/main` and re-apply, or to say the revert is intended.
- `.github/workflows/silent-revert-guard.yml`: passes `REVERT_ANNOUNCED` from
  the pull request title and body, re-runs on `edited`, and no longer files
  "ask a human for the label" issues (and no longer needs `issues: write`).
- `tests/unit/theAnnouncementIsTheApproval.test.ts` (was
  `theLabelIsTheApproval`) pins all four paths against the real script in a
  throwaway repository.
- CLAUDE.md 10.8.2 rewritten.

The stale-checkout clobber the guard was written for (World Hub 902d8b2b) is
still caught: that commit did not say it was a revert, and would still fail.
