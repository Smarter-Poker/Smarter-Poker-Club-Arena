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

## description: What to do when a Club Arena change is not live

# Deploy troubleshooting

**REWRITTEN 2026-09-04.** The banner above has been on this file since
2026-09-03 and 240 lines of dead procedure sat under it: `sync-club-arena.sh`
failure modes, World Hub commit conflicts, `public/hub/club-arena/` partial
pushes. None of those steps exist any more. A banner over a body that still
reads as instructions does not help a reader who skims into the middle.

## Step 0 - establish what is actually live

```bash
curl -s https://smarter.poker/hub/club-arena/build-info.json
git -C ~/Documents/club-arena rev-parse origin/main
```

If `ca_sha` equals `origin/main`, **production is current** and your problem is
somewhere else: a browser cache, a service worker holding an old shell, or a
change that never merged.

## Then work down this list

| Symptom                                       | Where to look                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch pushed, no pull request                | `agent-open-pr.yml` runs on `create` and `push` for any branch name. Check its run. `.github/scripts/report-stuck-prs.sh` names every branch pushed but never proposed                                                                                                                                                                     |
| PR open, not merging                          | A required check is red, or auto-merge was never enabled. Read the check, not the PR. Six are required: TypeScript Check, Client Unit Tests, Server Engine, Production Build, CSS Beat E2E, Silent Revert Guard                                                                                                                            |
| Merged, but production is behind              | The publisher failed or was cancelled. Three nets run automatically: the `*/30` catch-up cron inside `publish-club-arena.yml`, `publish-watchdog.yml` (three re-dispatches, then an issue), and the orphan sweep in `agent-autopilot.yml`. Behind by more than ~25 minutes means something is genuinely broken - read the watchdog's issue |
| A publish run says "cancelled"                | The publisher's concurrency group is `cancel-in-progress: false`, so a third push cancels the PENDING run, not the running one. The catch-up cron picks it up                                                                                                                                                                              |
| An asset 404s for some players                | `/assets/*` and `/fonts/*` come from an ADDITIVE pool on the origin, pruned by age only. If someone "cleaned it up", old hashed chunks are gone and any tab holding the previous `index.html` breaks mid-hand                                                                                                                              |
| A route 404s entirely                         | The World Hub's rewrite. `tests/club-arena-is-a-rewrite.test.mjs` in that repo pins both rewrite rules                                                                                                                                                                                                                                     |
| Production serves a bundle that never changes | Someone re-created `public/hub/club-arena/` in the World Hub. Next serves `public/` BEFORE the rewrite, so a file there SHADOWS the origin silently. That test fails CI if it comes back - check whether it was disabled                                                                                                                   |

## What NOT to do

- **Do not publish by hand.** If infrastructure is degraded, re-dispatch the
  owning Club Arena workflow when its runner path is available; section 9 of
  `.agent/AGENT-OPERATIONS-GUIDE.md` preserves that single authority.
- **Do not run the Vercel CLI.** Club Arena's own Vercel project has
  `deploymentEnabled: false` and CLAUDE.md 1.3 forbids it.
- **Do not re-vendor the bundle into the World Hub.** See the last row above.
- **Do not wait passively for the next engine schedule.** If an exact engine
  SHA is already staged, dispatch `auto-deploy-hetzner.yml` toward the current
  certified maintenance break with `force=false`, then verify the sealed
  result and cache-busted live SHA.
