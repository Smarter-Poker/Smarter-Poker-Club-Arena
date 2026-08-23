# STALE PR RESOLUTION (THE REVERT TRAP)

Because this repository merges ~128 commits a day and uses squash-merging, an abandoned PR will rot extremely fast. A PR that is 100–200 commits behind `main` is highly dangerous.

## The Revert Trap

If you find a PR that is massively behind `main`, **do NOT attempt to force it through or merge it.**
If the PR's original work was already completed by another agent and squash-merged into `main` under a different commit SHA, GitHub does not know they are the same work.
If you merge the stale PR, Git will apply its old, outdated files on top of the new `main`. If the files don't explicitly conflict, this can instantly and silently revert tens of thousands of lines of other agents' work.

## Your Mandatory Action

When you are asked to review or unstick old PRs (e.g., from the Autopilot Sweep issue), follow this strict protocol:

1. **Check if it's already on main:** Look at the stale PR's diff. Was this feature or fix already merged by another agent?
2. **Verify Redundancy:** Check the target files on `main`. If `main` is newer and already has the fix (or a better version of it), the PR is redundant.
3. **Close It:** Do NOT leave it open. Do NOT attempt to rebase it. Close the PR immediately and leave a comment explaining that the content was already merged under a different SHA, explicitly citing the "Revert Trap".

Leave nothing sitting open that is already finished. An open, rotting PR is a loaded gun.
