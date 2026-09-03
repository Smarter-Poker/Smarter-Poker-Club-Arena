---
description: MANDATORY POST-TASK VERIFICATION PROTOCOL. You must run these commands and paste the output before EVER claiming a task is done.
trigger: always_on
---

# MANDATORY VERIFICATION PASS

Before you EVER claim a task is "done", "finished", or ready for review, you MUST run the following commands and paste their output into your final response. Do not take your own word for it.

### PART A — IS IT ACTUALLY SHIPPED?

- `git status --porcelain` (must be empty of tracked files)
- `git log --oneline origin/main..HEAD` (must show your commits are pushed to the remote branch)
- `git branch -r --contains HEAD` (must name your remote branch)
- `gh pr list --head <your-branch>` (must show an OPEN PR)

### PART B — DID YOU FOLLOW THE RULES?

- `pwd` (must be under `.agent-trees/`)
- `git log -1 --format='%an <%ae>'` (must be Smarter-Poker)
- Did you use `--no-verify`? State plainly if you did and why. (It is strictly forbidden for normal work).

### PART C — IS THE CODE ACTUALLY DONE?

Run `git diff origin/main...HEAD` and verify:

1. **STUBS**: Zero `TODO`, `FIXME`, or `not implemented` placeholders.
2. **WIRING**: Every new function is called, every component rendered.
3. **DATABASE**: Migrations exist and will be applied by CI.
4. **REGRESSIONS**: Existing tests passing.
5. **ERROR PATHS**: Network failures and missing rows are caught and handled (e.g., `toast.error`).

### PART D — DOES IT RUN?

You must run and paste the output of:

- `npx tsc --noEmit`
- `npx vitest run tests` (or the specific tests covering your change)
- `npm run build`

### PART E — IS IT LIVE?

Check if the PR has merged or what is blocking it:

- `gh pr view <pr-number> --json mergeStateStatus`
- `gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/<id>/jobs --jq '.jobs[]|"\(.name) \(.conclusion)"'`

**DO NOT CLAIM SUCCESS WITHOUT PASTING THE OUTPUT OF THESE COMMANDS.**
