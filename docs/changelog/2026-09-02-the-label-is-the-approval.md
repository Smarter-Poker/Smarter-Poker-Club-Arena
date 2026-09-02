# The Label Is The Approval

2026-09-02. The Silent Revert Guard's human-approval path had never worked.

## Measured

PR #2676 deletes `build-for-world-hub.yml` and, in a later commit, restores
the shared `report-stuck-prs.sh` to main's version. The guard flagged the
restore (correctly - that is its definition of a revert) and filed #2682 asking
for the `revert-approved` label. The label was applied at 18:41. The guard
re-ran on `labeled` at 18:42 with `REVERT_APPROVED: true` in its environment
and **exited 1 anyway**.

## Why

    if (announced && APPROVED) continue;

The label exempted a commit only if its message ALSO contained the word
"revert" or `[allow-revert]`. CLAUDE.md 10.8.2 and the guard's own issue text
both promise "apply the label and the check passes"; neither mentions the
message. 10.8.2 also forbids editing commit messages to route around the
guard. So a human-approved pull request whose commits were not phrased as a
revert had no path through: the approved path could not be taken. A gate whose
approved path cannot be taken is a lock.

## The fix

The label is a human's approval of the PULL REQUEST they read. It is not
conditional on how any commit inside it was phrased. When it is present the
guard says what is being waved through and exits 0. A message saying "revert"
or `[allow-revert]` remains worth nothing on its own (2026-08-31: an agent
wrote it into its own message to get past the guard) - that is unchanged.

## Verified

`tests/unit/theLabelIsTheApproval.test.ts` runs the real script against a
throwaway repository: without the label a restore is reported (exit 1); with
the label the same pull request passes; a message that announces a revert is
still not approval. Mutating the script back to `announced && APPROVED`
reproduces the #2676 failure exactly and turns the pin red.
