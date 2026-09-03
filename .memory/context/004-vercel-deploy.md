# Vercel Deployment — Frontend

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

**Type:** CONTEXT
**Date:** 2026-03-30
**Project:** Smarter Poker Club Arena

## Project Details

| Field           | Value                                                          |
| --------------- | -------------------------------------------------------------- |
| Vercel Project  | `hub-vanguard`                                                 |
| Project ID      | `prj_op66GkZyZcygXQKm76iyycfVFAQx`                             |
| Domain          | `smarter.poker`                                                |
| Token           | `<REDACTED:VERCEL_TOKEN — read from .env.local, never commit>` |
| GitHub Repo     | `Smarter-Poker/Smarter-Poker-World-Hub`                        |
| Club Arena Path | `public/hub/club-arena/`                                       |
| Production URL  | `https://smarter.poker/hub/club-arena/`                        |

## Deploy Pipeline

1. Build Club Arena: `cd ~/Documents/club-arena && npm run build`
2. Sync to World Hub: `bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub`
3. Commit World Hub: `cd ~/Documents/Smarter-Poker-World-Hub && git add public/hub/club-arena/ && git commit && git push`
4. Vercel auto-deploys from GitHub push (or manual via API)

## Manual API Deploy

```bash
curl -X POST "https://api.vercel.com/v13/deployments" \
  -H "Authorization: Bearer <REDACTED:VERCEL_TOKEN — read from .env.local, never commit>" \
  -H "Content-Type: application/json" \
  -d '{"name":"hub-vanguard","project":"prj_op66GkZyZcygXQKm76iyycfVFAQx","gitSource":{"type":"github","org":"Smarter-Poker","repo":"Smarter-Poker-World-Hub","ref":"main"}}'
```

## Notes

- NEVER deploy to `smarter-poker` project — that's the old one
- `smarter.poker` domain is on `hub-vanguard` project
- Vercel GitHub App may not be installed — manual API deploy may be needed
- World Hub sparse checkout on Cowork VM: `/sessions/intelligent-stoic-darwin/Smarter-Poker-World-Hub`
