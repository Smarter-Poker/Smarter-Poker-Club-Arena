---
description: Superseded — see 00-anti-regression-workflow.md
trigger: always_on
---

# Superseded

The binding workflow now lives in **`.agents/rules/00-anti-regression-workflow.md`**.

Two rules files describing the same workflow drifted apart and agents followed
whichever they read first. This file is intentionally a pointer so that cannot
happen again.

Summary of the rule that matters: **open the PR, set a `schedule` timer, and sleep.** Autopilot enables
squash auto-merge and GitHub merges it when the required checks pass. Wait for the timer to wake you up, check for green, fix any failures, and only report success when merged. Never use
`--admin`, `--merge`, `--rebase`, or a bash polling script.
