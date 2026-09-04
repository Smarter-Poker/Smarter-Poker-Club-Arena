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

DEPLOYMENT PIPELINE (rewritten 2026-09-04; the four steps that were here
named a sync script deleted on 2026-09-02, and following them would have
SHADOWED the live bundle rather than published it - Next serves the World
Hub's public/ BEFORE the rewrite that reaches this app):

1. Make changes on a branch in your own worktree
2. git push origin HEAD:refs/heads/<branch> <- YOUR JOB ENDS HERE
3. agent-open-pr.yml opens the PR; agent-autopilot.yml merges it green
4. publish-club-arena.yml rsyncs dist/ to ca-static.smarter.poker and swaps
   the `current` symlink; the World Hub's one rewrite serves it
5. Verify: curl -s https://smarter.poker/hub/club-arena/build-info.json
   ca_sha must equal the squash commit on main. Nothing else counts.

SERVER DEPLOYMENT:

- Push to Hetzner VPS via git pull + PM2 restart
- Uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS)

GIT CONFIG:

- Hooks bypassed: git config core.hooksPath /dev/null
- Always run npx tsc --noEmit before committing

SUPABASE CREDENTIALS:

- Login: daniel@bekavactrading.com / 215SlalomCt!
