# How Agents Push And Publish Club Arena

Club Arena publishes from this repository to its own Hetzner origin. World Hub
only rewrites the public route; it never receives, builds, or publishes the
Club Arena bundle. The canonical path is
`.agent/architecture/deploy-paths.md`.

Last verified: 2026-09-10

## Credential boundary

Use the host's configured Git/CLI authentication to push a branch. Never hunt
through World Hub environment files, embed a token in a remote URL, copy a
credential into a command, or print a value. The autopilot application and both
Hetzner publishers read their own write-only Club Arena repository secrets.

## Push paths, in order of preference

1. Work in an isolated worktree on a feature branch.
2. Merge current `origin/main` into that branch when it moves; never rebase or
   force-push around a conflict.
3. Push the branch with normal hooks. The repository's `agent-open-pr` and
   `agent-autopilot` workflows own proposal and merge.
4. Follow required checks, merge, and the relevant Club Arena Hetzner workflow
   to a terminal result. Fix red checks forward through the same branch path.

## Deploy pipeline note

Merging to `Smarter-Poker-Club-Arena` `main` triggers **`publish-club-arena.yml`**,
whose `publish-to-origin` job rsyncs `dist/` to Club Arena's own static origin:
`/srv/club-arena/releases/<ca_sha>/` on the Hetzner box, then swaps the `current`
symlink atomically. The World Hub carries ONE Next.js rewrite,
`/hub/club-arena/:path*`, pointing at `https://ca-static.smarter.poker`.

Nothing is committed into the World Hub repo, and the bundle is not a Vercel
deployment. To confirm a publish landed, read the build stamp - the origin and
the rewrite must agree:

    curl -s https://ca-static.smarter.poker/build-info.json
    curl -s https://smarter.poker/hub/club-arena/build-info.json

Both return `{ ca_sha, built_at, built_by: "publish-club-arena.yml", run_id }`
and both `ca_sha` values must equal the exact current Club Arena `main`.

Publishing is GitHub-Actions-gated. If a run is dropped or infrastructure
recovers after an outage, re-dispatch the owning Club Arena workflow
immediately; never create a workstation, World Hub, or Vercel fallback.
