---
description: Superseded — see 00-anti-regression-workflow.md
trigger: always_on
---

# Superseded

The binding workflow now lives in **`.agents/rules/00-anti-regression-workflow.md`**.

Two rules files describing the same workflow drifted apart and agents followed
whichever they read first. This file is intentionally a pointer so that cannot
happen again.

Summary of the rule that matters: **open the PR and stop.** Autopilot enables
squash auto-merge and GitHub merges it when the required checks pass. Never use
`--admin`, `--merge`, `--rebase`, or a polling script.
