# GitHub credentials: three configs, one token, one missing permission

**Date:** 2026-08-25
**Trigger:** the GitHub MCP returned `Authentication Failed: Bad credentials` for
two consecutive Cowork sessions, which turned a routine push into a manual
branch-and-PR through `curl`.

## What was actually wrong

The MCP server's token is **not** UI-only configuration. It lives in plain JSON
on disk, in **three** places, and all three must agree:

| Location                                                          | Key                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN`                                                                            |
| `~/.claude.json`                                                  | `mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN` (global)                                                                   |
| `~/.claude.json`                                                  | `projects["/Users/smarter.poker"].mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN` (**project scope, overrides the global**) |

Two carried revoked tokens (an expired `github_pat_11B4UMBYA039…` and a dead
`ghp_ae4KJm9…`). The third — the project-scoped one, which is the one a session
rooted at the home directory actually uses — held the **literal string**
`${GITHUB_PERSONAL_ACCESS_TOKEN}`, 31 characters of unexpanded shell syntax.

That last one is the trap worth remembering. `~/.zshrc` line 33 does:

```sh
export GITHUB_PERSONAL_ACCESS_TOKEN="$(gh auth token 2>/dev/null)"
```

`gh auth token` returns the correct, live token — so from a **terminal** the
placeholder resolves and everything works. Claude Desktop is launched from the
GUI, which never sources `.zshrc`, so the variable is empty and the literal
`${GITHUB_PERSONAL_ACCESS_TOKEN}` is sent to GitHub as a bearer token. The
failure is environment-dependent, which is exactly why it looked like a revoked
token rather than a config bug.

All three now hold the same literal PAT as `~/Documents/club-arena/.env`
(fine-grained, expires **2026-11-19**). A config edit only takes effect on a
**new session** — the MCP server process inherits its environment at spawn, so
the session that fixes the file still fails until it restarts.

## The permission that is still missing: `Checks: Read`

The live token answers `200` on `/user`, the repo, `/actions/runs`, `/pulls`
and `/search/repositories`, and `403 Resource not accessible by personal access
token` on:

```
GET /repos/Smarter-Poker/Smarter-Poker-Club-Arena/commits/{ref}/check-runs
```

**So: do not poll `check-runs` to find out whether CI passed.** It returns a
`403` body with no `check_runs` key, and naive code reads that as "no checks
yet" and waits out its whole timeout. Use instead:

```
GET /actions/runs?head_sha={sha}          # which workflows ran
GET /actions/runs/{id}/jobs               # per-job status + which step failed
GET /pulls/{n}  -> mergeable_state         # clean | unstable = safe to merge
```

`mergeable_state` is the authoritative answer for "may this land": `clean` means
required checks are green, `unstable` means green-but-a-non-required-check-failed
(e2e is slow and flaky and is not required), `blocked` means keep waiting,
`dirty` means a real conflict that waiting will not fix.

To remove the workaround: GitHub -> Settings -> Developer settings -> Personal
access tokens -> Fine-grained tokens -> the token expiring 2026-11-19 ->
Repository permissions -> **Checks: Read-only**. If GitHub regenerates the token
on save, update `.env` **and all three config entries above**.
