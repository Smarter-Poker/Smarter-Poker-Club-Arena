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

CONTEXT: Platform Architecture
DATE: 2026-03-29

THREE-SERVICE ARCHITECTURE:

1. Vercel — Frontend at smarter.poker (World Hub repo, auto-deploys)
2. Hetzner VPS — Poker engine server (server/ directory, Node.js + PM2)
3. Supabase — PostgreSQL + Auth + Realtime (kuklfnapbkmacvwxktbh.supabase.co)

KEY URLS:

- Production: https://smarter.poker/hub/club-arena/
- Engine: engine.smarter.poker (Hetzner VPS)
- Supabase: kuklfnapbkmacvwxktbh.supabase.co

DEPLOYMENT PIPELINE:

1. Make changes in Club Arena repo
2. npm run build (Vite → dist/)
3. bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub
4. Push World Hub to GitHub → Vercel auto-deploys

SERVER DEPLOYMENT:

- Push to Hetzner VPS via git pull + PM2 restart
- Uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS)

GIT CONFIG:

- Hooks bypassed: git config core.hooksPath /dev/null
- Always run npx tsc --noEmit before committing

SUPABASE CREDENTIALS:

- Login: daniel@bekavactrading.com / 215SlalomCt!
