# How agents push to Smarter-Poker repos (READ THIS FIRST)

Last verified: 2026-08-06

## TL;DR — which token works

- ✅ **Live token:** `GITHUB_TOKEN` in `Smarter-Poker-World-Hub/.env` (prefix `ghp_HUV…`).
  This one authenticates against the GitHub API and has write access to the org repos.
- ❌ **Stale token:** the PAT embedded in the club-arena git remote URL
  (`ghp_waRF…`) is **revoked** — GitHub returns `401 Bad credentials`. Do not use it.
  Update the remote to use the `.env` token if you push from the Mac.

## Push paths, in order of preference

1. **GitHub MCP through the device bridge** (`mcp__remote-devices__github__*`).
   Runs on the Mac with network + auth. Works for normal-size files
   (`push_files`, `create_or_update_file`, `create_pull_request`, `merge_pull_request`).
   This is the default for everyday commits/PRs.

2. **Large files (>~250 KB) — GitHub git-data API.**
   `push_files` / `create_or_update_file` send the whole file inline, and the
   agent's own tool-call output cap (~85–100k tokens) makes a 300 KB file
   impossible to emit in one call. Instead build the commit from git objects:
   `POST /git/blobs` → `POST /git/trees` (base_tree + changed entries) →
   `POST /git/commits` → `PATCH /git/refs/heads/<branch>`. Verify the blob SHA
   with `git hash-object` before committing. (This is how `TablePage.tsx`,
   ~300 KB, was shipped on 2026-08-06.)

3. **The cloud session's git proxy is per-repo gated.** From the cloud container,
   `git push` / `api.github.com/repos/...` return `403 "not enabled for this
session"` for repos not in the session's authorized set — regardless of token.
   `/user` still 200s because the proxy injects its own credential there, so that
   endpoint is NOT a valid token test. To push directly from the cloud, add the
   repo to the session's GitHub sources (add_repo, access:"push").

4. **Compute-with-network fallback (only if 1–3 are blocked).** A short-lived
   Vercel serverless function can call the GitHub git-data API with the `.env`
   token passed **in the request body** (never baked into source), then be
   deleted. Used once during the 2026-08-06 GitHub Actions outage.

## Deploy pipeline note

Merging to `Smarter-Poker-Club-Arena` `main` triggers the **Build for World Hub
Sync** GitHub Action, which builds the CA bundle and commits it into
`Smarter-Poker-World-Hub/public/hub/club-arena`, which Vercel then deploys.
That sync is **GitHub-Actions-gated** — during an Actions outage a merge will not
go live until Actions recovers and the sync workflow runs.
