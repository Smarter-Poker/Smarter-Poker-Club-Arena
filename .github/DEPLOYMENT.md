# Club Arena Deployment

Club Arena publishes through Hetzner. This document replaces the obsolete Vercel/direct-main instructions previously here.

1. Work in your own branch and isolated worktree under .agent-trees.
2. Run the required source, test and build checks. Commit normally.
3. Push the feature branch with the normal pre-push hooks enabled.
4. agent-open-pr.yml opens the pull request. Autopilot enables squash auto-merge after required checks.
5. publish-club-arena.yml builds and publishes to ca-static.smarter.poker on Hetzner, then atomically switches the current release.
6. Verify https://smarter.poker/hub/club-arena/build-info.json and the affected behavior. A pushed branch is not proof of publication.

The public Club Arena path is rewritten to the Hetzner origin. Do not deploy Club Arena with Vercel, push directly to main, modify the World Hub repository, bypass checks, manually merge or force an engine restart.

Engine adoption follows its documented scheduled maintenance workflow and is verified separately from static frontend publication. Database migrations also require their own applied-definition evidence.

Read ../AGENT-PLAYBOOK.md and ../CLAUDE.md section 1.1 for canonical instructions and credential locations. Never place credential values in documentation.
