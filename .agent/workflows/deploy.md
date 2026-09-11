> **SUPERSEDED 2026-09-03 - READ THIS FIRST.**
> Club Arena no longer publishes by committing its build into the World Hub
> repo. It publishes by rsync to its own origin, `https://ca-static.smarter.poker`
> (`/srv/club-arena` on the Hetzner box: `releases/<ca_sha>/`, an atomically
> swapped `current` symlink, an additive `pool/`), and the World Hub carries a
> single Next.js rewrite `/hub/club-arena/:path*` to it. `public/hub/club-arena/`
> is GONE from that repo and a law test refuses to let it back.
>
> **Every `sync-club-arena.sh` / `build-club-arena.sh` / `sync-to-world-hub.sh`
> command below is dead.** Those scripts are deleted from `main`. If you find one
> on disk you are on a stale branch - it still works, and running it would
> re-vendor the bundle and shadow the origin.
>
> **You do not publish by hand at all now:** push a branch, and
> `agent-open-pr` -> `agent-autopilot` -> `publish-club-arena` does the rest.
> The current path is `.agent/architecture/deploy-paths.md`.

---

## description: How a Club Arena change reaches a player

# Club Arena Deployment Workflow

**REWRITTEN 2026-09-04.** The banner above has been on this file since
2026-09-03, and everything under it was still the old procedure written in the
present tense: build locally, run `sync-to-world-hub.sh`, copy 618 files into
the World Hub's `public/hub/club-arena/`, push the World Hub. A banner over a
body that still reads as instructions does not help a reader who skims into the
middle of it, so the body is gone.

## Production URL

`https://smarter.poker/hub/club-arena/`

## The route

```
push a branch
  -> agent-open-pr.yml opens the pull request (seconds)
  -> ci.yml runs the six required checks on the estate's runners
  -> agent-autopilot.yml squash-merges when they are green
  -> publish-club-arena.yml builds dist/ and rsyncs it to
     ca-static.smarter.poker: /srv/club-arena/releases/<ca_sha>/, then an
     atomic swap of the `current` symlink (ten releases kept; rollback is
     re-pointing the symlink)
  -> the World Hub's ONE rewrite, /hub/club-arena/:path* -> that origin,
     serves it. The World Hub is NOT rebuilt for a Club Arena merge.
```

## What you actually do

```bash
git worktree add -b fix/<slug> ~/Documents/.agent-trees/club-arena/<name> origin/main
# edit, commit, then:
git push origin HEAD:refs/heads/fix/<slug>
```

The push starts delivery; it does not prove delivery. Follow the pull request
and the owning Club Arena workflows to a terminal result, fix any red check,
and do not call the work complete until the exact merged SHA is live.

## Verify - by reading, never by assuming

```bash
curl -s https://smarter.poker/hub/club-arena/build-info.json
```

`ca_sha` at both the direct origin and public rewrite must equal the squash
commit on `main`. "The push succeeded" and "the merge landed" are not
deployment. For `server/` changes, independently verify the sealed
`auto-deploy-hetzner.yml` run and the cache-busted engine health SHA too.

## The one thing about the origin worth knowing

`/assets/*` and `/fonts/*` are served from an ADDITIVE pool the publisher never
`--delete`s, pruned by age (30 days) only. A player whose tab still holds the
previous `index.html` asks for the previous hashed chunks mid-hand. **Do not
"clean up" that pool** - that is the 404 it exists to prevent.

## Files that matter

- `vite.config.ts` - base path `/hub/club-arena/`
- `.github/workflows/publish-club-arena.yml` - THE publisher, and the only one
  (`tests/no-commit-left-behind.law.test.ts` counts them and requires exactly one)
- World Hub `next.config.js` - the single rewrite
- World Hub `pages/api/club-arena/*` - the API routes

## Where the detail lives

`.agent/architecture/deploy-paths.md` and CLAUDE.md section 1.1.
