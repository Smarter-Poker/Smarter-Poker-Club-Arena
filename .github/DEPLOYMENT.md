# Club Arena Deployment

Club Arena publishes through Hetzner. This document replaces the obsolete Vercel/direct-main instructions previously here.

1. Work in your own branch and isolated worktree under .agent-trees.
2. Run the required source, test and build checks. Commit normally.
3. Push the feature branch with the normal pre-push hooks enabled.
4. The unprivileged branch-proposal workflow signals the trusted default-branch
   agent-open-pr.yml, which opens the pull request. Autopilot enables protected
   squash auto-merge after required checks.
5. publish-club-arena.yml builds and publishes to ca-static.smarter.poker on Hetzner, then atomically switches the current release.
6. Verify https://smarter.poker/hub/club-arena/build-info.json and the affected behavior. A pushed branch is not proof of publication.

The public Club Arena path is rewritten to the Hetzner origin. Do not deploy Club Arena with Vercel, push directly to main, modify the World Hub repository, bypass checks, manually merge or force an engine restart.

Every protected-main `server/**` change is immediately sent by
`stage-engine-release.yml` as an exact-SHA Club Arena repository event toward
the documented maintenance window. Engine adoption is verified separately from
static frontend publication. Do not create a duplicate dispatch or race the
active engine-release owner. Database migrations require their own
applied-definition evidence.

Read ../AGENT-PLAYBOOK.md and ../CLAUDE.md section 1.1 for canonical instructions and credential locations. Never place credential values in documentation.
