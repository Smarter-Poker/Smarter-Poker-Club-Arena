# Club Arena Delivery Pipeline

Club Arena has one reviewed delivery chain. Local janitors, recovery watchers,
direct-main pushes, World Hub bundle syncs, Vercel builds, and workstation SSH
deploys are not part of it.

## 1. Preserve Work Locally

Work in an isolated feature branch. Stage only task-owned paths, commit with all
hooks enabled, fetch `origin/main`, and merge it forward when it advances. Never
rebase or rewrite shared history. A guard refusal is fixed at the root; it is not
bypassed.

## 2. Review And Merge

Credential-free `.github/workflows/agent-branch-proposal.yml` signals a pushed
feature branch. Trusted default-branch `.github/workflows/agent-open-pr.yml`
opens the missing pull request, and `.github/workflows/agent-autopilot.yml`
enables protected squash auto-merge. Conflicts and failures stay blocked until
a reviewed commit fixes them; no periodic reconciler mutates branches.

## 3. Publish The Frontend

A merge to `main` invokes `.github/workflows/publish-club-arena.yml`. It builds
the exact main SHA and publishes it atomically to the Club Arena Hetzner static
origin at `ca-static.smarter.poker`. The public World Hub URL is a routing layer
only. The publisher may also be retried with the `publish-club-arena` repository
event carrying the exact full main SHA; it still fails closed on stale or
diverged input.

## 4. Deploy The Engine

Protected-main server changes trigger `.github/workflows/stage-engine-release.yml`,
which immediately sends the exact SHA to `.github/workflows/auto-deploy-hetzner.yml`.
The owning workflow stages and verifies that immutable commit, then cuts over
only within the sealed maintenance authority. There is no force input, timer
dependency, or manual workstation deployment path.

## 5. Prove The Release

`.github/workflows/production-integrity-audit.yml` compares both the direct
Hetzner `build-info.json` and the public Club Arena route with current `main`.
It is read-only and cannot repair or re-dispatch. A green workflow is not
sufficient: completion requires the intended SHA and affected behavior to be
live. Engine adoption is proven independently with the cache-busted engine
health/version response.

Credential values live only in the Club Arena repository's GitHub Actions
secret store and the target runtime. Documentation and local `.env` files may
name required variables but must never contain or relay production values.
