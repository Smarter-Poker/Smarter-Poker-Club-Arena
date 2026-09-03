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

## description: How to deploy Club Arena to production

# Club Arena Deployment Workflow

## Production URL

The production Club Arena is served at: `https://smarter.poker/hub/club-arena`

Club Arena lives 100% inside smarter.poker. All files (JS, CSS, HTML, images, cards,
videos, logos) are in the World Hub's `public/hub/club-arena/` directory and served
directly from smarter.poker. ZERO requests go to external domains.

## Architecture

```
smarter.poker/hub/club-arena/*
  → Static files from public/hub/club-arena/ (JS/CSS/images/cards/videos)
  → SPA fallback rewrite serves index.html for client-side routes
  → React Router handles navigation
  → Auth via shared Supabase session (same-origin localStorage)
```

NO iframe. NO proxy. NO club-arena.vercel.app. Everything from smarter.poker.

## Deployment Steps

**After ANY code change to Club Arena, you MUST sync to the World Hub and push.**

### 1. Build and Sync

```bash
cd /Users/smarter.poker/Documents/club-arena

# Make your code changes, then:
bash scripts/sync-to-world-hub.sh /Users/smarter.poker/Documents/Smarter-Poker-World-Hub
```

This script will:

- Run safety checks (no iframe code, no hardcoded domains)
- TypeScript compilation check
- Build with Vite
- Strip source maps
- Copy all 618 files to World Hub's public/hub/club-arena/
- Verify the copy

### 2. Push World Hub to Deploy

```bash
cd /Users/smarter.poker/Documents/Smarter-Poker-World-Hub

# Use the safe push script
bash scripts/git-safe-push.sh "chore: update Club Arena dist"
```

Vercel auto-deploys smarter.poker with the updated Club Arena files.

### 3. Verify Deployment

After deploying, verify at: `https://smarter.poker/hub/club-arena/`

**DO NOT verify on club-arena.vercel.app** — that is NOT the production URL.

## Key Configuration Files

### Club Arena (Smarter-Poker-Club-Arena repo)

- `vite.config.ts` — Build config with base path `/hub/club-arena/`
- `scripts/sync-to-world-hub.sh` — One-command build + sync script
- `scripts/build-and-verify.sh` — Safety checks before every build

### World Hub (Smarter-Poker-World-Hub repo)

- `public/hub/club-arena/` — ALL Club Arena files (618 files, 89MB)
- `next.config.js` — `fallback` rewrite for SPA routing (serves index.html for unmatched routes)
- `pages/hub/club-arena/*.js` — 14 native pages (take priority over SPA)
- `pages/api/club-arena/` — 66 API routes

## If Site Shows Old Content

1. **Club Arena not updating?**
   - Did you run `sync-to-world-hub.sh`? Changes must be copied to the World Hub.
   - Did you push the World Hub? Only the World Hub deploys to smarter.poker.

2. **Cache issues?**
   - Vercel caches are cleared on new deployments
   - Hard refresh: Ctrl+Shift+R / Cmd+Shift+R

3. **Build failed?**
   - Run `bash scripts/build-and-verify.sh` locally to check for errors
   - Check TypeScript: `npx tsc --noEmit`

## Deprecated — DO NOT USE

- `club-arena.vercel.app` — Legacy standalone deployment, NOT production
- `club-engine.vercel.app` — Legacy duplicate, NOT production
- `club.smarter.poker` — Legacy subdomain, redirects to smarter.poker
- `ClubArenaEmbed` — Deleted iframe component
- `postMessage` / `window.parent` — Deleted iframe communication
- `VITE_XAI_API_KEY` — Moved server-side to World Hub API route
